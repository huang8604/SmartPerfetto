# SmartPerfetto 技术交流逐页讲稿

这份讲稿按 13 页 PPT 顺序写，目标是线上交流时可以直接照着讲，也可以按现场时间删减。每页包含本页目的、完整讲法和本页小结。

LLM、Claude Agent SDK、Codex、Claude Code、Openclaw、上下文管理、成本控制和模型选择预计会被追问，完整备忘见 `llm-agent-discussion-notes.md`。Skill 设计和 Strategy / Skill 分工分别见 `skill-design-rationale.md`、`strategy-skill-relationship.md`。

## 1. 开场：这次交流讲什么

### 这一页要讲清楚什么

开场先定边界：SmartPerfetto 不是一个单点脚本，也不是把 trace 丢给大模型让它自由解释。它是一套围绕 Perfetto trace 的 AI 辅助分析系统，重点是背景、架构、场景方法、工程取舍和后续可交流的方向。

### 完整讲法

今天主要介绍 SmartPerfetto。它面向 Android / HarmonyOS 性能分析里的一个具体问题：Perfetto trace 里事实非常多，但从这些事实走到一个可以复查、可以解释、可以交付给工程团队的结论，中间还有大量人工工作。

传统方式通常是工程师打开 Perfetto UI，手动找时间段、看线程、写 SQL、比指标、截图，再把现象整理成分析报告。这个过程非常依赖经验。遇到启动、滑动、ANR、Binder 阻塞、渲染管线或多 trace 对比时，一个问题往往跨多个表、多条线程和多个系统模块，人工来回切换的成本很高。

SmartPerfetto 保留 Perfetto UI、trace_processor_shell 和 Perfetto SQL 的确定性能力，再把 AI 放在一个受工具约束的位置上。模型负责理解问题、规划分析、选择工具、解释证据；系统负责查询、统计、证据保存、报告生成和结果校验。

这次交流可以按三段走。第一段介绍 SmartPerfetto 的背景、建设思路、架构和当前能力。第二段听听你们在做的相关工作，比如 trace 怎么采集、分析流程怎么组织、内部平台或工具遇到哪些问题。第三段一起讨论 LLM 在性能分析里该承担什么角色，如何控制成本和上下文，如何保证结论可信，哪些场景适合共建 Skill、Strategy 或数据契约。

### 本页小结

SmartPerfetto 的主题不是“用 AI 看 trace”这么泛，而是在 Perfetto 的确定性数据能力之上，构建一套可复查的 AI 分析工作流。

## 2. 自我介绍：为什么我会做这件事

### 这一页要讲清楚什么

这一页简单建立交流背景：个人长期在 Android 性能、APM、Perfetto、Systrace 方向工作，经历过不同厂商和团队的性能优化场景，也长期在做工具和内容。这里不用讲太久，但要让对方知道这套系统来自真实性能分析工作流。

### 完整讲法

我叫高建武，也用 Gracker 这个名字写 Android Performance 相关内容。目前在成都 MTK 性能优化团队，主要关注 Android Framework、APM、Perfetto、Systrace 以及系统性能分析工具。

之前的经历包括乐蛙、魅族、OPPO、OnePlus。这些经历有一个共同点：性能问题不是某一类单点 bug，而是跨系统、跨应用、跨设备、跨版本的工程问题。不同公司、不同产品线会有不同工具，但很多问题会反复出现，比如启动慢、滑动卡、ANR、渲染管线异常、Binder 等待、线程调度、内存增长、功耗和回归对比。

作品这块，除了 SmartPerfetto，还有 TraceFix、100Years、Android App Memory Analysis、Perfetto Auto-Pin 等。它们都和一个方向有关：把手工分析经验做成可复用工具，让问题可以被记录、复查、传播，而不是只停留在某个工程师脑子里。

核心 AI 工具这块，日常主要用 Codex、Claude Code 和 Openclaw。Codex 更适合放在代码仓库里做工程修改、审查和资料整理；Claude Code 更适合长上下文、工具调用和交互式 agent 工作流；Openclaw 更偏向把多 agent、审查和自动化流程组合起来。SmartPerfetto 不是简单调用这些工具，但这几个工具影响了它的设计判断：AI 必须有工具边界、产物边界和可复查的上下文。

所以这页可以用一句话收回来：SmartPerfetto 背后的问题不是“怎么让模型更会说”，而是“怎么把多年 trace 分析经验变成工具、契约和可复查的 AI 分析流程”。

