# Context Engineering v2.1 — Implementation Plan

> **日期**: 2026-04-28
> **取代**: v1（`context-engineering-improvements.md`）的"补丁式"思路
> **背景**: owner 对 v1 不满意；3 份独立 review（Explore 现状摸底 + general-purpose 2026 SOTA + 2 轮 Codex 批判）汇总后，v1 整体打 4/10
> **目标**: 从"5 个独立补丁"升级为"4 条架构主线 + bug 修复 + 度量闭环"
> **总工程量**: ~7 天（A 路径）/ 6.5 天（B 路径）

---

## 1. v1 体检诊断（来自 3 份 review）

### 1.1 整体评价

| 维度 | 现状 | Codex 评语 |
|------|------|-----------|
| 设计层 | 5 个改动各自独立，无统一上层 | "把策略句子挪到 tool response 末尾，不是 context architecture" |
| 命中率 | 关键词匹配 ~50% miss + critical fallback 也有 bug | 既漏又误配，至少 3 个可复现场景 |
| 可观测 | 仅 `console.log`，无 dashboard、无指标 | 无法证明命中率/误配率真的改善质量 |
| 测试 | 0 单测覆盖 next_phase_reminder / hard-gate / compact recovery | 高置信度的吹嘘 |
| 覆盖 | 12 scene 仅 3 个有 phase_hints | "包装成通用方案，实际只是局部补丁" |

### 1.2 4 个 P0（必修）+ 关键 bug

- **P0.1【设计缺陷】** Phase 边界注入治标不治本——8-15 turn 后照样丢
- **P0.2【真实 Bug】** self-improve 的 `phaseHintsRenderer` 与 `strategyFingerprint` 算 fingerprint 用不同 canonical → 自动 patch 永远被误判 changed；renderer 强制 `critical:false` → critical fallback 永远救不到自动 hint
- **P0.3【设计缺陷】** hard-gate 第二次无脑放行 = 反向训练 agent 先交不全 plan
- **P0.4【时序错误】** compact recovery 注入太晚，救不到当前会话
- **P1.2【真实 Bug】** `SCENE_PLAN_TEMPLATES` 的 key 写成 `'touch-tracking'`（连字符），strategy frontmatter scene id 是 `touch_tracking`（下划线）→ touch_tracking 场景 hard-gate 永远不生效
- **P1.4【架构违例】** `SCENE_PLAN_TEMPLATES` 中文建议+keyword 仍硬编码在 TS，违反 `prompts.md` "NEVER hardcode prompt content in TypeScript"
- **P1.5【漏洞】** `revise_plan` 不复用 hard-gate 校验 + 重置 `planSubmitAttempts=0` → 可绕过
- **P1.6【质量门虚设】** plan adherence 只匹配工具名不匹配 skillId → phase 写"调用 startup_slow_reasons"，agent 实际调任意 invoke_skill 都被记为完成
- **F.6【Codex 二轮发现 Bug】** `strategyFingerprint.ts:76-89` 用 `${scene}.strategy.md` 拼路径，touch_tracking/scroll_response 找 underscore 文件名（实际是 hyphen）→ fingerprint 返回空 hash

### 1.3 与 2026 SOTA 的 5 个最大差距

| # | SOTA | 现状 | 收益÷难度 |
|---|------|------|----------|
| 1 | **Prompt cache 显式 1h TTL**（Anthropic） | 大概率默认 5min，多 turn 命中率近 0 | 极高/极低 |
| 2 | **KV-cache 命中率作北极星指标**（Manus） | 从未度量 cache_read 比率 | 高/低 |
| 3 | **per-tool-call living plan recitation**（planning-with-files） | per-phase（粗 5-10 倍） | 高/中 |
| 4 | **Pre-Rot Threshold 主动 compact + raw preservation**（Manus） | 被动等 SDK auto-compact | 中-高/中 |
| 5 | **Anthropic 4 件套**（Compaction + NOTES.md + Subagent 摘要 + JIT retrieval） | 只做了 JIT，其它残缺 | 中-高/中 |

