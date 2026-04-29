# 测试与验证

SmartPerfetto 的默认完成标准是 trace 回归通过。任何代码改动后运行：

```bash
cd backend
npm run test:scene-trace-regression
```

## 核心命令

| 场景 | 命令 |
|---|---|
| TypeScript build | `cd backend && npm run build` |
| 类型检查 | `cd backend && npx tsc --noEmit` |
| 核心单测 | `cd backend && npm run test:core` |
| 场景 trace 回归 | `cd backend && npm run test:scene-trace-regression` |
| Skill 校验 | `cd backend && npm run validate:skills` |
| Strategy 校验 | `cd backend && npm run validate:strategies` |
| 默认 gate | `cd backend && npm run test:gate` |

## 改动类型与必须验证

| 改动 | 必跑 |
|---|---|
| TypeScript 代码 | `npm run test:scene-trace-regression` |
| Build/type 修复 | `npx tsc --noEmit` + 回归 |
| Skill YAML | `npm run validate:skills` + 回归 |
| Strategy/template Markdown | `npm run validate:strategies` + 回归 |
| 前端生成类型相关 | `npm run generate:frontend-types` + 相关前端测试 |
| 渲染管线文档且影响 Skill doc_path | `npm run validate:skills` + 回归 |

## Canonical traces

`test:scene-trace-regression` 使用 6 条 canonical traces：

| 场景 | Trace |
|---|---|
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scrolling | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scrolling | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## E2E Agent 验证

当改动影响 startup、scrolling、Flutter、system prompt、verifier、MCP 工具或关键 Skill 时，只跑 Skill 回归不够，需要跑 Agent SSE 验证。

启动性能：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/lacunh_heavy.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

滑动性能：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-scrolling.json \
  --keep-session
```

fast/full 模式：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode fast \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "这个 trace 的应用包名和主要进程是什么？" \
  --output test-output/e2e-fast.json
```

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode full \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-full.json
```

## 验证输出

E2E 完成后检查：

- `test-output/e2e-*.json` 是否有 terminal event 和错误事件。
- `backend/logs/sessions/session_*.jsonl` 中 phase 是否完整。
- 结论是否覆盖场景策略的强制检查项。
- Skill 表格和最终结论是否能互相支撑。

## 文档-only 改动

普通说明文档不一定需要跑完整回归，但如果文档被运行时读取，或改动同时触碰 `.ts`、`.yaml`、`backend/strategies/*.md`，按上表执行。