### 本页小结

自我介绍不用展开成履历。重点是说明这套系统来自长期 Android 性能分析、工具建设和 AI 工程实践，后面讲的 Skill、Strategy、报告契约和成本控制都是从这些经验里长出来的。

## 3. 背景：为什么需要 SmartPerfetto

### 这一页要讲清楚什么

这一页说明问题来源。Perfetto trace 不缺数据，困难在于数据规模大、关系复杂、人工分析路径长，而性能结论又必须可以复查。这里要把“为什么不能直接把 trace 给模型”讲明白。

### 完整讲法

Perfetto trace 的价值很高，因为它把调度、slice、counter、Binder、SurfaceFlinger、GPU / HWC、内存、频率、电源等信息放在同一个时间轴里。问题是，这些信息不会自动变成结论。一个 trace 可能几十 MB 到几百 MB，里面有大量表、线程、进程、时间戳和事件，工程师需要从中找出和当前问题有关的一小部分。

性能分析又很少是单表问题。比如滑动掉帧，看起来是 UI 线程某一帧耗时超标，但原因可能来自主线程执行过长、RenderThread 阻塞、Binder 等待、CPU 频率不足、后台线程抢占、SurfaceFlinger 或 GPU 合成压力。启动问题也是类似，表面上是首帧慢，背后可能涉及进程创建、bindApplication、ContentProvider、资源加载、主线程任务和渲染准备。

这里有两个矛盾。第一个矛盾是数据很多，但分析问题需要的是少量关键证据。第二个矛盾是大模型擅长理解语义和组织解释，但它不能在没有工具约束的情况下准确计算 trace 指标。如果直接把 trace 文本塞给模型，放不下是一方面，更严重的是模型可能生成看似合理但没有数据来源支撑的数字和归因。

SmartPerfetto 的出发点是避免让模型读取原始 trace，改为让模型围绕 Perfetto SQL、YAML Skill 和结构化证据工作。模型每给出一个关键判断，都应该能回到 SQL、Skill 结果、artifact 或 report 里复查。

### 本页小结

SmartPerfetto 面对的问题不是缺数据。从数据走到可复查结论，才是最耗时间的部分。AI 的价值在于理解问题和组织分析过程，Perfetto 的价值在于提供可信数据。

## 4. 建设思路：模型只做擅长的部分

### 这一页要讲清楚什么

这一页讲系统分工。模型不直接承担计算和事实生成，确定性服务负责数据访问、统计、Skill 执行和证据保存。这里也要引出 Strategy、Skill、工具 registry、输出契约和 fast / full 模式。

### 完整讲法

SmartPerfetto 的建设思路可以概括成一句话：让模型做它擅长的理解、规划和表达，让确定性系统做它擅长的查询、计算和保存。

trace_processor_shell 负责读取 trace 和执行 Perfetto SQL。YAML Skill 把常见场景的分析步骤做成可复用能力，比如启动、滑动、ANR、内存、CPU、渲染管线和对比。Strategy 文件保存不同场景的分析方法和输出要求，避免把场景知识写死在 TypeScript 里。后端负责 session、provider、runtime、工具注册、报告和 snapshot。

模型处在中间。它拿到用户问题、Perfetto UI 选区、前台 app、架构识别结果和场景 Strategy 后，需要生成分析计划，再调用 SQL、Skill、schema、artifact、knowledge、comparison 或 CodeRef 工具。模型可以决定下一步查什么，但不能绕开工具直接编造数字。工具返回的结果会进入 DataEnvelope、artifact 和证据结构。

这里的重点是受约束的自主性。模型不是脚本引擎，因为它可以根据问题动态选择分析路径；模型也不是自由发挥，因为每一步都受工具、权限、上下文预算和输出格式约束。full 模式更适合完整分析，会启用计划、证据、报告契约和校验；fast 模式更适合轻量问答，工具集合更小，turn budget 更紧，响应速度优先。

LLM 工程上有几个关键判断。提示词不硬编码在业务代码里，而是由 role、输出格式、场景 Strategy、架构上下文、选区上下文、历史分析和对比上下文组合出来。工具也不靠静态列表，而是根据当前请求、模式、权限和上下文动态生成可见集合。后续增加场景时，可以优先改 Skill、Strategy 和 registry，而不是到处改 runtime 代码。

### 本页小结

SmartPerfetto 的设计重点不在“把更多东西塞进 prompt”，而在把性能分析拆成模型、SQL、Skill、artifact、报告和校验几个职责清晰的部分。

