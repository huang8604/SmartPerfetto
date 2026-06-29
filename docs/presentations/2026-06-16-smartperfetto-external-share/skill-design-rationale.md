# SmartPerfetto 为什么自定义 Skill

这篇说明用于外部技术交流。对方大概率会问：既然现在不少 Agent 平台都有“标准 Skill”，SmartPerfetto 为什么还要定义自己的 `.skill.yaml`？这个选择关注的是 SmartPerfetto 对 trace 数据执行契约的要求，文件格式只是表面差异。

一句话结论：通用 Agent Skill 更适合告诉模型“怎么思考和行动”；SmartPerfetto YAML Skill 用来告诉系统“如何稳定执行 trace 分析、如何产出结构化证据、如何进入 UI 和报告”。

Strategy 与 Skill 的完整分工见 `strategy-skill-relationship.md`。这篇只回答为什么 SmartPerfetto 自定义 `.skill.yaml`。

当前仓库里已经有 231 个 `.skill.yaml`。其中 atomic 136 个、composite 38 个、pipelines 32 个、modules 18 个、deep 2 个、comparison 1 个，另有 4 个 template。完整清单见 `skill-strategy-inventory.md`，PPT 第 7 页只展示代表能力。

## 1. 这里说的标准 Skill 指什么

这里的“标准 Skill”主要指 Claude Code / Agent 生态里常见的 Skill 形态：一个 `SKILL.md` 文件，带 YAML frontmatter 和 Markdown 说明，可以附脚本、模板或资源。它的主要作用是把某类任务的操作经验写成模型可读的说明，让模型在合适时机按这些说明完成任务。

这种 Skill 很适合这些任务：

- 教模型遵循某种工作流程，例如“写发布说明”“做代码审查”“生成某类文档”。
- 给模型提供可复用的背景知识、命令、模板和注意事项。
- 在不同仓库、不同任务里复用一套行为规范。
- 让模型按自然语言步骤组合已有工具。

它解决的是模型行为问题。

SmartPerfetto 的问题更靠近数据执行。一次滑动分析可能要查十几到几十段 Perfetto SQL，要判断 trace 是否有 FrameTimeline、刷新率来自哪里、掉帧是否可感知、Buffer Stuffing 是否只是管线背压、输入事件是否能关联到帧、某个帧是否被 Binder、锁、GC、IO、调度或 GPU 影响。这里不能只靠一份 Markdown 指令让模型临场组织。

## 2. SmartPerfetto Skill 的设计出发点

SmartPerfetto Skill 是一个面向 Perfetto trace 的 YAML DSL。它的目标是把性能分析专家的固定分析步骤写成可执行管线，让 agent runtime 只决定“调用哪个 Skill”，具体查询、条件判断、结果组织由 SkillExecutor 完成。

这个设计服务于六个要求。

可复现：同一个 trace、同一组参数、同一版 Skill，应该得到同样的 SQL 结果。模型可以解释结果，但不应该负责现场重写整套统计逻辑。

可验证：输出必须能进入 DataEnvelope、artifact、HTML report、CLI artifact 和 snapshot。后续 claim verification、identity resolution 和结果对比都需要结构化来源。

可展示：前端要自动渲染概览、列表、详情、诊断和时间线跳转。YAML 里的 `display.columns`、`layer`、`severity`、`clickAction` 直接决定 UI 和报告怎么展示。

可扩展：高频分析步骤应该用 atomic Skill、composite Skill、fragment、iterator、parallel 复用。新增 Skill 不应该要求每次改前端或 runtime。

可控成本：SQL 和 Skill 的大结果通过 summary、synthesize 和 artifact 压缩给模型，完整数据保留在系统产物里。模型上下文只拿必要摘要和 artifact id。

跨 runtime：Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core 和 OpenCode 都能通过 `invoke_skill` 这一类工具调用同一套 Skill。Skill 的执行语义不依赖某一个模型厂商。

## 3. 两种 Skill 的差异

