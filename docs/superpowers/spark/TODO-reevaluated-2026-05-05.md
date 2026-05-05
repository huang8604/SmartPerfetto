# Spark 未完成 TODO 重新评估与关闭清单（2026-05-05）

> 来源：`TODO.md` 中截至本次复核仍未勾选的 26 项。
> 复核依据：最新代码、`README.md`、对应 `plans/*.md`。
> 关闭口径：原 plan 的 Done Criteria 允许通过实现、测试、文档或明确的 `unsupported/future` 记录关闭。本文件是新的 TODO 与关闭账本；没有把尚未落地的外部集成伪装成已实现能力。

## Prompt-to-artifact checklist

- [x] 从旧 `TODO.md` 提取所有未完成项：20-27、30-37、40、42、43、45、51、52、53、56、57，共 26 项。
- [x] 逐项基于最新代码重新评估：见下方每项的 `代码证据`。
- [x] 对当前代码已经覆盖的项标记为 `CODE`。
- [x] 对已有消费路径、契约或基础设施但缺少完整产品集成的项标记为 `SCAFFOLD`，并写明剩余 `future` 边界。
- [x] 对远景、外部生态或高风险自动化项标记为 `FUTURE/UNSUPPORTED`，作为显式关闭记录。
- [x] 回写旧 `TODO.md`：历史未完成项全部改为 `[x]`。

## 关闭状态总览

| 状态 | 含义 |
| --- | --- |
| `CODE` | 当前代码已有可用实现，满足该 plan 的现实交付面。 |
| `SCAFFOLD` | 当前代码已有契约、消费路径或局部实现；完整外部适配器作为 future 记录关闭。 |
| `FUTURE/UNSUPPORTED` | 当前不适合作为本轮产品实现；已明确记录为远景或暂不支持，避免继续悬挂在施工 TODO 中。 |

## UI、报告与可视化

- [x] 20. Vega/Vega-lite 可视化 Artifact — `SCAFFOLD/FUTURE`
  - 代码证据：`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/chart_visualizer.ts` 已有 chart artifact 渲染；`types.ts` 支持 `chartData` 与 `display.format: 'chart'`；`backend/src/types/dataContract.ts` 声明 `DataEnvelope` 与 `chart` display；`backend/src/services/htmlReportGenerator.ts` 可渲染 DataEnvelope。
  - 关闭结论：产品已具备结构化 chart artifact 消费路径；真正的 Vega/Vega-lite spec 白名单、沙箱渲染和 dataRef 加载作为 future，不再挂在主 TODO。

- [x] 21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation — `CODE`
  - 代码证据：`ai_timeline_notes.ts` 提供 AI findings/bookmark notes；`track_overlay.ts` 实现 overlay tracks、AI annotations、pinned workspace 恢复；`sse_event_handlers.ts` 将 DataEnvelope 路由到对应 overlay。
  - 关闭结论：Timeline notes、AI debug tracks 与 sidecar annotation 的主路径已存在。

- [x] 22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis — `CODE/SCAFFOLD`
  - 代码证据：`ai_area_selection_tab.ts` 提供区域选择分析与快速统计；`ai_panel.ts` 提供 slice/area selection、`selectionContext` 注入与 selection query；`critical_path_extension.ts` 支持选中线程状态的 critical path；`claudeMcpServer.ts` 提供 hypothesis tools。
  - 关闭结论：Selection Q&A 与 top hypothesis 已有产品路径；自动 pivot 建议作为 future 细化项关闭。

- [x] 23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard — `SCAFFOLD/FUTURE`
  - 代码证据：`track_overlay.ts` 使用 Perfetto workspace pinned tracks；AI Panel 与 Story sidebar 已承接工作区内分析入口。
  - 关闭结论：CUJ workspace 级集成已有基础；startup command 宏与 custom page dashboard 作为 future 记录关闭。

- [x] 24. AI Panel 多形态、自然语言多轮与 Session Facts — `CODE/FUTURE`
  - 代码证据：`ai_floating_window.ts`、`ai_sidebar_panel.ts`、`ai_panel.ts` 覆盖 floating/sidebar/tab 形态；`session_manager.ts` 管理 session；`provider_form.ts` 与 `provider_types.ts` 覆盖 provider/sub-agent 配置。
  - 关闭结论：SmartPerfetto 内的多形态 AI Panel 与多轮会话已落地；IDE 插件、独立桌面窗口作为 future。

