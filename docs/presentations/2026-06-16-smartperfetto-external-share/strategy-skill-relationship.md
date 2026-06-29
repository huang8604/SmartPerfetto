# Strategy 和 Skill 的分工

这篇说明回答一个现场很容易出现的问题：SmartPerfetto 已经有 `.skill.yaml`，为什么还要有 `.strategy.md`？两者分别解决什么问题？

短答：Strategy 是场景级分析契约，负责告诉 agent 该按什么路径分析、哪些证据不能漏、报告必须包含什么；Skill 是数据执行单元，负责稳定查询 trace、组织结构化结果、生成 DataEnvelope 和 artifact。

当前仓库里有 21 个 Strategy 文件，其中 19 个 normal scene，2 个 contract-only；同时有 231 个 `.skill.yaml`。PPT 第 6 页展示 Strategy 场景版图，第 7 页展示 Skill 能力库，完整文件清单见 `skill-strategy-inventory.md`。

## 1. 两者处在不同层

Strategy 和 Skill 都服务于 trace 分析，但作用层级不同。

| 层级 | 文件 | 回答的问题 | 运行时位置 |
|---|---|---|---|
| Strategy | `backend/strategies/*.strategy.md` | 这个场景该怎么分析，计划里不能漏什么，报告要满足什么结构 | 进入系统提示词、计划门禁、阶段提醒、报告契约和 verifier 规则 |
| Skill | `backend/skills/**/*.skill.yaml` | 具体数据怎么查，步骤怎么执行，结果怎么展示和保存 | 由 `SkillExecutor` 执行，通过 `invoke_skill` 暴露给 runtime |

一个简单判断：Strategy 约束 agent 的分析行为，Skill 约束系统的数据执行。

这也是为什么两页要分开展示。Strategy 展示的是“我们已经把哪些性能场景的方法写成契约”，Skill 展示的是“这些场景背后有哪些可执行取证能力”。前者体现分析方法覆盖面，后者体现工程执行能力。

## 2. Skill 做什么

SmartPerfetto YAML Skill 是可执行的 trace 分析管线。它把 Perfetto SQL、输入参数、前置模块、条件执行、子 Skill、展示配置和 artifact 保存写成系统能执行的契约。

一个 Skill 通常承担这些职责：

- 声明输入参数，例如 `package`、`start_ts`、`end_ts`、`frame_id`。
- 声明 Perfetto stdlib 模块和必需表，例如 `android.frames.timeline`、`android.input`、`android.binder`。
- 执行一组 SQL 或子 Skill，并通过 `save_as` 保存中间结果。
- 用 `condition`、`optional`、`iterator`、`parallel` 控制执行分支。
- 用 `display` 描述前端和报告如何展示列、层级、严重度和点击行为。
- 用 `synthesize` 和 artifact 保存大结果，让模型只拿摘要和引用。
- 产出 DataEnvelope，供 UI、HTML report、CLI artifact、snapshot 和后续校验使用。

Skill 的输出是事实和结构化证据。它不负责决定“这个用户问题是不是滑动场景”“该不该补查 WebView producer”“最终报告必须有哪些章节”。这些判断放在 Strategy。

## 3. Strategy 做什么

Strategy 是场景级分析说明和质量契约。它不执行 SQL，它告诉 agent 在这个场景里如何安排分析、如何选择 Skill、哪些误判要避开、最终回答必须满足哪些要求。

一个 `.strategy.md` 主要包含这些信息：

- `scene`、`priority`、`keywords`、`compound_patterns`：用于场景分类。用户问“滑动卡顿、jank、fps、掉帧”时，系统能把问题归到 scrolling。
- `required_capabilities` / `optional_capabilities`：说明这个场景依赖哪些 trace 能力，哪些能力缺失会影响结论。
- Markdown 正文：进入系统提示词，给 agent 场景分析规则，例如 Android 版本差异、FrameTimeline 口径、架构分支和证据边界。
- `phase_hints`：阶段性提醒。分析进行到某个方向时，系统能提醒 agent 必须调用哪些 Skill、哪些判断不能省。
- `plan_template.mandatory_aspects`：计划门禁。full 模式要求先 `submit_plan`，计划必须覆盖场景要求的分析面。
- `final_report_contract`：最终报告契约。报告必须包含哪些结构，系统会用 contract gate 检查。
- `verifier_misdiagnosis_patterns`：场景相关的已知误诊规则，用于 verifier 提醒或降噪。

Strategy 的输入是用户问题、场景和运行上下文；输出是 agent 行为约束，不是数据表。

## 4. 为什么不能只有 Skill

只有 Skill，系统能查数据，但 agent 仍然缺少场景级判断。