## 5. 前后端架构：从 UI 上下文到证据闭环

### 这一页要讲清楚什么

这一页根据当前代码讲前后端边界。重点是说明前端不只是一个聊天框，它负责把 Perfetto UI 里的 trace、选区、会话和 provider 状态组织成请求；后端也不只是一个转发 API，它负责 session、SSE、runtime、MCP 工具、Skill / Strategy、trace_processor 和报告产物的闭环。

### 完整讲法

这页可以从左往右讲。最左边是 Perfetto UI 里的 `com.smartperfetto.AIAssistant` 插件。用户看到的是 AIPanel、Floating Window、Sidebar、Area Selection、Provider Switcher 这些入口，但它们背后最关键的是上下文采集。前端会维护 `backendTraceId`，也就是后端已经接管的 trace；还会采集 `selectionContext`，比如用户在时间线上框选的区域或点击的 slice；必要时会带上 `traceContext`，也就是前端预查询到的局部数据；对比模式下还会带上 `referenceTraceId`。

用户发起分析时，前端通过 workspace API 调 `POST /agent/analyze`。请求里包含用户问题、trace id、analysis mode、session id、选区、对比 trace 和 provider 选择。这里有一个很重要的点：前端不直接调用模型，也不直接执行复杂 SQL。前端负责把 Perfetto 交互状态变成后端可以理解的分析上下文。

后端入口在 Express workspace routes 里，`/api/workspaces/:workspaceId/agent` 会挂到 `agentRoutes.ts`。`POST /analyze` 会先检查 RBAC、tenant mutation policy、trace 是否可访问、reference trace 是否可访问、quota 是否允许，然后调用 `AgentAnalyzeSessionService.prepareSession()`。这一步会决定是新建 session、复用同一个 trace 的多轮会话，还是从持久化状态恢复会话。

session 编排层有几个关键对象。`AgentAnalyzeSessionService` 负责 session 准备、provider snapshot 检查和恢复；`AssistantApplicationService` 负责内存里的 session 与 SSE client 管理；`StreamProjector` 负责把后端事件投影成 SSE；`SessionPersistenceService` 负责跨重启恢复上下文、runtime arrays、focus store、architecture cache 和 run state。每次 run 都有 `runId`、`requestId` 和 `runSequence`，这样前端、日志、SSE replay、报告和 snapshot 可以对齐同一次分析。

前端拿到 `sessionId` 后，会再连 `GET /agent/:sessionId/stream`。这条 SSE 流不是简单长连接。后端会发送 `connected`、`progress`、`data`、`conversation_step`、`analysis_completed`、`snapshot_created`、`error` 和 `end` 等事件；如果前端刷新、弹窗 dock back 或连接中断，`Last-Event-ID` 可以让后端重放持久化事件和 ring buffer 里的遗漏事件。也就是说，用户看到的实时进度不是一次性响应，而是可恢复的事件流。

中间的 runtime 层由 Provider Manager 决定。代码里 `resolveAgentRuntimeSelection()` 的优先级是 provider、snapshot、环境变量，最后默认 `claude-agent-sdk`。当前架构已经抽象出 Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core、OpenCode 四条 runtime 路径。默认讲 Claude Agent SDK 即可，但要强调它不是写死的唯一后端。

Agent Runtime 不直接操作 trace，它通过 SmartPerfetto 自己的 MCP / tool layer 访问能力。常用工具包括 `execute_sql`、`invoke_skill`、`fetch_artifact`、`submit_plan`、`lookup_knowledge`、`compare_skill` 等。`execute_sql` 面向临时 SQL 和验证，`invoke_skill` 面向预构建分析管线，`fetch_artifact` 用于分页读取大结果，`submit_plan` 和 `update_plan_phase` 用于 full 模式计划门禁和阶段追踪。

最右边是知识和数据层。Strategy 从 `backend/strategies/*.strategy.md` 加载，参与场景分类、system prompt、phase hints、plan template、final report contract 和 verifier 规则。Skill 从 `backend/skills/**/*.skill.yaml` 加载，由 `SkillExecutor` 执行。底层事实来自 `trace_processor_shell` 进程池、lease、Perfetto SQL / stdlib 和已上传 trace。高并发或企业模式下，trace_processor lease 会决定这次 agent run 或 report generation 使用共享还是隔离 processor。