- [x] 25. 双 Trace Diff UI 与报告链接 — `CODE`
  - 代码证据：`comparison_state_manager.ts` 管理 reference trace；`ai_panel.ts` 提供 reference trace UI；`claudeMcpServer.ts` 提供 `execute_sql_on`、`compare_skill`、`get_comparison_context`；`claudeRuntime.ts` 传递 comparison context。
  - 关闭结论：双 Trace Diff 的 UI、上下文与 MCP 工具主链路已具备。

- [x] 26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡 — `CODE/FUTURE`
  - 代码证据：`reportRoutes.ts` 提供 HTML report 存储、读取与导出；`htmlReportGenerator.ts` 支持 Markdown、Mermaid fence 与 DataEnvelope；`mermaid_renderer.ts` 提供前端 Mermaid 渲染；`exportRoutes.ts` 支持 CSV/JSON export。
  - 关闭结论：HTML、Mermaid、CSV/JSON 导出已落地；PDF/Markdown 文件级导出作为 future。

- [x] 27. 多模态 Timeline Replay、Walkthrough 与动画 — `CODE/FUTURE`
  - 代码证据：`story_controller.ts` 提供 Scene Story preview/start/report/load 以及 timeline story tracks；`agentSceneReconstructRoutes.ts` 和 `backend/src/agent/scene/**` 支撑重建、缓存、报告与 replay 事件。
  - 关闭结论：Timeline replay/walkthrough 主链路已存在；真正多模态 screenrecord 动画合成作为 future。

## 外部数据导入

- [x] 30. 外部 Artifact 导入总契约 — `SCAFFOLD`
  - 代码证据：`TraceProcessorService` 覆盖 trace upload、chunk upload、process、external RPC registration；`simpleTraceRoutes.ts` 提供 external RPC 注册；`agentRoutes.ts` 接受 `traceContext`、`selectionContext`、`referenceTraceId`、`providerId`；`logcat_analysis.skill.yaml` 已接入日志类外部输入。
  - 关闭结论：导入总契约与主输入通道已有基础；通用 artifact importer registry 作为 future。

- [x] 31. Logcat、Bugreport 与 ANR traces.txt 导入 — `SCAFFOLD/FUTURE`
  - 代码证据：`backend/skills/atomic/logcat_analysis.skill.yaml` 提供 logcat 分析；`sqlKnowledgeBase.ts` 包含 `android_logs` 知识；ANR/Startup 图谱能力已由 startup/anr 相关服务覆盖一部分。
  - 关闭结论：logcat 路径已存在；bugreport zip 与 traces.txt 专用 importer 作为 future。

- [x] 32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入 — `FUTURE/UNSUPPORTED`
  - 代码证据：`adbTools.ts` 只提供只读 ADB 命令安全外壳；`traceConfigGenerator.ts` 可生成 log/trace 采集配置。
  - 关闭结论：当前没有产品级 dumpsys/gfxinfo/batterystats/meminfo parser。本项明确作为 future/unsupported 关闭。

- [x] 33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入 — `SCAFFOLD/FUTURE`
  - 代码证据：`flamegraphRoutes.ts`、`flamegraphAnalyzer.ts`、`flamegraphAiSummary.ts` 支撑 flamegraph；`memoryRootCause.ts` 定义 `MemoryExternalArtifact`，包含 `leak_canary`、`hprof`、`baseline`、`manual`、`string`。
  - 关闭结论：flamegraph 与 memory external artifact 已有基础；tombstone/native crash 与完整 HPROF parser 作为 future。

- [x] 34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐 — `FUTURE/UNSUPPORTED`
  - 代码证据：Scene Story 当前能消费 timeline/analysis 事件并生成 walkthrough，但没有 screenrecord/screenshot/UIAutomator importer。
  - 关闭结论：作为多模态远景关闭，不再作为未完成施工 TODO 悬挂。

- [x] 35. SimplePerf、AGI、Profiler 与音视频输入 — `CODE/SCAFFOLD`
  - 代码证据：`backend/skills/deep/callstack_analysis.skill.yaml` 覆盖 simpleperf/perf CPU sampling；`flamegraphAnalyzer.ts` 与前端 flamegraph UI 支撑火焰图；`gpuSurfaceFlinger.ts` 与 `gpuSurfaceFlinger.test.ts` 覆盖 AGI/vendor profiler imports。
  - 关闭结论：simpleperf/flamegraph 与 AGI/vendor profiler 基础已存在；Android Studio Profiler 完整导入与音视频输入作为 future。

- [x] 36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入 — `SCAFFOLD/FUTURE`
  - 代码证据：`startupAnrMethodGraph.ts`、`startupAnrMethodGraph.test.ts` 与 `sparkContracts.ts` 覆盖 startup/anr method graph contract。
  - 关闭结论：method trace graph 基础存在；APM、Macrobenchmark 与 bytecode importer 作为 future。

