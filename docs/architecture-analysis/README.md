# SmartPerfetto 架构深度分析（与代码对齐）

> 更新日期：2026-02-05  
> 范围：以当前 `backend/src/agent/` 的 **目标驱动 Agent** 主链路为准（trace-scoped，多轮对话可持续）。

本目录用于沉淀“可维护、可落地”的架构深度文档：不仅描述模块如何工作，也明确 **哪些已经实现**、**哪些是设计但未接入主链路**，避免“文档看起来很高级，实际系统仍像 pipeline + LLM 胶水”。

---

## 文档索引

| 文档 | 关注点 | 对应核心代码 |
|------|--------|--------------|
| [01-agent-driven-orchestrator.md](./01-agent-driven-orchestrator.md) | Orchestrator（薄协调层）与执行器路由 | `backend/src/agent/core/agentDrivenOrchestrator.ts` |
| [02-multi-round-conversation.md](./02-multi-round-conversation.md) | 多轮对话：follow-up、实体引用、上下文注入 | `backend/src/agent/context/enhancedSessionContext.ts` |
| [03-memory-state-management.md](./03-memory-state-management.md) | Memory：短期/长期、证据摘要、trace 隔离、持久化 | `backend/src/agent/state/traceAgentState.ts` |
| [04-strategy-system.md](./04-strategy-system.md) | Strategy：确定性流水线作为“工具”，以及如何与目标驱动 loop 融合 | `backend/src/agent/strategies/*` |
| [05-domain-agents.md](./05-domain-agents.md) | Domain Agents：Think‑Act‑Reflect、skills、动态 SQL 自主修复 | `backend/src/agent/agents/*` |

---

## 一句话结论（为什么以前“机械化”，现在如何避免）

SmartPerfetto 的核心升级点是：从“按固定 pipeline 走完就结束”变为围绕 **用户目标** 构建闭环：

**目标（Goal） → 假设空间（Hypotheses） → 实验（Experiments） → 证据（Evidence） → 结论（Conclusion） → 下一步（Next）**

并且把“已做过的实验/已获得的证据摘要/用户偏好”在每一轮都注入给模型（同一 trace），减少重复、遗漏与空洞复述。

---

## 架构总览（当前真实运行路径）

```
┌─────────────────────────────────────────────────────────────────────┐
│ AgentDrivenOrchestrator (Thin Coordinator)                           │
│ - trace-scoped EnhancedSessionContext                                 │
│ - TraceAgentState(目标/偏好/实验/证据摘要)                              │
│ - Executor routing (follow-up / strategy / hypothesis loop)          │
└─────────────────────────────────────────────────────────────────────┘
                │
        ┌───────┴─────────────────────────────────────────────────┐
        ▼                                                         ▼
┌───────────────────────────────┐                      ┌───────────────────────────┐
│ HypothesisExecutor（默认）      │                      │ StrategyExecutor（可选）    │
│ - 假设 + 实验循环               │                      │ - 确定性多阶段流水线         │
│ - 证据驱动 early stop（软预算） │                      │ - direct_skill 高性能阶段     │
└───────────────┬───────────────┘                      └──────────────┬────────────┘
                │                                                      │
                ▼                                                      ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │ Domain Agents（Frame/CPU/Binder/…）                                 │
        │ - skills as tools（YAML）                                           │
        │ - 动态 SQL 生成/验证/修复（当 skills 不够用且目标明确）               │
        └────────────────────────────────────────────────────────────────────┘
```

关键约束：
- **仅同一 trace**：所有记忆/状态以 `(sessionId, traceId)` 为 key，且有迁移时的 trace guard。
- **偏好预算是软约束**：默认偏好每轮 ≤3 个实验；但当结果不足时允许继续（最多到硬上限）。
- **结论必须含证据链摘要**：输出结构固定为“结论 / 证据链 / 不确定性与反例 / 下一步”。

---

## 推荐阅读顺序

1. `docs/ARCHITECTURE.md`：目标驱动 Agent 总览（短）
2. 本目录 `01/02/03`：编排 + 对话 + memory（主矛盾在这里）
3. `04/05`：策略与技能工具化（落地“像专家”体验的关键）