最后是输出面。后端不会只返回一段文本。分析过程中的结构化数据进入 `DataEnvelope`，聊天窗口展示的是 chat projection，完整结果会生成 HTML report，关键结论会进入 analysis-result snapshot，对比场景还有 comparison appendix，最终结论还会做 claim verification、identity resolution 和 final report contract 检查。这样用户在前端看到的是可读结果，系统内部保留的是可复查证据。

### 本页小结

前后端分工可以概括为：前端把 Perfetto 交互状态变成分析上下文，后端把上下文编排成可恢复的 agent session；模型通过受控工具访问 SQL、Skill 和知识库，结果再回到 SSE、UI、report 和 snapshot。这个闭环比普通聊天 API 多很多工程边界。

## 6. 当前 Strategy 清单：场景级分析契约

### 这一页要讲清楚什么

这一页是展示当前场景方法的“肌肉页”。要讲清楚 Strategy 的作用、当前数量、覆盖场景，以及为什么它不能被 Skill 取代。

### 完整讲法

当前仓库里有 21 个 Strategy 文件，其中 19 个 normal scene，2 个 contract-only。它们放在 `backend/strategies/*.strategy.md`。这页不只是列数字，重点是说明 SmartPerfetto 已经把很多场景分析方法从“经验口述”转成了场景契约。

Strategy 回答的是几个问题：这个用户问题属于哪个场景；分析计划里必须覆盖哪些证据；分析过程中哪些误判要避开；最终报告必须包含哪些结构。比如 startup、scrolling、scroll_response、touch_tracking、interaction、ANR、teaching 这些更接近用户感知；memory、power、io、media、network、linux、runtime_correctness 更接近系统资源；pipeline、game、overview、general、multi_trace_result_comparison 更接近渲染架构、游戏和通用分析；smart、verifier_misdiagnosis 更偏契约和防误诊。

Strategy 文件里通常会有 `keywords`、`compound_patterns`、`required_capabilities`、`phase_hints`、`plan_template`、`final_report_contract` 和 `verifier_misdiagnosis_patterns`。这些字段会影响场景分类、计划门禁、阶段提醒、最终报告检查和误诊提醒。

为什么它要单独存在？因为同一个场景会调用多个 Skill，同一个 Skill 也可能被多个场景复用。比如滑动分析不只调用 `scrolling_analysis`，还可能继续调用 `jank_frame_detail`、`frame_blocking_calls`、`blocking_chain_analysis`，遇到 WebView、Flutter、TextureView、RN、GL / Game 时还要走架构分支。Skill 能查数据，但“查到什么程度才够”“报告里必须讲哪些口径”需要 Strategy 来判断。

现场如果对方问“这是不是 prompt”，可以这样答：Strategy 会进入提示词，但它不只是普通 prompt。它同时参与场景分类、plan gate、phase hints、final report contract 和 verifier 规则。它是场景级分析契约。

### 本页小结

Strategy 管分析是否充分。它把不同性能场景的分析路线、必检证据、报告结构和误判边界写成文件，让 agent 不会只看一个概览结果就下结论。

## 7. 当前 Skill 能力库：可执行取证单元

### 这一页要讲清楚什么

这一页展示当前可执行能力库。重点不是 231 这个数字本身，而是说明 Skill 是确定性取证管线：它能执行 SQL、组合子 Skill、保存 artifact、产出 DataEnvelope，并进入 UI / report / snapshot。

### 完整讲法

当前仓库扫描到 231 个 `.skill.yaml`。目录上分成 `_template`、`atomic`、`composite`、`pipelines`、`modules`、`deep`、`comparison`。其中 atomic 有 136 个，composite 有 38 个，pipelines 有 32 个，modules 有 18 个，deep 有 2 个，comparison 有 1 个。

这些 Skill 不是给模型看的说明书，而是系统可以执行的 trace 分析契约。一个 Skill 会声明 typed inputs，比如 `package`、`start_ts`、`end_ts`、`frame_id`；声明 Perfetto stdlib 模块和必需表；执行 SQL 或子 Skill；用 condition、iterator、parallel 控制分支；用 display 描述前端和报告怎么展示；用 synthesize 和 artifact 控制大结果。

Composite 场景能力里，比较常见的有 `startup_analysis`、`scrolling_analysis`、`jank_frame_detail`、`anr_analysis`、`binder_analysis`、`memory_analysis`、`cpu_analysis`、`gpu_analysis`、`power_consumption_overview`、`surfaceflinger_analysis`、`webview_drawfunctor_jank_chain`、`flutter_scrolling_analysis`。它们负责把一类场景的固定取证路径稳定下来。

