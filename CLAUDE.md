# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Tech Stack

This is primarily a TypeScript codebase. Use TypeScript idioms, strict typing, and follow existing patterns in the codebase.

## Post-change Dev Workflow

Both backend (`tsx watch`) and frontend (`build.js --watch`) auto-rebuild on file save. After code changes:
- **All .ts / .yaml changes**: Tell user to refresh the browser. No restart needed.
- **Only use `./scripts/restart-backend.sh`** for: `.env` changes, `npm install`, or tsx watch stuck.
- **Only use `./scripts/start-dev.sh`** for: first-time setup or both services crashed.
- **Default assumption**: User only refreshes browser after changes. If a restart is truly needed, explicitly tell the user to run the specific script and why.

## Mandatory Post-change Trace Regression

After every code change, run the scene reconstruction regression suite:

```bash
cd backend && npm run test:scene-trace-regression
```

This suite is mandatory and validates these canonical traces in `test-traces/`:

- 重度滑动卡顿: `app_aosp_scrolling_heavy_jank.pftrace`
- 轻度滑动: `app_aosp_scrolling_light.pftrace`
- 标准滑动: `app_scroll_Standard-AOSP-App-Without-PreAnimation.pftrace`
- App 启动: `app_start_heavy.pftrace`
- Flutter TextureView 滑动: `Scroll-Flutter-327-TextureView.pftrace`
- Flutter SurfaceView 滑动: `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace`

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
- **Primary Runtime: agentv3** — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as orchestrator
- **Deprecated Fallback: agentv2** — governance pipeline + agent/core executors (activated by `AI_SERVICE=deepseek`)
- Claude orchestrates via 15 MCP tools: execute_sql, invoke_skill, submit_plan, submit_hypothesis, recall_patterns, etc.
- Scene Classifier routes queries to scene-specific system prompts (scrolling/startup/anr/general)
- Analysis logic in YAML Skills (`backend/skills/`)
- Results layered: L1 (overview) → L2 (list) → L3 (diagnosis) → L4 (deep)
- SSE for real-time streaming

---

## Backend Structure

### Runtime Layer (Primary Path): `backend/src/agentv3/`

The primary execution path uses Claude Agent SDK as the orchestrator. Claude receives a system prompt with scene-specific analysis strategies and accesses trace data through MCP tools.

**Routing:** `agentAnalyzeSessionService.ts` calls `isClaudeCodeEnabled()` → `ClaudeRuntime` (default) or legacy `AgentRuntime` (fallback).

| Component | Purpose |
|-----------|---------|
| claudeRuntime.ts | 主编排器 — implements `IOrchestrator`, wraps `sdkQuery()` |
| claudeMcpServer.ts | 15 MCP tools for Claude to access trace data |
| claudeSystemPrompt.ts | 动态 system prompt — 按 SceneType 注入分析策略 + 上轮计划上下文 |
| claudeSseBridge.ts | SDK stream → SSE events 桥接 (text buffering, tool tracking) |
| claudeConfig.ts | 配置 + `isClaudeCodeEnabled()` 路由判断 |
| sceneClassifier.ts | 关键词场景分类 (scrolling/startup/anr/general, <1ms) |
| focusAppDetector.ts | 焦点应用检测 (battery_stats/oom_adj/frame_timeline) |
| claudeAgentDefinitions.ts | Sub-agent 定义 (feature-flagged: `CLAUDE_ENABLE_SUB_AGENTS=true`) |
| claudeVerifier.ts | 4 层验证 (heuristic + plan adherence + hypothesis + scene completeness + LLM) + 可学习误诊模式. 默认开启 |
| artifactStore.ts | Skill 结果引用存储 — 3 级获取 (summary/rows/full) |
| sqlSummarizer.ts | SQL 结果摘要 — `summary=true` 时返回列统计+采样行，节省 ~85% tokens |
| claudeFindingExtractor.ts | 从 SDK 响应和 Skill 结果中提取 Findings |
| analysisPatternMemory.ts | 跨会话分析模式记忆 — 持久化 trace 特征→insights (200 条, 频率加权, 60 天 TTL) |
| types.ts | ClaudeAnalysisContext, AnalysisNote, AnalysisPlanV3, Hypothesis, UncertaintyFlag, VerificationResult |
| index.ts | 导出 + `createClaudeRuntime()` 工厂 |

