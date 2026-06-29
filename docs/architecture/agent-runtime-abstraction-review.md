<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Agent Runtime 抽象层 Review（1→4 SDK 重构后）

> 状态：**规划全部完成 + Codex 可交接（不含任何实现）**。按用户要求：Claude 只做规划 + Codex 复审，
> 实现由其他方执行。本文档即交接物。Codex 复审 7 轮（R2 findings / R3–R6 F13 方案 / R7 Option 2 方案），终审"可交接"。
> 交接内容：F12（P0 红测试，§4.5 Phase 0）+ F13（P1-high 取消泄漏，完整 Scope B 规格 §4.5）+ Option 2 架构项
> T1–T15（§4.6，11 个工作流）。工作树仅含本文档；先前对 F12 的修复已回滚以保持"纯规划"。
> 范围：`backend/src/agentRuntime/` 公共层及其与 4 个 runtime 的协作
> 起始日期：2026-06-06
> 评审方式：Claude 结构化评审 → Codex 只读复审（反复）→ 修正 → 记录
> 关联文档：[`agent-runtime.md`](./agent-runtime.md) · 引入提交 `a212ca89 feat: add four-agent runtime contract`

---

## 实现方 Goal Prompt（交接入口，复制到 goal 命令）

```text
目标：实现 SmartPerfetto agent runtime 抽象层 review 的全部整改项——F12（P0 红测试）+ F13（取消特性 Scope B）
+ Option 2 架构项 T1–T15——按既定规格落地、每步回归通过、最终可发 PR。

【唯一真相源】docs/architecture/agent-runtime-abstraction-review.md
动手前**完整读它**：§2 发现、§4 决策表、§4.5 F13 规格(Phase 0/1/2 + 关键签名 + Phase 校正)、
§4.6 Option 2(WS-A…WS-K + 推荐执行顺序 + 验证)。该文档已经 7 轮 Claude+Codex 复审、终审"可交接"。
同时读 .claude/rules/ 下 backend/frontend/prompts/skills/testing/git/product-surface/release 相关规则与根 CLAUDE.md。

【已锁定决策，勿重新讨论】原则：早期阶段一次做对，**不要半成品/休眠/deferred 中间态**。
- T4=瘦身 capabilities(删 inert 字段，不强行驱动行为)  T5=4 runtime 全下沉 agentRuntime/engines/<kind>/(完全对等)
- T6=彻底删除 AnalysisHarness  T13=实现真 opaque 续接(先做 WS-I.0 SDK spike gate；不支持则降级+capabilities 如实声明)
- T15=彻底删除 intervention 两端(含前端面板)；歧义处理归一到 clarify 多轮

【执行顺序，每项独立分支/提交、独立回归】
1) F12(§4.5 Phase 0) 红测试 1 行修复
2) F13(§4.5)：Phase 1(取消语义+abortSession+4 runtime 中止登记+入口接线) → 跑通 6-trace → Phase 2(SQL worker-aware 取消 + SkillExecutor 穿 signal)
3) Option 2(§4.6)按序：WS-A→B→E→G→F→H→D→J→I→K→**WS-C(目录全下沉，最后做的纯机械迁移)**

【工作方式，项目强制】
- 非平凡 WS(F13/T5/T13/T15…)走独立 review gate：Plan → 只读 reviewer 复审 → 修正 → 执行(根 CLAUDE.md "Independent Review Gate")。
- 不在 TS 硬编码 prompt 内容(用 backend/strategies/)、不硬编码 skill 逻辑(用 backend/skills/)、不手编生成文件。
- 每 WS 按 .claude/rules/testing.md：cd backend && npm run typecheck + 受影响单测 + npm run test:scene-trace-regression；
  动 IOrchestrator/snapshot/取消热路径/前端的 WS 另跑相关 Agent SSE e2e；落地前 npm run verify:pr。
- 前端改动(WS-K 删 intervention_panel；WS-C 若涉及前端)：./scripts/start-dev.sh 验证 + ./scripts/update-frontend.sh，
  并遵守 perfetto 子模块**先推 fork、再推根 gitlink**(.claude/rules/git.md)；勿让根 gitlink 指向本地-only 子模块 commit。
- 开 feature 分支，勿在 main 直接堆 commit；commit 粒度对齐 WS/子特性，review fixup fold 回原 commit；保留无关本地改动。

【必避开的高频致命坑(详见文档)】
- /interaction、/focus、recordUserInteraction、getFocusStore 是 **focus tracking(live 功能，保留)**，不是 intervention。
  WS-K 只删 intervention(getInterventionController、/intervene、intervention 事件、intervention_panel.ts、hypothesisExecutor.ts:323 的 intervention_required)。误删 /interaction 会致前端 404。
- 取消语义：cancel marker **绑定当前 runId**；agentEventStore 把任意 error 事件映射为 failed(agentEventStore.ts:130)——
  取消需独立事件/状态并进 TERMINAL_SSE_EVENT_TYPES(sessionSseReplay.ts:15)与持久回放(agentRoutes.ts:709)；
  防 late success 覆盖 cancelled(finalizeAgentDrivenSession)；两处 catch(agentRoutes.ts:3591-3604 / 1672-1684)按 cancel marker 区分，真失败仍 failed。
- runtime 中止登记用 Map<sessionId, Set<handle>> + identity 注销；claude 三个 query 创建点(1094/1810/2362)全覆盖。
- trace_processor SQL 是 Node http.request + worker_threads(**非 fetch**)；Phase 2 需 worker 取消协议 +
  SkillExecutor.execute(skillId,traceId,params,inherited) 把 signal 放进第 4 参 inherited 并加入 SkillExecutionContext，全链路穿 signal。
- T5 全下沉：claudeMcpServer/mcpToolRegistry/claudeSystemPrompt/claudeFindingExtractor/sessionStateSnapshot/
  ArtifactStore/strategyLoader/sceneClassifier 等是**共享件必留**(改名去 claude 前缀)；claudeRuntime/SseBridge/Verifier/AgentDefinitions 可搬入 engines/claude/；claudeConfig/openAiConfig 搬动需 stable re-export。纯文件移动零行为变化、单独提交。

【完成定义】
- F12 + F13(Phase 1+2) + Option 2 全 WS 落地，每 WS commit 自带验证；
- 最终 npm run verify:pr 全绿、6-trace 回归 6/6、取消 e2e 通过、前端无残留调用且 dev 验证过；
- capabilities 声明与真实行为一致；无半成品/死代码/休眠开关遗留；受影响文档(架构 doc、用户面向行为变化的 README/getting-started)同步更新。

【冲突即停】若规格与代码现实冲突，或 SDK 能力不足(如 T13 spike 失败)，**停下并报告**，不要自行降质或留半成品。
```

---

## 0. 背景

SmartPerfetto 的 agent runtime 从 1 个（Claude）扩展到 4 个，并把"公共内容"抽到
`backend/src/agentRuntime/`，4 个具体 runtime 在其下实现：

| Runtime kind | 实现文件 | 位置 |
| --- | --- | --- |
| `claude-agent-sdk` | `claudeRuntime.ts` | `backend/src/agentv3/` |
| `openai-agents-sdk` | `openAiRuntime.ts` | `backend/src/agentOpenAI/` |
| `pi-agent-core` | `piAgentCoreRuntime.ts` | `backend/src/agentRuntime/` |
| `opencode` | `openCodeRuntime.ts` | `backend/src/agentRuntime/` |

公共层文件：`runtimeSelection.ts` · `runtimeRegistry.ts` · `runtimeCapabilities.ts` ·
`runtimeCommon.ts` · `runtimeToolSpec.ts` · `analysisRunSpec.ts` · `analysisHarness.ts` ·
`runtimeHealth.ts` · `envCredentialSources.ts` · `index.ts`。

---

## 1. 总体结论（回答三个问题）

**贯穿全局的主线判断：当前的 "common" 层本质是 "claude + openai 的 common"，
`pi-agent-core` 与 `opencode` 是后来焊在边缘的，并非真正的 4-peer 对等抽象。**

