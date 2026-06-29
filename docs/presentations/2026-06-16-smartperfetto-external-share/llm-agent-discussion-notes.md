# LLM / Claude Agent SDK 讨论备忘

这份材料配合第 4、5、8、9、11、12 页使用，面向交流现场的追问。重点放在 SmartPerfetto 如何把 LLM 放进性能分析系统里：工具边界、上下文预算、成本控制、模型选择、Codex / Claude Code / Openclaw 的使用方式，以及结果可信度。

## 1. 先讲清楚 SmartPerfetto 对 LLM 的定位

SmartPerfetto 不把 LLM 当成 trace 数据库，也不让模型直接“阅读整个 trace”。trace 的事实来自 trace_processor_shell、Perfetto SQL、YAML Skill 和结构化工具结果。LLM 的职责是理解用户问题、拆分析步骤、选择工具、解释证据和组织报告。

这个定位可以回答很多追问：

- 如果问准确性：关键结论要回到 SQL、Skill、artifact 或 report 证据，不靠模型记忆。
- 如果问成本：模型上下文里只放必要上下文、摘要和 artifact id，完整数据保留在系统产物里。
- 如果问扩展：新增场景优先加 Skill / Strategy / registry，而不是把更多规则塞进模型 prompt。
- 如果问 provider：runtime 可以切换，但工具契约、报告契约和证据保存尽量保持在 runtime 之外。

一句话讲法：LLM 是分析编排者和解释者，Perfetto 与 SmartPerfetto 工具层是事实来源。

## 补充：核心 AI 工具怎么讲

自我介绍页里列了 Codex、Claude Code、Openclaw。这三个工具可以作为“我平时怎么和 AI 协作”的背景，不要讲成 SmartPerfetto 的运行时依赖。

Codex 更适合放在代码仓库里做工程修改、文档整理、review、验证和多文件任务。它的价值是能贴近仓库结构工作，适合把 SmartPerfetto 里的 Strategy、Skill、文档和测试一起维护。

Claude Code 更适合长上下文和交互式 agent 工作流。它对多轮工具调用、上下文续接、代码理解和复杂任务拆解比较自然。SmartPerfetto 默认 runtime 走 Claude Agent SDK，但这和“用 Claude Code 写代码”是两件事：前者是产品运行时，后者是开发工作流。

Openclaw 更适合把多 agent、审查、计划和自动化流程组合起来。它可以作为外部工程协作经验来源，但 SmartPerfetto 不依赖 Openclaw 才能运行。

现场可以这样收束：Codex、Claude Code、Openclaw 影响的是工程工作方式；SmartPerfetto 内部真正固化的是工具契约、Strategy / Skill、artifact、report contract 和 provider runtime 抽象。

## 2. Claude Agent SDK 在系统里怎么用

当前默认 runtime 是 `claude-agent-sdk`。SmartPerfetto 通过 Claude Agent SDK 执行 agent loop，同时挂载自己的 in-process MCP server。这个 MCP server 名为 `smartperfetto`，里面注册了 Perfetto SQL、Skill、schema、artifact、knowledge、comparison、CodeRef 等工具。

分析请求进入后，后端会创建 runtime 上下文，并把这些信息传给 SDK：

- `model`：主模型，默认来自 `CLAUDE_MODEL`。
- `maxTurns`：最大工具/对话轮数，来自 `CLAUDE_MAX_TURNS` 或通用预算配置。
- `systemPrompt`：按角色、输出格式、架构、场景方法、选区和历史上下文组合。
- `mcpServers`：挂载 SmartPerfetto 的 MCP server。
- `allowedTools`：从工具 registry 自动生成，只允许当前请求可见的工具。
- `effort`：按场景或配置决定，复杂问题可以给更高 effort。
- `env`：由 Provider Manager 或环境变量生成的隔离凭证环境。
- `resume`：full 模式有可用 `sdkSessionId` 时才传入。

这里有一个容易被问到的细节：SDK 里的 permission 不是 SmartPerfetto 的主要安全边界。SmartPerfetto 会通过 provider scope、request scope、工具 registry、allowlist 和 code-aware 权限决定工具能不能出现。SDK 层的权限提示在服务端场景里不能作为唯一保护。

full 模式和 quick 模式的处理不同：

- full 模式会保存 Claude SDK 返回的 `sdkSessionId`，同一个 SmartPerfetto session 后续可以续问。
- quick 模式故意不复用 SDK session，因为 quick 的预算是单次问题的延迟保护，复用长会话可能把 turn budget 消耗在历史上下文上。
- quick 模式只注入压缩后的本地对话上下文，适合轻量问答和解释。

