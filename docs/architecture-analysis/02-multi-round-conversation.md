# 多轮对话设计深度解析（同一 trace 的连续推理）

> 对齐版本：2026-02-05  
> 目标：让用户感觉在和“懂 Android + 懂当前 trace”的专家对话，而不是每轮重新跑一遍 pipeline。

---

## 0. 先给结论：多轮对话的核心不是“存聊天记录”，而是“存可用状态”

多轮对话想要不机械，必须让模型每轮都能清楚回答三件事：

1. **用户目标是什么**（Goal / Done-when）
2. **我们已经做了哪些实验、拿到了哪些证据**（Experiments / Evidence digests）
3. **下一步为什么要做这个，而不是别的**（Hypothesis space + 信息增益）

因此 SmartPerfetto 的多轮对话不是靠“拼接全部历史文本”，而是靠 trace-scoped 的结构化状态：

- `EnhancedSessionContext`：turns/findings/entity store/working memory
- `TraceAgentState`：目标/偏好/实验/证据摘要/矛盾（durable）
- `EntityStore`：可 drill-down 的实体缓存（frame/session/...）
- `FocusStore`：用户关注点（实体/时间段/指标/问题）与增量范围

---

## 1. 不变式：必须严格 trace-scoped（“仅同一 trace”）

### 1.1 复合 key（sessionId, traceId）

- 内存态：`SessionContextManager` 使用 `sessionId::traceId`
- 迁移态：`migrateTraceAgentState` 校验 sessionId/traceId，不接受跨 trace snapshot

### 1.2 为什么这很重要

跨 trace 的“知识迁移”在性能诊断里极易制造幻觉：
- 同名进程/线程不等价
- frame_id/session_id 在不同 trace 中没有语义关联
- 证据链一旦混入错 trace，会让结论“看起来很合理但完全错误”

因此：默认禁止跨 trace memory；若未来要做跨 trace，需要用户明确授权 + 隔离设计（不在当前默认架构内）。

---

## 2. 核心数据结构（多轮对话真正依赖的“记忆”）

### 2.1 EnhancedSessionContext（会话上下文）

位置：`backend/src/agent/context/enhancedSessionContext.ts`

职责：
- turn 管理：`addTurn(...)` / `getAllTurns()`
- findings 库：`getAllFindings()`（并维护 finding↔turn 映射）
- 上下文摘要：`generatePromptContext(maxTokens)`
- working memory：从结论中确定性抽取（减少“last N turns”机械遗忘）
- 持有 `EntityStore` 与 `TraceAgentState`

### 2.2 TraceAgentState（目标驱动 durable state）

位置：`backend/src/agent/state/traceAgentState.ts`

关键字段：
- `goal`：用户目标（可被 intent 逐步归一化）
- `preferences`：默认 loop 模式、软预算、输出视图等
- `experiments`：每轮实验记录（objective / status / producedEvidenceIds）
- `evidence`：证据摘要（digest + provenance）
- `contradictions`：矛盾（脚手架，逐步增强）

### 2.3 EntityStore（实体缓存 + 可引用实体）

位置：`backend/src/agent/context/entityStore.ts`

核心能力：
- `upsertFrame/upsertSession/...`：写入实体（字段合并）
- `wasFrameAnalyzed/markFrameAnalyzed`：增量分析与 extend 的基础
- `setLastCandidateFrames/getUnanalyzedCandidateFrames`：候选列表（extend 批处理）

### 2.4 FocusStore（用户关注点）

位置：`backend/src/agent/context/focusStore.ts`

用途：
- 记录用户显式/隐式关注：点击、drill-down、compare、extend、query
- 用 decay 权重表达“最近更重要”
- 供 `IncrementalAnalyzer` 决定本轮增量范围

---

## 3. Follow-up 类型：分类的目的不是“做 NLP”，而是“选正确的执行器”

Intent 里 follow-up 类型（`followUpType`）直接决定“本轮要不要跑 SQL、跑多少、以及怎么复用缓存”：

