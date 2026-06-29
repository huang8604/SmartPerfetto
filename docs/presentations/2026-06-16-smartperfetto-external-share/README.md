# SmartPerfetto External Share Deck

这套材料面向 2026-06-16 的线上技术交流。内容覆盖 SmartPerfetto 的背景、建设思路、当前架构、Strategy / Skill 体系、LLM 工程、可解决场景、工程困难和后续计划。

## 可直接使用的文件

- 可直接打开的 PPTX：`output/smartperfetto-external-share.pptx`
- PDF 预览：`output/smartperfetto-external-share-preview.pdf`
- 图片压缩包：`output/smartperfetto-external-share-slides-1920x1080.zip`
- 逐页详细讲稿：`talk-track.md`
- LLM / Claude Agent SDK 讨论备忘：`llm-agent-discussion-notes.md`
- Skill 设计澄清：`skill-design-rationale.md`
- Strategy + Skill 分工：`strategy-skill-relationship.md`
- 当前 Skill / Strategy 清单：`skill-strategy-inventory.md`

## 使用方式

可以直接打开 `output/smartperfetto-external-share.pptx`。如果需要放进自己的模板，在 PowerPoint、Keynote 或飞书文档中创建 16:9 演示文稿，解压 `output/smartperfetto-external-share-slides-1920x1080.zip`，按文件名顺序插入 PNG。每张图片已经标准化为 1920 x 1080。

## 页码

| 页 | 图片 | 主题 |
|---|---|---|
| 1 | `00-00-cover.png` | 开场和交流框架 |
| 2 | `01-01-self-intro.png` | 自我介绍 |
| 3 | `02-02-background.png` | 为什么需要 SmartPerfetto |
| 4 | `03-03-build-idea.png` | 建设思路 |
| 5 | `04-04-frontend-backend-architecture.png` | 前后端架构 |
| 6 | `05-05-strategy-inventory.png` | 当前 Strategy 清单 |
| 7 | `06-06-skill-inventory.png` | 当前 Skill 能力库 |
| 8 | `07-07-architecture.png` | 当前架构 |
| 9 | `08-08-analysis-flow.png` | 一次分析的过程 |
| 10 | `09-09-scenarios.png` | 覆盖场景 |
| 11 | `10-10-design-decisions.png` | 架构取舍 |
| 12 | `11-11-hard-problems.png` | 工程困难 |
| 13 | `12-12-roadmap-discussion.png` | 后续计划和讨论问题 |

## 讲稿说明

`talk-track.md` 已按 13 页补成可直接口播的详细版本，每页包含本页目的、完整讲法和本页小结。LLM、Claude Agent SDK、Codex、Claude Code、Openclaw、上下文管理、成本控制和模型选择的追问材料集中在 `llm-agent-discussion-notes.md`。

Skill 设计相关追问可用 `skill-design-rationale.md` 回答。它解释了 SmartPerfetto 选择面向 Perfetto trace 的 `.skill.yaml` DSL 的原因，并用 `scrolling_analysis` / `jank_frame_detail` 举例说明。

如果对方追问 Strategy 和 Skill 的边界，用 `strategy-skill-relationship.md`。它把 Strategy 的场景分析契约、plan gate、phase hints、final report contract 与 Skill 的数据执行、DataEnvelope、artifact 分开讲，并用滑动分析串起完整过程。

如果现场需要展示“现在已经有多少能力”，用第 6、7 页加 `skill-strategy-inventory.md`。PPT 页负责总览，清单文档保留完整文件名。

## 生成说明

最终目录只保留结果文档和 `output/` 产物。图片没有使用本地 HTML 或浏览器渲染；自我介绍页、前后端架构页、Strategy 清单页和 Skill 清单页均使用当前会话可用的 GPT image / raster image generation 工具生成，并按 16:9 标准化后写入 PPTX、PDF 和 PNG 包。

## 验收建议

- 线上分享前用投屏比例打开一次，确认会议软件缩放下文字仍可读。
- 对外讲述以 `talk-track.md` 为准；图片页只承担视觉摘要。
- 如果需要继续替换单页，优先更新对应讲稿和清单文档，再重新导出 PPTX / PDF / PNG。