Atomic 探针更像细颗粒度证据，比如 `consumer_jank_detection`、`binder_root_cause`、`frame_overrun_summary`、`android_gpu_work_period_track`、`cpu_time_per_frame`、`process_identity_resolver`、`input_to_frame_latency`、`vrr_detection`、`lmk_kill_attribution`、`wattson_thread_power_attribution`。这些探针可以被 composite Skill 调用，也可以在 agent 需要补证据时单独调用。

Rendering / pipelines 目录用于处理不同渲染架构，比如 `android_view_standard_blast`、`compose_standard`、`flutter_textureview`、`webview_gl_functor`、`rn_new_arch`、`opengl_es`、`vulkan_native`、`game_engine`、`video_overlay_hwc`、`variable_refresh_rate`。这很重要，因为不同渲染架构的 trace 证据路径不同，不能都按标准 View 体系分析。

Modules / deep 则更接近系统能力和深度分析，比如 `scheduler_module`、`binder_module`、`surfaceflinger_module`、`input_module`、`cpu_module`、`gpu_module`、`thermal_module`、`callstack_analysis`、`cpu_profiling`。

### 本页小结

Skill 管证据如何取得。一个 `invoke_skill` 背后可能是几十个 SQL、条件分支、子 Skill、artifact 和 UI 展示配置。模型负责选择和解释，事实由 SkillExecutor 执行。

## 8. 当前架构：Perfetto UI 之上的 AI 分析层

### 这一页要讲清楚什么

这一页讲现在系统怎么搭起来。重点包括前端、后端、runtime 抽象、Provider Manager、MCP 工具、trace_processor_shell、报告产物，以及 Claude Agent SDK 在架构里的位置。

### 完整讲法

当前架构可以从用户入口开始讲。前端是 forked Perfetto UI，里面集成了 SmartPerfetto AI Assistant。用户可以直接打开 trace，在时间线上选区，也可以在聊天窗口里提问。选区、trace id、session id、当前 app、对比 trace 等信息会进入后端分析请求。

后端是 Node.js 24、TypeScript strict 和 Express。核心请求路径是 `POST /api/agent/v1/analyze`，后端会准备 session、trace 上下文、provider scope、runtime 选择和分析模式，然后创建对应的 orchestrator。runtime 目前支持 Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core 和 OpenCode。默认路径是 Claude Agent SDK，但 Provider Manager 或环境变量可以切换。

runtime 选择有明确优先级。请求或 session 里指定的 `providerId` 优先，然后是 Provider Manager 当前 active provider，再是 `SMARTPERFETTO_AGENT_RUNTIME`，没有配置时默认使用 `claude-agent-sdk`。这点对部署很重要，因为线上环境、Docker、个人本地和第三方 provider 往往需要不同凭证来源。Provider Manager active profile 的优先级高于 `.env`，如果要回到环境变量，需要在 UI 设置里停用 active provider。

Claude Agent SDK 在这里提供 agent loop、streaming、resume、MCP server 挂载、allowed tools 和模型执行。SmartPerfetto 会创建一个名为 `smartperfetto` 的 in-process MCP server，把 SQL、Skill、schema、artifact、knowledge、comparison、CodeRef 等工具暴露给 SDK。可用工具由 registry 根据当前请求生成，然后形成 `allowedTools` 传给 SDK。

底层数据仍然来自 trace_processor_shell。系统通过进程池执行 Perfetto SQL，Skill 也是围绕 SQL、统计和特定场景规则组织起来。工具返回以后，结果进入 SSE、chat 投影、HTML report、CLI artifact 和 analysis-result snapshot。用户看到的聊天只是一个展示面，完整证据还会保存在报告和 snapshot 里。

### 本页小结

当前架构把 Perfetto UI、后端 runtime、MCP 工具和 trace_processor_shell 分开。Claude Agent SDK 负责 agent 执行，SmartPerfetto 负责工具边界、数据契约和产物治理。

## 9. 一次分析如何从问题走到报告

### 这一页要讲清楚什么

这一页讲一条完整分析请求经历什么阶段，尤其是上下文如何组装、Claude Agent SDK 如何执行、工具结果如何保存、结论如何进入报告和 snapshot。LLM 上下文管理可以在这里详细讲。

### 完整讲法

