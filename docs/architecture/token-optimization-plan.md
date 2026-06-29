<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Token 优化方案（Plan-Only / 已通过 Codex 三轮 Review）

> 状态：**纯规划交付，未改动任何代码、未跑 build/regression。**
> 评审：Claude 规划 → Codex 只读 review ×3 轮 → 修订 → 定稿 LGTM。
> Codex session：`019ed7f9-27c2-7811-b473-88199a8a5fcd`。
> 日期：2026-06-18。

---

## 1. 问题背景

团队反馈 token 用量偏高。本方案先**定位 token 去向**，再**评估优化空间**，最后给出
**按里程碑排序的实施计划**。所有结论均经代码核对。

核心判断：**最大头不在单次 SQL/Skill 返回，而在 full-mode 系统提示词里被完整注入的
scene strategy**，且现有 8000-token 预算对这块**完全失效**。

---

## 2. 已验证的现状（带证据）

| # | 现状 | 证据 |
| --- | --- | --- |
| 1 | full-mode system prompt 最大段是 `methodology`，它通过 `buildSceneStrategySection` 嵌入**完整** scene strategy | `backend/src/agentv3/claudeSystemPrompt.ts:414-423`、`:109-133` |
| 2 | `MAX_PROMPT_TOKENS = 8000` 的预算裁剪只裁 `dropOrder` 里的 tier-2/4 辅助段（`knowledge_base`/`pattern_context`/`plan_history` 等）；`methodology` 是 tier-3 且**不在 dropOrder**，预算对最大段无效 | `claudeSystemPrompt.ts:38`、`:558-587` |
| 3 | strategy 体积：`startup.strategy.md` 58KB(~51K tokens)、`scrolling.strategy.md` 46KB(~38K tokens) | `ls -la backend/strategies/` |
| 4 | `startup.strategy.md` 中 44KB/58KB 是 phase-specific recipe：「启动场景关键 Stdlib 表」24KB（嵌入 SQL + fetch_artifact 表）+「根因诊断决策树」20KB | 逐段 byte 统计 |
| 5 | Claude 路径 SDK 不暴露 `cache_control`，缓存由 SDK/API 自动管理；实测 91% cache_read（52.4M/57.5M），稳态便宜 | 测试 `claudeSystemPrompt.test.ts:393`；`backend/logs/metrics` 汇总 |
| 6 | 真正成本在：① **cache creation**（每个新 session 付全价建 ~50K prefix，实测 ~3.7M tokens）② **context window 压力** ③ **非缓存 provider**（部分 OpenAI-compat / Pi / OpenCode）可能每轮付全价 | 同上 + runtime 核对 |
| 7 | `buildSystemPromptParts` 已拆出 `stablePrefix(tier≤3)`/`volatileSuffix(tier4)`，但**消费方未用于显式 cache 断点** | `claudeSystemPrompt.ts:589-598` |
| 8 | `phase_hints` 注入机制已存在，但仅在阶段 completed/skipped 后触发，且只返回 `constraints/criticalTools`——**首阶段与阶段开始拿不到 detail** | `claudeMcpServer.ts:3814`、`:3984`；`strategyLoader.ts:172` |
| 9 | `final_report_contract` 已是 frontmatter 解析的**数据**并由 final gate 校验，不是纯散文 | `strategyLoader.ts:196`；`finalReportContractGate.ts:51` |
| 10 | `fetch_artifact` **已默认 summary**（rows 默认 50、上限 200、full cap 500）；`execute_sql` raw 结果默认仍可返回最多 200 行，summary 是显式开关 | `artifactStore.ts:207`；`claudeMcpServer.ts:1871` |
| 11 | 各 runtime 每轮重新构造 `instructions/tools`：OpenAI 每次构造 Agent 传 `instructions`，Pi/OpenCode 也直接传完整 system prompt | `openAiRuntime.ts:755`、`:1544-1584` |
| 12 | tool registry 现仅按 exposure/codebase permission 过滤，**不按 scene/mode** | `mcpToolRegistry.ts:182`；`claudeMcpServer.ts:4866` |

### 2.1 缓存语境下为什么仍值得优化