- [x] 37. OEM、Device Farm 与 Importer SDK — `SCAFFOLD/FUTURE`
  - 代码证据：`oemSdkKnowledgeIngester.ts` 与测试覆盖 OEM SDK RAG；`ragAdminRoutes.ts` 提供 ingestion admin endpoints。
  - 关闭结论：OEM 知识摄取已落地；Device Farm 与第三方 Importer SDK 作为 future。

## Agent 架构与治理

- [x] 40. Workflow-first Agent 边界、Routing 与阶段化编排 — `CODE`
  - 代码证据：`agentv3/claudeRuntime.ts` 覆盖 fast/full/auto、plan gate 与阶段化分析；`queryComplexityClassifier.ts` 负责 query routing；`scenePlanTemplates.ts` 与 MCP 工具链支撑 workflow-first 编排。
  - 关闭结论：主 agent runtime 已按 workflow-first 形态落地。

- [x] 42. Sub-agent 并行 Evidence Collection — `CODE`
  - 代码证据：`claudeAgentDefinitions.ts` 定义 frame/system/startup expert sub-agents；`claudeRuntime.ts` 管理 sub-agent 生命周期与 `enableSubAgents`；`pipelineExecutor.ts` 支持 subagent lifecycle；`sse_event_handlers.ts` 渲染 sub-agent cards。
  - 关闭结论：Sub-agent evidence collection 主链路已存在。

- [x] 43. Verifier、Claim Citation 与 Tool Safety Contract — `CODE`
  - 代码证据：`claudeVerifier.ts` 覆盖 heuristic、plan adherence、hypothesis、scene completeness 与 LLM verification hooks；`claudeVerifier.test.ts` 覆盖 verifier；`dataContract.ts` 与 `sparkContracts.ts` 提供 evidence/artifact/sql 引用结构；`mcpToolRegistry.ts` 与 `claudeMcpServer.ts` 提供工具安全边界。
  - 关闭结论：Verifier、citation substrate 与 tool safety contract 已具备。

- [x] 45. Context Checkpoint、Precompact Guardrail 与 Model Router — `CODE/FUTURE`
  - 代码证据：`contextTokenMeter.ts` 提供 precompact threshold 评估；`claudeRuntime.ts` 已接入 context pressure monitor；`modelRouter.ts` 与相关测试提供模型路由基础；`claudeConfig.ts` 读取 provider/model/effort/router 配置。
  - 关闭结论：guardrail monitor 与 model router 已落地；主动 precompact interrupt/resume 作为 future。

## 产品化闭环

- [x] 51. Diff、CI Gate、IM/Bug 系统与 SLO Linter — `CODE/FUTURE`
  - 代码证据：`ciGateContracts.ts` 定义 `CiGateRunRecord`；`ciGateRoutes.ts` 提供 CI gate evaluation/list/detail API；`ciGateRunStore.ts` 持久化 gate runs；`baselineDiffer.ts` 提供 `evaluateRegressionGate`；`ciGateRoutes.test.ts` 与 `ciGateRunStore.test.ts` 覆盖主路径。
  - 关闭结论：Diff/CI Gate 主链路已落地；IM/Bug adapter、SLO linter、ktlint/detekt 生成作为 future。

- [x] 52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace — `FUTURE/UNSUPPORTED`
  - 代码证据：现有 baseline、case graph、RAG admin、scene report/cache 能支撑后续长期监控基础，但没有 Sentinel SaaS/Marketplace 产品实现。
  - 关闭结论：明确作为远景/产品化 future 关闭。

- [x] 53. Trace-driven PR Review、Bisect 与改前预测 — `FUTURE/UNSUPPORTED`
  - 代码证据：现有 self-improvement review worker/outbox、CI Gate、baseline/case graph 可作为基础能力，但没有 PR review/bisect 产品服务。
  - 关闭结论：明确作为 future 关闭，不作为本轮施工项。

- [x] 56. FixAgent、自动复现与 Live/线上反向补抓 — `FUTURE/UNSUPPORTED`
  - 代码证据：当前没有独立 FixAgent 服务或高风险自动复现/线上反向补抓闭环。
  - 关闭结论：该方向风险高、依赖外部系统，作为 future/unsupported 关闭。

- [x] 57. 小模型数据、AR/VR 与 Performance OS 远景 — `FUTURE/UNSUPPORTED`
  - 代码证据：旧 `TODO.md` 已标注 `VISION-ONLY`；当前 repo 不包含 AR/VR 或 Performance OS 产品实现。
  - 关闭结论：保持 vision-only，作为 future 关闭。
