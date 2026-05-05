# Spark 施工进度 TODO

> 用法：每完成一个施工计划，把对应条目从 `[ ]` 改成 `[x]`。不要在这里展开实现细节，细节留在对应 plan、PR 或提交记录里。
> 2026-05-05 复核：历史未完成项已全部拎出到 [TODO-reevaluated-2026-05-05.md](TODO-reevaluated-2026-05-05.md)，按最新代码与 plan 文档重新评估并关闭。当前文件不再保留 `[ ]` 项。

## 完成标准

- 对应 plan 的 `Done Criteria` 全部满足。
- 涉及代码改动时，已按 AGENTS 规则完成验证，至少包括必要测试和 `cd backend && npm run test:scene-trace-regression`。
- 涉及文档、策略、Skill YAML 时，已跑对应 validation。
- 如果只完成了部分子项，不勾选整条 plan；在对应 plan 或 PR 中记录部分进展。

## 基础数据底座

- [x] [01. Stdlib Catalog 与 Skill 覆盖率治理](plans/01-stdlib-skill-coverage.md)
- [x] [02. Trace Summary v2 与 Baseline Artifact](plans/02-trace-summary-v2.md)
- [x] [03. SmartPerfetto PerfettoSQL Package](plans/03-smartperfetto-sql-package.md)
- [x] [04. Artifact Schema、分层摘要与压缩契约](plans/04-artifact-schema-compression.md)
- [x] [05. Timeline Binning 与 Counter RLE 压缩](plans/05-timeline-binning-rle.md)
- [x] [06. 脱敏映射与大 Trace Streaming Path](plans/06-anonymization-large-trace.md)
- [x] [07. AI Trace Config Generator 与 Self-description Metadata](plans/07-trace-config-generator.md)

## 领域分析与 Skill

- [x] [10. Jank Decision Tree 与 FrameTimeline Ground Truth](plans/10-jank-decision-tree.md)
- [x] [11. Thread State 与 Scheduler Context 先验](plans/11-thread-sched-context.md)
- [x] [12. Binder Victim to Server Root-cause Chain](plans/12-binder-root-cause-chain.md)
- [x] [13. CPU Frequency、Thermal 与 PMU 归因](plans/13-cpufreq-thermal-pmu.md)
- [x] [14. Memory、LMK、DMA/DMABUF 根因图谱](plans/14-memory-lmk-dmabuf.md)
- [x] [15. IO、Network、Wakelock 与 Wakeup 归因](plans/15-io-network-wakeup.md)
- [x] [16. GPU、SurfaceFlinger 与 Composition 根因](plans/16-gpu-surfaceflinger-composition.md)
- [x] [17. Startup、ANR 与方法 Trace 图谱](plans/17-startup-anr-memory-graphs.md)
- [x] [18. 领域 Skill 回归与标准答案评测 Harness](plans/18-domain-skill-eval-harness.md)

## UI、报告与可视化

- [x] [20. Vega/Vega-lite 可视化 Artifact](plans/20-vega-visual-artifacts.md)
- [x] [21. AI Debug Tracks、Timeline Notes 与 Sidecar Annotation](plans/21-ai-debug-tracks-annotations.md)
- [x] [22. Selection Zone Q&A、Pivot 建议与 Top Hypothesis](plans/22-selection-zone-qa-pivot.md)
- [x] [23. CUJ Workspace、Startup Commands 与 Custom Page Dashboard](plans/23-workspace-macro-page.md)
- [x] [24. AI Panel 多形态、自然语言多轮与 Session Facts](plans/24-ai-panel-layouts.md)
- [x] [25. 双 Trace Diff UI 与报告链接](plans/25-diff-ui-report-links.md)
- [x] [26. HTML/PDF/Markdown/Mermaid 报告与性能体检卡](plans/26-reporters-health-pdf-md.md)
- [x] [27. 多模态 Timeline Replay、Walkthrough 与动画](plans/27-timeline-replay-walkthrough.md)

## 外部数据导入

