# AgentDrivenOrchestrator 深度解析（目标驱动 Agent 主链路）

> 对齐版本：2026-02-05  
> 范围：`backend/src/agent/core/agentDrivenOrchestrator.ts` 及其直接依赖  
> 目标：解释“为什么它更像 Agent 而不是 pipeline”，以及关键闭环如何形成。

---

## 0. 先给结论：Orchestrator 的职责边界（Thin Coordinator）

AgentDrivenOrchestrator 不是“把所有能力写在一个文件里的超级大脑”，它应当是薄协调层，主要做 6 件事：

1. **trace-scoped 状态装配**：获取 `EnhancedSessionContext(sessionId, traceId)`，初始化/恢复 `TraceAgentState`（目标/偏好/实验/证据摘要）。
2. **理解本轮意图**：`understandIntent(...)` + follow-up 分类（drill_down/extend/compare/clarify）。
3. **决定本轮“怎么跑”**：选择 executor（Hypothesis loop / Strategy pipeline / Follow-up executors）。
4. **将结果变成“可持续记忆”**：把 tool 输出压缩为 evidence digest（写入 TraceAgentState），把结论抽取为 working memory。
5. **生成“结论 + 证据链摘要”**：`generateConclusion(...)` 强制结构化输出，减少模板化复述。
6. **可观测与可控**：SSE 事件、CircuitBreaker、Intervention（不确定时请求用户选择方向）。

> 重要：Orchestrator 不应该直接写大量业务分析 SQL。SQL/规则应落在 skills（YAML）与 domain agents 工具层。

---

## 1. 不变式（必须长期保持的系统约束）

### 1.1 严格 trace-scoped（防跨 trace 泄漏）

- SessionContextManager 的 key：`sessionId::traceId`（`backend/src/agent/context/enhancedSessionContext.ts`）
- TraceAgentState 的迁移守卫：`migrateTraceAgentState(expected: { sessionId, traceId })`

含义：即便 sessionId 相同，切换 traceId 也必须创建新上下文，避免“上一条 trace 的结论污染下一条”。

### 1.2 预算语义：软偏好 vs 硬上限（质量优先）

用户偏好是“每轮最多实验数”（默认 3），但用户明确允许“没有硬约束，以结果为准”。

因此：
- `config.softMaxRounds`：**偏好预算**（到达后仅当结果足够好才收敛）
- `config.maxRounds`：**硬安全上限**（防跑飞）

这解决了“3 轮就停导致结论质量被预算绑架”的问题。

### 1.3 每轮必须注入“同一 trace 的历史上下文”

Orchestrator 要保证 domain agents 与 conclusion 生成时都能看到：
- 目标与偏好（Goal/Preferences）
- 最近实验记录（Experiments）
- 可引用证据摘要（Evidence digests）
- 已确认发现（Findings）与可 drill-down 的实体（EntityStore）

实现点：
- `EnhancedSessionContext.generatePromptContext(...)` 生成压缩上下文
- 任务规划：`planTaskGraph(..., hints.historyContext)`
- agent 执行：`additionalData.historyContext` 注入到 `BaseAgent` prompt
- 结论生成：`generateConclusion(..., options.historyContext)`

---

## 2. analyze() 的真实执行路径（按“体验影响”排序）

### 2.1 Session 与 Goal 状态装配

1. `sessionContextManager.getOrCreate(sessionId, traceId)`
2. `sessionContext.getOrCreateTraceAgentState(query)`：把用户首句作为 goal seed（后续可被 intent 归一化）
3. 发射 `progress: agent_state_loaded`（便于前端观测）

### 2.2 ADB context（可选协作能力，默认只读）

- `detectAdbContext(options.adb, traceProcessorService, traceId)`
- 写入 `sharedContext.userContext.adb`
- 强约束：除非明确 full，否则工具层不允许改变设备状态

### 2.3 Trace 配置检测（refresh rate / vsync）

目的：避免“用错帧预算导致 jank 误判/矛盾”。

- `detectTraceConfig(...)` 写入 `sharedContext.traceConfig`
- 同时镜像到 `sharedContext.globalMetrics.*`（兼容旧链路）

### 2.4 意图理解 + follow-up 解析

- `understandIntent(query, sessionContext, modelRouter, emitter)`：识别 followUpType、引用实体、目标描述
- `resolveFollowUp(intent, sessionContext)`：把“引用实体/前一轮发现”解析成可执行参数
- drill_down 进一步通过 `resolveDrillDown(...)` 获取精确 intervals（cache 优先、SQL enrichment 兜底）