**MCP Tools (15):**

| Tool | Purpose |
|------|---------|
| execute_sql | 执行 Perfetto SQL 查询 (支持 summary 模式, 需先 submit_plan) |
| invoke_skill | 调用 YAML Skill (参数传递, 结果存入 ArtifactStore, 需先 submit_plan) |
| list_skills | 列出可用 Skills (按类型过滤) |
| detect_architecture | 检测渲染架构 (Standard/Flutter/Compose/WebView) |
| lookup_sql_schema | 查询 Perfetto SQL 表/视图/函数 schema (模糊匹配) |
| write_analysis_note | 写入结构化分析笔记 (跨轮次持久化, 磁盘备份, 20 条上限) |
| fetch_artifact | 分页获取 Skill 结果详情 (summary/rows/full) |
| query_perfetto_source | 搜索 Perfetto 源码 (异步 fs) |
| submit_plan | 提交结构化分析计划 (必须首先调用, 场景模板验证) |
| update_plan_phase | 更新计划阶段状态 (in_progress/completed/skipped, 需推理摘要) |
| revise_plan | 修改分析计划 (保留已完成阶段, 记录修改历史) |
| submit_hypothesis | 提交可检验假设 (formed → confirmed/rejected) |
| resolve_hypothesis | 解决假设 (提供证据, 结论前必须全部解决) |
| flag_uncertainty | 标记不确定性 (非阻塞, SSE 通知用户, 分析继续) |
| recall_patterns | 查询跨会话分析经验 (按架构/场景/关键词检索) |

**Sub-Agents (Optional, feature-flagged):**

| Agent | Model | Scene | Purpose |
|-------|-------|-------|---------|
| frame-expert | sonnet | scrolling | 帧渲染 + 卡顿分析 |
| system-expert | sonnet | all | CPU/内存/Binder 系统级分析 |
| startup-expert | sonnet | startup | 启动性能分析 |

### Agent Core (Shared): `backend/src/agent/`

Both agentv3 and agentv2 share these components:

**Detectors:** `agent/detectors/`
- architectureDetector.ts - 架构检测 (总控)
- standardDetector.ts / composeDetector.ts / flutterDetector.ts / webviewDetector.ts

**Context & Entity Tracking:** `agent/context/`
- enhancedSessionContext.ts - 多轮对话上下文
- entityStore.ts - 跨轮次实体追踪 (进程/线程/帧/区间)
- contextBuilder.ts / contextTypes.ts

**Core Utilities:** `agent/core/`
- entityCapture.ts - 从分析结果中提取实体
- conclusionGenerator.ts - 结论综合与格式化
- orchestratorTypes.ts - `IOrchestrator` 接口

### Legacy Runtime (Deprecated Fallback): `backend/src/agentv2/`

Activated only when `AI_SERVICE=deepseek`. Uses a governance pipeline wrapping agent/core executors.

<details>
<summary>展开 agentv2 详细结构</summary>

**Runtime:** `agentv2/runtime/`
- agentRuntime.ts — 主 entry point
- runtimeGovernancePipeline.ts — PrincipleEngine → Planner → SoulGuard → Execute
- runtimeModeExecutor.ts — mode 路由 (initial/clarify/extend/compare/drill_down)

**Executors:** `agent/core/executors/`
- strategyExecutor.ts — 确定性多阶段流水线 (Strategy matched)
- hypothesisExecutor.ts — 假设驱动多轮分析 (No strategy match)
- directSkillExecutor.ts — 直接执行 Skill (零 LLM 开销)
- clarifyExecutor.ts / comparisonExecutor.ts / extendExecutor.ts

**Strategies:** `agent/strategies/`
- scrollingStrategy.ts — 滑动分析 3 阶段流水线
- registry.ts — trigger 匹配策略选择

**Decision Trees:** `agent/decision/`
- trees/scrollingDecisionTree.ts, launchDecisionTree.ts

