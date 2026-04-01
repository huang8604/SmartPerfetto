# SmartPerfetto 架构文章 Q&A

> 这篇文章收集了[《从 Trace 到洞察：SmartPerfetto AI Agent 的 Harness Engineering 实战》](./architecture-deep-dive.md)发布后收到的技术问题，以问答形式展开讨论。

---

## Q1：为什么不用 Claude Code 的标准 Skill 系统，而要自建 YAML Skill？

**提问背景：** Claude Code 的 Skill 系统支持 `scripts/` 目录放确定性脚本，避免 LLM 泛化。既然可以用 scripts/ 执行固定的 SQL，为什么还要自建一套 YAML Skill 系统？YAML Skill 是不是本质上是一个让性能工程师按预定义规则执行 SQL 的工具？

### 关键区分：两套 Skill 不在同一个层面

Claude Code Skills 和 SmartPerfetto YAML Skills 解决的是不同阶段的问题：

```
开发阶段（我写代码时）:
  Claude Code + Skills/Hooks → 帮我开发 SmartPerfetto

运行阶段（用户分析 trace 时）:
  SmartPerfetto Backend + YAML Skills → 帮用户分析性能数据
```

Claude Code 的 Skill 运行在开发者的终端里，是 CLI 工具的扩展。SmartPerfetto 的 YAML Skill 运行在 Express 后端的 Skill Engine 中，是 Agent 在运行时通过 MCP 工具 `invoke_skill` 调用的分析单元。两者的执行环境、调用方式、数据流完全不同。

### 即使只看「确定性执行」，YAML Skill 有几个针对性设计

**1. 参数化 SQL，不是固定脚本**

性能分析的 SQL 不是写死的——同一个 Skill 需要接受不同的参数（进程名、时间范围、帧 ID 列表）：

```yaml
steps:
  - id: thread_state_distribution
    type: atomic
    sql: |
      SELECT state, SUM(dur) as total_dur
      FROM thread_state ts
      JOIN thread_track tt ON ts.track_id = tt.id
      WHERE tt.utid = ${main_thread_utid}
        AND ts.ts BETWEEN ${start_ts} AND ${end_ts}
      GROUP BY state
```

`${main_thread_utid}` 和 `${start_ts}` 是 Claude 调用 `invoke_skill` 时传入的参数。YAML Skill Engine 做参数替换后执行 SQL。如果用 scripts/，要么写 shell 脚本接收参数拼 SQL（容易出注入问题），要么写完整的 Python/Node 脚本——复杂度比 YAML 高很多。

**2. 自描述的输出格式（DataEnvelope）**

```yaml
    display:
      level: detail
      columns:
        - { name: state, type: string }
        - { name: total_dur, type: duration }
```

每个 step 声明了输出列的名称和类型。前端根据这个 schema 自动渲染表格——`duration` 类型自动格式化为 ms，`timestamp` 类型支持点击跳转到 Perfetto 时间线。scripts/ 方式的输出是自由文本，前端没法自动渲染。

**3. 可组合（composite + iterator）**

一个 composite Skill 可以引用多个 atomic Skill，iterator 可以遍历数据行逐帧分析。这种组合在 YAML 中是声明式的，Skill Engine 负责编排执行。scripts/ 方式要实现同样的组合需要自己写编排逻辑。

**4. 面向性能工程师，不是面向开发者**

提问者说对了：YAML Skill 本质上是一个让性能工程师按预定义规则贡献分析逻辑的工具。性能工程师知道该查什么 SQL、该看什么指标，但不一定会写 TypeScript。YAML 格式让他们直接定义 SQL 查询和输出格式，不需要碰后端代码。修改后 DEV 模式刷新浏览器即可生效。

### 对比总结

| 维度 | Claude Code scripts/ | SmartPerfetto YAML Skill |
|------|---------------------|--------------------------|
| 运行环境 | 开发者终端 (CLI) | Express 后端 (runtime) |
| 调用者 | 开发者通过 `/skill` 命令 | Agent 通过 `invoke_skill` MCP 工具 |
| 参数化 | 需要自己处理 | `${param|default}` 内置支持 |
| 输出格式 | 自由文本 | DataEnvelope (schema-driven) |
| 前端渲染 | 不涉及 | 自动表格/图表 |
| 组合能力 | 手动编排 | composite / iterator / conditional |
| 贡献门槛 | 需要写脚本 | 只写 YAML + SQL |

两者不是替代关系，而是在不同层面解决不同问题。

---

## Q2：「确定性 + 灵活性混合」具体是怎么实现的？

**提问背景：** 文章说「已知场景用 Strategy 文件约束必检项，但每个阶段内的具体查询和深钻方向由 Claude 自主决定」。这个约束和自主之间的边界在哪里？具体是怎么做到的？

### 三层机制配合

这个混合设计靠三层机制配合实现：Strategy 文件定义「必须做什么」，Planning Gate 强制「先计划再执行」，Verifier 事后检查「是否真的做了」。

### 第一层：Strategy 文件 — 有硬约束也有软指引

以滑动分析的 `scrolling.strategy.md` 为例，它定义了多个分析阶段，但每个阶段的约束强度不同：

**硬约束（必须执行，跳过会触发验证错误）：**