### 1.4 Codex 二轮 review 的 6 个致命问题（全部接受）

| # | 问题 | 修法 |
|---|------|------|
| F.1 | 12 scene raw bodies 全塞 prefix 会从 4.5K 暴涨到 24.5K tokens | stable prefix 只放 capability registry + 12 scene 一句话 skeleton；active scene 仍按需注入完整 strategy |
| F.2 | Claude Agent SDK 用 `query()` 单字符串 systemPrompt，cache_control 落点未证实 | Phase 1 前置 SDK capability spike 作为 hard gate |
| F.3 | hard-gate 失败延迟到 verifier 等于换名字 | 真硬拦截：缺 aspect → 反复 reject 直到合格 OR 显式 waiver |
| F.4 | fingerprint 共享让历史 patch 全失配 | dual-read + 版本号 + migration 脚本 |
| F.5 | SDK mid-stream push 不可行 | 双 fallback：spike 通过 → mid-stream；不通过 → "提前结束 turn + resume + recovery" |
| F.6 | fingerprint 用 scene id 拼文件路径，underscore scene 找不到 hyphen 文件 | 改从 `loadStrategies()` 真实 sourcePath 取 |

---

## 2. v2.1 实施编排

### Phase -1: 三档 baseline（0.5 天）

**新增** `backend/src/scripts/captureContextEngineeringBaseline.ts`，跑 6 canonical traces × full mode，输出 5 关键指标的 JSON：

- `cache_read_ratio`
- `uncached_input_tokens`
- `total_cost_usd`
- `first_token_latency`
- `compact_trigger_rate` + `phase_hint hit/miss` + `submit_plan reject`

**三档采集**：current → post-P0 → post-v2.1，写入 `test-output/baseline-{stage}.json` 用于对比。

### Phase 0: 紧急 bug 修复（1.5 天）

| # | 改动 | 文件 |
|---|------|------|
| 0.2 | `'touch-tracking'` → `'touch_tracking'` + 12-scene coverage 单测 | `claudeMcpServer.ts:1199` |
| 0.3 | fingerprint 文件定位改用 `loadStrategies()` sourcePath（F.6） | `strategyFingerprint.ts:76-89` |
| 0.5 | `ToolCallRecord` 扩展 `{toolName, inputSummary, skillId?, paramsHash?, matchedPhaseId, timestamp}` | `claudeRuntime.ts:653-680` |
| 0.6 | `PlanPhase.expectedTools: string[]` → `expectedCalls: Array<{tool, skillId?, paramsPredicate?}>` | `types.ts:208-218` + matcher |
| 0.4 | 抽 `validatePlanAgainstSceneTemplate(plan, scene)`，submit + revise 共用 | `claudeMcpServer.ts` |
| 0.1 | Fingerprint 共享 + 版本化 + dual-read + migration | `selfImprove/fingerprint.ts`（新） |

**依赖顺序**：0.2 → 0.5 → 0.6 → 0.4 → 0.1。0.3 独立可并行。

**验收**：6 个新单测 + 6/6 regression PASS + supersede store migration 后无 fingerprint mismatch。

### Phase 1: SDK spike + cache-aware foundation

- **1.0 ✅ 已完成** SDK capability spike：见 `docs/sdk-capability-spike-2026-04-28.md`。**关键发现**：`@anthropic-ai/claude-agent-sdk` 的 `systemPrompt` 类型是 `string | {type:'preset',preset:'claude_code',append?}` —— **不接受 `cache_control` block，无法显式配置 1h TTL**。Query handle 也只暴露 `interrupt()` / `setPermissionMode()`，无 mid-stream message push API
- **1.1 ❌ 已 dropped** 显式 `cache_control: {ttl: '1h'}` —— SDK 类型签名不接受。原计划改为 "等 SDK 暴露后再做"，目前只能依赖 SDK 内部默认 cache（5 min TTL）
- **1.2 未做** 抽 `buildSystemPromptParts()` → `{stablePrefix, cacheBoundary, volatileSuffix}`；stablePrefix 只放 `role + arch + methodology + capability_registry + 12-scene-skeleton(每个 scene 1 行 name+goal)`。**单独 PR**——537 行 builder 重构
- **1.3 ⏳ 部分** 复用 `AgentMetrics` 已有 `cacheHitRate` 字段；`uncached_input_tokens` 仍待抽 derived getter
- **1.4 ✅ 已完成 lite** 4 个 cache-stability 测试（同 ctx 字节相等 / volatile 不影响 stable prefix / 无 Date.now() 漏入），见 `claudeSystemPrompt.test.ts:cache stability`