**Core:** `agent/core/`
- modelRouter.ts — 多模型路由 (DeepSeek/OpenAI/Anthropic)
- stateMachine.ts, circuitBreaker.ts, pipelineExecutor.ts, etc.

**Domain Agents:** `agent/agents/domain/`
- frameAgent.ts, cpuAgent.ts, memoryAgent.ts, binderAgent.ts, additionalAgents.ts

</details>

### Key Services

| Service | Location | Purpose |
|---------|----------|---------|
| TraceProcessorService | services/traceProcessorService.ts | HTTP RPC 查询 (端口池 9100-9900) |
| SkillExecutor | services/skillEngine/skillExecutor.ts | YAML Skill 引擎 |
| SkillLoader | services/skillEngine/skillLoader.ts | Skill 加载器 |
| PipelineSkillLoader | services/pipelineSkillLoader.ts | Pipeline Skill 加载器 (含 Teaching) |
| SkillAnalysisAdapter | services/skillEngine/skillAnalysisAdapter.ts | Skill 分析适配 |
| AnswerGenerator | services/skillEngine/answerGenerator.ts | 答案生成器 |
| SmartSummaryGenerator | services/skillEngine/smartSummaryGenerator.ts | 智能摘要 |
| EventCollector | services/skillEngine/eventCollector.ts | 事件收集 |
| HTMLReportGenerator | services/htmlReportGenerator.ts | HTML 报告生成 |
| SessionLogger | services/sessionLogger.ts | JSONL 会话日志 |
| SessionPersistenceService | services/sessionPersistenceService.ts | 会话持久化 |
| ResultExportService | services/resultExportService.ts | 结果导出 |

---

## Data Flow

### agentv3 (Primary — Claude Agent SDK)

```
User Query → POST /api/agent/v1/analyze → AgentAnalyzeSessionService
    │
    ├─ isClaudeCodeEnabled() → true (default)
    │
    ├─ Phase 1: Context Preparation (prepareAnalysisContext)
    │   ├─ classifyScene(query) → SceneType (scrolling/startup/anr/general)
    │   ├─ detectFocusApps() → 焦点应用 + 包名
    │   ├─ detectArchitecture() → 渲染架构 (缓存 per traceId)
    │   ├─ loadLearnedSqlFixPairs() → 跨会话 SQL 纠错上下文
    │   ├─ previousPlan → 上一轮分析计划 (跨轮次)
    │   ├─ loadPersistedNotes() → 磁盘持久化笔记 (跨重启)
    │   └─ buildSystemPrompt(context, sceneType) → 场景化 system prompt
    │
    ├─ Phase 2: SDK Orchestration (15 MCP tools)
    │   ├─ sdkQuery({ prompt, systemPrompt, mcpServers, model, effort })
    │   ├─ Claude 必须先 submit_plan → 然后通过 MCP tools 自主决策:
    │   │   ├─ submit_plan → 提交分析计划 (场景模板验证)
    │   │   ├─ execute_sql / invoke_skill → 查询数据 (需先 submit_plan)
    │   │   ├─ submit_hypothesis / resolve_hypothesis → 假设驱动分析
    │   │   ├─ flag_uncertainty → 标记不确定性 (非阻塞)
    │   │   ├─ recall_patterns → 查询跨会话分析经验
    │   │   └─ write_analysis_note / fetch_artifact / etc.
    │   └─ claudeSseBridge → SDK messages → SSE events → 前端实时展示
    │
    ├─ Phase 3: Result Extraction + Verification
    │   ├─ extractFindingsFromText() + extractFindingsFromSkillResult()
    │   ├─ captureEntitiesFromResponses() → entityStore (跨轮次追踪)
    │   └─ verifyConclusion() (4 层: heuristic + plan + hypothesis + scene + LLM)
    │
    └─ Phase 4: conclusion → analysis_completed → SSE
```

### Multi-Turn Conversation

```
Round N+1 → sdkQuery({ resume: existingSdkSessionId })
    │
    ├─ SDK 自动恢复对话上下文 (无需手动传 previousFindings)
    ├─ entityStore 提供实体解析 ("第3帧" → frameId)
    └─ analysisNotes 跨轮次传递结构化笔记
```