| 维度 | 通用 Agent Skill | SmartPerfetto YAML Skill |
|---|---|---|
| 主要层级 | prompt / 行为说明 | trace 数据执行契约 |
| 常见文件 | `SKILL.md` | `.skill.yaml` |
| 执行者 | 模型读取说明后行动 | `SkillExecutor` 执行 SQL、条件和子 Skill |
| 计算方式 | 模型选择工具并组织步骤 | YAML 声明步骤，系统确定性执行 |
| 输入 | 自然语言上下文为主 | typed inputs，例如 `package`、`start_ts`、`end_ts` |
| trace 能力 | 依赖模型临场写 SQL | 支持 prerequisites、Perfetto modules、SQL fragments |
| 多步任务 | 由模型维护中间状态 | `save_as`、`condition`、`skill_ref`、`iterator`、`parallel` |
| 大结果 | 容易进入模型上下文 | artifact 引用、分页读取、summary 返回 |
| UI 输出 | 需要模型组织文本 | DataEnvelope + display 配置自动渲染 |
| 校验 | 多依赖模型自检 | 可进入验证、报告、snapshot 和对比 |
| runtime 绑定 | 依赖平台语义 | 通过 MCP / function tool 对多 runtime 暴露 |

这个表可以当现场回答的主材料。标准 Skill 的工作层级不同。SmartPerfetto 已经用 Strategy 表达“滑动分析应该怎么想”，YAML Skill 负责把“滑动分析该查哪些表、怎么判断、怎么展示、怎么保存证据”变成系统能执行的契约。

现场如果想展示规模，可以补一句：现在不是只有一个 `scrolling_analysis` 示例，而是已经按 atomic、composite、pipelines、modules、deep 分层建了 231 个 YAML Skill。这个数量本身不是目标，它说明很多可复用取证路径已经从临场 SQL 变成了可执行契约。

## 4. 如果滑动分析只用标准 Skill，会遇到什么

假设把滑动分析写成一个 `SKILL.md`，大概会包含这些说明：先判断 FrameTimeline 是否存在，再估算 VSync 周期，接着查实际帧、识别掉帧、区分 App 和 SurfaceFlinger，再看 Binder、锁、GC、IO、调度、GPU 等证据。

这份说明对模型有帮助，但运行时仍有几个问题。

模型每次都要重新写 SQL。滑动分析里的 SQL 很长，涉及 `actual_frame_timeline_slice`、`expected_frame_timeline_slice`、`counter`、`counter_track`、`process`、`slice`、`thread_state` 等表，还要处理刷新率、时间窗口、包名过滤、Buffer Stuffing 和空数据。让模型每次现场重写，失败率和 token 成本都会变高。

中间结果容易散掉。VSync 周期、总帧数、感知掉帧、输入事件、滑动区间、掉帧帧列表、批量根因分类都要在后续步骤复用。标准 Skill 主要给模型说明，不会天然提供 `save_as`、条件执行、artifact 和 DataEnvelope。

前端无法直接渲染。性能分析结果不是一段文字就够。用户需要概览指标、掉帧列表、滑动区间、可点击时间戳、详情表、诊断等级和 report 证据索引。Markdown Skill 无法直接声明这些 UI 字段。

证据难以统一进入报告。SmartPerfetto 的最终报告、CLI artifact、snapshot 和 claim verification 依赖 DataEnvelope 和 artifact。标准 Skill 可以让模型写得更像专家，但不能自动提供这些结构化证据面。

多模型路径会变得不稳定。Claude、OpenAI、Pi、OpenCode 的工具调用和上下文语义都不一样。如果分析逻辑主要写在某一种平台 Skill 里，跨 runtime 的一致性会变差。

## 5. 滑动分析例子：`scrolling_analysis`

`scrolling_analysis` 是一个 composite Skill，文件在 `backend/skills/composite/scrolling_analysis.skill.yaml`。它以可执行分析管线存在，不停留在“教模型怎么分析滑动”的文字说明。

它的输入包括：

