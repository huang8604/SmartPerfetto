# Strategy 系统深度解析（确定性流水线作为“可调用工具”）

> 对齐版本：2026-02-05  
> 目标：把“稳定高频场景的确定性流水线”融入“目标驱动 Agent”闭环，而不是让系统退化成 pipeline + LLM 胶水。

---

## 0. 先给结论：Strategy 的正确定位

Strategy 的价值是：
- **把高频分析场景编码为可复用结构**（stages / tasks / interval extraction）
- **用 direct_skill 把高成本 LLM 环节从 hot path 移出去**
- **让输出结构稳定可预测**（有利于 UI、报告与对比）

但为了达到“目标驱动 Agent”的体验，Strategy 不应强制成为默认主链路；它更像一个**高质量的实验模板库**：

- 默认：HypothesisExecutor（假设 + 实验）驱动闭环
- Strategy：作为
  -（A）可直接执行的确定性 pipeline（在需要时/显式强制时）
  -（B）供 planner 复用的结构化 hint（在 hypothesis loop 中）

---

## 1. 核心类型与概念

位置：`backend/src/agent/strategies/types.ts`

### 1.1 FocusInterval（发现 → 深挖 的桥梁）

FocusInterval 是 stage 之间传递的“焦点区间”：
- id / processName / startTs / endTs
- label / priority
- metadata（非常关键：用于 direct_skill 参数映射、实体捕获、UI 展示）

### 1.2 StageTaskTemplate（阶段任务模板）

每个 stage 定义一组任务模板：
- `scope: global | per_interval`
- `executionMode: agent | direct_skill`
- `directSkillId`（direct_skill 模式）
- `paramMapping`（interval → skill params）
- `skillParams`（额外控制参数）

### 1.3 StagedAnalysisStrategy（策略定义）

一条策略本质是“stage 列表 + interval extraction + early stop”：
- `trigger(query)`：关键词/模式触发
- `stages[]`：有序阶段
- `extractIntervals(responses)`：从上一阶段响应中提取下一阶段 intervals
- `shouldStop(intervals)`：可选早停

---

## 2. 策略匹配：keyword-first + LLM fallback

位置：`backend/src/agent/strategies/registry.ts` + `backend/src/agent/core/strategySelector.ts`

目标：在“确定性快速路径”和“语义匹配”之间取得平衡：
- keyword：快、可控、可预测（默认优先）
- LLM：补充语义理解（当关键词不够用时）

匹配结果会产生：
- `strategy_selected` / `strategy_fallback` SSE 事件（可观测）
- `options.suggestedStrategy`（无论是否执行 pipeline，都传入 planner 作为结构化 hint）

---

## 3. 执行：StrategyExecutor（确定性流水线）

位置：`backend/src/agent/core/executors/strategyExecutor.ts`

### 3.1 两类任务：AgentTask vs DirectSkillTask

StrategyExecutor 会把 stage tasks split 为两路：
- **AgentTask**：走 message bus → Domain Agent（可包含 LLM reasoning）
- **DirectSkillTask**：直接调用 skill engine（纯 SQL/规则 + 极少 LLM），适合 per-frame deep dive

这种 split 是“性能可控”的关键：对帧级分析，direct_skill 可以显著降低延迟与成本。

### 3.2 Follow-up 优化：prebuilt intervals → 跳过 discovery stages

当 follow-up/drill-down 已经给出 intervals（或 incrementalScope 提供 focusIntervals）时：
- 直接跳过 discovery stage（避免重复找 session/frame）
- 如果 prebuilt 已经是 frame-level，则跳过 session_overview

### 3.3 预算语义：仅硬安全 cap

StrategyExecutor 中的 `maxRounds` 只作为“硬 stage 上限”：
- 防止异常策略/循环阶段导致跑飞
- 不把用户偏好预算（softMaxRounds）当硬 stop

原因：deterministic pipeline 的 stage 数量本身就是“结构的一部分”，更适合由策略定义控制。

### 3.4 历史注入（避免 pipeline 阶段失忆）

StrategyExecutor 在构建 AgentTask 时也会注入：
- `additionalData.historyContext = sessionContext.generatePromptContext(...)`

保证即便走 pipeline，也不会“每个阶段像第一次见到 trace”。

---

## 4. 典型案例：Scrolling Strategy（概览 → 会话 → 帧级）

位置：`backend/src/agent/strategies/scrollingStrategy.ts`

典型 3 阶段：
1. overview（global）：定位 scroll sessions + jank 概览
2. session_overview（per session）：生成 per-frame 列表与 metadata
3. frame_analysis（per frame, direct_skill）：`jank_frame_detail` 深挖

关键机制：
- `extractIntervals` 把“会话级”转为“帧级”（每帧一个 FocusInterval）
- 通过 metadata + paramMapping 把“帧详情需要的参数”在 interval 中携带
- 可将 L2 帧表延迟发射，待 L4 结果就绪后绑定 expandableData（更好的 UI 体验）

---

## 5. 在目标驱动 Agent 下：Strategy 如何“变聪明”而不是“变僵硬”

当默认走 HypothesisExecutor 时，Strategy 不执行，但其结构仍然有价值：

### 5.1 作为 suggestedStrategy（结构化 hint）

planner 可以复用 strategy 的 stages 作为“实验候选空间”，例如：
- 当前缺口在“帧级根因” → 直接选 frame_analysis 的 direct_skill
- 当前缺口在“会话级定位” → 选 overview/session_overview

### 5.2 作为“实验模板库”

建议未来增强：
- 为每个 stage/task 增加 capability 标签（产出哪些证据）
- planner 在“假设空间”里做信息增益最大化，而不是纯 LLM 自由发挥

---

## 6. Skills 在新架构下需要怎样的改造（工具化）

Strategy 的稳定性最终依赖 skills 的“证据可消费性”：

### 6.1 display.columns：建议使用富列定义

使用 `name/label/type/format` 的列定义能带来：
- UI 通用渲染更准确
- Evidence digest 能稳定抽取 KPI
- iterator 表格能从 nested results 中提取字段

### 6.2 synthesize：让 skill 产出确定性洞见摘要

推荐在关键步骤加：
- `synthesize: { role, fields, insights, ... }`

让“洞见”从 YAML 数据驱动产生，减少 LLM “复述表格”的机械化。

### 6.3 diagnostic：证据字段要可引用

diagnostic 规则尽量补 `evidence_fields`，否则只能 best-effort 从 condition 解析来源。

---

## 7. 下一步建议（Strategy × Agent 的真正融合）

1. **stage-cost 模型**：把 stage 的时延/数据量/LLM 次数纳入规划（质量优先但可控）
2. **矛盾消解 stage**：当出现冲突（例如 app jank vs consumer jank）时自动选择“能区分责任”的实验
3. **strategy-to-experiment 编译**：把 stages 编译为 hypothesis loop 的实验候选，统一闭环语义