### agentv2 (Deprecated Fallback)

<details>
<summary>展开 agentv2 数据流</summary>

```
User Query → POST /api/agent/v1/analyze → agentv2/AgentRuntime
    ├─ Intent Understanding → ModelRouter → LLM 意图分类
    ├─ Governance Pipeline → PrincipleEngine → OperationPlanner → SoulGuard
    ├─ Mode Execution:
    │   ├─ [Strategy Match] StrategyExecutor → 确定性多阶段流水线
    │   └─ [No Strategy] HypothesisExecutor → 多轮迭代
    └─ EvidenceSynthesizer → 结论生成
```

</details>

---

## Skill System

**Types:** atomic, composite, iterator, parallel, conditional

**Layered Results:**
- **L1 (overview):** 聚合指标 - `display.level: overview/summary`
- **L2 (list):** 数据列表 - `display.level: list/detail` + expandableData
- **L3 (diagnosis):** 逐帧诊断 - iterator over jank frames
- **L4 (deep):** 详细分析 - `display.level: deep/frame`

**Parameter Substitution:**
```yaml
# Skill 通过 ${param|default} 接收参数
inputs:
  - name: max_frames_per_session
    type: number
    required: false
steps:
  - id: diagnose
    type: iterator
    max_items: "${max_frames_per_session|8}"  # Strategy 传参覆盖默认值
```

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

**Location:** `backend/skills/`
- `atomic/` - 单步检测 (57 skills)
- `composite/` - 组合分析 (28 skills)
- `deep/` - 深度分析 (2 skills)
- `pipelines/` - 渲染管线检测+教学 (26 skills)
- `modules/` - 模块配置 (app/framework/hardware/kernel)
- `vendors/` - 厂商适配 (pixel/samsung/xiaomi/honor/oppo/vivo/qualcomm/mtk)

### Pipeline Skills (26)

渲染管线检测和教学内容，每个 Pipeline Skill 包含:
- `detection` - SQL 检测逻辑
- `teaching` - 教学内容 (线程角色、关键 Slice、Mermaid 时序图)

**Android View 系列:**
- android_view_standard_blast, android_view_standard_legacy
- android_view_software, android_view_mixed, android_view_multi_window
- android_pip_freeform

**Surface/Texture 系列:**
- surfaceview_blast, textureview_standard, surface_control_api

**Flutter 系列:**
- flutter_surfaceview_skia, flutter_surfaceview_impeller, flutter_textureview

**WebView 系列:**
- webview_gl_functor, webview_surface_control
- webview_surfaceview_wrapper, webview_textureview_custom

**Graphics API 系列:**
- opengl_es, vulkan_native, angle_gles_vulkan

**特殊场景:**
- game_engine, video_overlay_hwc, camera_pipeline
- hardware_buffer_renderer, variable_refresh_rate

---

## Teaching Content System

**Purpose:** 为每种渲染管线提供结构化教学内容，帮助用户理解帧渲染流程。

### 数据结构

```typescript
interface TeachingContent {
  threadRoles: ThreadRole[];     // 关键线程角色
  keySlices: KeySlice[];         // 关键 Trace Slice
  mermaidBlocks: string[];       // Mermaid 时序图源码
}

interface ThreadRole {
  thread: string;                // 线程名 (main/RenderThread/SurfaceFlinger)
  responsibility: string;        // 职责描述
  traceLabels: string[];         // 对应的 Trace 标签
}

interface KeySlice {
  name: string;                  // Slice 名称
  description?: string;          // 说明
}
```

### 前端渲染

**Mermaid 图表渲染流程:**
```
Teaching Content → Base64 编码 → data-mermaid-b64 属性
                                       ↓
页面加载 → loadMermaidScript() → 从 assets/mermaid.min.js 加载
                                       ↓
renderMermaidInElement() → 解码 Base64 → mermaid.render() → SVG
```

