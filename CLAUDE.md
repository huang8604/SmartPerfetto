# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Architecture Overview

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
                │                                     │
                └───────── HTTP RPC (9100-9900) ──────┘
                                  │
                    trace_processor_shell (Shared)
```

**Core Concepts:**
- Frontend/backend share `trace_processor_shell` via HTTP RPC
- Analysis logic in YAML Skills (`backend/skills/`)
- Results layered: L1 (overview) → L2 (list) → L4 (deep)
- SSE for real-time streaming

---

## Backend Structure

### Agent System (v4.0)

**Core:** `backend/src/agent/core/`
| Component | Purpose |
|-----------|---------|
| masterOrchestrator.ts | 主协调器，管理分析生命周期 |
| pipelineExecutor.ts | 流水线执行 (plan→execute→evaluate→refine→conclude) |
| circuitBreaker.ts | 熔断器，触发用户介入 |
| modelRouter.ts | 多模型路由 (DeepSeek/Anthropic/OpenAI/GLM) |
| stateMachine.ts | 状态机 |

**SubAgents:** `backend/src/agent/agents/`
- plannerAgent.ts - 意图理解、规划
- evaluatorAgent.ts - 结果评估
- workers/analysisWorker.ts - Skill 执行桥接

**Context & State:**
- `context/enhancedSessionContext.ts` - 多轮对话 (Phase 5)
- `compaction/contextCompactor.ts` - Token 溢出防护
- `state/checkpointManager.ts` - 暂停/恢复
- `fork/forkManager.ts` - 会话分叉 (Phase 4)

**Detectors:** `backend/src/agent/detectors/`
- standardDetector.ts, composeDetector.ts, flutterDetector.ts, webviewDetector.ts

**Experts:** `backend/src/agent/experts/`
- launchExpert.ts, interactionExpert.ts, systemExpert.ts

**Tools:** `backend/src/agent/tools/`
- sqlExecutor, frameAnalyzer, skillInvoker, dataStats

### Key Services

| Service | Location | Purpose |
|---------|----------|---------|
| OrchestratorBridge | services/orchestratorBridge.ts | Agent↔SSE 桥接 |
| WorkingTraceProcessor | services/workingTraceProcessor.ts | HTTP RPC 查询 |
| SkillExecutor | services/skillEngine/skillExecutor.ts | YAML Skill 引擎 |
| HTMLReportGenerator | services/htmlReportGenerator.ts | 报告生成 |

---

## Skill System

**Types:** atomic, composite, iterator, parallel, diagnostic, ai_decision, ai_summary, conditional, skill

**Layered Results:**
- **L1 (overview):** 聚合指标 - `display.level: overview/summary`
- **L2 (list):** 数据列表 - `display.level: list/detail` + expandableData
- **L4 (deep):** 详细分析 - `display.level: deep/frame`

**Skill Example:**
```yaml
name: scrolling_analysis
type: composite
steps:
  - id: summary
    sql: "SELECT COUNT(*) as total..."
    display: { level: overview, title: "概览" }
  - id: jank_frames
    sql: "SELECT frame_id, ts, dur..."
    display:
      level: list
      columns:
        - { name: ts, type: timestamp, clickAction: navigate_timeline }
        - { name: dur, type: duration, format: duration_ms }
```

**Location:** `backend/skills/` (atomic/, composite/, deep/)

---

## DataEnvelope (v2.0)

统一数据契约 - 数据自描述，前端按配置渲染。

```typescript
interface DataEnvelope<T> {
  meta: { type, version, source, skillId?, stepId? };
  data: T;  // { columns, rows, expandableData }
  display: { layer, format, title, columns?: ColumnDefinition[] };
}

interface ColumnDefinition {
  name: string;
  type: 'timestamp' | 'duration' | 'number' | 'string' | 'percentage' | 'bytes';
  format?: 'duration_ms' | 'timestamp_relative' | 'compact';
  clickAction?: 'navigate_timeline' | 'navigate_range' | 'copy';
}
```

**Type Generation:** `npm run generate:frontend-types` (auto-run by start-dev.sh)

---

## Frontend

**Plugin:** `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`
- ai_panel.ts - 主 UI
- sql_result_table.ts - 数据表格 (schema-driven)
- ai_service.ts - 后端通信

---

## API Endpoints

**Agent:**
- `POST /api/agent/analyze` - 启动分析
- `GET /api/agent/:sessionId/stream` - SSE 流
- `POST /api/agent/:sessionId/respond` - 响应断路器

**Logs:**
- `GET /api/agent/logs/:sessionId` - 会话日志
- `GET /api/agent/logs/:sessionId/errors` - 仅错误

**Trace:**
- `POST /api/traces/register-rpc` - 注册 RPC

---

## SSE Events

| Event | Description |
|-------|-------------|
| progress | 阶段进度 |
| skill_layered_result | L1/L2/L4 数据 |
| circuit_breaker | 需用户介入 |
| analysis_completed | 完成 |
| error | 错误 |

---

## Quick Start

```bash
./scripts/start-dev.sh  # Auto-builds trace_processor_shell
# Backend @ :3000, Frontend @ :10000
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty data | 检查 stepId 匹配 YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| Debug | 查看 `backend/logs/sessions/*.jsonl` |

---

## Environment

```bash
# backend/.env
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
```