滑动场景里，`scrolling_analysis` 可以给出帧率、掉帧、滑动区间、Input 延迟和批量根因分类。问题是，用户可能问的是“这段滑动为什么卡”“是不是 WebView 造成的”“是不是刷新率变化”“能不能给优化建议”。同一个 Skill 结果在不同问题里需要不同分析路径。

没有 Strategy 时，常见失败会变多：

- agent 只调用一个概览 Skill，看见掉帧率后直接下结论，没有检查代表帧。
- agent 漏掉架构分支，把 Flutter、WebView、TextureView、RN、GL/Game 都按标准 HWUI 分析。
- agent 不知道 Buffer Stuffing、present_ts 间隔、token gap、FrameTimeline prediction error 的口径边界。
- agent 忘记用 artifact 翻页，只看掉帧列表前几十行。
- agent 输出报告时缺少全帧根因分布、代表帧分析或指标口径说明。
- agent 遇到混合渲染时只看 host FrameTimeline，没有补 producer 侧证据。

Skill 能给事实，Strategy 决定“事实够不够、还要查什么、结论怎么讲”。

## 5. 为什么不能只有 Strategy

只有 Strategy，agent 知道该怎么分析，但具体取证会退回到临场写 SQL。

这会带来几个问题：

- SQL 长、易错、重复。滑动分析会涉及 FrameTimeline、VSync、process、thread、slice、thread_state、input、Binder、GC、GPU 等多类数据。
- 成本高。模型每次都要在上下文里维护 SQL、错误修正、中间结果和后续计算。
- 展示差。自然语言或临时 SQL 结果无法稳定进入 DataEnvelope、前端表格、时间线跳转和报告证据索引。
- 回归困难。同一场景每次由模型现场组织，trace regression 很难判断是分析能力变了，还是模型这次走了另一条路径。
- 跨 runtime 不稳。Claude、OpenAI、Pi、OpenCode 的工具调用语义不同，把数据逻辑放在 prompt 层会放大差异。

Strategy 管规则，Skill 管执行。两者分开后，模型可以少写临时 SQL，高频场景可以走经过验证的管线。

## 6. 滑动分析里的分工

以滑动场景为例，`scrolling.strategy.md` 和 `scrolling_analysis.skill.yaml` 的分工很清楚。

### Strategy 负责场景规则

`backend/strategies/scrolling.strategy.md` 会做这些事：

- 通过 `keywords` 和 `compound_patterns` 让“滑动、卡顿、掉帧、jank、fps、WebView、TextureView、RN、GLSurfaceView”等问题进入 scrolling 场景。
- 用 `required_capabilities` 声明帧渲染和 CPU 调度是基础能力，用 `optional_capabilities` 声明 Binder、GPU、thermal、input、lock、功耗等是增强证据。
- 在正文里说明 FrameTimeline、Buffer Stuffing、present_ts、token gap、guilty frame、Chrome/WebView、混合出图等分析口径。
- 用 `phase_hints.overview` 要求调用 `scrolling_analysis` 获取全帧统计，并区分 Buffer Stuffing 和感知掉帧。
- 用 `phase_hints.root_cause_drill` 要求对占比较高的根因选代表帧调用 `jank_frame_detail`、`frame_blocking_calls` 或 `blocking_chain_analysis`。
- 用 `phase_hints.architecture_specific_jank` 要求检测到 Flutter、WebView、TextureView、RN、GL、Compose 等架构时补对应 Skill。
- 用 `final_report_contract` 要求最终报告包含全帧根因分布、代表帧分析、峰值和指标口径。
- 用 `plan_template.mandatory_aspects` 要求计划覆盖帧卡顿分析、根因诊断和架构分支。

Strategy 给的是分析路线、检查项和报告要求。

### Skill 负责数据执行

`backend/skills/composite/scrolling_analysis.skill.yaml` 会做这些事：

- 检查 `actual_frame_timeline_slice` 是否存在。
- 估算刷新率和 VSync 周期。
- 计算总帧数、感知掉帧、App 侧掉帧、SurfaceFlinger 侧掉帧、Buffer Stuffing、P95 呈现间隔和实际 FPS。
- 在 `android.input` 可用时补充输入分发、处理、ACK、端到端延迟和事件堆积。
- 识别滑动区间和区间内掉帧。
- 生成掉帧列表、责任归属和批量根因分类。
- 保存大结果为 artifact，让 agent 用 `fetch_artifact` 分页读取。
- 输出 overview / list / deep 层级的 DataEnvelope，供前端和报告使用。

需要解释单帧时，`jank_frame_detail.skill.yaml` 会继续检查四象限、Binder、CPU 频率、主线程和 RenderThread slice、锁、GC、IO、调度、GPU、SurfaceFlinger、VSync 和渲染管线。

Skill 给的是可复查证据。

## 7. 一次滑动分析怎么经过 Strategy 和 Skill

用户问：“这个 trace 滑动为什么卡？”