### 2.5 Focus 记录 + 增量范围（Incremental Scope）

为“像专家一样承接上下文”提供结构化输入：

- `FocusStore`：记录用户最近关注（实体/时间段/指标/问题）
- `IncrementalAnalyzer`：结合 Focus + EntityStore + 历史 findings，决定本轮是 full 还是 incremental

收益：避免 follow-up 每次都从“全局概览”重跑一遍。

### 2.6 Executor 路由（从 pipeline 走向 goal-driven loop）

路由优先级（从最确定到最自适应）：

1. `clarify` → `ClarifyExecutor`（只读解释，不跑 SQL）
2. `compare` → `ComparisonExecutor`（多实体对比）
3. `extend` → `ExtendExecutor`（增量补分析未覆盖实体）
4. drill_down（有 intervals）→ `DirectDrillDownExecutor`（针对区间直接跑）
5. 其余 → strategy match（keyword-first + LLM fallback）
   - 默认偏好（`TraceAgentState.preferences.defaultLoopMode = hypothesis_experiment`）时：即便匹配到 strategy，也**把 strategy 作为 suggested hint**，仍走 `HypothesisExecutor`
   - 仅当 `SMARTPERFETTO_FORCE_STRATEGY=1` 或偏好切换时才执行 `StrategyExecutor`

这一步是关键变化：**strategy 不再是唯一正确路径，而是 agent 可调用的一类工具/脚手架**。

### 2.7 执行 + 证据写回（让后续轮次更聪明）

executor 产出：
- `findings`（本轮新增）
- `capturedEntities`（写入 EntityStore）
- `analyzedEntityIds`（标记已分析，供 extend）
- `interventionRequest`（需要用户选择方向）

同时，tool 输出会被压缩为 evidence digest（写入 TraceAgentState），用于：
- 后续 prompt 注入（避免重复与遗忘）
- 结论中的“证据链摘要”
- 矛盾/反例的可解释记录（逐步增强）

### 2.8 Intervention：不确定时与用户协作

当满足以下条件之一时，executor 可以请求 intervention：
- 置信度过低（low confidence）
- 多方向歧义（ambiguity）
- 超时或长时间无有效进展（timeout / no progress）

Orchestrator 会把 intervention 转换为前端可选择的 options（继续 / 聚焦某方向 / 结束）。

### 2.9 结论生成 + 多轮记忆更新

`generateConclusion(...)` 的输出约束：
- 固定 4 段：`结论 / 证据链 / 不确定性与反例 / 下一步`
- 结论最多 3 条，且必须引用已提供的 findings/数据
- follow-up 时优先回答本轮焦点，避免复述历史长文

本轮落盘（为下一轮“更像专家”）：
- `sessionContext.addTurn(...)`：保存 turn 与 findings
- `sessionContext.updateWorkingMemoryFromConclusion(...)`：确定性抽取摘要（减少机械化遗忘）
- `sessionContext.recordTraceAgentTurn(...)`：写 TraceAgentState.turnLog（审计线）

---

## 3. 可观测性（SSE / DataEnvelope）

关键事件（部分）：
- `progress`：轮次/阶段/降级原因（可带 softMaxRounds）
- `finding`：实时 findings 推送
- `stage_transition`：strategy pipeline stage 变更
- `strategy_selected` / `strategy_fallback`：策略匹配与回退原因
- `sql_generated` / `sql_validation_failed`：动态 SQL upgrade 观测点
- `degraded`：模块降级（fallback）

数据输出统一为 DataEnvelope（v2 data contract），并通过“turn scoped registry”去重，避免 UI 重复渲染。

---

## 4. 设计复盘：当前强项与仍需补齐的点

### 已解决的“机械化来源”

- “每轮只看本轮输入” → `generatePromptContext + historyContext` 全链路注入
- “预算导致早停” → 软预算 + 硬上限（质量优先）
- “skills 不够用就失败” → BaseAgent 动态 SQL 生成/验证/修复（有限次数）

### 建议继续增强（下一阶段）

1. **矛盾驱动实验**：把 `TraceAgentState.contradictions` 真正接入 planning（优先做能消解矛盾的实验）
2. **实验成本模型**：为每个 skill/agent 标注 cost（时延/数据量/LLM 次数），让 planner 做信息增益/成本权衡
3. **更强的 stop 条件**：除了 confidence，还要考虑 coverage 与关键缺口（gaps）
4. **strategy 结构复用**：当匹配到 strategy 但走 hypothesis loop 时，可把 stages 转为实验候选（比纯 LLM 规划更稳定）