佐证（散落在各处的 "2-runtime DNA"）：
- `runtimeCommon.toProtocolHypothesis(h, source: 'claude' | 'openai')` —— 联合类型只容得下 2 个 runtime。
- `RuntimeContinuationPolicy` 字段名 `claudeVerifierCorrectionLoop` / `openAiPlanContinuation` / `openAiFinalReportContinuation` —— 把 provider 专有概念塞进"通用"结构。
- `snapshotState.storesClaudeSdkSession` / `storesOpenAiResponseState`，而 pi/opencode 共用一个兜底 `storesOpaqueThirdPartyState`。
- `IOrchestrator` 注释仍写 "Shared interface for ClaudeRuntime and OpenAIRuntime"。

| 问题 | 结论 | 一句话 |
| --- | --- | --- |
| Q1 抽取的内容**对不对**？ | **部分对** | 行为承载型抽取（helpers / RunSpec / ToolSpec / Registry / Selection）是对的；但 `EngineCapabilities` 大矩阵是**描述性元数据、不驱动行为**（非强制契约），且 `toProtocolHypothesis` 抽了却没去重。 |
| Q2 **架构**有没有问题？ | **有结构性问题** | 公共目录里塞了 2 个具体 runtime（非对等）；4-kind 列表在约 10 处独立硬编码（单一真相源缺失）；health 用嵌套三元为 4 runtime 特判。 |
| Q3 抽象层与 4 个 SDK 的**协作**有没有问题？ | **有 1 个分层倒置 + 1 个红测试 + 多处运行时不对称** | 通用 selection 依赖具体 runtime（pi）做跨 runtime 选择；**用户 cancel 不触达任一 runtime 的 abort**；**pi/opencode 的 snapshot resume 是"假 opaque 恢复"**；provider pinning 的 hash 覆盖漏掉 pi/opencode 关键配置；capabilities 是描述性而非强制契约；harness 默认开启却近乎空操作。数据形状层面（RunSpec / `'update'` 事件 / ToolSpec）的协作是健康的。 |

---

## 2. 详细发现（均附 file:line 证据）

severity：P0=必须修 / P1=应当修 / P2=可改进。

### Q1 —— 抽取内容是否正确

#### F1 [P1] `EngineCapabilities` 特征矩阵是"描述性元数据"，不驱动行为（非强制契约）
- ⚠️ Round 2 收窄措辞：初稿写"~92% 只写不读"略过激。准确说法是——
  `.classifierPolicy` 与 `.continuationPolicy` **确实**被复制进 `AnalysisRunSpec`
  （`analysisRunSpec.ts:164` / `:184`），`.kind` 被 registry 自洽检查
  （`runtimeRegistry.ts:43-47`）。
- 但**核心判断成立**：这些字段都不**驱动** runtime 行为。`.continuationPolicy`
  复制进 RunSpec 后无生产读取点；`.toolExecution` / `.snapshotState` / `.abortMechanism` /
  `.eventModel` / `.nativeLoop` / `.toolSchemaDialect` / `.publicRuntime` /
  `.supportsProviderRuntimePinning` 均未被路由 / health / provider pinning 当作强制契约消费。
- 真实的分类与续接逻辑仍**分散硬编码**在各 runtime 内部，例如 Claude classifier
  `claudeRuntime.ts:935-971`、OpenAI classifier `openAiRuntime.ts:1594-1622`、
  OpenAI continuation 常量/循环 `openAiRuntime.ts:116/787/938/964`。
- `RuntimeContinuationPolicy.sdkRunDoneMeansAnalysisDone` 被类型固定为字面量 `false`
  （`runtimeCapabilities.ts:13`）—— 常量伪装成配置。
- **影响**：它看起来是一份"运行时行为契约"，实为可与真实实现静默漂移的文档。
  没有任何测试断言"声明的能力"与"真实行为"一致（F13/F14 即反例）。
- **方向**（二选一，待定）：
  - (a) 让它**承载行为**：runtimes / health / classifier 真正读取 capabilities 分支；或
  - (b) **瘦身**到真正被消费的少数字段，停止假装它是行为契约。

#### F2 [P1] `toProtocolHypothesis` 抽了共享版却仍被 fork 成 3 份
- 证据：共享版 `runtimeCommon.ts:221`（`source: 'claude' | 'openai'`）被 claude
  （`claudeRuntime.ts:2781` 传 `'claude'`）与 openai（`openAiRuntime.ts:2232` 传 `'openai'`）使用；
  但 `piAgentCoreRuntime.ts:469` 与 `openCodeRuntime.ts:1064` 各自定义了**逐字节相同**的私有版，
  仅 `proposedBy` 不同（`'pi-agent-core'` / `'opencode'`）。
- 根因：共享版的 `source` 联合类型没拓宽到 4 个 runtime，新增 runtime 时只能复制粘贴。
- **影响**：现存 3 份近似副本（shared + pi + opencode），confidence/status 映射逻辑将来必然漂移。
- **方向**：把 `source` 拓宽为 4 runtime（或 `string` / 专门的 runtime-source 类型），pi/opencode 改调共享版。修复成本极低。

#### F3 [P2] 两个文件同名 `runtimeCapabilities.ts`，语义完全不同
- `agentRuntime/runtimeCapabilities.ts`：引擎行为特征（`EngineCapabilities`）。
- `services/providerManager/runtimeCapabilities.ts`：provider 类型 ↔ runtime 兼容映射
  （`supportsAgentRuntimeType` / `resolveProviderAgentRuntime`）。
- **影响**：同名异义，import 时易混淆；两者还各自独立硬编码了 4-kind 列表（见 F5）。
- **方向**：至少其一改名（如 `engineCapabilities.ts` / `providerRuntimeMatrix.ts`）。

#### F4 [P2] `runtimeCommon.ts` 是混合关注点的"杂物抽屉"
- 一个文件里混了：LRU 缓存（`getLruCacheEntry`/`setLruCacheEntry`）、新鲜度判断、
  trace 上下文 Markdown 格式化、对话上下文拼装、entity capture、hypothesis 协议转换、
  skill-notes 预算。这些彼此无关。
- **方向**：按职责拆成 `runtimeCache.ts` / `runtimePromptContext.ts` / `runtimeHypothesis.ts` 等（低优先级）。

### Q2 —— 架构是否有问题

#### F5 [P1] 4-kind 运行时集合在约 10 处独立硬编码（单一真相源缺失）
- 证据（含 `pi-agent-core` 字面量的非测试文件）：`services/providerManager/types.ts:10`
  （类型联合）、`providerManager/runtimeCapabilities.ts`（`isAgentRuntimeKind`）、
  `agentRuntime/runtimeCapabilities.ts`（`PRODUCTION_RUNTIME_KINDS` + `isProductionAgentRuntimeKind`）、
  `runtimeRegistry.ts`（`productionRuntimeDefinitions`）、`runtimeSelection.ts`（错误信息字符串）、
  `runtimeHealth.ts`、`sessionStateSnapshot.ts`、`providerService.ts`、`providerSnapshot.ts`、
  `connectionTester.ts`。
- 存在**两个独立**的 "是不是合法 runtime kind" 谓词：`isAgentRuntimeKind`（providerManager）
  与 `isProductionAgentRuntimeKind`（agentRuntime）。
- **影响**：新增第 5 个 runtime 需散点修改约 10 处，极易遗漏（与 memory 里
  `AnalysisOptions` whitelist trap 同类）。
- **方向**：建立单一 runtime 描述符注册表（kind + 元数据 + 工厂 + provider 兼容），其余从它派生。

#### F6 [P1] 公共目录 `agentRuntime/` 内部塞了 2 个具体 runtime —— 抽象层非对等
- `pi-agent-core` 与 `opencode` 实现文件（1428 + 1749 行）直接住在"公共层"目录里，
  而 claude 在 `agentv3/`、openai 在 `agentOpenAI/`。