一次分析从用户问题开始，但后端不会直接把问题转发给模型。后端会先准备分析上下文，包括 trace id、session id、用户选区、当前前台 app、架构识别结果、分析模式、provider scope、可能的对比 trace，以及之前会话里有用的发现和实体。

接着系统会选择场景。常见场景包括 startup、scrolling、ANR、interaction、memory、rendering pipeline、general 和 multi-trace comparison。不同场景会加载不同 Strategy，只注入当前场景需要的方法说明。这样可以减少无关 prompt，也能让分析流程更稳定。

系统提示词会按层级组合：稳定角色和输出格式、trace 稳定信息、场景方法、用户选区和对话上下文。代码里有约 8000 token 的系统提示词预算，超出预算时会优先丢掉知识库参考、trace 完整度、历史模式、SQL 错误记录、子代理说明和历史计划等可丢弃段落。用户选区和当前问题不会被当成低优先级内容。

如果走 Claude full 模式，后端会调用 Claude Agent SDK 的 `query`，传入 model、maxTurns、systemPrompt、MCP server、allowedTools、effort、cwd、环境变量和可选的 resume id。full 模式会保存 SDK 返回的 `sdkSessionId`，后续同一个 SmartPerfetto session 可以续问；quick 模式不复用 SDK session，因为 quick 的 turn budget 是按单次问题控制的，复用长会话反而容易耗尽预算。

分析过程中，模型会通过 MCP 调用工具。SQL 结果不会无脑塞回上下文。`execute_sql` 支持 summary 模式，系统会返回列统计、样本行和关键分位，而完整数据仍然进入前端和 artifact。大型 Skill 或 SQL 结果会保存到 session-scoped artifact store，模型看到的是压缩摘要和 artifact id，需要时再用 `fetch_artifact` 分页读取。

最终结果也不是模型输出完就结束。runtime 的输出会经过 normalizer，进入 final report contract gate，再做 evidence / claim 相关检查和 identity resolution。chat 里展示的是可读摘要和关键表格，HTML report、CLI artifact 和 analysis-result snapshot 会保留更完整的证据、来源和可复查信息。

### 本页小结

一次分析不是“问题进模型、答案出模型”。中间有上下文准备、场景选择、提示词预算、SDK 执行、工具调用、artifact 压缩、结果规范化、证据校验和报告生成。

## 10. 当前解决哪些场景

### 这一页要讲清楚什么

这一页把能力范围讲清楚，不只罗列名词。每类场景要说明它看什么数据、给什么结果、适合什么问题。也要说明 Web UI、CLI/API 和报告产物可以覆盖不同使用方式。

### 完整讲法

目前 SmartPerfetto 覆盖的场景可以分成几组。

启动性能主要关注冷启动、热启动、bindApplication、Activity 启动、ContentProvider、资源加载和首帧。分析时会看关键阶段耗时、主线程任务、调度等待、Binder 调用和渲染准备。输出上不会只给一个总耗时，还会拆出主要阶段、可疑任务和证据来源。

滑动和 Jank 场景关注帧级别体验。系统会看慢帧分布、P90 / P99、UI 线程、RenderThread、Choreographer、SurfaceFlinger、CPU 频率和调度状态。对用户来说，比较有价值的是从“有几帧慢”走到“哪类帧慢、慢在哪里、是否有系统负载或 Binder 等待共同参与”。

ANR 和交互延迟更关注等待关系。比如主线程是否阻塞在 Binder、锁、IO、输入分发或长任务上，关键线程之间是否存在等待关系。这里单看主线程经常不够，需要把系统线程、服务端进程和调度状态放在一起看。

CPU、内存和功耗类问题更多面向系统资源。CPU 会看线程利用率、频率、调度延迟和竞争；内存会看 RSS、PSS、LMK、GC 和 native 分配线索；功耗会看 power rails、频率和活跃时间。它们适合和启动、滑动或后台行为结合分析。

渲染架构侧覆盖 Standard View、Flutter、Compose、WebView、SurfaceView、TextureView、OpenGL / Vulkan 等类型。不同架构的证据路径不同，比如 Flutter 和传统 View 的线程与 slice 语义不一样，SurfaceView 和 TextureView 对合成路径的影响也不同。SmartPerfetto 会把架构识别结果注入分析上下文，避免拿错误方法分析错误场景。

另外还有对比和自动化能力。raw trace comparison 适合比较两个 trace 的原始指标差异，analysis-result comparison 适合比较两次分析产物。CLI / API 可以用于批处理、回归分析或和内部平台集成，HTML report 则适合分享和归档。