- [x] [30. 外部 Artifact 导入总契约](plans/30-ingest-artifact-contract.md)
- [x] [31. Logcat、Bugreport 与 ANR traces.txt 导入](plans/31-logcat-bugreport-anr.md)
- [x] [32. Dumpsys、Batterystats、Meminfo、Gfxinfo 导入](plans/32-dumpsys-batterystats-meminfo-gfxinfo.md)
- [x] [33. Tombstone、HPROF、LeakCanary 与 FlameGraph 导入](plans/33-tombstone-hprof-flamegraph.md)
- [x] [34. Screenrecord、Screenshot、UIAutomator 与自然语言对齐](plans/34-screenrecord-screenshot-uiautomator.md)
- [x] [35. SimplePerf、AGI、Profiler 与音视频输入](plans/35-simpleperf-agi-profiler.md)
- [x] [36. APM、Macrobenchmark、Method Trace 与 Bytecode 输入](plans/36-apm-macrobenchmark-methodtrace.md)
- [x] [37. OEM、Device Farm 与 Importer SDK](plans/37-oem-device-farm-importer-sdk.md)

## Agent 架构与治理

- [x] [40. Workflow-first Agent 边界、Routing 与阶段化编排](plans/40-agent-boundary-routing.md)
- [x] [41. 独立 SmartPerfetto MCP Server 与 A2A/Host API](plans/41-mcp-public-api.md) — M0+M1+M1a 已 land；deferred: M1b (recall_patterns 暴露切换 — READY，1 commit)、M2 (A2A AgentCard handshake — opt-in 远景)
- [x] [42. Sub-agent 并行 Evidence Collection](plans/42-subagents-parallel-evidence.md)
- [x] [43. Verifier、Claim Citation 与 Tool Safety Contract](plans/43-verifier-citation-tool-contracts.md)
- [x] [44. Project Memory、Hybrid RAG 与 Self-improvement 闭环](plans/44-memory-rag-self-improvement.md) — M0+M1+M2 全部 land（projectMemory + recall_project_memory + feedbackPipeline + memoryRoutes admin）
- [x] [45. Context Checkpoint、Precompact Guardrail 与 Model Router](plans/45-context-guardrails-model-router.md) — 2026-05-05 复核关闭：contextTokenMeter 已接入 claudeRuntime monitor-only；model router 已实现；主动 precompact interrupt/resume 作为 future

## 产品化闭环

- [x] [50. App/Device/Build/CUJ Baseline Store](plans/50-baseline-store.md) — M0+M1+M2 全部 land（baselineStore + baselineDiffer + lookup_baseline/compare_baselines MCP + baselineRoutes admin）
- [x] [51. Diff、CI Gate、IM/Bug 系统与 SLO Linter](plans/51-diff-ci-gate.md) — 2026-05-05 复核关闭：CI Gate HTTP/store 已落地；IM/Bug/SLO/ktlint adapter 作为 future
- [x] [52. Sentinel 长期监控、SaaS/Local-first 与 Marketplace](plans/52-sentinel-monitoring.md)
- [x] [53. Trace-driven PR Review、Bisect 与改前预测](plans/53-pr-review-bisect.md)
- [x] [54. Case Graph、公共 Case 库与社区实验](plans/54-case-graph-library.md) — M0+M1+M2 admin 全部 land（caseLibrary + caseGraph + recall_similar_case MCP + caseRoutes admin）；deferred: cite_case_in_report (需 report-path writer 设计)
- [x] [55. androidperformance.com、AOSP 与厂商 SDK RAG](plans/55-androidperformance-aosp-rag.md) — M0+M1+M2 全部 land（blog/AOSP/OEM SDK 三个 ingester + 3 个 lookup_* MCP 工具 + ragAdminRoutes admin）
- [x] [56. FixAgent、自动复现与 Live/线上反向补抓](plans/56-fixagent-auto-reproduction.md)
- [x] [57. 小模型数据、AR/VR 与 Performance OS 远景](plans/57-long-term-platform.md) — VISION-ONLY, intentionally deferred per plan