即便 91% cache_read，50K prefix 仍：
- 每个新 session 付一次全价 cache creation（实测累计 ~3.7M tokens）；
- 每轮以 cache-read 价（约 input 价 10%）被重复读取，prefix 越大累积越多；
- 占用 context window，挤压对话/证据空间；
- 在不做 prefix 缓存的 provider 上**每轮付全价**。

把 prefix 从 ~50K 压到 ~12K，可同步削减 cache_read 体积、cache creation 成本与
context 压力，对非缓存 provider 收益最大。

---

## 3. 实施方案（里程碑顺序，guardrail-first）

> 排序原则：**先建可度量的安全网，再拆**；**质量靠结构化 gate 兜底，不靠散文**；
> **低风险高性价比先做**。

### M1 — 守门基线（先于任何拆分）

- 新增「读**真实** strategy 文件」regression（不 mock `strategyLoader`，因现有 prompt 单测
  多数 mock 了它，捕捉不到真实体积）：
  - 先做**实测基线 + 分段 token 报告 + 记录目标阈值**（snapshot 当前体积）；
  - **不在 M1 就硬断言 ≤12K**，否则会立刻打红主线；硬门禁在 M2 拆分完成后激活。
- 覆盖 **worst-case 组合**：scene + architecture + trace_completeness + selection +
  comparison + code-aware + plan_history，不只测 bare scene。
- `methodology` 拆 `base_methodology` / `scene_strategy_core` / `report_contract` 三段并
  加分段度量；`scene_strategy_core` 进入可截断逻辑，但硬门禁段不可丢。

### M2 — Scene strategy 拆分 + 固定模板精简（拆分后激活 M1 硬门禁）

- 每个 `*.strategy.md` 拆两层（内容仍在 markdown 层，**不 hardcode 进 TS**）：
  - **core**（always-inject，≤~3-4K tokens）：场景路由卡、阶段骨架、硬门禁、contract 摘要；
  - **detail**（on-demand）：phase recipe / 嵌入 SQL / fetch_artifact 表 / 根因决策树。
- **detail 投递协议**（不只靠 agent 主动拉）：
  - `submit_plan` 返回首阶段 `detailRef` + 短摘；
  - `update_plan_phase` 返回下一阶段确定性 `detailRef` + **硬 cap excerpt** + 命中日志；
  - 新增 `lookup_strategy_detail` MCP 工具仅作兜底，**非质量主路径**。
- **detail 加载标为 `informational`**：不计入 `expectedCalls`、不满足「已采集 trace 证据」、
  excerpt 有硬 cap（防其进入 provider history 后重新膨胀上下文）。
- **质量护栏（关键）**：把「必须 fetch 关键 artifact / 必须执行根因深钻」从 detail 散文
  迁移到 `plan_template` 的 `expectedCalls` + verifier，使质量**不依赖 detail 是否被加载**。
  迁移须保留 **conditional trigger / alternativeExpectedCalls / skipped+reason**，
  不把数据缺失场景变成 false failure。
- **执行期护栏**：OpenAI/Pi 的 final report continuation 与 Claude correction prompt
  都**无法在最终阶段重新拉 detail/工具**，因此 M2 必须保证**执行阶段** detail 或硬门禁
  已生效，不能指望最终报告修正阶段补回来。
- 同里程碑精简 `prompt-methodology.template.md`(20.8KB) + `prompt-output-format.template.md`(8.5KB) 冗余。

### M3 — 大 raw SQL 结果压缩

- `execute_sql` 大结果自动转 summary + 可分页 artifact/ref，**保留完整 provenance**；
- 不再下调已默认 summary 的 `fetch_artifact`（避免影响需要逐行证据的阶段）。

### M4 — 减少 plan churn（实测 `submit_plan` 94 次 / 失败 45 次）

- **仅自动修复 schema 形状问题**：数组/字符串、字段别名、类型 coercion；
- **禁止**自动加 waiver、删 missing aspect、删 `expectedCalls`、把语义失败改成通过
  （否则会削弱 M2 质量护栏）。

### M5 — 工具 schema 成本（降级，ROI 待评估）