**实际验收**：SDK spike 落地 + 4 个 stability guards。绝对 cache_read_ratio 提升需 Phase 1.2 完成后才能量化。

### Phase 2: Plan template + 真硬拦截（2 天）

- **2.1** `SCENE_PLAN_TEMPLATES` 移到 12 个 strategy.md frontmatter `plan_template:` 段 + zod schema validation；解决 P1.4
- **2.2** `AnalysisPlanV3` phase 加 `phase_hint_id?`, `mandatoryAspects`, `unresolvedAspects`, `waivers: Array<{aspect_id, reason}>`
- **2.3 真硬拦截**：缺 aspect → `success:false` + missingAspects 列表，**不写入** `analysisPlanRef.current`，可无限次重试；唯一放行：`waiver.reason` 长度 ≥ 50 字符
- **2.4** 删 LivingPlan 新 class 设想（O.1 砍）；扩 `sessionPlans` + `sessionStateSnapshot` 现有结构
- **2.5 决策点提前**：跑 baseline-postPhase2.1 → A=补 12 scene phase_hints / B=弃用 phase_hints 只保 plan_template / C=保留 3 高风险 scene

### Phase 3: SDK-aware compact + bounded recovery（拆 4 个 PR）

> **SDK spike 结果（2026-04-28，见 `docs/sdk-capability-spike-2026-04-28.md`）**：
> Claude Agent SDK 不支持 `cache_control` 也无 mid-stream message push API。
> 所以 Phase 3.1 不能"当场 push 到 SDK"——改为 **interrupt + resume + recovery preamble**
> （详见 `docs/v2.1-phase-3-active-compact-design.md`）。

- **3-1 ✅ 已完成** Token meter 抽到独立 `contextTokenMeter.ts`：用 `uncached_input + cache_creation + payloadBytesToTokens(recent_payload)`（**不**用 cache_read），阈值 `CLAUDE_PRECOMPACT_THRESHOLD=0.6`，纯函数 12 个单测
- **3-2 ✅ 已完成** Recovery note 抽到独立 `recoveryNoteBuilder.ts` + 加 `recent_tool_calls` section（保留最近 N=5 条结构化摘要：`{toolName, skillId?, inputSummary, matchedPhaseId}`），11 个单测
- **3-3 未做** Orchestrator 集成：在 `claudeRuntime` 主循环每 turn 后调用 token meter；超阈值则 `query.interrupt()` → `sdkQuery({resume, prompt: recoveryPreamble + originalQuery})`。**最高风险**，单独 PR
- **3-4 未做** Recitation 限频包装器：phase transition / post-compact 第一条 / `fetch_artifact(full+rows)`；其它数据 tool 不 append（O.3 砍）

### Phase 4: Metrics CLI report + 单测覆盖（0.5 天，✅ 已完成）

- **4.1 ✅** `scripts/captureContextEngineeringBaseline.ts` 输出 JSON / Markdown 三档对比；不上 dashboard endpoint（O.2 砍）
- **4.2 ✅** 5+ 组核心单测：next_phase_reminder（`phaseHintMatcher.test.ts` 9 测试） / hard-gate 真硬拦截（`validatePlanAgainstSceneTemplate.test.ts` 10 测试） / compact recovery（`recoveryNoteBuilder.test.ts` 11 测试） / fingerprint v2 dual-read（`hintFingerprint.test.ts` 4 测试） / plan template frontmatter（`planTemplateFrontmatter.test.ts` 7 测试）+ token meter（`contextTokenMeter.test.ts` 12 测试）

