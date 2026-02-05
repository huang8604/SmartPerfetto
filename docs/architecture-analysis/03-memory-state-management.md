# Memory & State Management 深度解析（短期/长期 + trace 隔离）

> 对齐版本：2026-02-05  
> 核心目标：让系统具备“可持续推理的记忆”，同时保证 **不跨 trace 泄漏**、不无限膨胀、可持久化恢复。

---

## 0. 先给结论：SmartPerfetto 需要两种 memory

用户说的“长期/短期 memory”在 SmartPerfetto 里应对应两类不同的职责：

### 0.1 短期 memory（本轮决策所需）

用于支持“下一步实验怎么选”的即时推理：
- 最近 turns 的摘要（不是原文全文）
- 当前目标（Goal）
- 最近实验（Experiments）
- 最近证据摘要（Evidence digests）
- 当前关注点（Focus）

实现载体：`EnhancedSessionContext.generatePromptContext(maxTokens)`

### 0.2 长期 memory（跨轮次稳定状态）

用于避免“做过的事丢了、证据链断裂、偏好丢失”：
- Goal & Preferences（含 soft 预算）
- 实验记录（每轮 objective/status/evidence）
- 证据摘要（digest + provenance）
- 矛盾记录（待消解）
- Entity cache（可 drill-down 的 frame/session/...）
- FocusStore（用户关注点）

实现载体：`TraceAgentState` + `EntityStore` + `FocusStore`，并可落盘。

---

## 1. 不变式：必须严格 trace-scoped

### 1.1 内存态：SessionContextManager 的复合 key

位置：`backend/src/agent/context/enhancedSessionContext.ts`

- key = `sessionId::traceId`
- 同一 sessionId 切换 traceId 会清理旧 trace context（防止污染）

### 1.2 持久态：TraceAgentState 迁移守卫

位置：`backend/src/agent/state/traceAgentState.ts`

`migrateTraceAgentState(snapshot, expected)` 会校验 snapshot 内的 sessionId/traceId；不匹配直接创建新 state。

---

## 2. 内存对象分层（当前真实实现）

### 2.1 EnhancedSessionContext（会话上下文）

位置：`backend/src/agent/context/enhancedSessionContext.ts`

持有：
- `turns`：本 trace 的多轮对话记录（带 turnIndex）
- `findings`：findingId → Finding
- `findingTurnMap`：findingId → turnId
- `EntityStore`：实体缓存 + “是否已分析”追踪
- `workingMemory`：从结论中确定性抽取的语义摘要（短文本）
- `TraceAgentState`：目标驱动 durable state

### 2.2 TraceAgentState（durable state）

位置：`backend/src/agent/state/traceAgentState.ts`

关键字段与用途：
- `goal`：用户目标（intent 可更新 normalizedGoal）
- `preferences`：默认 loop 模式、输出视图、maxExperimentsPerTurn（偏好预算）
- `experiments`：实验记录（用于“我已经查过 X，不要重复”）
- `evidence`：证据摘要（用于“证据链摘要/引用”）
- `contradictions`：矛盾（用于“下一步实验优先消解冲突”）

---

## 3. 有界增长（避免 memory 膨胀）

当前主链路在写入 TraceAgentState / workingMemory 时有明确上限：

- `TraceAgentState.turnLog`：保留最近 30
- `TraceAgentState.evidence`：总量上限 500（每次 ingest 最多新增 40）
- `TraceAgentState.experiments`：保留最近 80
- `TraceAgentState.contradictions`：保留最近 40
- `EnhancedSessionContext.workingMemory`：保留最近 12

设计原则：
- **长期 memory 存“摘要 + provenance”，不存大表**（大表通过 DataEnvelope/SSE 给前端）
- **摘要要可 dedupe**：digest 保持稳定、适度截断，避免每次执行都膨胀

---

## 4. 证据摘要（Evidence digests）：从“文本复述”到“可引用链路”

### 4.1 为什么需要 evidence digest

LLM 直接读表格会出现两类问题：
- 机械化复述（缺洞见）
- 多轮后遗忘/重复（缺闭环）

Evidence digest 的目标是把“工具输出”压缩成可注入 prompt 的短证据片段，并保留 provenance：
- agentId / skillId / scopeLabel / timeRange / stageName / round 等

实现入口：`EnhancedSessionContext.ingestEvidenceFromResponses(responses)`

### 4.2 digest 的边界

digest 不是为了复现整张表：
- 仅保留 rowCount、表标题、关键 KPI 片段、错误摘要、少量 sample
- 严格截断（稳定性与去重优先）

---

## 5. Prompt 注入策略（短期 memory 的工程化落点）

入口：`EnhancedSessionContext.generatePromptContext(maxTokens)`

内容结构（高层）：
- 目标与偏好（Goal/soft budget）
- 最近实验（3 条）
- 证据摘要（8 条）
- 矛盾摘要（3 条）
- working memory（最多 6 条）
- 最近 3 轮 turns 摘要（含可引用实体）

末端保护：
- 粗略 token 估算（中文按 4 chars/token）
- 超限按比例截断（保证不炸上下文）

---

## 6. 持久化（跨重启恢复）

位置：`backend/src/services/sessionPersistenceService.ts`

SmartPerfetto 会把以下快照写入 `sessions.metadata`：
- `sessionContextSnapshot`：`EnhancedSessionContext.serialize()`
- `entityStoreSnapshot`：EntityStore（便于快速恢复 drill-down 能力）
- `focusStoreSnapshot`：FocusStore（恢复关注点与增量范围）
- `traceAgentStateSnapshot`：TraceAgentState（目标/偏好/实验/证据）

这解决“服务重启后多轮对话断档”的问题。

---

## 7. 现存但未接入主链路的组件（需要明确标注）

仓库内仍存在一些“设计得很完整”的模块（如 ContextCompactor、Fork/Checkpoint），但它们**不一定已经接入 agent-driven 主链路**。

建议策略：
- 文档中明确“是否已接入主链路”
- 若未接入：要么补齐接入点，要么标记 legacy/deprecated，避免误导

---

## 8. 下一步建议（真正让 memory 成为推理资产）

1. **矛盾→实验闭环**：contradictions 进入 planning，优先选择能消解冲突的数据/实验
2. **证据链可追溯**：finding 增加 evidenceIds（指向 TraceAgentState.evidence），让结论可自动生成链路摘要
3. **偏好可调**：允许用户显式设置“快/准/可解释”，并映射到 soft budget、策略选择与输出视图