Claude runtime 还承载了一些 Claude 路径专有能力，比如 conclusion verification、可选 sub-agent、SDK session resume，以及 Claude-compatible provider 的错误诊断。OpenAI、Pi、OpenCode runtime 会尽量复用同一套工具 registry 和报告契约，但具体 resume、streaming 和工具调用语义不同。

## 3. Provider 和配置怎么讲

对外建议把配置分成两类：UI 配置和环境变量配置。

新用户、Docker 用户、portable package 用户更适合 Provider Manager。它能明确看到 provider 类型、runtime、base URL、主模型、轻量模型和凭证来源。Provider Manager active provider 的优先级高于 `.env`；如果想回到 `.env`，需要在 AI Assistant 设置里停用 active provider。

源码运行、CI、内部部署和自动化更适合环境变量。常见配置如下。

Claude direct：

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=<your-claude-model>
CLAUDE_LIGHT_MODEL=<your-light-claude-model>
```

Anthropic-compatible provider：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-key
CLAUDE_MODEL=<provider-primary-model>
CLAUDE_LIGHT_MODEL=<provider-light-model>
```

OpenAI Agents runtime：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=<your-openai-model>
OPENAI_LIGHT_MODEL=<your-openai-light-model>
```

OpenAI-compatible 或本地服务通常走 `chat_completions`：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=your-model
OPENAI_LIGHT_MODEL=your-small-model
```

配置排查时有几条经验：

- 第一次配置不要同时启用 Anthropic 和 OpenAI 两套变量，避免不知道当前命中哪一路。
- Docker Hub compose 读取仓库根目录 `.env`，本地源码运行默认使用 `backend/.env`。
- Docker 容器不会自动读取宿主机 Claude Code 本地登录状态。
- 健康检查重点看 `runtime`、`providerMode`、`credentialSource`、`providerOverridesEnv` 和模型字段。
- 如果 Claude-compatible gateway 返回 HTTP 200 但 SDK 报 malformed response，通常说明代理只兼容 OpenAI 协议或 SSE 翻译不完整。要么换完整 Anthropic-compatible gateway，要么切到 OpenAI runtime。
- 如果 Claude Agent SDK 原生二进制探测失败，可以用 `CLAUDE_BINARY_PATH` 指向实际安装的 SDK binary。

## 4. 上下文管理怎么讲

trace 分析里，上下文管理比 prompt 文案更关键。SmartPerfetto 主要做了几件事。

系统提示词分层：

- Tier 1：角色、输出语言、输出格式，进程生命周期内基本稳定。
- Tier 2：trace 级稳定信息，比如架构、前台 app、trace 完整度、知识库参考。
- Tier 3：当前场景的方法，比如 startup、scrolling、ANR 或 comparison。
- Tier 4：每次交互变化的信息，比如用户选区、对比上下文、对话摘要、历史计划。

系统提示词有约 8000 token 预算。超出预算时，会按优先级丢弃辅助段落，例如知识库参考、trace 完整度、历史模式、SQL 错误记录、子代理说明和历史计划。用户选区、当前问题和场景方法不作为低优先级内容处理。

场景 Strategy 按需注入。比如非 scrolling 问题不会注入完整 scrolling 方法，这样可以减少无关上下文，也降低模型被无关规则带偏的概率。

工具结果做摘要。`execute_sql` 支持 summary 模式，返回列统计、样本行、分位数和关键字段，而不是把全部行塞进模型上下文。完整结果仍然保存在 DataEnvelope、前端表格、报告或 artifact 里。

大型结果走 artifact。Skill 或 SQL 结果很大时，模型拿到的是摘要和 artifact id。需要更多数据时再调用 `fetch_artifact` 分页读取。这样既能保留完整证据，又能避免一次响应把上下文吃满。

会话续问区别处理。full 模式用 Claude SDK `sdkSessionId` 续会话，适合多轮深入分析；quick 模式只注入压缩后的本地历史，不续 SDK session，适合低延迟问答。

身份上下文独立管理。前台 app、process、thread、slice、frame、symbol 和 CodeRef 都不能只靠模型记忆。系统会把已知实体和身份解析结果作为上下文传入，并在报告阶段做 identity resolution。

## 5. 成本控制怎么讲

成本控制不能只看单价。真实成本来自 prompt 长度、工具结果大小、turn 数、模型选择、失败重试、续会话长度和超时设置。SmartPerfetto 的控制点分几层。

模式层：

- `fast`：轻量问答，工具少，turn budget 紧，适合解释、简单 SQL 和短问题。
- `full`：完整分析，启用计划、完整工具、证据和报告校验，适合要交付结论的场景。
- `auto`：通过规则和轻量分类选择模式，避免所有问题都走 full。

预算层：

