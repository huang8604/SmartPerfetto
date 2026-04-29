# 故障排查

## AI backend not connected

检查后端是否运行：

```bash
curl http://localhost:3000/health
```

如果没有响应：

```bash
./scripts/start-dev.sh
```

如果只有后端配置变更或 watcher 卡住：

```bash
./scripts/restart-backend.sh
```

## trace 上传后没有数据

常见原因：

- trace 没有成功注册到后端。
- `trace_processor_shell` 进程退出。
- 查询依赖的 Perfetto stdlib 表不存在。
- Skill 的 stepId 与 YAML 输出不一致。

检查：

```bash
curl http://localhost:3000/api/traces
curl http://localhost:3000/api/traces/stats
```

## 端口冲突

默认端口：

- Backend: `3000`
- Frontend: `10000`
- trace_processor RPC: `9100-9900`

清理 trace processor：

```bash
pkill -f trace_processor_shell
```

如果 backend 端口被占用，先确认是否已有 SmartPerfetto 实例在跑，再决定是否停止旧进程。

## LLM 调用慢或失败

慢模型、代理模型、本地模型通常需要更长超时：

```bash
CLAUDE_FULL_PER_TURN_MS=120000
CLAUDE_QUICK_PER_TURN_MS=80000
CLAUDE_VERIFIER_TIMEOUT_MS=120000
CLAUDE_CLASSIFIER_TIMEOUT_MS=60000
```

如果 fast 模式分析重型问题失败，改用 full：

```json
{
  "options": {
    "analysisMode": "full"
  }
}
```

## 401 或鉴权失败

如果设置了 `SMARTPERFETTO_API_KEY`，请求需要：

```http
Authorization: Bearer <token>
```

本地开发没有设置该变量时，默认不要求 bearer token。

## SSE 断开

SSE 断开通常由浏览器刷新、网络中断或请求超时触发。后端支持 `Last-Event-ID` / `lastEventId` replay ring buffer，前端会尽量恢复缺失事件。

如果 session 已完成，重新连接 `/api/agent/v1/:sessionId/stream` 会尝试恢复结果并发送终态事件。

## Scene reconstruction 被禁用

`/api/agent/v1/scene-reconstruct/*` 受 feature flag 控制。接口返回：

```json
{
  "code": "FEATURE_DISABLED"
}
```

说明当前环境未启用 `FEATURE_AGENT_SCENE_RECONSTRUCT`。

## Docker 启动失败

检查：

- `backend/.env` 是否存在。
- 是否配置了 `ANTHROPIC_API_KEY` 或代理。
- `perfetto/` submodule 是否存在。
- Docker 可用内存和磁盘是否足够。

本地开发排查更容易时，可以先运行：

```bash
./scripts/start-dev.sh
```

确认代码路径正常后再回到 Docker。

## Skill 校验失败

运行：

```bash
cd backend
npm run validate:skills
```

常见问题：

- YAML 缩进错误。
- step `id` 重复。
- `doc_path` 指向不存在的渲染管线文档。
- `display.columns` 字段名与 SQL 结果列不一致。
- `${param|default}` 拼写错误。

## Strategy 校验失败

运行：

```bash
cd backend
npm run validate:strategies
```

常见问题：

- frontmatter 不是合法 YAML。
- scene 名称与运行时枚举不一致。
- `phase_hints` 结构错误。
- Prompt 模板变量漏填。