- 由此 `runtimeRegistry.ts` 的引入方式三态不一致：claude 用静态 `import { createClaudeRuntime } from '../agentv3'`、
  openai 用懒加载 `require('../agentOpenAI')`、pi/opencode 用同目录直接 import。
- **影响**：公共层不是"中立的对等层"，而是"2 个外来 + 2 个本地"的混合体；新增 runtime 该放哪里没有一致规则。
- **方向**：要么把 4 个 runtime 全部下沉到 `agentRuntime/engines/<kind>/`（对等），
  要么把 pi/opencode 上移到与 claude/openai 同级目录，公共层只留抽象。

#### F7 [P2] `runtimeHealth.ts` 用深层嵌套三元为 4 个 runtime 特判
- 证据：`runtimeHealth.ts` 中 `selectedDiagnostics` / `selectedModel` / `selectedProviderMode`
  是三层嵌套三元，逐个判断 claude/openai/pi/opencode。
- 根因：`EngineCapabilities` 没有把"取诊断 / 取模型名"纳入多态契约，所以 health 只能手动 fan-out。
- **影响**：每加一个 runtime 都要改这段；可读性差。
- **方向**：把 `getDiagnostics()` 纳入 runtime 定义（见 F8），health 改为统一调用。

#### F8 [P2] `RuntimeRegistry` 公共 API 过度建设 + 双重间接
- `has` / `get` / `require` / `getCapabilities` / `listRuntimeKinds` 在非测试代码中**无外部调用方**，
  实际只用到 `createOrchestrator`（经 `createRuntimeRegistryForSelection`）。
- `productionRuntimeDefinitions` 里 pi/opencode 的 `createOrchestrator` 为
  `createXxxRuntimeDefinition(KIND).createOrchestrator(input)` —— 每次创建编排器都先**新建一个定义对象**再调它的工厂（双重间接）。
- `listProductionRuntimeKinds()` 亦无调用方。
- **方向**：精简注册表 API 到实际所需；pi/opencode 直接挂工厂，去掉"建定义再取工厂"的中间层。

### Q3 —— 抽象层与 4 个 SDK 的协作

#### F9 [P0] 分层倒置：通用 selection 依赖具体 runtime（pi）做跨 runtime 选择
- 证据：通用 `runtimeSelection.ts:11-13` 从**具体** runtime 文件
  `piAgentCoreRuntime.ts` import `resolveExperimentalAgentRuntimeSelection` 与
  `ExperimentalAgentRuntimeKind`；而该函数（`piAgentCoreRuntime.ts:215-237`）同时解析
  **pi 和 opencode 两个** experimental kind，并 import 了 opencode 的
  `EXPERIMENTAL_OPENCODE_RUNTIME_KIND`（`piAgentCoreRuntime.ts:68`）。
- 形成的依赖链：通用层 → 具体 runtime A（pi）→ 具体 runtime B（opencode）。
- **影响**：跨 runtime 的"实验性选择策略"埋在某一个 runtime 文件里；最严重的分层问题。
- 严重度（Round 2 校准）：作为"4-peer runtime 抽象"评审 **P0** 成立；作为**当前生产行为**
  则更接近 **P1-high**——它是边界倒置与扩展风险，不是已证明的运行故障。
- **方向**：把 experimental 选择/kind 收敛到公共层（`runtimeSelection.ts` 或 registry），
  各 runtime 只声明自己的 kind，由公共层聚合。

#### F10 [P1] `AnalysisHarness`（"hidden strangler"）默认开启却近乎空操作
- 证据：`runtimeSelection.ts:107-109` 默认（除非 env=0/false/off）把**每个**生产编排器包进 harness；
  但 `analysisHarness.test.ts:44` 的 `describe('AnalysisHarness hidden strangler')` 表明它是
  **有意为之的迁移 seam**（strangler fig）。当前 `analyze()` 仅透传，未集中任何编排逻辑。
- 代价（当前已发生）：多一层 EventEmitter 跳转 + 一份**手工维护**的可选 hook 重绑定
  （`analysisHarness.ts:62-115`，13 个 hook 各写一遍）。
- 保护它的测试是**硬编码镜像**（change-detector）：`orchestratorContractInventory.test.ts`
  断言"硬编码数组 == 另一硬编码数组"；`analysisHarness.test.ts` 也逐个 hook 手写断言。
  二者都**不会**在 `IOrchestrator` 新增第 14 个 hook、而 harness 漏绑时失败（与 F2/F5 同类陷阱）。
- **方向**（二选一）：(a) 加速 strangler 让它真正承载价值；或 (b) 在它承载价值前**默认关闭**。
  同时把 hook 转发改为 `Proxy` / `keyof IOrchestrator` 驱动，去掉手工镜像。

#### F11 [P1] capabilities 是"描述性"而非"强制性"契约（与 F1 同源，列在协作视角）
- 4 个 runtime 都**不读** capabilities 来决定行为，各自内部硬编码。没有测试把"声明的能力"
  和"真实行为"对齐。
- **影响**：抽象层与 SDK 之间的"契约"只是注释级别的承诺，会漂移。
- **方向**：见 F1(a)——若保留 capabilities，则让它成为唯一行为开关并加对齐测试。

#### F12 [P0] 公共层留下一个**当前就失败**的红测试
- 证据：`analysisHarness.test.ts:147-152` 断言
  `productionRuntimeRegistry.listRuntimeKinds()` 等于 `['claude-agent-sdk','openai-agents-sdk']`（仅 2 个），
  但 `runtimeRegistry.ts:84-121` 的 `productionRuntimeDefinitions` 已注册 4 个。
- **已实跑验证**：`npx jest src/agentRuntime/__tests__/analysisHarness.test.ts` →
  `1 failed, 4 passed`，diff 显示 received 多出 `pi-agent-core` / `opencode`。
- **影响**：four-agent 重构遗留的 stale assertion，测试套件红。**最高优先、修复成本极低**。
- **方向**：更新断言为 4 kind（或改为从单一真相源派生，配合 T3）。

#### F13 [P1-high] 用户 cancel / abort **不触达任一 runtime 的真实中止**
- 证据：`IOrchestrator` 没有统一 cancel/abort hook（`orchestratorTypes.ts:167-203` 只有
  `cleanupSession?` / intervention / snapshot 等可选 hook）。
  `/respond abort` 仅改 session 状态（`agentRoutes.ts:2230-2234`）；
  `/cancel` 仅取消 smart/scene bridge + 标记 failed + 关闭 SSE，**从不调用** runtime 的
  abort/cleanup（`agentRoutes.ts:2389-2420`，已逐行确认）。
- 各 runtime 其实**有**内部中止能力，但路由层够不着：Pi `abortActiveRun()` 不在接口上
  （`piAgentCoreRuntime.ts:1401-1403`）、OpenAI `AbortController` 只用于内部 timeout/idle
  （`openAiRuntime.ts:752-759/816-855`）、OpenCode `cleanupSession()` 能关 server 但 cancel 不调它
  （`openCodeRuntime.ts:1645-1647`）。
- **影响**：用户点取消后，前端收到"已取消"，但后台 `analyze()`（LLM 调用、trace_processor 查询、
  SDK 子进程 / OpenCode server）仍在跑到自然结束/超时 —— **算力与额度泄漏**，4 个 runtime 都受影响。
- **方向**：在 `IOrchestrator` 增加统一 `abortSession(sessionId)`，4 个 runtime 各自实现，
  `/cancel` 与 `/respond abort` 调用之。

#### F14 [P1] snapshot/resume 对 4 个 runtime **不对称**：pi/opencode 是"假 opaque 恢复"
- 证据：snapshot schema 支持 4 kind（`sessionStateSnapshot.ts:128-158`）。
  Claude/OpenAI 的 restore 会真正恢复 SDK/response 续接状态
  （`claudeRuntime.ts:2769-2776` / `openAiRuntime.ts:1257-1265`）。
  但 Pi 的 snapshot 只存 message/tool 计数（`piAgentCoreRuntime.ts:1357-1363`），
  restore 不读 engineState（`:1372-1394`）；OpenCode 存了 `openCodeSessionId`
  （`openCodeRuntime.ts:1688-1694`），restore 也不读回（`:1702-1728`）。
