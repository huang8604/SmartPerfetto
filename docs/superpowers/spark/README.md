# SmartPerfetto Spark 施工计划包

> 来源：`docs/spark.md` 的 205 个脑暴点，以及根目录 `todo.md` 的第一次提炼。本文档包把它们拆成可独立施工的计划文件。

## 使用方式

1. 先看 [TODO.md](TODO.md) 确认哪些 plan 已完成、哪些还没做。
   - 2026-05-05 之后，历史未完成项的集中复核与关闭证据见 [TODO-reevaluated-2026-05-05.md](TODO-reevaluated-2026-05-05.md)。
2. 从本 README 选择一个 plan。
3. 打开对应 `plans/*.md`，按其中的 Current Code Grounding 重新调研代码。
4. 只施工该 plan 的 Spark coverage，不顺手扩大范围。
5. 代码改动后按 AGENTS 规则验证，至少跑相关单测；任何代码改动最终需要 `cd backend && npm run test:scene-trace-regression`。
6. 完成后回到 [TODO.md](TODO.md) 把对应 checkbox 改成 `[x]`。

## 代码调研基线

本包生成前已调研以下当前实现，所有 plan 都基于这些事实拆分：

- `backend/src/agentv3/claudeRuntime.ts`: agentv3 fast/full/auto、session resume、sub-agent、verifier、context pressure、artifact store。
- `backend/src/agentv3/claudeMcpServer.ts`: MCP tools、plan gate、hypothesis、uncertainty、stdlib、artifact、comparison、pattern recall。
- `backend/src/services/perfettoStdlibScanner.ts` 与 `backend/src/agentv3/sqlIncludeInjector.ts`: stdlib symbol asset、source scanning、raw SQL auto INCLUDE。
- `backend/src/services/workingTraceProcessor.ts` 与 `backend/src/services/traceProcessorService.ts`: `trace_processor_shell --httpd`、上传、query、processor lifecycle。
- `backend/src/services/skillEngine/*` 与 `backend/skills/**`: atomic/composite/pipeline Skill、display、diagnostic、synthesize。
- `backend/src/types/dataContract.ts`: DataEnvelope、column definition、unit、click action。
- `backend/src/routes/agentRoutes.ts`、`exportRoutes.ts`、`reportRoutes.ts`: agent API、export、report。
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/**`: AI panel、selection tab、timeline notes、overlay tracks、floating/sidebar、comparison state。

## 实施顺序

1. 基础数据底座：01-07。
2. 领域分析与 Skill：10-18。
3. UI、报告与可视化：20-27。
4. 外部数据导入：30-37。
5. Agent 架构与治理：40-45。
6. 产品化闭环：50-57。

## 计划文件清单

| 编号 | 计划文件 | 大类 | Spark 覆盖 |
| --- | --- | --- | --- |
| 01 | [01. Stdlib Catalog 与 Skill 覆盖率治理](plans/01-stdlib-skill-coverage.md) | 基础数据底座 | #1, #21 |
| 02 | [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md) | 基础数据底座 | #2, #22, #102 |
| 03 | [03. SmartPerfetto PerfettoSQL Package](plans/03-smartperfetto-sql-package.md) | 基础数据底座 | #3, #36 |
| 04 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) | 基础数据底座 | #24, #25, #26, #28 |
| 05 | [05. Timeline Binning 与 Counter RLE 压缩](plans/05-timeline-binning-rle.md) | 基础数据底座 | #23, #27 |
| 06 | [06. 脱敏映射与大 Trace Streaming Path](plans/06-anonymization-large-trace.md) | 基础数据底座 | #29, #30 |
| 07 | [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md) | 基础数据底座 | #53, #197, #201 |
| 10 | [10. Jank Decision Tree 与 FrameTimeline Ground Truth](plans/10-jank-decision-tree.md) | 领域分析与 Skill | #16, #31 |
| 11 | [11. Thread State 与 Scheduler Context 先验](plans/11-thread-sched-context.md) | 领域分析与 Skill | #6, #17 |
| 12 | [12. Binder Victim to Server Root-cause Chain](plans/12-binder-root-cause-chain.md) | 领域分析与 Skill | #7 |
| 13 | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) | 领域分析与 Skill | #8, #9, #10, #35 |
| 14 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) | 领域分析与 Skill | #11, #12, #13, #34, #51, #70, #109, #112 |
| 15 | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) | 领域分析与 Skill | #15, #18, #20, #56 |
| 16 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) | 领域分析与 Skill | #14, #19, #46, #65, #66, #106, #107 |
| 17 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) | 领域分析与 Skill | #32, #33, #49, #68, #69, #72, #78, #132 |
| 18 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) | 领域分析与 Skill | #61, #63, #67, #76, #87, #99 |
| 20 | [20. Vega/Vega-lite 可视化 Artifact](plans/20-vega-visual-artifacts.md) | UI、报告与可视化 | #4, #129 |
| 21 | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) | UI、报告与可视化 | #5, #37, #39, #41 |
| 22 | [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md) | UI、报告与可视化 | #40, #147, #156 |
| 23 | [23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard](plans/23-workspace-macro-page.md) | UI、报告与可视化 | #38, #138 |
| 24 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) | UI、报告与可视化 | #134, #135, #136, #137, #139, #140, #142, #146, #149, #173 |
| 25 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) | UI、报告与可视化 | #150, #151, #170, #172 |
| 26 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) | UI、报告与可视化 | #148, #164, #165, #166, #167, #168 |
| 27 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) | UI、报告与可视化 | #57, #153, #154, #155, #171, #192, #193, #194 |
| 30 | [30. 外部 Artifact 导入总契约](plans/30-ingest-artifact-contract.md) | 外部数据导入 | #42, #53, #63, #101 |
| 31 | [31. Logcat、Bugreport 与 ANR traces.txt 导入](plans/31-logcat-bugreport-anr.md) | 外部数据导入 | #43, #44, #49 |
| 32 | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) | 外部数据导入 | #45, #46, #47, #48, #108, #115, #116 |
| 33 | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) | 外部数据导入 | #50, #51, #59, #64, #70, #109, #130 |
| 34 | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) | 外部数据导入 | #54, #55, #57, #58, #60, #144, #153, #192 |
| 35 | [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md) | 外部数据导入 | #10, #61, #65, #103, #104, #106, #107, #131 |
| 36 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) | 外部数据导入 | #67, #71, #72, #78, #105, #110, #111, #121 |
| 37 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) | 外部数据导入 | #62, #66, #73, #74, #75, #76, #77, #79, #80, #117, #118, #119, #122, #141, #143 |
| 40 | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) | Agent 架构与治理 | #81, #82, #83, #88, #89, #90 |
| 41 | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) | Agent 架构与治理 | #91, #92, #96, #133, #139, #173 |
| 42 | [42. Sub-agent 并行 Evidence Collection](plans/42-subagents-parallel-evidence.md) | Agent 架构与治理 | #84, #85, #87 |
| 43 | [43. Verifier、Claim Citation 与 Tool Safety Contract](plans/43-verifier-citation-tool-contracts.md) | Agent 架构与治理 | #86, #98, #99 |
| 44 | [44. Project Memory、Hybrid RAG 与 Self-improvement 闭环](plans/44-memory-rag-self-improvement.md) | Agent 架构与治理 | #94, #95 |
| 45 | [45. Context Checkpoint、Precompact Guardrail 与 Model Router](plans/45-context-guardrails-model-router.md) | Agent 架构与治理 | #97, #100 |
| 50 | [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) | 产品化闭环 | #34, #67, #105, #150, #176, #177, #178 |
| 51 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) | 产品化闭环 | #52, #113, #114, #125, #126, #127, #161, #163, #200, #205 |
| 52 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) | 产品化闭环 | #80, #93, #122, #152, #157, #158, #159, #160, #175 |
| 53 | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) | 产品化闭环 | #124, #174, #184, #185, #186 |
| 54 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) | 产品化闭环 | #162, #179, #180, #195, #196, #203 |
| 55 | [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) | 产品化闭环 | #181, #182, #183 |
| 56 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) | 产品化闭环 | #120, #123, #128, #169, #184, #187, #188, #189, #190, #191, #198, #199, #202 |
| 57 | [57. 小模型数据、AR/VR 与 Performance OS 远景](plans/57-long-term-platform.md) | 产品化闭环 | #145, #187, #188, #189, #204 |

## 基础数据底座

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 01 | [01. Stdlib Catalog 与 Skill 覆盖率治理](plans/01-stdlib-skill-coverage.md) | #1, #21 | Stdlib Catalog 与 Skill 覆盖率治理 |
| 02 | [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md) | #2, #22, #102 | Trace Summary v2 与 Baseline Artifact |
| 03 | [03. SmartPerfetto PerfettoSQL Package](plans/03-smartperfetto-sql-package.md) | #3, #36 | SmartPerfetto PerfettoSQL Package |
| 04 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) | #24, #25, #26, #28 | Artifact Schema、分层摘要与压缩契约 |
| 05 | [05. Timeline Binning 与 Counter RLE 压缩](plans/05-timeline-binning-rle.md) | #23, #27 | Timeline Binning 与 Counter RLE 压缩 |
| 06 | [06. 脱敏映射与大 Trace Streaming Path](plans/06-anonymization-large-trace.md) | #29, #30 | 脱敏映射与大 Trace Streaming Path |
| 07 | [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md) | #53, #197, #201 | AI Trace Config Generator 与 Self-description Metadata |

## 领域分析与 Skill

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 10 | [10. Jank Decision Tree 与 FrameTimeline Ground Truth](plans/10-jank-decision-tree.md) | #16, #31 | Jank Decision Tree 与 FrameTimeline Ground Truth |
| 11 | [11. Thread State 与 Scheduler Context 先验](plans/11-thread-sched-context.md) | #6, #17 | Thread State 与 Scheduler Context 先验 |
| 12 | [12. Binder Victim to Server Root-cause Chain](plans/12-binder-root-cause-chain.md) | #7 | Binder Victim to Server Root-cause Chain |
| 13 | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) | #8, #9, #10, #35 | CPU Frequency、Thermal 与 PMU 归因 |
| 14 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) | #11, #12, #13, #34, #51, #70, #109, #112 | Memory、LMK、DMA/DMABUF 根因图谱 |
| 15 | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) | #15, #18, #20, #56 | IO、Network、Wakelock 与 Wakeup 归因 |
| 16 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) | #14, #19, #46, #65, #66, #106, #107 | GPU、SurfaceFlinger 与 Composition 根因 |
| 17 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) | #32, #33, #49, #68, #69, #72, #78, #132 | Startup、ANR 与方法 Trace 图谱 |
| 18 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) | #61, #63, #67, #76, #87, #99 | 领域 Skill 回归与标准答案评测 Harness |

## UI、报告与可视化

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 20 | [20. Vega/Vega-lite 可视化 Artifact](plans/20-vega-visual-artifacts.md) | #4, #129 | Vega/Vega-lite 可视化 Artifact |
| 21 | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) | #5, #37, #39, #41 | AI Debug Tracks、Timeline Notes 与 Sidecar Annotation |
| 22 | [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md) | #40, #147, #156 | Selection Zone Q&A、Pivot 建议与 Top Hypothesis |
| 23 | [23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard](plans/23-workspace-macro-page.md) | #38, #138 | CUJ Workspace、Startup Commands 与 Custom Page Dashboard |
| 24 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) | #134, #135, #136, #137, #139, #140, #142, #146, #149, #173 | AI Panel 多形态、自然语言多轮与 Session Facts |
| 25 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) | #150, #151, #170, #172 | 双 Trace Diff UI 与报告链接 |
| 26 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) | #148, #164, #165, #166, #167, #168 | HTML/PDF/Markdown/Mermaid 报告与性能体检卡 |
| 27 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) | #57, #153, #154, #155, #171, #192, #193, #194 | 多模态 Timeline Replay、Walkthrough 与动画 |

## 外部数据导入

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 30 | [30. 外部 Artifact 导入总契约](plans/30-ingest-artifact-contract.md) | #42, #53, #63, #101 | 外部 Artifact 导入总契约 |
| 31 | [31. Logcat、Bugreport 与 ANR traces.txt 导入](plans/31-logcat-bugreport-anr.md) | #43, #44, #49 | Logcat、Bugreport 与 ANR traces.txt 导入 |
| 32 | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) | #45, #46, #47, #48, #108, #115, #116 | Dumpsys、Batterystats、Meminfo、Gfxinfo 导入 |
| 33 | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) | #50, #51, #59, #64, #70, #109, #130 | Tombstone、HPROF、LeakCanary 与 FlameGraph 导入 |
| 34 | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) | #54, #55, #57, #58, #60, #144, #153, #192 | Screenrecord、Screenshot、UIAutomator 与自然语言对齐 |
| 35 | [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md) | #10, #61, #65, #103, #104, #106, #107, #131 | SimplePerf、AGI、Profiler 与音视频输入 |
| 36 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) | #67, #71, #72, #78, #105, #110, #111, #121 | APM、Macrobenchmark、Method Trace 与 Bytecode 输入 |
| 37 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) | #62, #66, #73, #74, #75, #76, #77, #79, #80, #117, #118, #119, #122, #141, #143 | OEM、Device Farm 与 Importer SDK |

## Agent 架构与治理

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 40 | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) | #81, #82, #83, #88, #89, #90 | Workflow-first Agent 边界、Routing 与阶段化编排 |
| 41 | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) | #91, #92, #96, #133, #139, #173 | 独立 SmartPerfetto MCP Server 与 A2A/Host API |
| 42 | [42. Sub-agent 并行 Evidence Collection](plans/42-subagents-parallel-evidence.md) | #84, #85, #87 | Sub-agent 并行 Evidence Collection |
| 43 | [43. Verifier、Claim Citation 与 Tool Safety Contract](plans/43-verifier-citation-tool-contracts.md) | #86, #98, #99 | Verifier、Claim Citation 与 Tool Safety Contract |
| 44 | [44. Project Memory、Hybrid RAG 与 Self-improvement 闭环](plans/44-memory-rag-self-improvement.md) | #94, #95 | Project Memory、Hybrid RAG 与 Self-improvement 闭环 |
| 45 | [45. Context Checkpoint、Precompact Guardrail 与 Model Router](plans/45-context-guardrails-model-router.md) | #97, #100 | Context Checkpoint、Precompact Guardrail 与 Model Router |

## 产品化闭环

| 编号 | 计划文件 | Spark 覆盖 | 独立施工目标 |
| --- | --- | --- | --- |
| 50 | [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) | #34, #67, #105, #150, #176, #177, #178 | App/Device/Build/CUJ Baseline Store |
| 51 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) | #52, #113, #114, #125, #126, #127, #161, #163, #200, #205 | Diff、CI Gate、IM/Bug 系统与 SLO Linter |
| 52 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) | #80, #93, #122, #152, #157, #158, #159, #160, #175 | Sentinel 长期监控、SaaS/Local-first 与 Marketplace |
| 53 | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) | #124, #174, #184, #185, #186 | Trace-driven PR Review、Bisect 与改前预测 |
| 54 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) | #162, #179, #180, #195, #196, #203 | Case Graph、公共 Case 库与社区实验 |
| 55 | [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) | #181, #182, #183 | androidperformance.com、AOSP 与厂商 SDK RAG |
| 56 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) | #120, #123, #128, #169, #184, #187, #188, #189, #190, #191, #198, #199, #202 | FixAgent、自动复现与 Live/线上反向补抓 |
| 57 | [57. 小模型数据、AR/VR 与 Performance OS 远景](plans/57-long-term-platform.md) | #145, #187, #188, #189, #204 | 小模型数据、AR/VR 与 Performance OS 远景 |

## Spark #1-#205 覆盖矩阵

| Spark 编号 | 提炼后的开发落位 | 主施工计划 |
| --- | --- | --- |
| #1 | F01：stdlib catalog + Skill module 声明覆盖率检查 | [01. Stdlib Catalog 与 Skill 覆盖率治理](plans/01-stdlib-skill-coverage.md) |
| #2 | F01：`trace_summary()` v2 baseline artifact 与 metric spec 管理 | [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md) |
| #3 | F01：SmartPerfetto 自有 PerfettoSQL function/table/view package | [03. SmartPerfetto PerfettoSQL Package](plans/03-smartperfetto-sql-package.md) |
| #4 | F03：Vega-lite artifact、Viz/DataExplorer 嵌入与图表渲染 | [20. Vega/Vega-lite 可视化 Artifact](plans/20-vega-visual-artifacts.md) |
| #5 | F03：AI debug track、pivot 建议、可疑时间段 pin 到 timeline | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) |
| #6 | F02：thread_state / sched.with_context 作为 jank/ANR 先验门禁 | [11. Thread State 与 Scheduler Context 先验](plans/11-thread-sched-context.md) |
| #7 | F02：Binder 受害者到服务端的跨进程根因链 | [12. Binder Victim to Server Root-cause Chain](plans/12-binder-root-cause-chain.md) |
| #8 | F02：CPU frequency residency 与 jank/smooth 对比 | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) |
| #9 | F02：thermal counter 与 cpufreq 降频联合判断 | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) |
| #10 | F02：PMU/simpleperf IPC/cache miss 归因 | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) |
| #11 | F02：process memory、mm_event、rss_stat、anon_rss_and_swap | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #12 | F02：LMK / oom_score_adj / kill_one_process 关联 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #13 | F02：DMA / dmabuf / ion 内存压力分析 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #14 | F02：GPU memory、gpu_slice、render stage 分析 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #15 | F02：block/ext4/f2fs IO 阻塞与文件定位 | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) |
| #16 | F02：FrameTimeline `jank_type` 作为责任归属 ground truth | [10. Jank Decision Tree 与 FrameTimeline Ground Truth](plans/10-jank-decision-tree.md) |
| #17 | F02：critical task / wakeup graph 报告化 | [11. Thread State 与 Scheduler Context 先验](plans/11-thread-sched-context.md) |
| #18 | F02/F06：battery stats、wakelock、cpu_time_per_uid baseline | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) |
| #19 | F02：SurfaceFlinger composition / BufferStuffing / HWC fallback | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #20 | F02/F04：network packets/net ftrace 与等待链关联 | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) |
| #21 | F01/F02：stdlib 新模块 watcher 与 Skill 建议 | [01. Stdlib Catalog 与 Skill 覆盖率治理](plans/01-stdlib-skill-coverage.md) |
| #22 | F01：L0-L3 hierarchical summarization | [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md) |
| #23 | F01：timeline binning token 压缩 | [05. Timeline Binning 与 Counter RLE 压缩](plans/05-timeline-binning-rle.md) |
| #24 | F01/F02：CUJ window strategy 与无关时段裁剪 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) |
| #25 | F01：slice clustering 与代表帧抽样 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) |
| #26 | F01：top-K、P95/P99 tail、随机样本组合 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) |
| #27 | F01：counter RLE / turning-point 压缩 | [05. Timeline Binning 与 Counter RLE 压缩](plans/05-timeline-binning-rle.md) |
| #28 | F01：schema-aware JSON 输出，带单位/量纲/来源 | [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md) |
| #29 | F01：package/process/thread/path 脱敏映射 | [06. 脱敏映射与大 Trace Streaming Path](plans/06-anonymization-large-trace.md) |
| #30 | F01：>1GB trace 的 streaming/chunked summarizer | [06. 脱敏映射与大 Trace Streaming Path](plans/06-anonymization-large-trace.md) |
| #31 | F02：Jank decision tree | [10. Jank Decision Tree 与 FrameTimeline Ground Truth](plans/10-jank-decision-tree.md) |
| #32 | F02：Startup decision tree | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #33 | F02：ANR decision tree | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #34 | F02/F06：Memory leak baseline diff graph | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #35 | F02：Thermal throttling decision tree | [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md) |
| #36 | F01：`--add-sql-package` / `smartperfetto.*` SQL package | [03. SmartPerfetto PerfettoSQL Package](plans/03-smartperfetto-sql-package.md) |
| #37 | F03：自定义 Tracks / Tabs / Pages / DetailsPanels | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) |
| #38 | F03：CUJ workspace、startup commands、macro 组合 | [23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard](plans/23-workspace-macro-page.md) |
| #39 | F03：AI 输出与 Perfetto selection 双向跳转 | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) |
| #40 | F03：Pivot table 自动建议与一键应用 | [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md) |
| #41 | F03：trace annotation / AI sidecar 注释 | [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md) |
| #42 | F04/F06：extension server / additional-directory 分发管道 | [30. 外部 Artifact 导入总契约](plans/30-ingest-artifact-contract.md) |
| #43 | F04：logcat importer、BOOTTIME 对齐、关键 tag 切窗 | [31. Logcat、Bugreport 与 ANR traces.txt 导入](plans/31-logcat-bugreport-anr.md) |
| #44 | F04：bugreport/dumpsys zip ingestor | [31. Logcat、Bugreport 与 ANR traces.txt 导入](plans/31-logcat-bugreport-anr.md) |
| #45 | F04：gfxinfo framestats parser | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #46 | F04：SurfaceFlinger latency parser | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #47 | F04/F06：batterystats checkin parser 与耗电报告 | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #48 | F04：meminfo/procrank/showmap parser | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #49 | F04/F02：ANR traces.txt 与 trace 证据合并 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #50 | F04：tombstone/native crash importer | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) |
| #51 | F04/F02：hprof / LeakCanary retained-size 分析 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #52 | F04/F06：git diff/blame 与性能回归归因 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #53 | F04/F01：业务埋点 protobuf / custom slice 注入规范 | [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md) |
| #54 | F04/F03：自然语言复现描述到 trace window 的对齐器 | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) |
| #55 | F04：语音 ASR 复现描述对齐 | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) |
| #56 | F04/F02：tcpdump/netlog/Charles 网络等待分析 | [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md) |
| #57 | F04/F03：screenrecord + Vision 异常识别 + timeline 对齐 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #58 | F04：截图异常识别 | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) |
| #59 | F04/F03：SVG FlameGraph parser 与报告双栏 | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) |
| #60 | F04：UI screenshot + uiautomator hierarchy importer | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) |
| #61 | F04/F02：SimplePerf importer 与 PMU/采样栈关联 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #62 | F04/F08：ETM/CoreSight P2 importer 插件位 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #63 | F04：atrace/systrace import 路径标准化 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #64 | F04：Android Studio Profiler / heapprofd importer | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) |
| #65 | F04/F02：AGI system profile / GPU counter 接入 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #66 | F04：Mali/Snapdragon/PowerVR vendor profiler 插件位 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #67 | F04/F06：Macrobenchmark/Microbenchmark 多 run baseline | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #68 | F02/F04：Compose tracing recomposition 风暴识别 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #69 | F02/F04：App Startup Library initializer 识别 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #70 | F04/F07：LeakCanary 文本/图输入 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #71 | F04：BlockCanary 卡顿栈输入 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) |
| #72 | F04/F02：Matrix/BTrace/RheaTrace/KOOM 方法 trace 映射 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #73 | F06：Sentry/Bugly/Firebase/Vitals 线上趋势旁证 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #74 | F04/F06：GameBench/PerfDog/Solar CSV/JSON parser | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #75 | F04：KernelShark/ftrace 原生输入 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #76 | F04/F02：bpftrace/eBPF 建议与输出解析 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #77 | F04/F08：Frida/Xposed hook 输出 custom track | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #78 | F04/F02：字节码插桩方法 trace | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #79 | F04/F06：OEM 私有日志 importer framework | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #80 | F04/F06：Device farm trace trigger + report 回填 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #81 | F05：workflow-first，agent 编排 deterministic pipeline | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #82 | F05：Prompt chaining + schema gate | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #83 | F05：classifier 路由到 scene/agent/model tier | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #84 | F05：多领域并行 evidence collection | [42. Sub-agent 并行 Evidence Collection](plans/42-subagents-parallel-evidence.md) |
| #85 | F05：orchestrator-workers 动态分解复杂 trace | [42. Sub-agent 并行 Evidence Collection](plans/42-subagents-parallel-evidence.md) |
| #86 | F05：Evaluator-Optimizer 与 claim citation verifier | [43. Verifier、Claim Citation 与 Tool Safety Contract](plans/43-verifier-citation-tool-contracts.md) |
| #87 | F02/F05：领域专家 sub-agent 拓展 | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #88 | F05：Ingest/Hypothesis/Evidence/Reasoning/Report/Fix 阶段 agent | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #89 | F05/F07：AppDev/OEM/Novice/Expert 角色化输出 | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #90 | F05：Skill vs Sub-agent vs Pipeline 规则文档化 | [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md) |
| #91 | F05：独立 SmartPerfetto MCP Server | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) |
| #92 | F05：A2A AgentCard / remote Agent 协作 | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) |
| #93 | F05/F06：long-running monitor agent | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #94 | F05/F07：session/project/world memory + hybrid RAG | [44. Project Memory、Hybrid RAG 与 Self-improvement 闭环](plans/44-memory-rag-self-improvement.md) |
| #95 | F05/F07：feedback -> case -> Skill draft -> review 入库 | [44. Project Memory、Hybrid RAG 与 Self-improvement 闭环](plans/44-memory-rag-self-improvement.md) |
| #96 | F05：工具 ACI contract、示例和单测 | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) |
| #97 | F05：context checkpoint / precompact 主动恢复 | [45. Context Checkpoint、Precompact Guardrail 与 Model Router](plans/45-context-guardrails-model-router.md) |
| #98 | F05：SQL/tool/importer sandbox 与高风险审批 | [43. Verifier、Claim Citation 与 Tool Safety Contract](plans/43-verifier-citation-tool-contracts.md) |
| #99 | F02/F05：trace + standard answer regression/eval harness | [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md) |
| #100 | F05：model router 与 Skill model tier metadata | [45. Context Checkpoint、Precompact Guardrail 与 Model Router](plans/45-context-guardrails-model-router.md) |
| #101 | F04：Perfetto/atrace/systrace 原生输入支持 | [30. 外部 Artifact 导入总契约](plans/30-ingest-artifact-contract.md) |
| #102 | F01：trace_processor httpd 引擎继续作为核心 | [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md) |
| #103 | F04：`import_simpleperf(path)` 工具 | [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md) |
| #104 | F04：Android Studio Profiler 导入 | [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md) |
| #105 | F06：Macrobenchmark/Microbenchmark CI 集成 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) |
| #106 | F04：AGI 输入 | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #107 | F04：vendor GPU profiler importer | [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md) |
| #108 | F04/F06：Battery Historian/batterystats 输入 | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #109 | F04：LeakCanary 输入 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #110 | F04：BlockCanary/Matrix TraceCanary 输入 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) |
| #111 | F04：BTrace 3.0 Perfetto 互通 | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) |
| #112 | F04：KOOM OOM + heap 输入 | [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md) |
| #113 | F06：Sentry/Bugly/Firebase 双向回写 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #114 | F06：Play Console Vitals baseline | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #115 | F04：adb dumpsys 全家桶 | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #116 | F04：procrank/showmap/proc poll | [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md) |
| #117 | F04：PerfDog/Solar/GameBench parser | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #118 | F04：KernelShark 输入 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #119 | F04：bpftrace/eBPF 主动建议 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #120 | F08：Frida/Xposed 主动 hook 脚本 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #121 | F04：Bytecode plugin 方法 slice | [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md) |
| #122 | F06：Device farm 协同 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #123 | F08：Android Test Orchestrator + UiAutomator 复现 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #124 | F05/F06：GitHub/GitLab/Gerrit PR diff/comment | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) |
| #125 | F06：Jenkins/GitHub Actions/GitLab CI gate | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #126 | F06：Slack/飞书/企业微信/Discord bot | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #127 | F06：Jira/Linear/Lark Bug 自动建单 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #128 | F08：Code model 作为 FixAgent engine | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #129 | F03：Vega/Vega-lite 可视化输出 | [20. Vega/Vega-lite 可视化 Artifact](plans/20-vega-visual-artifacts.md) |
| #130 | F04/F03：FlameGraph/SpeedScope 输入与报告 | [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md) |
| #131 | F04：Lyra/Stagefright 音视频分析输入 | [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md) |
| #132 | F04/F02：ART verifier/dex2oat 启动慢日志 | [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md) |
| #133 | F05：Antigravity/Cursor/Claude Code/Codex CLI host | [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) |
| #134 | F03：底部抽屉 AI 面板 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #135 | F03：Picture-in-Picture 浮窗增强 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #136 | F03：侧边栏 + 全屏切换 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #137 | F03：独立窗口 + BroadcastChannel/postMessage 联动 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #138 | F03：Perfetto custom page 分析 dashboard | [23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard](plans/23-workspace-macro-page.md) |
| #139 | F05/F06：VS Code / IntelliJ 插件 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #140 | F06/F03：CLI/TUI 与 ASCII timeline | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #141 | F04/F06：移动端抓 trace/录屏/报告闭环 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #142 | F03/F06：浏览器扩展注入 ui.perfetto.dev | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #143 | F06：IM bot 上传 trace 异步分析 | [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md) |
| #144 | F04/F03：voice assistant 触发最近 capture | [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md) |
| #145 | F08：AR/VR 性能看板远景 | [57. 小模型数据、AR/VR 与 Performance OS 远景](plans/57-long-term-platform.md) |
| #146 | F03：自然语言对话分析，多轮上下文 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #147 | F03：zone Q&A | [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md) |
| #148 | F03：一键诊断报告 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #149 | F03/F05：持续追问与 session facts | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #150 | F06：双 trace diff 模式 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) |
| #151 | F03/F06：多人协作 trace session P2 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) |
| #152 | F06：持续监控模式 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #153 | F03/F04：录屏 + trace 同步回放 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #154 | F03/F07：walkthrough 导览模式 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #155 | F03/F07：问句模板树 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #156 | F03：选区聚合 top hypothesis | [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md) |
| #157 | F06：SaaS 上传 trace 即报告 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #158 | F06：本地隐私敏感部署 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #159 | F06：local-first + cloud inference hybrid | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #160 | F06：Plugin marketplace | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #161 | F06：企业版 + CI gate | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #162 | F07：教育版 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #163 | F06：订阅 baseline 服务 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #164 | F03：可点击 timestamp HTML 报告 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #165 | F03：PDF 报告 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #166 | F03：Markdown + Mermaid/SVG 因果图 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #167 | F03：AI narration 视频解说 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #168 | F03：性能体检卡 | [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md) |
| #169 | F08：修复 PR 自动生成 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #170 | F03/F06：CSV/JSON 长期分析导出 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) |
| #171 | F03/F04：火焰图 + 文字解说双栏 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #172 | F03/F06：OKR-style 优化收益报告 | [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md) |
| #173 | F06：Performance Copilot IDE 常驻 | [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md) |
| #174 | F06/F05：Trace-driven code review | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) |
| #175 | F06：Sentinel 性能哨兵 | [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md) |
| #176 | F06：App/Device/Build/CUJ baseline 库 | [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) |
| #177 | F06：SoC/OEM ROM 横向矩阵 | [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) |
| #178 | F06：性能基因图谱 | [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) |
| #179 | F07：Case Graph | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #180 | F07：开源公共 case 库 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #181 | F07：androidperformance.com RAG | [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) |
| #182 | F07：AOSP 源码 RAG | [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) |
| #183 | F07：厂商 SDK 文档 RAG | [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) |
| #184 | F08：一键修复 PR | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) |
| #185 | F06/F08：性能回归 bisect | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) |
| #186 | F06/F08：改前预测 | [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md) |
| #187 | F08：trace 摘要小模型数据/评测准备 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #188 | F08：PerfettoSQL 专精模型数据/评测准备 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #189 | F08：跨模态对齐模型数据/评测准备 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #190 | F08：Espresso/UiAutomator 脚本生成 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #191 | F08：fuzz/monkey 复现 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #192 | F03：多模态时间轴叠加 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #193 | F03：因果链动画 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #194 | F03：3D / 多层 timeline P2 | [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md) |
| #195 | F08/F07：游戏化社区运营实验 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #196 | F08/F07：性能擂台 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #197 | F01：AI 生成 Perfetto 抓取配置 | [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md) |
| #198 | F08：live trace streaming 分析 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #199 | F08/F02：跨 App 资源争抢分析 | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #200 | F06：端到端 SLO Linter | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |
| #201 | F01：Trace self-description metadata | [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md) |
| #202 | F06/F08：从线上 stack trace 反向补抓 trace | [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md) |
| #203 | F07：用户反馈训练样本贡献 | [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) |
| #204 | F08：Performance OS / AOSP Copilot 远景 | [57. 小模型数据、AR/VR 与 Performance OS 远景](plans/57-long-term-platform.md) |
| #205 | F08/F06：trace 反模式生成 ktlint/detekt 规则 | [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) |

## 通用施工规则

- 每个 plan 都是单独施工单元。不要一次实现多个 plan，除非它们只共享纯 schema 且提交边界清晰。
- Current Code Grounding 是开始施工前必须重新确认的事实清单。代码已经变化时，先更新 plan 再实现。
- 新增 runtime 能力优先走现有 agentv3、MCP、Skill、DataEnvelope、report/export 和 AIAssistant plugin 入口。
- 外部输入统一走 ingest artifact contract，不直接把 raw 文件塞进 LLM prompt。
- 所有结论类能力都要能引用 evidenceRef、time range、unit、provenance。
- 高风险能力，包括 hook、FixAgent、自动 PR、CI fail、远程 importer，默认只生成候选或报告，必须人工确认后执行。