### Phase 5（已并入 2.5）

phase_hints 命运决策提前到 Phase 2.1 完成后；下游工作量按 A/B/C 路径动态调整。

---

## 3. 砍掉的过度工程（来自 Codex review）

| # | 原计划 | 砍掉原因 |
|---|-------|---------|
| O.1 | LivingPlan markdown 文件 | runtime + history + snapshot 已是 2 个事实源，加 markdown 是第三个，长期会失同步。改为 markdown 由 report 派生 |
| O.2 | `/api/agent/v1/observability/dashboard` 新 endpoint | 指标定义未稳定，过早产品化。改 CLI/JSON report，Phase 5 决策后再上 dashboard |
| O.3 | "所有数据 MCP tool response append recitation" | SmartPerfetto 默认 20-25 turn（不是 Manus 数百 turn），全 tool append 是噪音 |
| O.4 | 12 scene raw bodies cache prefix | 24.5K tokens 爆预算，cache 命中率好看但绝对 input token 暴涨 |

---

## 4. v1 改动命运总表

| v1 改动 | v2.1 命运 |
|---------|---------|
| #1 DETERMINISTIC_SCENES 扩展 | **保留**（teaching/pipeline 拆细到 Phase 5 决定） |
| #2 phase_hints frontmatter | **改造**：phase 显式绑定 `phase_hint_id`，弃关键词匹配；Phase 2.5 决策是否合并到 plan_template |
| #3 restatement 注入 | **升级**：phase transition / post-compact / high-risk tool 三类触发 |
| #4 submit_plan hard-gate | **重做**：真硬拦截 + 显式 waiver 路径 + 共用 validator |
| #5 compact recovery | **重做**：主动触发 + raw preservation + 双 fallback |

---

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| Phase 1.0 spike 失败导致 1.1 / 3.1 大幅简化 | 已设计双 fallback；spike 是 hard gate，不通过就走降级路径 |
| Phase 0.1 fingerprint 改动让历史 patch 全失效 | dual-read v1/v2 + migration 脚本扫 supersede store 重算 |
| Phase 1.2 cache breakpoint 选错位置导致 cache 反而失效 | 1.4 单测严格防回归 + `CLAUDE_CACHE_AWARE_PROMPT` 环境开关灰度 |
| Phase 2.3 真硬拦截让 agent 卡住循环 | reject 次数上限（如 5 次），超过强制写入 plan + 标记为 unresolved；最终 verifier 仍兜底 error |
| Phase 3 主动 compact 触发过频 | 阈值环境变量化 + canary 1 天观察 |

---

## 6. 验收 Checklist

每个 Phase 完成后必须满足：

- [ ] `cd backend && npm run test:scene-trace-regression` PASS（6 traces）
- [ ] `npx tsc --noEmit` PASS
- [ ] 该 Phase 新增的单测 PASS
- [ ] 重跑 `captureContextEngineeringBaseline.ts`，存 `baseline-{phase-id}.json`
- [ ] `/simplify` 在 changed code 上 PASS

最终验收（Phase 4 完成后）：

- [ ] cache_read_ratio 比 baseline-current 提升 ≥ 30 个百分点
- [ ] phase_hint_hit_rate（如保留）≥ 80% 或 phase_hints 已弃用
- [ ] hard-gate 反复重试到合格（fixture e2e 验证）
- [ ] 长 trace（300+ turn 模拟）compact 后 plan 不丢
- [ ] 三档 baseline 对比报告交付

---

## 7. 历史依据

完整诊断、SOTA 对比、Codex 两轮 review 全文存档：见 memory `context_engineering_v2_plan_2026-04-28.md`（待落地）和 git history。

v1 设计文档保留为历史参考：[`context-engineering-improvements.md`](./context-engineering-improvements.md)。