- **影响**：`capabilities.snapshotState.storesOpaqueThirdPartyState: true` 对 pi/opencode 只是
  声明，并非真实续接能力 —— 正是 F1/F11"声明≠契约"的实锤。
- **方向**：要么让 pi/opencode 真正灌回 opaque 状态，要么把 capabilities 改为如实声明
  （并在 resume 路径上对"不可续接"给出明确降级）。

#### F15 [P1] provider pinning 的 snapshot hash **覆盖不全** pi/opencode 关键配置
- 证据：恢复主路径是对的——`agentAnalyzeSessionService.ts:398-420/441-449` 会比对
  snapshot 的 provider override 与 hash，`providerId=null` 时用 `runtimeOverride` 避免读当前 active provider。
  但 `providerSnapshot.ts:62-92` 的 env 白名单以 Claude/OpenAI 主字段为主；
  敏感字段 hash（`:39-50`）只含 `piAgentCoreModelJson` / `openCodeModelJson`，
  **不含** module path / system prompt；而 `providerService.ts:291-313` 确实会为 pi/opencode
  写入 module path / model / system prompt。
- **影响**：pi/opencode 的 runtime-critical 配置变化**不会**触发 snapshot hash mismatch，
  恢复时可能静默沿用旧配置。
- **方向**：把 pi/opencode 的 module path / system prompt / OpenCode server/MCP 配置纳入
  snapshot hash 覆盖面（最好与 T3 单一真相源一起做）。

#### F16 [P2] intervention hook 在 4 个 runtime 里**无任何实现**
- 证据：除 harness 的转发声明外，4 个 runtime 都未实现
  `getInterventionController()` / `recordUserInteraction()`；路由注释亦写明 ClaudeRuntime 不实现。
- **影响**：intervention 端点目前对 4 个 runtime 基本是 no-op；harness 为其做的可选 hook 绑定（F10）也随之落空。
- **方向**：明确 intervention 是否仍是产品目标——是则在 runtime 落地，否则从接口/harness/文档移除以止损。

#### ✅ 协作做得好的部分（不要回退）
- 4 个 runtime 都经 `createAnalysisRunSpec` 构建统一的 `AnalysisRunSpec`（数据形状统一）。
- 4 个 runtime 都只 `emit('update')`，监听方（`agentRoutes.ts:3467` / `cliAnalyzeService.ts:217`）
  也只听 `'update'` —— 事件模型一致，harness 只转发 `'update'` 是**正确**的。
- tool 适配统一走 `runtimeToolSpec`（`SharedToolSpec` + zod→json schema sanitize + arg normalize）。
- runtime 创建统一经 registry 工厂；env 凭证探测统一经 `envCredentialSources`。

---

## 3. 待办行动项（优先级排序，未实施）

> 注意：本轮只评审与记录，**不改代码**。以下为后续可执行项，需用户拍板方向后再做，
> 且遵守 `.claude/rules/testing.md`（build + trace regression + 相关 e2e）。

| ID | 待办 | 来源 | 优先级 | 预估 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T1 | 收敛 experimental 选择/kind 到公共层，解除 selection→pi→opencode 倒置 | F9 | P0 | M | 待定 |
| T2 | 拓宽 `toProtocolHypothesis` 的 `source`，pi/opencode 改调共享版，删 2 份副本 | F2 | P1 | S | 待定 |
| T3 | 建立单一 runtime 描述符真相源，消除约 10 处 4-kind 硬编码与双 `isXxxRuntimeKind` | F5 | P1 | L | 待定 |
| T4 | 决策 `EngineCapabilities`：承载行为(a) 或 瘦身(b)；定后加对齐测试 | F1/F11 | P1 | M | **需用户决策** |
| T5 | 统一 4 个 runtime 的目录归属（对等化） | F6 | P1 | M | **需用户决策** |
| T6 | `AnalysisHarness`：加速 strangler 或默认关闭；hook 转发改 Proxy/keyof | F10 | P1 | M | **需用户决策** |
| T7 | 把 `getDiagnostics()` 纳入 runtime 定义，重写 `runtimeHealth` 嵌套三元 | F7 | P2 | S | 待定 |
| T8 | 精简 `RuntimeRegistry` API + 去除 pi/opencode 的"建定义再取工厂"双重间接 | F8 | P2 | S | 待定 |
| T9 | 同名 `runtimeCapabilities.ts` 其一改名 | F3 | P2 | S | 待定 |
| T10 | 拆分 `runtimeCommon.ts` 杂物抽屉 | F4 | P2 | S | 待定 |
| **T11** | **修复红测试**：`analysisHarness.test.ts:148` 断言改为 4 kind（或从真相源派生） | F12 | **P0** | XS | 📋 已规划（Phase 0，确切 diff 见 §4.5）；曾实测改后 5 passed，现已回滚交实现方 |
| **T12** | 在 `IOrchestrator` 加统一 `abortSession`，4 runtime 实现，`/cancel`+`/respond abort` 调用 | F13 | **P1-high** | M | 待定 |
| T13 | 让 pi/opencode 真正续接 opaque 状态，或把 capabilities 改为如实声明 | F14 | P1 | M | **需用户决策** |
| T14 | snapshot hash 纳入 pi/opencode 的 module path / system prompt / OpenCode 配置 | F15 | P1 | S | 待定 |
| T15 | 明确 intervention 去留：runtime 落地 或 从接口/harness/文档移除 | F16 | P2 | S | **需用户决策** |

> 优先级提示：**T11（红测试）应立即修**（成本 XS，且现在套件是红的）；
> **T12（cancel 触达 runtime）是用户可感知的算力/额度泄漏**，建议紧随其后。

---

## 4. 开放问题 —— ✅ 已全部决策（2026-06-06）

原则（用户）：**早期阶段一次做对，不要半成品**。

| 决策 | 结论 | 实施 |
| --- | --- | --- |
| T4 capabilities 去向 | **瘦身为描述子集 + 真相源**（删 inert 字段，不强行驱动行为） | WS-A |
| T5 目录对等化 | **4 runtime 全下沉 `agentRuntime/engines/<kind>/`**（完全对等） | WS-C |
| T6 harness 去留 | **彻底删除**（无消费者的投机基础设施；F13 abortSession 已在 IOrchestrator 上） | WS-D |
| T13 pi/opencode 续接 | **实现真 opaque 续接**（先 SDK spike gate；不支持则降级 + capabilities 如实声明） | WS-I |
| T15 intervention 去留 | **彻底删除两端**（含前端面板）；歧义处理归一到 `clarify` 多轮；可逆 | WS-K |

---

## 4.5 F13 Scope B 实施方案（用户选定 Scope B，分两阶段）

> 现实语义校准：trace_processor SQL 走本地 **HTTP RPC**（`traceProcessorService.query` → `processor.query`
> → Node `http.request`，**生产默认再经 worker_threads**），当前无 signal。Scope B 的"打断 in-flight SQL"
> = **worker-aware 取消（取消排队任务 + 忽略/reject pending 响应）+ 停止派发后续查询**；
> server 端 shell 的单条查询可能仍跑完（HTTP RPC 不支持 kill 单 query），但那是本地有界资源，非 LLM 额度。
> claude 走 MCP/SDK，`close()` 本就中断 in-flight MCP 工具调用，**claude 免费获得 Scope B 行为**。

### Phase 0 —— F12 红测试（无依赖，先行）
文件 `backend/src/agentRuntime/__tests__/analysisHarness.test.ts`，
`it('does not register the harness as a production runtime path')` 内：

```ts
// 原（红）：
expect(productionRuntimeRegistry.listRuntimeKinds()).toEqual([
  'claude-agent-sdk',
  'openai-agents-sdk',
]);
// 改为：
expect(productionRuntimeRegistry.listRuntimeKinds()).toEqual([
  'claude-agent-sdk',
  'openai-agents-sdk',
  'pi-agent-core',
  'opencode',
]);
```
（已实测改后该套件 `5 passed`；`runtimeRegistry.test.ts:54-65` 本就正确无需动。理想做法见 T3：从单一真相源派生而非硬编码两份。）