- `package`：应用包名，可选；系统会通过 identity policy 做进程身份检查和参数重写。
- `start_ts` / `end_ts`：用户选区或分析窗口，单位是纳秒。
- `enable_frame_details`：是否启用更深入的逐帧分析。
- `max_frames_per_session`：控制每个滑动区间最多处理多少个掉帧帧。
- `enable_expert_probes`：是否启用专家探针，例如帧稳定性方差。

它声明的 Perfetto stdlib 模块包括 `android.input`、`android.frames.timeline`、`android.binder`、`android.garbage_collection` 和 `android.monitor_contention`。这些模块属于 SQL 执行前需要加载的数据能力，不能只写在 prompt 里。

一次调用大致会经历这些步骤：

1. `frame_timeline_check` 检查 `actual_frame_timeline_slice` 是否存在。没有 FrameTimeline 时走 fallback，不会假装能做完整帧分析。
2. `vsync_config` 通过 `VSYNC-sf` 或 expected frame 数据估算刷新率和 VSync 周期，并吸附到 30 / 60 / 90 / 120 / 144 / 165 Hz 等常见刷新率。
3. `performance_summary` 计算总帧数、感知掉帧、App 侧掉帧、SurfaceFlinger 侧掉帧、Buffer Stuffing、P95 呈现间隔和实际 FPS。
4. `input_data_check` 和 `input_latency_summary` 在 `android.input` 可用时补充输入分发、处理、ACK、端到端延迟和事件堆积证据。
5. `frame_variance_probe` 在掉帧达到阈值时检查帧间稳定性，避免只看单帧最大耗时。
6. `jank_type_stats`、`scroll_sessions`、`session_jank` 把掉帧按类型和滑动区间组织出来。
7. `get_app_jank_frames` 和 `batch_frame_root_cause` 产出掉帧列表、责任归属和根因分类，结果会进入 artifact，模型按需分页读取。
8. `global_context_flags`、`session_quadrant_summary`、`session_cpu_freq`、`session_thread_core_affinity` 提供系统上下文，帮助判断是否有调度、频率或核心分配影响。
9. `root_cause_classification` 在启用逐帧详情时产出更明确的分析结论。

这些步骤的结果按层级进入前端和报告：

- overview：显示配置、滑动性能概览、Input 延迟概览、分析结论。
- list：滑动区间、区间掉帧、掉帧列表。
- deep：单帧详情、线程状态、Binder、CPU、GPU、锁、GC、IO、调度等证据。
- artifact：大表和批量分类结果不直接塞进模型上下文，通过 `fetch_artifact` 读取。

这就是自定义 Skill 的价值：模型只需要调用

```text
invoke_skill("scrolling_analysis", {
  package: "com.example.app",
  start_ts: 123000000000,
  end_ts: 128000000000
})
```

系统内部可以稳定执行几十个查询和条件判断，并把结果变成 UI、报告和后续验证都能使用的结构。

## 6. 继续深入时：`jank_frame_detail`

`scrolling_analysis` 负责从全局滑动窗口里找出区间、掉帧和候选根因。需要解释某一帧时，可以继续调用 `jank_frame_detail`。这个 Skill 以帧开始时间、结束时间、frame id、包名和线程区间为输入，继续检查单帧附近的证据。

它会看这些方向：

- 四象限线程状态：大核运行、小核运行、等待调度、不可中断等待、休眠等待。
- Binder 调用与阻塞：是否有跨进程等待。
- CPU 频率与核心分配：是否频率低、核心迁移异常、调度延迟高。
- 主线程和 RenderThread slice：是否有长任务。
- 锁竞争、GC、IO/page cache、page fault：是否和帧窗口重叠。
- GPU、SurfaceFlinger、VSync 时序和渲染管线：是否有生产端或消费端压力。

如果这些逻辑写在标准 Skill 里，模型要把所有证据方向逐个转成 SQL，再自己合并结果。SmartPerfetto YAML Skill 把这些方向声明成稳定步骤，模型只负责选择代表帧、解释结果和组织报告。

## 7. Strategy 和 YAML Skill 的分工

SmartPerfetto 并没有完全放弃“标准 Skill”擅长的那一层。项目里的 `.strategy.md` 和 `.template.md` 承担了类似职责：告诉模型不同场景应该按什么顺序分析、应该优先调用哪些工具、哪些结论不能轻易下。

