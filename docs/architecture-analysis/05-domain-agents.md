# Domain Agents 深度解析（让系统“像专家”而不是“跑流程”）

> 对齐版本：2026-02-05  
> 目标：解释 Domain Agents 如何围绕“目标/假设/证据/下一步”闭环工作，以及 skills 在新架构下需要怎样的工具化改造。

---

## 0. 先给结论：Domain Agents 的职责不是“生成漂亮文字”，而是“产出可验证证据”

一个真正可用的性能分析 Agent 必须能做到：
- 知道自己要验证什么（objective / hypothesis）
- 知道用哪个工具拿证据（skills / SQL）
- 发现工具失败时能修复（参数、SQL、前置模块）
- 产出可引用的证据（DataEnvelope / evidence digest）
- 在不确定时能主动向用户提问或请求干预（intervention）

Domain Agents 在 SmartPerfetto 中就是承载这些能力的“领域专家”层。

---

## 1. Domain Agents 清单与定位

位置：`backend/src/agent/agents/domain/*`

默认 8 个 agents（可扩展）：
- Frame / CPU / Binder / Memory
- Startup / Interaction / ANR / System

定位原则：
- **每个 Agent 对应一个稳定的“证据集合”**（它知道该域有哪些表/指标/常见机制）
- **skills 是它的工具箱**（YAML 定义 SQL/规则/展示）
- **LLM 是协调与补洞**（不是替代证据）

---

## 2. BaseAgent：Think‑Act‑Reflect 闭环（可控的自主性）

位置：`backend/src/agent/agents/base/baseAgent.ts`

BaseAgent 提供统一的执行模板：

1. Understand：把任务描述转成 objective + questions + constraints
2. Plan：选择工具与步骤（skills 为主）
3. Execute：按序执行工具（并记录观测）
4. Reflect：评估证据是否满足目标、识别缺口与矛盾
5. Respond：输出 findings（带 evidence/置信度）+ hypothesis update + next steps

关键点：
- **工具调用是结构化的**（不是让 LLM “随口写 SQL”）
- **失败可恢复**（见动态 SQL upgrade）
- **上下文可承接**（historyContext 注入）

---

## 3. “多轮不遗忘”在 Agent 侧如何实现

### 3.1 historyContext 注入

Orchestrator / Executor 会把 `sessionContext.generatePromptContext(...)` 放入每个任务的：
- `task.context.additionalData.historyContext`

BaseAgent 会将其写入 prompt（并有长度保护），确保 agent 知道：
- 用户目标与偏好（含 soft 预算）
- 最近实验与证据摘要
- 过去几轮的关键发现与可引用实体

### 3.2 为什么这能减少机械化

没有 historyContext 时，LLM 很容易：
- 复述当前 skill 表格（缺洞见）
- 重复跑已做过的实验（浪费）
- 忘记用户真正关心的对象（偏题）

historyContext 把“已做过/已得到”变成强约束输入，Agent 更像在做连续推理。

---

## 4. Skills 作为工具：需要“证据可消费”

Domain Agents 的主要工具是 skills（YAML）。为了支持 goal-driven loop，skills 的输出必须满足：

### 4.1 证据可展示（UI）

- `display.layer` 分层（overview/list/deep）
- `display.columns` 用富列定义（name/label/type/format）而不是只给字符串
- iterator 的 L2 列表需要能绑定 L4 expandableData（可 drill-down）

### 4.2 证据可引用（Agent/结论）

建议：
- 关键步骤加 `synthesize:`（role/fields/insights）生成确定性“洞见摘要”
- diagnostic 规则带 `evidence_fields`，让 findings.details 含可引用数据

效果：
- 减少 LLM “看大表复述”的机械化
- 结论可以更像“证据链推理”

---

## 5. 动态 SQL Upgrade：当 skills 不够用时的自主补洞

位置：`backend/src/agent/agents/base/baseAgent.ts` + `backend/src/agent/tools/sqlGenerator.ts` + `backend/src/agent/tools/sqlValidator.ts`

触发时机（概念）：
- 预置 skills 返回空/失败
- 任务 objective 明确（可以用 SQL 补证据）

执行流程（简化）：
1. 生成 SQL（带 objective、约束、可用表提示）
2. 静态验证（风险/表依赖/危险语句）
3. 执行 SQL
4. 若失败：有限次数修复（repair）再重试

关键约束：
- 有最大重试次数（防止跑飞）
- validator 可拒绝高风险 SQL（可继续增强）

这条路径决定了 Agent “像专家”还是“像脚本”：
- 脚本：skill 不行就报错
- 专家：知道如何换方法拿证据，并能修复错误

---

## 6. findings / evidence / DataEnvelope：从工具输出到“可推理结论”

### 6.1 skill → DataEnvelope（给前端）

SkillExecutor 会把 DisplayResults 转为 DataEnvelope（v2 data contract）：
- UI 可通用渲染（表格/summary/层级）
- executor 可对 envelope 做去重与延迟绑定（expandableData）

### 6.2 tool output → evidence digest（给后续轮次）

EnhancedSessionContext 会把 toolResults 压缩为 evidence digest 写入 TraceAgentState：
- 保留 provenance（agentId/skillId/scopeLabel/timeRange 等）
- 控制体积（截断、上限、去重）

### 6.3 findings（给结论）

Domain Agent 需要产出：
- 明确标题（问题是什么）
- 描述（为什么是问题/影响）
- details（关键数据/证据）
- 置信度（便于收敛与对话）

结论生成器会把 findings 组织为“结论 + 证据链摘要”。

---

## 7. 什么时候该问用户（Intervention / Clarify）

当出现以下情况时，Agent/Executor 应更像专家一样“停下来问”：
- 证据不足以区分 2 个机制（歧义）
- 继续实验成本高但收益不确定（需要用户偏好）
- 用户没有提供关键对象（frame_id/session_id/时间范围/进程）

对应机制：
- executor 提交 `interventionRequest`
- 或 follow-up `clarify` 走 ClarifyExecutor（只读解释，不跑 SQL）

---

## 8. Skills 是否需要改造？（结论）

需要，但改造方向不是“加更多 LLM”，而是“更工具化、更证据优先”：

1. **输出列定义与摘要**：`display.columns` 富定义 + `synthesize` 洞见摘要
2. **诊断携带证据**：diagnostic 的 evidence_fields / inputs 设计
3. **失败可解释**：明确 prerequisites、on_empty、optional；让 Agent 能基于错误选择下一步（修复/换证据）

这会直接提升“洞见感”和“多轮承接感”。