- `CLAUDE_MAX_TURNS` 控制 full 模式最大轮数。
- `CLAUDE_QUICK_MAX_TURNS` 控制 quick 模式最大轮数。
- `CLAUDE_FULL_PER_TURN_MS` 和 `CLAUDE_QUICK_PER_TURN_MS` 控制单 turn 时间预算。
- `CLAUDE_VERIFIER_TIMEOUT_MS` 和 `CLAUDE_CLASSIFIER_TIMEOUT_MS` 控制辅助模型调用。
- `CLAUDE_MAX_BUDGET_USD` 可作为 SDK 支持路径下的预算保护。

模型层：

- 主模型用于完整分析、复杂归因、多工具调查和报告生成。
- 轻量模型用于分类、短摘要、校验或单轮辅助任务。
- 如果第三方 provider 只映射一个模型，可以把 `CLAUDE_LIGHT_MODEL` 配成和 `CLAUDE_MODEL` 一样，先保证请求可用。

上下文层：

- 场景 Strategy 只注入当前需要的内容。
- SQL summary 减少工具结果体积。
- artifact 保存完整结果，模型上下文只保留摘要和引用。
- quick 模式不续长会话，避免历史过长拖慢短问答。
- 对话摘要、历史发现和计划会截断到有限条数。

工程层：

- provider health 和错误诊断要清晰，否则失败重试会放大成本。
- 工具返回要结构化，避免模型反复询问同一批信息。
- 报告契约要明确，避免模型生成长篇但不可复查的文本。
- 对高频场景优先做 Skill，而不是每次让模型临时写 SQL。

现场可以这样总结：成本控制更像一组工程约束，需要把“模式、预算、模型、上下文、工具结果、错误恢复”一起管理。

## 6. 模型选择怎么讲

模型选择不要只按排行榜。对 SmartPerfetto 这种工具型分析系统，模型要重点看这些能力：

- 工具调用稳定性：能不能持续按 schema 调工具，少漏参数，少输出无效 JSON。
- 多轮状态保持：能不能记住前几轮工具结果和分析计划。
- 长上下文质量：上下文变长后，能不能抓住用户选区和关键证据。
- 流式输出兼容：provider 的 SSE 和 SDK 协议是否稳定。
- 推理与纠错：SQL 报错、工具空结果、trace 不完整时能不能调整计划。
- 中文技术表达：报告要能清楚解释证据、风险和建议。
- 速度与成本：轻量任务不能全靠昂贵主模型。

主模型适合：

- 完整 performance case 分析。
- 多子系统归因。
- trace comparison。
- 带报告契约和证据检查的输出。
- 需要多轮工具调用的问题。

轻量模型适合：

- 场景分类。
- quick 问答。
- 简短总结。
- 校验辅助。
- 低风险的格式转换。

Claude-compatible 路径适合已经有 Anthropic/Claude、Bedrock、Vertex 或完整 Anthropic-compatible gateway 的团队。它和 Claude Agent SDK 的 MCP、resume 和 agent loop 结合自然。OpenAI-compatible 路径适合已有 OpenAI 网关、本地 Ollama/vLLM 服务，或 provider 只支持 OpenAI chat/completions 协议的团队。

如果 provider 的工具调用不稳定，要优先降级问题复杂度，而不是只换 prompt。比如先减少工具集合，缩短输出要求，把场景变成 Skill，再让模型在更窄范围内选择工具。

## 7. Claude Agent SDK 使用技巧

交流时可以重点讲这些经验。

把工具边界做窄。不要把所有工具永远暴露给模型。工具是否出现应该由场景、权限、模式和上下文决定。这样既省 token，也降低误用概率。

让工具返回结构化结果。模型最怕看到没有字段语义的大段文本。SQL、Skill、artifact、comparison 和 CodeRef 都应该有明确字段，报告阶段才能做证据映射。

把大结果放到 artifact。模型上下文放摘要、引用和少量样本；完整数据进 artifact、report 和 snapshot。需要更多数据再分页读取。

full 和 quick 分开。full 可以复用 SDK session，适合追问；quick 要保持短上下文和单次预算，适合解释和轻量查询。

错误信息要面向操作者。provider 配错、协议不兼容、quota、native binary 缺失和超时都要给可操作提示。否则用户只会看到“模型失败”，很难判断是模型、网关、SDK 还是工具层问题。

不要让模型承担安全边界。SDK permission、system prompt 和模型自律都不是完整安全机制。可靠边界应在服务端 registry、scope、allowlist、源码读取策略和数据脱敏策略里。

## 8. 现场 Q&A：可能被问到的问题

问：为什么用 Claude Agent SDK，不是直接调 Anthropic Messages API？