系统大致会这样走：

1. 场景分类读取 `.strategy.md` frontmatter，把问题识别为 scrolling。
2. 系统提示词组合 `prompt-methodology.template.md` 和 `scrolling.strategy.md` 正文，agent 看到滑动场景规则。
3. full 模式要求 agent 先 `submit_plan`。`plan_template.mandatory_aspects` 会检查计划是否包含帧分析、根因诊断和架构分支。
4. agent 按 Strategy 调用 `invoke_skill("scrolling_analysis", { process_name, start_ts, end_ts })`。
5. `SkillExecutor` 执行 YAML 管线，返回 DataEnvelope 和 artifact。
6. 如果 Strategy 的 phase hint 命中根因深入要求，agent 选代表帧调用 `jank_frame_detail` 或其他补充 Skill。
7. 如果 detect_architecture 发现 WebView、Flutter、TextureView、RN 或 GL/Game，Strategy 要求补对应 producer 侧 Skill。
8. final report contract 检查最终回答是否包含根因分布、代表帧分析和指标口径。缺失时系统要求修正。

这条路径里，Strategy 没有替代 Skill 执行数据，Skill 也没有替代 Strategy 决定分析是否充分。

## 8. 两者如何一起扩展

新增一个场景时，通常先写 Strategy：

- 定义 scene、keywords、priority 和 effort。
- 写清该场景的分析口径、必检证据、常见误判和报告结构。
- 配置 `plan_template` 和 `final_report_contract`，让 full 模式能检查计划和结果。
- 在已有 Skill 足够时，Strategy 直接引用它们。

当某类查询反复出现、SQL 口径稳定、结果需要进入 UI/报告/回归，就把它做成 Skill：

- 把 SQL、输入参数、条件分支和展示配置写进 `.skill.yaml`。
- 用 `synthesize` 和 artifact 控制模型上下文。
- 用 `validate:skills` 和 trace regression 检查数据契约。
- 在相关 Strategy 的 phase hints 里引用这个 Skill。

这个分工让场景方法和数据执行可以独立演进。修改分析口径，多数时候改 Strategy；修改取数和展示，改 Skill。

## 9. 和通用 Agent Skill 的关系

通用 Agent Skill 更接近 SmartPerfetto 的 Strategy / template 层：它告诉模型怎么做某类任务。SmartPerfetto 没有把场景分析全写成通用 Agent Skill，是因为运行时还需要 plan gate、final report contract、scene classifier、phase hints、verifier patterns 和 trace 数据能力。

可以这样解释：

- 通用 Agent Skill：模型行为包。
- SmartPerfetto Strategy：场景分析契约，进入提示词和质量门禁。
- SmartPerfetto YAML Skill：数据执行契约，进入工具调用和证据产物。

这三者不冲突。通用 Agent Skill 可以用来指导“如何写一个 Strategy”或“如何审查一个 Skill”。运行时 trace 分析仍然需要 Strategy + YAML Skill 这套分工。

## 10. 现场回答模板

问：Strategy 和 Skill 分别是什么？

答：Strategy 是场景级分析契约，告诉 agent 这个场景怎么分析、计划里必须覆盖什么、报告里必须包含什么。Skill 是数据执行单元，告诉系统怎么查 trace、怎么组织结果、怎么生成 DataEnvelope 和 artifact。

问：为什么要有 Strategy？

答：Skill 只能稳定执行一组数据分析，但它不知道当前用户问题需要什么程度的证据，也不知道报告必须包含什么结构。Strategy 把场景方法、必检项、阶段提醒、计划门禁和报告契约放到模型前面，避免 agent 只拿一个 Skill 概览就直接下结论。

问：为什么不把 Strategy 合进 Skill？

答：同一个 Skill 可能被多个场景复用，同一个场景也会调用多个 Skill。把场景方法写进 Skill，会让数据执行和分析行为耦合，修改一个场景规则就可能影响其他调用方。分开后，Strategy 可以指导调用，Skill 保持稳定取证。

问：为什么不把 Skill 合进 Strategy？

答：那会让数据执行回到模型临场写 SQL。滑动分析这类场景 SQL 很长、分支多、展示要求复杂，也需要 artifact、DataEnvelope 和回归检查。Skill 保留为可执行 YAML，系统才能稳定取证。

问：滑动分析怎么讲？

答：`scrolling.strategy.md` 规定滑动场景必须看全帧统计、根因分布、代表帧、架构分支和报告结构；`scrolling_analysis.skill.yaml` 执行 FrameTimeline、VSync、掉帧、Input、滑动区间和批量根因分类；`jank_frame_detail.skill.yaml` 再看单帧的线程状态、Binder、锁、GC、IO、调度、GPU 和 SurfaceFlinger。Strategy 管“查到什么程度才够”，Skill 管“这些证据怎么查出来”。