### 关键签名/契约（实现方按此对齐，减少分歧）
```ts
// 1) orchestratorTypes.ts —— IOrchestrator 新增可选 hook（best-effort、幂等）
abortSession?(sessionId: string, referenceTraceId?: string): void | Promise<void>;

// 2) 各 runtime 内：按 sessionId 键、Set 容多句柄、identity 注销，避免并发误删
private activeAbortHandles = new Map<string, Set<{ abort(): void }>>();
//   start：set.add(handle)；finally：set.delete(handle)（按引用），空集再 map.delete(sessionId)
//   abortSession：取该 sessionId 的整个 set，逐个 handle.abort()

// 3) 取消标记绑定当前 run（不要裸 session 布尔，否则多 turn/resume 脏）
interface SessionRunCancelState { runId: string; cancelled: boolean; reason?: string }
//   每次 startSessionRun / runAgentDrivenAnalysis 开始：重置为当前 runId、cancelled=false

// 4) Phase 2：trace_processor 取消（worker-aware，非 fetch）
interface TraceProcessorServiceQueryOptions { /* …existing… */ signal?: AbortSignal }
//   query/queryRaw 透传 signal；worker 路径需取消协议（取消排队任务 + 忽略 pending 响应 + 标记为“取消”而非可重试 SQL 错误）
//   SkillExecutor 实际签名：execute(skillId, traceId, params, inherited)（skillExecutor.ts:1505）
//   → 把 signal 放进第 4 参 inherited，并加入 SkillExecutionContext（types.ts:460），全链路下传
//   invoke_skill / compare_skill / execute_sql 三个 tool handler 都要把 extra.signal 接到这里
```

### Phase 1 —— Scope A 地基（先做，跑通 6-trace 回归再进 Phase 2）
1. **取消语义**（核心，防误报失败）：
   - 路由/会话层加 `cancelRequested`/`cancelReason`（per session）。
   - `cancelled` 状态传播到内存 session/run context（持久层 `analysisRunStore` 已支持 `cancelled`）。
   - `agentRoutes.ts:3591-3604` 与外层 `:1672-1684` 两处 catch：识别 cancel，**不**覆盖为 failed、不发重复 error 终态。
2. **契约**：`IOrchestrator.abortSession?(sessionId, referenceTraceId?)`（optional，best-effort，幂等）。
3. **harness**：`analysisHarness.ts` 增字段 + 绑定转发 `abortSession`。
4. **4 runtime 实现 abortSession**（`Map<sessionId, Set<handle>>` + identity 注销）：
   - claude：登记 3 个 query 创建点（`:1094/:1810/:2362`）的 `close()`；abort 调全部。
   - openai：登记 per-session `AbortController`；abort 调 `.abort()`。
   - pi：单槽 `activeAgent` → `Map`；同步改 `takeSnapshot()`（`:1357-1363`）；补 `cleanupSession`；`abortActiveRun` 留兼容壳。
   - opencode：登记 per-session bridge/server + SDK `session.abort?`；`cleanupSession` 尊重 sessionId。
5. **入口接线**：`/cancel`(`:2389`)、`/respond abort`(`:2230`)、`/intervene` abort directive(`:2336`) → `await orchestrator.abortSession(sessionId, referenceTraceId)`。DELETE(`:2141`)/stale(`:5754`) 暂以"先 abort 再 cleanup"覆盖；SSE `req.on('close')` 不默认 abort。
6. **测试**：4 production runtime "必须实现 abortSession" 的强制测试；harness 转发；取消→`cancelled` 非 `failed`；build + 6-trace 回归。

### Phase 2 —— Scope B delta（SQL 信号透传，Phase 1 绿后再做）
1. `TraceProcessorServiceQueryOptions` 加 `signal?: AbortSignal` → `processor.query/queryRaw` →
   **HTTP RPC 客户端（Node `http.request`，`traceProcessorHttpRpcClient.ts:33`）+ worker 取消协议**（**非 fetch**；
   worker 需取消排队任务、忽略/reject pending 响应，并把取消标记为 cancellation 而非可重试 SQL 错误，
   见 `traceProcessorSqlWorker.ts:101/125/259`）。
2. 共享 tool handler（`claudeMcpServer.ts` 中调 `traceProcessorService.query` 者）从 `extra.signal` 取信号并下传；`SharedToolSpec.handler` 的 `extra` 类型显式化（含可选 `signal`）。
3. 各 adapter 供给信号：openai `openAiToolAdapter.ts:46` 传 `{ signal }`；pi/opencode 同理；claude 维持 close() 即可。
4. 取消时：先置信号（停止派发新查询 + 取消 in-flight HTTP RPC 等待 + worker pending/queued 任务取消），再中止 LLM 循环。
5. 测试：tool 执行收到 aborted signal 时快速失败；回归再跑一遍。

### 范围声明
本规格覆盖 **agent-driven runtime 主路径**。`preset: 'smart'` 的旧路径另有终态写入点
（外层 `agentRoutes.ts:1481`、内层 `:2766`）——实现方需**明确二选一**：要么纳入同一 run-bound cancel marker 判断，
要么在 PR 描述里声明 smart preset 取消为 out-of-scope（避免"agent 路径能取消、smart 路径仍报 failed"的不一致）。

### 验证
按 `.claude/rules/testing.md`：`cd backend && npm run typecheck` + 受影响单测 + `npm run test:scene-trace-regression`。
单测族至少覆盖：
- 4 个 production runtime **必须实现 abortSession**（强制契约测试，呼应 F1/F11）。
- 取消语义：late error 不覆盖 cancelled / late success 不写 completed / 真失败仍 failed / 多 turn 新 run 不继承旧 marker。
- Phase 2：SQL worker 排队任务与 pending 响应的取消；`invoke_skill`/`compare_skill` 的 signal 透传到 SkillExecutor。
- 取消 e2e（启动 analyze → /cancel → 断言：cancelled 终态、event store/SSE replay **不**写回 failed、无 LLM 续跑）。

落地前 `npm run verify:pr`。

### Phase 校正（Codex R4 复审本方案后，必须并入）
Phase 1（取消语义）远不止改两处 catch：
- **防 late success**：abort 后 analyze 若返回 partial/late result，会走 `completeAgentDrivenSessionWithResult` →
  `finalizeAgentDrivenSession`（`finalizeAgentDrivenSession.ts:119` / `agentRoutes.ts:223`）写 completed/failed，
  需在 finalize 前/内检查"本 run 已取消"。
- **致命：取消会被 event store 写回 failed**——`/cancel` 现发 `error` SSE，`agentEventStore.ts:130` 把任意 `error`
  事件映射为 `failed`。需独立 cancellation 事件/状态，或让 event store 识别取消 payload。
- **cancellation 事件三件套**（若引入独立 cancel 事件，三处都要改，否则 reconnect/replay 不闭合）：
  ① event store 识别取消（`agentEventStore.ts:130`）；② 加入 SSE 终态集
  `TERMINAL_SSE_EVENT_TYPES`（`sessionSseReplay.ts:15`，当前仅 `analysis_completed`/`error`/`end`）；
  ③ 持久回放加载（`agentRoutes.ts:709` 当前只载 completed 类事件）。
- cancel 标记必须**绑定当前 runId**（创建/重置点 `agentRoutes.ts:316` / `:3312`），否则多 turn/resume 把新 run 真失败误判为取消。
- `cancelled` 需贯通：内存 session/run 类型（`agentRoutes.ts:394` / `agentAnalyzeSessionService.ts:68`）、
  cleanup 终态判断（`assistantApplicationService.ts:104`）、resume/snapshot（`agentResumeRoutes.ts:40` / `sessionStateSnapshot.ts:98`）。
- catch 判断要按"本 run cancel marker"，**不**按 AbortError 字符串泛化，确保真失败仍报 failed。