| Follow-up 类型 | 执行器 | 是否跑 SQL | 关键目标 |
|---|---|---|---|
| `drill_down` | DirectDrillDownExecutor | 是（聚焦区间） | 深挖某个 frame/session/时间段 |
| `clarify` | ClarifyExecutor | 否（只读） | 解释上一轮发现/概念 |
| `extend` | ExtendExecutor | 是（批量） | 在同类候选中继续补覆盖 |
| `compare` | ComparisonExecutor | 否（优先缓存） | 多实体对比（差异 + 证据） |
| `initial` | HypothesisExecutor（默认）或 StrategyExecutor（可选） | 是 | 目标驱动探索/验证 |

> 关键变化：即便 strategy 匹配成功，默认仍优先 hypothesis+experiments（质量优先、闭环优先）。

---

## 4. 引用解析：如何把“你刚才说的那一帧”变成可执行的参数

### 4.1 DrillDownResolver 的优先级（cache-first）

位置：`backend/src/agent/core/drillDownResolver.ts`

解析顺序（由强到弱）：
1. **显式值**：`ReferencedEntity.value`（若带 start_ts/end_ts 直接可用）
2. **EntityStore 命中**：已有 frame/session 且 timestamps 完整（0 SQL）
3. **从 Findings 中解析**：上一轮 findings.details 中有实体与时间范围
4. **SQL enrichment**：轻量查询补齐 timestamps（并回写 EntityStore）
5. **失败**：返回 null → Orchestrator 选择降级路径（提示用户或回到概览）

### 4.2 为什么要 cache-first

用户的 follow-up 期望是“立即承接”，不是“再跑一遍全局发现”：
- cache hit：通常 < 0.5s（直接进入 deep skill）
- cache miss：需要 enrichment（仍比全局 pipeline 更快）

---

## 5. “每一轮都要给模型什么”：上下文注入点（非常关键）

多轮对话的失败往往来自“只把当前问题给 LLM”。SmartPerfetto 的做法是把 `generatePromptContext()` 产物注入到 3 个关键位置：

### 5.1 任务规划（Hypothesis loop）

- `planTaskGraph(..., hints.historyContext)`
- 目标：避免重复实验、沿着未覆盖的证据缺口规划

### 5.2 Agent 执行（Domain Agents）

- 每个 AgentTask 的 `additionalData.historyContext`
- BaseAgent 会把它写入 prompt：目标/偏好/近期实验/证据摘要/最近 turns
- 目标：让 agent “知道之前已经查过什么”

### 5.3 结论生成（Conclusion）

- `generateConclusion(..., options.historyContext)`
- 目标：输出“结论 + 证据链摘要”，并显式呈现不确定性与下一步

---

## 6. 常见多轮问题与修复策略

### 6.1 机械化复述（LLM 只会总结表格）

修复要点：
- skills 用 `synthesize:` 产出确定性“洞见摘要”，减少 LLM 看大表
- evidence digests 让 LLM 有可引用的、短而稳定的证据片段

### 6.2 重复实验（每轮都跑 scrolling overview）

修复要点：
- EntityStore + FocusStore → IncrementalAnalyzer 决定增量范围
- follow-up drill_down 直接绕过 discovery stage

### 6.3 “忘记用户目标”（多轮后偏题）

修复要点：
- TraceAgentState.goal 持久化并进入 prompt
- working memory 从结论中抽取“稳定目标/已确认结论/下一步”

---

## 7. 建议的后续增强（让对话更像专家）

1. **把矛盾变成一等公民**：`TraceAgentState.contradictions` 进入 planning，优先做“能消解冲突”的实验
2. **可解释的覆盖度**：输出“哪些域/哪些实体/哪些时间段已覆盖”，指导用户提问与系统选择下一步
3. **偏好闭环**：允许用户明确设置“更快/更准/更可解释”，并映射到预算、策略与输出视图