- 先压缩过长 tool description（低风险，横跨 4 runtime 共用 `toolDefinitions`）；
- 再评估 scene/mode-scoped registry，**严格 allowlist**：绝不滤掉
  `fetch_artifact` / planning / comparison / code-aware 条件工具。

### M6 — 跨 provider 缓存对齐（最后，provider-specific）

- 按 **runtime adapter capability flag** 判断是否支持 explicit cache breakpoint，
  **不按 provider 名字写死**（Anthropic/DeepSeek 等）；
- 消费已有 `stablePrefix`/`volatileSuffix` 设 cache 断点；Pi/OpenCode 不假设有同等
  cache-control 入口，按 adapter 分支处理。

---

## 4. 风险与边界

- **拆分不得破坏 AI 输出契约**：reports / snapshots / CLI artifacts 需要 provenance；
  chat 可隐藏低信号细节但不可删证据面（见 `.claude/rules/backend.md` AI Output Contract）。
- **on-demand 质量风险**：靠 M2 的结构化 gate（expectedCalls + verifier）+ 执行期注入兜底，
  而非依赖 agent 主动加载 detail。
- **缓存命中风险**：拆分边界须落在「稳定核心 + 真正按需详情」上；不要把高频稳定内容变 volatile
  而降低缓存命中。
- **detail excerpt 膨胀风险**：硬 cap + informational 标记，防其经 plan tool-call log /
  provider history 重新进入上下文抵消收益。

---

## 5. 验证策略（每里程碑）

| 验证 | 触发里程碑 |
| --- | --- |
| `npm run validate:strategies` / `validate:skills` | M1 / M2 |
| `npm run test:scene-trace-regression`（6 canonical traces） | 每里程碑 |
| 新增 system prompt token regression | M1 引入（基线）→ M2 转硬门禁 |
| Agent SSE e2e startup/scrolling/flutter，对比拆分前后结论质量 + token | M2 |
| focused result-quality 套件（`finalReportContractGate` / `claimVerificationRunner`） | M2 改 verifier/gate 时 |
| `npm run verify:pr` | 每里程碑落地前 |

---

## 6. Codex Review 轨迹（3 轮）

**Round 1**（6 点，全部采纳）：
1. P0 不能只靠 agent 主动拉 detail；`update_plan_phase` 仅在阶段完成后返回 `constraints/criticalTools`，首阶段无 detail → 需 detailRef 投递协议。
2. `final_report_contract` 是 frontmatter 数据不易被破坏，但真风险是「文本满足 pattern 却缺 artifact 深钻」→ 质量要求迁到 `expectedCalls`/verifier。
3. P4（模板精简）排太低，固定模板仍大（methodology 20.8KB / output-format 8.5KB）→ 合并进 M2。
4. P2（scene-scoped registry）有 runtime 约束、ROI 偏低 → 降级，先压缩 description。
5. P3 应针对 raw SQL，不是已默认 summary 的 `fetch_artifact`。
6. P6 不能假设跨 provider 统一缓存 → 最后做、按能力分支。

**Round 2**（7 点，全部采纳）：
1. M1 不能一开始硬断言 ≤12K（会打红主线）→ 先基线后门禁。
2. token 门禁须覆盖 worst-case 组合，不只 bare scene。
3. `lookup_strategy_detail` 标 informational，不计 evidence/expectedCalls，excerpt 硬 cap。
4. expectedCalls 迁移须保留 conditional/alternative/skipped+reason。
5. M4 仅修 schema 形状，禁止自动改语义/加 waiver。
6. final report continuation/correction 无法补救未加载 detail → M2 执行期必须生效。
7. M6 按 adapter capability flag 判断，不按 provider 名写死。

**Round 3**：定稿 → **LGTM**。

---

## 7. 交付说明

- 本文档为**纯规划交付**，未改动代码，未跑 build/trace regression。
- 实施时每里程碑遵循项目 `Plan → independent review → Revise → Execute` gate 与
  `.claude/rules/testing.md` 的对应验证 tier。
- 落地顺序建议：**M1 → M2（含原 P4）→ M3 → M4 → M5 → M6**。