### 本页小结

当前能力不是泛泛的聊天入口。它围绕常见性能场景建立了工具化分析路径。越是有明确数据表、指标定义和场景方法的场景，AI 分析越容易稳定、可复查、可复用。

## 11. 几个影响架构的取舍

### 这一页要讲清楚什么

这一页讲为什么系统长成现在这样。重点是内容文件化、工具 registry、输出分面、多 runtime 抽象、Provider Manager，以及 LLM 成本和模型选择的工程取舍。

### 完整讲法

SmartPerfetto 有几个设计取舍，对架构影响很大。

第一个是分析知识尽量文件化。场景方法放在 `backend/strategies/`，工具化分析放在 `backend/skills/`，提示模板也按用途拆分。性能分析方法会变化，如果把 prompt、场景步骤和工具说明都写进 TypeScript，后续很难维护，也很难让不同团队共建。

第二个是工具注册由 registry 管。一个工具能不能被当前请求看到，取决于 runtime、analysis mode、权限、artifact store、对比上下文、code-aware 设置和 allowlist。比如 fast 模式只暴露轻量工具，full 模式才暴露完整分析工具；没有 codebase permission 时，代码相关工具不能随便出现；对比模式才需要 comparison 工具。

第三个是输出要分面。chat 要短、清楚、适合用户阅读；report 要完整、带证据；CLI artifact 要适合机器读取；snapshot 要适合后续恢复和对比。不能为了让 chat 看起来干净，就把证据来源删掉。展示可以简化，证据不能丢。

第四个是 runtime 抽象。Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core 和 OpenCode 的工具调用、流式事件、resume、cancel、超时语义都不一样。后端需要把这些差异收进 runtime 层，再向上提供相对一致的 analyze 接口、SSE 事件和结果结构。

第五个是 LLM 成本控制不能只靠换便宜模型。系统层有几道控制：fast / full / auto 模式，`CLAUDE_MAX_TURNS` 和 `CLAUDE_QUICK_MAX_TURNS`，单 turn 超时，轻量模型，SQL summary，artifact 摘要，场景 Strategy 按需注入，以及 quick 模式不复用长 SDK 会话。模型层再根据任务选择主模型和轻量模型。

模型选择上，更看重工具调用稳定性、streaming 稳定性、长上下文处理、复杂推理时的纠错能力，以及中文报告表达质量。trace 分析不是普通聊天，模型必须能稳定按工具协议工作，能在多轮工具结果里维持证据关系。轻量模型适合分类、校验、短摘要；主模型适合完整分析和复杂归因。

### 本页小结

这些取舍背后的主线是：让可变的分析知识留在文件和 registry 里，让 runtime 差异留在适配层里，让证据和报告契约留在模型外面。

## 12. 做起来难在哪里

### 这一页要讲清楚什么

这一页诚实讲工程困难。不要只说“模型不稳定”，要拆成数据规模、身份解析、跨子系统归因、上下文预算、runtime 差异、隐私边界、分发一致性、成本与体验之间的冲突。

### 完整讲法

SmartPerfetto 的难点不只在接一个模型 API。更麻烦的是，把一个探索式分析过程做成稳定系统。

第一个难点是数据规模。Perfetto SQL 查出来的结果可能很大，Skill 结果也可能包含很多行、很多 frame 或很多 slice。如果每次都把完整结果放进模型上下文，成本和延迟都会失控，模型也更容易丢重点。所以系统需要 SQL summarizer、artifact store、分页读取和结果压缩，同时还要保证完整数据没有从报告和 snapshot 里丢失。

第二个难点是身份解析。trace 里有 process、thread、pid、tid、upid、utid、slice、frame、symbol、package name、surface name 等多种身份。它们之间不是简单一一对应。尤其是多进程 app、WebView、Flutter、SurfaceView、系统服务和 Binder 服务端参与时，很容易把证据归到错误对象上。所以系统要做前台 app 识别、进程准入、身份重写和最终 identity resolution。

第三个难点是跨子系统归因。一次卡顿可能同时涉及 UI 线程长任务、RenderThread 等待、Binder 调用、CPU 频率、内存压力和 SurfaceFlinger。模型如果只看一个局部，结论容易过早收敛；但如果每个方向都查，又会超时、超预算。这里需要场景 Strategy、Skill 分阶段分析、代表样本选择和工具结果摘要。