Phase 2（Scope B SQL 中断）比预想深：
- 底层是 Node `http.request`（`traceProcessorHttpRpcClient.ts:33`）+ **生产默认 worker_threads**
  （`traceProcessorSqlWorker.ts:101/259`，post 无 signal）→ 需 **worker 级取消协议**（取消排队任务 + 忽略/ reject pending 响应）。
- `TraceProcessorSqlWorker.query()` catch 后返回 `{error}` 不 reject（`:125`）→ abort 不能被当成"可重试 SQL 失败"，要识别为取消。
- 主 SQL 热路径是 `invoke_skill`/`compare_skill` → `SkillExecutor.execute`（`claudeMcpServer.ts:2029/4514`，内部大量 `traceProcessor.query` 如 `skillExecutor.ts:2590`），**SkillExecutor 全链路要穿 signal**；只改 `execute_sql` 会漏掉绝大部分 SQL。
- adapter 现状：claude 不能注入 signal（SDK 给 extra）只能靠 close()；pi 已传 SDK signal（`piAgentCoreRuntime.ts:610`）；
  openai（`openAiToolAdapter.ts:44` 传 `{}`）与 opencode（`openCodeRuntime.ts:681` 传 `{runtime}`）需补 signal。

**推荐执行顺序（交接实现方）**：Phase 0 → Phase 1（落地后跑通 6-trace 回归）→ Phase 2。
Phase 2 是对 SQL 内核（worker 协议 + SkillExecutor）的高风险改动，回归面 = 全部 6-trace，**务必作为独立、单独回归的提交**，
不要与 Phase 1 混在一个不可二分的大改里。claude 在 Phase 1 已靠 close() 免费获得 in-flight SQL 中断，
故 Phase 2 仅需为 openai/pi/opencode 补齐。若 Phase 2 的 worker 取消协议风险超预期，可接受"Phase 1 + claude 免费中断"
作为合格的最小可用取消（openai/pi/opencode 的已发出单条本地 SQL 自然跑完）。

---

## 4.6 Option 2 架构项实施方案（T1–T15，用户决策版）