分工可以这样讲：

- Strategy / template：告诉模型“这类问题怎么分析”。
- YAML Skill：告诉系统“这类数据怎么执行、怎么展示、怎么保存证据”。
- MCP / function tool：让不同 runtime 都能调用同一套数据能力。
- DataEnvelope / artifact / snapshot：让结果进入 UI、报告、CLI 和验证。

标准 Skill 可以继续用于作者工作流，例如“如何写一个新的 SmartPerfetto Skill”“如何审查某个 Skill 的 SQL”“如何把团队 SOP 转成 Strategy”。但运行时 trace 分析不适合把主要数据逻辑放在标准 Skill 里。

## 8. 这个选择的代价

自定义 Skill 也有代价。

要维护 DSL、validator、SkillExecutor、DataEnvelope、artifact 和前端展示协议。Perfetto stdlib、Android 版本、厂商 trace 差异变化时，Skill 也需要更新。

写一个高质量 Skill 比写一段 prompt 更慢。作者要知道 trace 表结构、SQL 口径、显示字段、空数据行为、identity policy 和报告证据要求。比如 `scrolling_analysis` 这种 S 级 Skill，本身就是一段工程化分析流程。

它也不会覆盖所有开放问题。一次性、低频、探索性问题仍然需要 `execute_sql` 或普通问答。SmartPerfetto 的策略是：高频、可复用、需要报告证据的场景做成 Skill；临时问题保留 SQL 和自然语言探索入口。

这些代价换来的是可复现、可展示、可验证和跨 runtime。对性能分析这种证据要求高的场景，这个交换是值得的。

## 9. 现场问答可以这样回答

问：为什么不用标准 Skill？

答：标准 Skill 主要解决模型行为复用，SmartPerfetto 的 Skill 解决 trace 数据执行。滑动分析需要稳定 SQL、分层结果、artifact、DataEnvelope、前端渲染和报告证据，放在标准 Skill 里会让模型每次临场执行，成本和一致性都不好控制。

问：这是不是重复造一套 Skill？

答：不是重复。两者处在不同层级。标准 Skill 更像 prompt 层经验包，SmartPerfetto YAML Skill 是数据层执行契约。SmartPerfetto 的 Strategy 和 template 已经承担了 prompt 层职责，YAML Skill 补的是确定性执行和结构化输出。

问：能不能把 SmartPerfetto Skill 转成标准 Skill？

答：可以为作者或迁移场景写一个标准 Skill，指导模型如何创建、审查或解释 SmartPerfetto Skill。但运行时分析管线仍应保留在 `.skill.yaml`，因为那里有输入类型、SQL、条件、display、artifact 和 identity policy。

问：模型能不能自动写 Skill？

答：可以辅助生成草稿，但不能跳过验证。新增或修改 Skill 后需要检查 YAML 约束、SQL schema、Perfetto stdlib 模块、DataEnvelope 展示和 trace 回归。模型适合帮忙整理步骤和生成初稿，最终契约仍要由工程验证。

问：什么时候不用 YAML Skill？

答：低频、探索性、没有稳定指标口径的问题可以先走 `execute_sql` 或普通问答。等某个分析步骤反复出现，且需要进入报告、UI 和验证，再把它做成 Skill。

## 10. 对外交流的压缩版

可以用这段话收束：

SmartPerfetto 自定义 Skill 的原因在于性能分析需要确定性数据执行。标准 Skill 适合教模型怎么行动；SmartPerfetto YAML Skill 适合让系统稳定查询 Perfetto、组织多步分析、产出 DataEnvelope、保存 artifact，并让结果进入 UI、报告和验证。以滑动分析为例，一个 `invoke_skill("scrolling_analysis")` 背后包含 FrameTimeline 检测、VSync 估算、掉帧识别、Input 延迟、滑动区间、批量根因分类和 artifact 分页。把这些放进标准 Skill，会让模型每次临场重写查询；放进 YAML Skill，模型只负责选择和解释，事实由系统执行。