答：因为这里需要多轮工具调用、MCP server、streaming、resume 和 agent loop。直接调 Messages API 可以做简单问答，但 SmartPerfetto 更像一个工具型 agent。SDK 能减少 agent loop 的自研成本，SmartPerfetto 把工具实现、证据契约和报告契约放在自己这一侧。

问：是不是绑定 Claude？

答：不是。默认 runtime 是 Claude Agent SDK，但系统还有 OpenAI Agents SDK、Pi Agent Core 和 OpenCode 适配。更重要的是，工具 registry、Skill、Strategy、artifact 和 final report contract 都尽量放在 runtime 外面。不同 runtime 的能力有差异，但上层分析流程尽量保持一致。

问：怎么保证模型不编数字？

答：设计上不允许关键数字只来自模型文本。数字应来自 SQL、Skill、DataEnvelope 或 artifact。最终报告还会经过 contract gate、claim verification 和 identity resolution。未来会加强 deterministic verifier，让更多数字 claim 可以机械校验证据单元。

问：上下文太长怎么办？

答：系统提示词有预算和优先级；场景 Strategy 按需注入；SQL 结果支持 summary；大结果走 artifact；quick 模式不续 SDK 长会话；历史发现和计划会截断。目标是让模型看到必要信息，而不是看到全部信息。

问：成本怎么控制？

答：主要靠 fast/full/auto 模式、turn budget、per-turn timeout、轻量模型、SQL summary、artifact、按需工具集合和错误诊断。高频场景要做成 Skill，减少每次让模型临时探索。

问：第三方模型能不能用？

答：能，但要看协议。Anthropic-compatible provider 走 Claude Agent SDK，需要完整兼容 Anthropic Messages API 和流式语义。OpenAI-compatible provider 走 OpenAI Agents runtime，按 responses 或 chat completions 协议配置。工具调用稳定性和 streaming 兼容比模型名更重要。

问：私有源码会不会暴露给模型？

答：code-aware 默认以 CodeRef 元数据为主，不把整个仓库放进上下文。源码摘录需要通过受控接口按需读取，并且保留引用边界。具体是否启用、能读哪些代码，由 codebase permission 和配置控制。

问：为什么 quick 模式不复用 Claude SDK session？

答：quick 的目标是低延迟和可控成本。SDK 续会话会携带长历史，可能让短问题消耗不必要的 turn budget。full 模式才适合复用 `sdkSessionId` 做多轮深入分析。

问：模型选型最关键的指标是什么？

答：工具调用稳定性排在很前面，后面依次看多轮状态保持、长上下文质量、流式协议稳定、复杂问题纠错能力和中文技术表达。trace 分析不是普通聊天，模型必须能稳定使用工具和引用证据。

问：Codex、Claude Code、Openclaw 和 SmartPerfetto 是什么关系？

答：Codex、Claude Code、Openclaw 是日常工程协作工具，帮助写代码、整理文档、审查方案和管理复杂任务。SmartPerfetto 是面向 Perfetto trace 的产品系统。它吸收了这些工具带来的 agent 工程经验，但运行时依赖的是自己的 Provider Manager、runtime adapter、MCP / function tools、Strategy、Skill、artifact 和 report contract。

## 9. 可以邀请对方一起讨论的问题

- 你们现在更常见的是启动、滑动、ANR、内存、功耗、渲染管线，还是版本回归对比？
- 你们 trace 采集是否有统一模板，字段和 buffer 是否能保证跨版本可比？
- 你们是否已有固定 SQL、脚本或 dashboard，可以转换成 Skill？
- 内部最担心 LLM 的哪一项：准确性、成本、隐私、部署、限流、还是模型供应商依赖？
- 是否需要把 report claim 和 evidence 做机械校验，校验粒度到指标、行、列还是时间段？
- 主模型和轻量模型是否愿意分开配置？是否需要 per-workspace 或 per-team provider profile？
- 如果和内部平台集成，更需要 CLI/API、HTML report、snapshot，还是直接嵌入 Perfetto UI？

## 10. 一分钟版本

如果时间很紧，可以这样讲：

SmartPerfetto 把 LLM 放在 Perfetto 分析流程中间，而不是让模型直接读完整 trace。Claude Agent SDK 负责 agent loop、MCP、streaming 和 full 模式续问；SmartPerfetto 负责工具 registry、Perfetto SQL、YAML Skill、artifact、报告契约和证据校验。上下文通过场景 Strategy、提示词预算、SQL summary 和 artifact 控制；成本通过 fast/full/auto、turn budget、轻量模型和错误诊断控制。模型选择时最看重工具调用稳定、长上下文质量、流式兼容和复杂归因能力。最终目标是让 AI 分析结果能被工程师复查，而不是只生成一段流畅解释。