**CSP 兼容:** Mermaid.js 从同源 `assets/mermaid.min.js` 加载，符合 CSP `script-src 'self'`

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
- ai_panel.ts - 主 UI + Mermaid 渲染
- sql_result_table.ts - 数据表格 (schema-driven)
- ai_service.ts - 后端通信
- chart_visualizer.ts - 图表可视化
- navigation_bookmark_bar.ts - 导航书签

**Mermaid 图表支持:**
- 懒加载 `assets/mermaid.min.js` (CSP 兼容)
- Base64 编码存储图表源码
- 错误处理 + 源码折叠展示

---

## API Endpoints

**Agent (唯一主链路):**
- `POST /api/agent/v1/analyze` - 启动分析 (agentv3 ClaudeRuntime 或 agentv2 fallback)
- `GET /api/agent/v1/:sessionId/stream` - SSE 实时流
- `GET /api/agent/v1/:sessionId/status` - 轮询状态
- `POST /api/agent/v1/:sessionId/respond` - 响应断路器 (agentv2 only)
- `POST /api/agent/v1/scene-reconstruct` - 场景重建（独立功能）

**Logs:**
- `GET /api/agent/v1/logs/:sessionId` - 会话日志
- `GET /api/agent/v1/logs/:sessionId/errors` - 仅错误

**Trace:**
- `POST /api/traces/register-rpc` - 注册 RPC

**Skills:**
- `GET /api/skills/*` - Skill 管理

**Export:**
- `POST /api/export/*` - 结果导出

**Sessions:**
- `GET /api/sessions/*` - 会话管理

---

## SSE Events

### agentv3 (claudeSseBridge)

| Event | Source | Description |
|-------|--------|-------------|
| progress | phase transitions | 阶段进度 (starting/analyzing/concluding) |
| agent_response | MCP tool results | 工具调用结果 (SQL/Skill) |
| answer_token | final text stream | 结论文本流式输出 |
| thought | intermediate reasoning | 中间推理 (工具调用前的文本) |
| analysis_completed | result message | 分析完成 |
| error | exceptions | 错误 |

### agentv2 (legacy)

| Event | Description |
|-------|-------------|
| hypothesis_generated, round_start, stage_start | 假设/轮次/阶段 |
| agent_task_dispatched, agent_dialogue, agent_response | 任务分派与完成 |
| synthesis_complete, strategy_decision | 综合与迭代决策 |

---

## Session Management

- 路由层内存 `Map<sessionId, AnalysisSession>` 管理会话
- agentv3: SDK session ID 持久化到 `logs/claude_session_map.json` (debounced, 24h TTL)
- 每 30 分钟清理过期会话
- 支持多轮对话（复用 sessionId, agentv3 通过 `resume: sdkSessionId` 恢复 SDK 上下文）
- 并发保护: `activeAnalyses` Set 防止同一 session 并行 analyze()

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
| Build/compilation error in unfamiliar file | Check if the file is auto-generated before editing. Look for headers like `// Generated`, `/* Auto-generated */`, or check if the path contains `generated`, `build`, or `dist`. Fix the generator/template instead. |

---

## Code Generation

When fixing localization (L10n) or code generation issues, always identify and modify the generator script/template rather than editing generated output files directly.

---

## Environment

```bash
# backend/.env
PORT=3000
# Default: claude-code (Claude Agent SDK). Set AI_SERVICE=deepseek for legacy agentv2 (deprecated).
# AI_SERVICE=claude-code
CLAUDE_MODEL=claude-sonnet-4-6          # Optional, default
# CLAUDE_MAX_TURNS=15                   # Optional
# CLAUDE_ENABLE_SUB_AGENTS=true         # Optional feature flag
# CLAUDE_ENABLE_VERIFICATION=false       # Default: true (set false to disable)

# Legacy (deprecated, only for AI_SERVICE=deepseek)
# DEEPSEEK_API_KEY=sk-xxx
```

---

## File Count Summary

| Category | Count |
|----------|-------|
| agentv3 (Primary) | 15 source files |
| agent (Shared) | ~50 source files |
| agentv2 (Deprecated) | ~37 source files |
| Services | ~31 service files |
| Skills | 113 definitions (57 atomic + 28 composite + 26 pipelines + 2 deep) |
| Routes | 16 API handlers |