Phase 1.9 根因深钻是最严格的阶段，策略文件里直接用了 🔴 标记和「禁止」字样：

```markdown
**Phase 1.9 — 根因深钻（🔴 强制执行，不可跳过）：**

对 `batch_frame_root_cause` 中占比 >15% 的每个 reason_code，
**必须**选最严重的 1 帧执行深钻。
**⛔ 禁止**仅靠 batch_frame_root_cause 的统计分类直接出结论。

| 条件                    | 深钻动作                                    |
| 任何 reason_code Q4>20% | invoke_skill("blocking_chain_analysis", ...) |
| binder_overlap >5ms     | invoke_skill("binder_root_cause", ...)       |
| ...
```

**软指引（建议但可跳过）：**

Phase 1.5（架构感知分支）和 Phase 1.7（根因分支）用的是「建议」「改用」等措辞，Claude 可以根据实际数据决定是否执行：

```markdown
**Phase 1.5 — 架构感知分支：**

| 架构      | 调整动作 |
| Flutter   | 改用 flutter_scrolling_analysis |
| WebView   | 注意 CrRendererMain 线程 |
```

Strategy 文件的全部内容被原文注入 System Prompt，注入时加了一行硬性说明：

```
场景策略（必须严格遵循）
对于以下常见场景，已有验证过的分析流水线。必须完整执行所有阶段，不可跳过。
```

Claude 直接在 System Prompt 中看到这些阶段定义、🔴 标记和「禁止」字样。

### 第二层：Planning Gate — 强制先计划，但不限制计划内容

Claude 在执行任何 SQL 查询或 Skill 调用之前，必须先调用 `submit_plan` 提交分析计划。没有提交计划就调用 `execute_sql` 或 `invoke_skill` 会被直接拒绝：

```typescript
function requirePlan(toolName: string): string | null {
  if (analysisPlanRef.current) return null;  // 已有计划，放行
  return `必须先调用 submit_plan 提交分析计划，然后才能使用 ${toolName}`;
}
```

关键点在于：**Gate 只要求计划存在，不要求计划和 Strategy 的阶段完全对应。** Claude 可以提交任何结构的计划——它可以把 Phase 1 和 1.5 合并，可以加入 Strategy 没提到的额外步骤，也可以根据初步数据调整深钻方向。

提交计划时，系统会做场景感知的关键词检查（比如滑动场景检查计划中是否提到了「帧」「jank」等词），但这只是 **warning 级别**——计划即使不包含这些词也会被接受。

这个设计的目的是：强制 Claude 在动手之前先想清楚要做什么（规划纪律），但不限制它怎么想（规划自由）。

### 第三层：Verifier — 事后检查关键步骤是否执行

计划和执行之间可能有偏差——Claude 可能提交了计划但实际跳过了某个关键步骤。Verifier 在分析结束后做事后检查：

```typescript
// 滑动场景：检查是否有显著掉帧但没做 Phase 1.9 深钻
case 'scrolling': {
  const hasSignificantJank = /* 检测文本中是否提到大量掉帧 */;
  const hasDeepDrill = /* 检测是否调用了 blocking_chain / binder_root_cause 等 */;
  if (hasSignificantJank && !hasDeepDrill) {
    issues.push({
      severity: 'error',
      message: '滑动分析有掉帧但缺少 Phase 1.9 根因深钻 — reason_code 只是分类标签，不是真正的根因'
    });
  }
}
```

如果检查发现 Phase 1.9 被跳过，会触发 Correction Prompt 让 Claude 补做。

注意 Verifier **不检查 Claude 的计划阶段是否匹配 Strategy 的阶段编号**——它检查的是「关键分析动作是否发生了」（有没有调用深钻工具），不是「计划格式是否正确」。

### 完整的约束光谱

把三层机制叠在一起，不同阶段的约束强度形成了一个光谱：

| 阶段 | Strategy 语气 | Planning Gate | Verifier 检查 | 约束强度 |
|------|-------------|:---:|:---:|:---:|
| Phase 1（概览） | 建议 | 需要计划 | 不单独检查 | 中 |
| Phase 1.5（架构分支） | 建议 | — | 不检查 | 低 |
| Phase 1.7（根因分支） | 建议+条件 | — | 不检查 | 低 |
| Phase 1.9（根因深钻） | 🔴 **必须/禁止** | — | **检查是否调用了深钻工具** | **高** |
| Phase 2（补充深钻） | 可选 | — | 不检查 | 无 |
| Phase 3（综合结论） | 必须覆盖分布 | — | 检查结论完整性 | 中 |

而 `general.strategy.md`（未匹配到场景时的 fallback）则完全是软指引：只给了一个按用户关注方向的路由决策树（CPU → cpu_analysis，内存 → memory_analysis），没有任何必须执行的阶段。Claude 在 general 场景下有完全的自主权。

### 一句话总结

**Strategy 文件告诉 Claude「分析滑动问题至少要做这几件事」，Planning Gate 确保它先想后做，Verifier 事后检查关键步骤有没有真的做。** 但在这个框架内，具体查什么数据、用哪个工具、按什么顺序，都是 Claude 根据实际数据自主决定的。

---

*（持续更新，收到新问题后补充）*