第四个难点是上下文管理。系统提示词里有角色、输出格式、架构、前台 app、trace 完整度、知识库、场景方法、子代理说明、选区、对话历史、SQL 错误记录和历史计划。每一项都有价值，但不能无限增长。SmartPerfetto 采用分层提示词和可丢弃段落策略，用户意图、选区和场景方法优先级最高，辅助知识和历史信息在预算紧张时可以丢弃。

第五个难点是 runtime 差异。Claude Agent SDK 有 SDK session resume 和 MCP server 挂载，OpenAI Agents SDK 有 responses 或 chat completions 协议，第三方 provider 对 streaming 和 tool calling 的兼容程度也不一样。比如 Claude-compatible gateway 必须兼容 Anthropic Messages API 和流式语义，如果只是 OpenAI 协议代理，应该切到 OpenAI runtime。

第六个难点是 code-aware 的隐私边界。性能分析有时需要结合源码，但不能把整个仓库塞给模型。SmartPerfetto 的思路是默认只给 CodeRef 元数据，源码摘录通过受控接口按需读取，并且要保留引用边界和证据来源。

第七个难点是分发一致性。这个项目有源码运行、Docker、npm CLI、portable package、预构建前端和 trace_processor prebuilts。AI Assistant 插件 UI 改动后，需要保证 dev mode、`frontend/` 预构建、Docker 用户路径和 portable package 一致。trace_processor 版本、前端构建和 provider 配置也要一起管理。

### 本页小结

难点来自工程系统，而不只是模型能力。SmartPerfetto 要同时管理 trace 数据规模、身份关系、跨系统归因、上下文预算、runtime 差异、隐私边界和分发路径。

## 13. 后续计划和讨论问题

### 这一页要讲清楚什么

这一页把后续计划和交流问题收回来。计划要具体，讨论问题要能引导对方分享他们的背景、思路、困难和合作点。

### 完整讲法

后续计划有几条主线。

一条是结论可信度。继续加强 deterministic claim verifier，让模型报告里的关键数字、时间段、线程、进程和指标尽量机械校验到证据来源。目标不是让模型“看起来严谨”，而是让结论可以被工程师复查，被自动化系统消费。

一条是 code-aware 加固。这里包括 CodeRef、symbol resolution、patch proposal 状态、源码读取边界和隐私策略。性能分析最终经常要回到代码改动，但从 trace 到代码之间有很多不确定性。系统需要清楚地区分 trace 证据支持的问题、可能相关的代码位置和建议修改方向。

一条是 analysis-result comparison。除了比较两个原始 trace，也希望比较两次分析结果，比如同一个场景在两个版本、两个窗口或两台设备上的差异。这里需要 snapshot、标准指标、报告契约和可比性检查。对企业用户来说，这会更接近回归分析和版本门禁。

一条是 runtime 抽象和 provider 体验。不同 provider 的模型能力、协议兼容、流式输出、工具调用、成本和限流都不同。后续会继续处理 provider pinning、resume、cancel、streaming、错误诊断和健康检查，让用户更容易知道当前用了哪个 runtime、哪个模型、哪个凭证来源。

一条是 trace_processor 资源治理。随着并发和文件规模增加，进程池、lease、RSS、超时、缓存、企业隔离和失败恢复都会变得重要。AI 分析看起来在模型层，实际也强依赖底层 trace 查询稳定性。

讨论部分，可以抛几个问题给对方。你们现在的 trace 是怎么采集、保存和脱敏的？哪些场景最常见，启动、滑动、ANR、内存、功耗还是对比回归？现有分析里最耗人力的是找证据、写 SQL、组织报告，还是和业务团队沟通结论？如果接入 LLM，你们最担心准确性、成本、隐私、部署还是内部系统集成？哪些经验可以做成共享的 Skill、Strategy 或指标契约？

关于 LLM，也可以专门邀请他们交流：你们更倾向 Claude-compatible provider 还是 OpenAI-compatible provider？主模型和轻量模型怎么选？长会话怎么截断？工具调用失败怎么恢复？报告里的 claim 是否需要机械校验？这些问题比单纯比较模型分数更接近真实工程使用。

### 本页小结

收尾不要停在 roadmap。更好的收尾是把问题交给双方共同讨论：trace 数据、场景方法、LLM 工程、证据校验和内部集成，哪些部分可以共享经验，哪些部分可以形成可复用的 Skill、Strategy 或数据契约。