> 用户决策：**T4 瘦身 capabilities**、**T5 4 runtime 全下沉 engines/<kind>/**、**T13 实现真 opaque 灌回**。
> 用户原则：**早期阶段一次做对，不要半成品**（不留休眠/deferred 中间态）。
> 据此 Claude 从整体架构 + 产品（让用户分析 Perfetto）视角定：**T6 harness 彻底删除**、**T15 intervention 彻底删除**
> （理由见 WS-D / WS-K；intervention 的歧义处理由 `clarify` 多轮覆盖）。
> 全部为规划交付，实现由他方按下列工作流执行；每个 WS 独立提交、独立回归。

### 推荐执行顺序（按依赖与回归隔离）
WS-A（真相源）→ WS-B（分层）→ WS-E（hypothesis）→ WS-G（registry）→ WS-F（diagnostics/health）
→ WS-H（拆 common）→ WS-D（harness）→ WS-J（pinning hash）→ WS-I（opaque 续接）
→ WS-K（intervention）→ **WS-C（目录全下沉，最后做的纯机械迁移）**。
理由：先做逻辑收口（在现有路径上改，便于 diff/回归），最后做大范围移动文件的机械迁移，避免中途反复挪文件。

### WS-A [T3+T4+T9] 单一 runtime 真相源 + 瘦身 capabilities + 改名
- 新建单一描述符（建议 `agentRuntime/runtimeDescriptors.ts`）：每个 runtime 贡献
  `{ kind, displayName, publicRuntime, providerTypes, createOrchestrator, getDiagnostics, capabilities(瘦身) }`。
- **派生**（消除 F5 的 ~10 处硬编码）：`AgentRuntimeKind` 联合、单一 `isAgentRuntimeKind`（删掉
  `isProductionAgentRuntimeKind` 重复谓词或让其 re-export）、`PRODUCTION_RUNTIME_KINDS`、provider 兼容矩阵、capabilities 全从描述符派生。
- **瘦身 `EngineCapabilities`**：删除不驱动行为的 `continuationPolicy/classifierPolicy/toolExecution/abortMechanism/
  eventModel/nativeLoop/toolSchemaDialect/snapshotState/supportsProviderRuntimePinning/toolTransport`
  （`toolTransport` 亦无生产消费方，`runtimeCapabilities.ts:24`，一并删）；仅保留被消费的
  `kind/displayName/production/publicRuntime`。`analysisRunSpec` 里对 classifier/continuation 的复制改为删除或就地常量。
- **改名（T9）**：`services/providerManager/runtimeCapabilities.ts` → `providerRuntimeMatrix.ts`；
  `agentRuntime/runtimeCapabilities.ts` → 并入描述符或更名 `engineCapabilities.ts`。
- 测试：派生一致性（描述符 kind 集合 == 类型 == registry == provider 矩阵）；删除字段后 `tsc --noEmit` 全绿；6-trace 回归。

### WS-B [T1] experimental 选择/kind 收敛到公共层
- 把 `resolveExperimentalAgentRuntimeSelection` 与 `ExperimentalAgentRuntimeKind` 从
  `piAgentCoreRuntime.ts` 移到公共层（`runtimeSelection.ts` 或新 `experimentalRuntime.ts`）。
- 各 runtime 只 `export` 自己的 experimental kind 常量；公共层聚合，解除 selection→pi→opencode 倒置。
- 测试：`runtimeSelection.test.ts` 覆盖两个 experimental kind 解析；无 common→具体 runtime 的反向 import（可加 import-lint 断言）。

### WS-E [T2] 去重 toProtocolHypothesis
- 拓宽 `runtimeCommon.toProtocolHypothesis` 的 `source` 为 4 runtime（或 `RuntimeHypothesisSource` 类型）。
- 删除 `piAgentCoreRuntime.ts:469` / `openCodeRuntime.ts:1064` 私有副本，改调共享版传各自 source；claude/openai 维持现状。
- 测试：4 source 各产出正确 `proposedBy`；snapshot 等值对比删副本前后输出不变。

### WS-G [T8] 精简 RuntimeRegistry + 去双重间接
- 移除非测试无调用方的 `has/get/require/getCapabilities/listRuntimeKinds`（或保留最小集）；
  pi/opencode 直接挂工厂，去掉 `createXxxRuntimeDefinition(KIND).createOrchestrator(input)` 的"建定义再取工厂"。
- 测试：registry 仅暴露 `createOrchestrator` + 必要查询；4 kind 注册正确。

### WS-F [T7] getDiagnostics 入描述符 + 重写 health
- `getDiagnostics()` 作为描述符成员（WS-A）；`runtimeHealth.ts` 的三层嵌套三元改为
  `descriptor.getDiagnostics(env, kind)` 统一调用 + 统一 model/providerMode 取值。
- 测试：`runtimeHealth.test.ts` 对 4 runtime 各断言 diagnostics 形状一致。

### WS-H [T10] 拆分 runtimeCommon 杂物抽屉
- 按职责拆：`runtimeCache.ts`（LRU/freshness）、`runtimePromptContext.ts`（trace/对话上下文）、
  `runtimeHypothesis.ts`（WS-E 后的共享版）、`runtimeEntities.ts`（entity capture）、`runtimeSkillNotes.ts`。
- `index.ts` 维持对外导出不变（纯内部重组，零行为变化）。测试：现有 `runtimeCommon.test.ts` 拆分后仍绿。

### WS-D [T6] harness —— 决策：**彻底删除**（Claude 从整体架构 + 产品视角定）
- **理由**：harness 当前零消费者、零用户可见价值；其设想的"集中 eval/telemetry/编排"无真实消费方，属投机基础设施。
  F13 的 `abortSession` 已在 `IOrchestrator` 上、直接调用即可，不依赖 harness。早期阶段"做对"= 不背投机抽象；
  待真有 eval/telemetry 消费方时再以**消费者驱动**方式引入名副其实的 seam。保留（哪怕默认关闭）即半成品。
- **删除范围**：`analysisHarness.ts`（AnalysisHarness 类）、`runtimeSelection.ts:107-109` 的默认包裹、
  `SMARTPERFETTO_ANALYSIS_HARNESS`/`ANALYSIS_HARNESS_ENV`、`analysisHarness.test.ts`、
  `orchestratorContractInventory.test.ts` 中 harness 相关镜像断言；`index.ts` 去掉相关导出。
  `createAgentOrchestrator` 直接返回 engine。
- **连带收益**：消除 F10 的手工 hook 镜像维护负担 + 热路径空 EventEmitter 跳转。
- 测试：`createAgentOrchestrator` 返回 raw runtime；route `on('update')` 仍工作；6-trace 回归。

### WS-J [T14] provider pinning hash 覆盖 pi/opencode
- `providerSnapshot.ts` env 白名单与敏感 hash 增加 pi/opencode 的 module path / system prompt /
  OpenCode server/MCP/project 配置（与 `providerService.ts:291-313` 写入面对齐）。
- 测试：改这些字段触发 snapshot hash mismatch；不改不触发。

### WS-I [T13] pi/opencode 真正的 opaque 状态续接
- **WS-I.0 先做 SDK 可恢复性 spike（gate）**：现状 pi snapshot 仅存 `messageCount/toolCount`、restore 不读 engineState
  （`piAgentCoreRuntime.ts:1357/1372`）；opencode 仅存 `openCodeSessionId`，每次 analyze 建临时 home/config/project
  且 finally 关 server（`openCodeRuntime.ts:1256/1320/1688`），restore 不重连（`:1702`）。
  **先验证 Pi/OpenCode SDK 是否暴露可 hydrate 的 session/history**：
  - 支持 → 实现"真 opaque 续接"（下方）。
  - 不支持 → **降级为"SmartPerfetto 外层上下文续接 + third-party state degraded"**，并据此把 capabilities 如实声明
    （此时 T13 与 T4 的诚实原则一致，不得承诺 true opaque）。
- 真续接实现：定义各自引擎状态（pi = 可序列化 session/history；opencode = sessionId + 重连服务端所需信息）；
  `sessionStateSnapshot.ts` 增 opaque 字段；各 runtime `takeSnapshot` 写、`restoreFromSnapshot` 读回并重建引擎/重连 server。
- pi 需配合 F13 的单槽→Map，使 `takeSnapshot` 取对应 session 的 agent。
- 测试：spike 结论记录在案；take→restore 后能续多轮且引用旧上下文；server 重启/不可重连的降级路径。

### WS-K [T15] intervention —— 决策：**彻底删除（含前端面板）**（Claude 从整体架构 + 产品视角定）
- **现状（已核实）**：intervention 是**"前端有面板、后端从不触发"的半成品**——前端
  `perfetto/ui/.../intervention_panel.ts` + `sse_event_handlers.ts` 消费 intervention 事件，但 4 runtime
  **全未实现** `getInterventionController`；`/intervene` 发现无 controller 即拒绝（`agentRoutes.ts:2309`）。
- 🚫 **务必区分 intervention（删）vs focus tracking（保留）**：`recordUserInteraction` / `getFocusStore` /
  路由 `/interaction` / `/focus` 是 **SQL 表格 focus 追踪**（前端 `sql_result_table.ts:75/577` →
  `ai_panel.ts:3928` 在用，是 live 功能），**绝不删**。误删 `/interaction` 会让前端打 404。
- **理由**：歧义/低置信处理已由 多轮对话 + `AnalysisPlanMode='clarify'`（agent 在回答里直接问、用户下一轮答）覆盖；
  mid-run 暂停/恢复跨 4 runtime 铺开不划算。
- **删除范围（仅 intervention，不碰 focus tracking）**：
  - 后端：`IOrchestrator.getInterventionController`；路由 `/intervene` 及其分支（`agentRoutes.ts:2309` 一带）；
    `orchestratorTypes` 的 intervention 事件 payload（`InterventionRequired/Resolved/Timeout`，确认无其他消费方）；
    旧 `HypothesisExecutor` 的 `phase:'intervention_required'` 发射（`hypothesisExecutor.ts:323`）—— 清掉或证明不可达；
    harness 相关随 WS-D 删；inventory 测试更新。
  - 前端（**perfetto 子模块**）：`intervention_panel.ts` + `sse_event_handlers.ts` 的 intervention 分支及单测；
    按 `.claude/rules/frontend.md` 走 `./scripts/start-dev.sh` 验证 + `./scripts/update-frontend.sh`，遵守子模块先推 `fork`。
- **保留**：`'clarify'` plan mode + 多轮澄清；**focus tracking 全套**（`recordUserInteraction`/`getFocusStore`/`/interaction`/`/focus`/`SqlResultTable.onInteraction`）。
- ⚠️ **可逆决策**：若产品要 human-in-the-loop，翻转为"后端 4 runtime 实现以点亮现有前端面板"（独立特性，另立规格）。
- 测试：intervention 移除后无悬挂引用；**focus tracking 回归正常（/interaction、/focus、SqlResultTable）**；clarify 多轮不受影响；前端 dev 验证。

### WS-C [T5] 4 runtime 全下沉 engines/<kind>/（最后做，纯机械迁移）
- 目标布局：`agentRuntime/engines/{claude,openai,pi,opencode}/`；公共层目录只留抽象
  （descriptors/selection/registry/common-split/toolSpec/runSpec/health；harness 已随 WS-D 删）。
- **关键风险**：`agentv3/` 是大模块，含大量被 **OpenAI/Pi/OpenCode 复用**的共享件，"下沉 claude" ≠ 搬整个 agentv3。
- **文件分类（Codex 核对，实现方按此搬）**：
  - 可搬入 `engines/claude/`：`claudeRuntime.ts`、`claudeSseBridge.ts`、`claudeVerifier.ts`、`claudeAgentDefinitions.ts`；
    `claudeConfig.ts` 若搬需 **stable re-export**（服务层在用，`comparisonAiConclusionService.ts:12`）。
  - **必须留公共/shared（被其他 runtime 复用）**：`claudeMcpServer`、`mcpToolRegistry`、`claudeSystemPrompt`、
    `claudeFindingExtractor`、`sessionStateSnapshot`、`ArtifactStore`、`strategyLoader`、`sceneClassifier` 等
    （`openAiRuntime.ts:32`、`piAgentCoreRuntime.ts:19`、`openCodeRuntime.ts:24` 均 import）。建议借机改名去掉 `claude` 前缀。
  - 可搬入 `engines/openai/`：`openAiRuntime.ts`、`openAiToolAdapter.ts`、`mimoReasoningCompat.ts`；
    `openAiConfig.ts`/`openAiComplexityClassifier.ts` 有外部服务消费（`comparisonAiConclusionService.ts:6`），需 re-export 或拆出 provider-shared util。
- 做法：纯文件移动 + import 路径更新，**零行为变化**，单独提交；先 `tsc --noEmit` 再 6-trace 回归。建议配路径别名/codemod。
- 测试：移动后全量 `npm run verify:pr`。

### 全局验证
每个 WS 落地按 `.claude/rules/testing.md` 跑 `tsc --noEmit` + 受影响单测 + `npm run test:scene-trace-regression`；
WS-C/WS-I/WS-D（动 IOrchestrator/snapshot/热路径）后建议加跑相关 Agent SSE e2e；全部完成后 `npm run verify:pr`。

---

## 5. Review Log（轮次记录）

### Round 1 —— Claude 结构化评审（2026-06-06）
- 阅读公共层全部文件 + 4 个 runtime 的协作点；用 grep 量化"消费方"。
- 验证防住 3 个假阳性：harness 漏事件（实为单 `'update'` 通道）、harness 死代码
  （实为有意 strangler seam）、共享 hypothesis helper（claude/openai 确实在用）。
- 产出上述 F1–F11 + T1–T10 + 3 个开放问题。
- 输出：本文档初版。

### Round 2 —— Codex 只读复审（2026-06-06，session `019e9c24-…`）
- 结论：**非 LGTM**。认同总体主线（claude+openai DNA、pi/opencode 焊边缘）。
- 确认：F2、F9（依赖链甚至比文档更明确）、F10。
- 收窄：F1/F11 —— `classifierPolicy`/`continuationPolicy` 确被复制进 `AnalysisRunSpec`，
  "92% 只写不读"过激；改为"描述性、不驱动行为、非强制契约"。→ 已改 F1。
- 校准：F9 严重度 = 抽象评审 P0 / 当前生产 P1-high。→ 已改 F9。
- **新增高优先风险（Codex 沿 cancel/resume/pinning 深挖，我已抽样验证）**：
  - F12 红测试 —— 我**实跑** `analysisHarness.test.ts` 确认 `1 failed`。✅ 验证属实。
  - F13 cancel 不触达 runtime —— 我**逐行读** `agentRoutes.ts:2389-2420` 确认 `/cancel`
    不调用任何 runtime abort/cleanup。✅ 验证属实。
  - F14 snapshot resume 不对称（pi/opencode 假 opaque 恢复）。
  - F15 provider pinning hash 覆盖不全 pi/opencode。
  - F16 intervention 无 runtime 实现。
- 我对 Codex 反馈的批判性处理：F12/F13 我亲自验证后才采纳（未盲从）；F14/F15 采纳为
  P1 但标注"需进一步代码确认续接/hash 细节"；其余按 file:line 核对一致。
- 输出：本文档更新到含 F1–F16 / T1–T15 / Round 2 记录。

### Round 3 —— 实施 R1（F12 落地 + F13 方案 Codex 复审，2026-06-06）
用户决策：先做 1（F12+F13），再做 2（架构方向）。

**F12（T11）已完成**：`analysisHarness.test.ts:148` 改为 4 kind，实跑 `5 passed`。
扫描确认无兄弟红测试（`runtimeRegistry.test.ts:54-65` 本就正确写了 4 kind）。

**F13（T12）方案经 Codex 第二轮复审 → 非 LGTM，规模显著上修**。已用源码验证的关键纠正：
- 取消需"一等语义"：`agentRoutes.ts:3591-3604` 的 catch **无条件**标 failed+广播 error，
  外层 `.catch`（`:1672-1684`）再标一次 → abort 触发的 reject 会把"用户取消"误报为"运行失败"+双终态。
  持久层已有 `cancelled` 状态（`analysisRunStore.ts:9-16`），但内存 session/run（`agentAnalyzeSessionService.ts:61-69`）未用。
  → 必须加 cancel flag + `cancelled` 状态传播 + 两处 catch 迟到错误抑制。
- 句柄登记需 `Map<sessionId, Set<handle>>` + identity 注销（claude/openai 有 `activeAnalyses` 并发 guard
  `claudeRuntime.ts:917-921` / `openAiRuntime.ts:661-664`，pi/opencode 没有）。
- Claude 有多个 query 创建点（main `:1094` / correction `:1810` / quick `:2362`），登记表要全覆盖。
- **范围分叉（待用户决策）**：仅中止 LLM 循环 + 关 SDK/server（Scope A）vs 还要把 AbortSignal
  透传到 tool adapter 以打断 in-flight trace_processor SQL（Scope B）——目前 OpenAI/Pi/OpenCode 的
  tool adapter 不透传 signal（`openAiToolAdapter.ts:44-47` 等），Scope A 下已在跑的 SQL 不会被打断。
- 漏掉的取消入口：`/intervene` abort directive（`:2336-2338`）、DELETE session（`:2141-2142`）、
  stale cleanup（`:5754-5755`）；SSE `req.on('close')` 不应默认 abort（支持 replay/重连）。
- Pi 单槽改 Map 后需同步改 `takeSnapshot()`（`piAgentCoreRuntime.ts:1357-1363`）读对应 session 的 agent。
- 需加"4 个 production runtime 必须实现 abortSession"的强制测试（呼应 F1/F11 声明≠契约）。

**结论**：F13 不是"接线"，而是一个取消特性。已回到用户处确认 **Scope A vs B** 与入口覆盖范围后再实施。

### Round 4 —— Codex 复审 Scope B 具体方案（2026-06-06，同 session）
- 用户选定 **Scope B**。我写出分阶段方案（见 §4.5）并请 Codex 只读复审。
- 结论：**非无条件 LGTM**，方向认可但有必须并入的修正（已写进 §4.5 "Phase 校正"）。
- 我已抽样验证 Codex 指出的代码位置可信（event store error→failed 映射、worker_threads SQL 路径、SkillExecutor SQL 热路径、各 adapter 的 extra 现状）。
- 最大新认知：**Scope B Phase 2 = 改 SQL 内核（worker 协议 + SkillExecutor 穿 signal），回归面覆盖全部 6-trace，风险集中**；
  而 claude 在 Phase 1 已靠 close() 免费获得 in-flight SQL 中断。
- 据此我向用户提出**再拆分建议**：Phase 1 先落地+回归，Phase 2 作为独立单独回归的变更。待用户裁决。

### Round 5 —— 用户改为"规划交付"模式（2026-06-06）
- 用户决策：**Claude 只做规划、不做任何实现；规划做完 + Codex review 完后，实现交其他方。**
- 据此：回滚先前 F12 测试修复（恢复 four-agent 遗留的红测试原状），把 F12 列为实现 Phase 0（§4.5 附确切 diff）。
- F13 全量 Scope B 实施规格已在 §4.5 完成（Phase 0/1/2 + 关键签名 + 验证），作为实现方交接物。
- 待办：对 §4.5 完整规格做最后一轮 Codex 复审确认；随后视用户需要把 Option 2 架构项（T4/T5/T6/T13/T15）也规划到位。

### Round 6 —— Codex 终审：F13 规格"可交接"（2026-06-06，同 session）
- 对 §4.5 完整规格做最终把关；Codex 指出 3 阻断（fetch↔worker 矛盾、SkillExecutor 签名、cancellation 三件套）+ 2 建议。
- 我逐条据实验证后修正（含 `skillExecutor.ts:1505` 真实签名、`sessionSseReplay.ts:15` 终态集），并清掉最后一处残留 "fetch" 措辞。
- **Codex 最终回复：可交接**。F13（F12 Phase 0 + Scope B Phase 1/2）实施规格交接就绪。
- 交付边界：本次为**规划交付**，工作树仅含本文档；F13 代码由实现方按 §4.5 执行（每阶段跑 6-trace 回归）。

### Round 7 —— Option 2 全量规划 + Codex 复审"可交接"（2026-06-06，同 session）
- 用户指示"继续"规划 Option 2，并定原则"早期一次做对、不要半成品"。
- 用户决策：T4 瘦身 capabilities、T5 4 runtime 全下沉、T13 真 opaque 续接。
- T6/T15 用户要求 Claude 自行从整体架构 + 产品视角定：均定为**彻底删除**（理由见 WS-D/WS-K）。
- 产出 §4.6：11 个工作流 WS-A…WS-K + 推荐执行顺序 + 全局验证。
- Codex 复审（本轮）：先非可交接，指出 4 缺口——T4 漏 `toolTransport`、WS-K 误把 focus-tracking 的
  `/interaction` 混入 intervention 删除（实测前端 `sql_result_table.ts`/`ai_panel.ts:3928` 在用）、
  WS-C 缺文件分类、WS-I 缺 SDK 可恢复性 gate。我逐条据实修正后，Codex 终审 **可交接**。
- 关键纠正记忆点：**`/interaction`//focus 是 focus tracking（保留），不是 intervention（删）**——误删会致前端 404。

### 规划阶段结论
**全部规划完成且 Codex 可交接**（F12 Phase 0 + F13 Scope B + Option 2 T1–T15）。本文档为实现方交接物。
实现方按各 WS 独立提交、独立回归（`.claude/rules/testing.md`）；动 IOrchestrator/snapshot/热路径/前端的 WS
另跑相关 e2e 与 `update-frontend.sh`，落地前 `npm run verify:pr`。

<!-- 后续轮次在此追加 -->
