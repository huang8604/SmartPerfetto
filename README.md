# SmartPerfetto - AI 驱动的 Perfetto 分析平台

AI-driven performance analysis platform for Android traces.

## Quick Start

```bash
# One command to start everything
./scripts/start-dev.sh
```

Access:
- **Perfetto UI**: http://localhost:10000
- **Backend API**: http://localhost:3000

> Configure `backend/.env` before first run (copy from `.env.example`)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MasterOrchestrator                               │
│  • Pipeline execution with checkpoints                              │
│  • Circuit breaker protection                                       │
│  • Multi-model routing (Anthropic/DeepSeek/OpenAI)                 │
│  • Evaluator-Optimizer loop                                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│ PlannerAgent  │     │ WorkerAgents  │     │ EvaluatorAgent│
│ (Task分解)     │     │ (专家分析)     │     │ (质量评估)     │
└───────────────┘     └───────────────┘     └───────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            ┌─────────────┐         ┌─────────────┐
            │ Tool Layer  │         │ Skill YAML  │
            │ (SQL/帧分析) │         │ (分析定义)   │
            └─────────────┘         └─────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| **MasterOrchestrator** | Main coordinator with pipeline, state machine, circuit breaker |
| **PipelineExecutor** | Stage execution with checkpoints for crash recovery |
| **CircuitBreaker** | Protection against infinite loops, requests user intervention |
| **ModelRouter** | Multi-model support with fallback chains |
| **SessionLogger** | Per-session persistent logging for debugging |

## Directory Structure

```
SmartPerfetto/
├── perfetto/ui/              # Frontend (Mithril.js) @ :10000
├── backend/
│   ├── src/
│   │   ├── agent/            # New Agent Architecture
│   │   │   ├── core/         # MasterOrchestrator, Pipeline, CircuitBreaker
│   │   │   ├── agents/       # PlannerAgent, EvaluatorAgent, Workers
│   │   │   ├── tools/        # SQL executor, frame analyzer
│   │   │   └── state/        # Session store, checkpoints
│   │   ├── services/         # TraceProcessor, SessionLogger
│   │   └── routes/           # API endpoints
│   ├── skills/v2/            # YAML analysis definitions
│   └── logs/sessions/        # Session logs (JSONL)
└── scripts/                  # Start/push scripts
```

## API Endpoints

### Analysis

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/analyze` | Start analysis with MasterOrchestrator |
| GET | `/api/agent/:id/stream` | SSE for real-time updates |
| GET | `/api/agent/:id/status` | Get analysis status |
| POST | `/api/agent/:id/respond` | Respond to circuit breaker |
| POST | `/api/agent/resume` | Resume from checkpoint |

### Logging (for debugging)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agent/logs` | List all session logs |
| GET | `/api/agent/logs/:sessionId` | Get logs for session |
| GET | `/api/agent/logs/:sessionId/errors` | Get only errors/warnings |

## Development

### Frontend (Mithril.js)

```typescript
// Component pattern
export class MyComponent implements m.ClassComponent<Attrs> {
  view(vnode: m.Vnode<Attrs>) {
    return m('div', vnode.attrs.title);
  }
}
```

Rebuild: `cd perfetto/ui && node build.js`

### Backend Skills (YAML)

```yaml
# backend/skills/v2/composite/my_analysis.skill.yaml
name: my_analysis
type: composite

steps:
  - id: summary_data        # Frontend data key
    sql: "SELECT ..."
    display:
      level: summary        # L1 layer
```

### Environment Variables

```env
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_MODEL=deepseek-chat
```

## Debugging

### View Session Logs

```bash
# List sessions
curl http://localhost:3000/api/agent/logs

# Get logs for session
curl http://localhost:3000/api/agent/logs/{sessionId}

# Get only errors
curl http://localhost:3000/api/agent/logs/{sessionId}/errors
```

Logs are stored in `backend/logs/sessions/*.jsonl`

### Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | Run `./scripts/start-dev.sh` to build trace_processor |
| Empty frontend data | Check stepId matches YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| CORS error | Clear browser cache, use incognito |

## Perfetto Submodule

```bash
# First clone
git submodule update --init --recursive

# Sync updates
cd perfetto && git checkout smartperfetto && git pull fork smartperfetto

# Push both repos
./scripts/push-all.sh
```

## License

MIT License
