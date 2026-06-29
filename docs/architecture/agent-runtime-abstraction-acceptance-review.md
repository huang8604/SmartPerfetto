<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Agent Runtime 抽象层整改 —— 验收 Review + 计划评审

> 状态：**Review 进行中**（Claude R1 + Codex R2 完成）。实现验收：高质量、所有自动化门绿，
> 但有 **1 个 P1 取消并发竞态（A0）** 须修 + P2/P3 若干；计划评审：方向认可，落地须先解 **B1/B2（P1）**。
> 对象：分支 `codex/agent-runtime-abstraction-review-fixes`（HEAD `ea571e85`），实现自
> [`agent-runtime-abstraction-review.md`](./agent-runtime-abstraction-review.md) 的规格 + 1 份待实现计划。
> 方式：Claude 验收 + 计划评审 → Codex 只读复审（反复）→ 修正 → 记录。实现由第三方按本文档整改。
> 日期：2026-06-07。Reviewer 不改实现代码。

---

## 实现方 Goal Prompt（整改交接入口，复制到 goal 命令）

```text
目标：按验收 review 整改实现 + 实现 verifier 误诊规则迁移计划，所有门绿、可发 PR。

【唯一真相源】docs/architecture/agent-runtime-abstraction-acceptance-review.md
**完整读它**：Part A 待整改表(A0–A5)、Part B(Q1–Q3 回答 + B1–B5)、验证证据。
背景见 docs/architecture/agent-runtime-abstraction-review.md。规则见 .claude/rules/(backend/prompts/skills/testing/git) + 根 CLAUDE.md。

【已锁定决策，勿重议】
Part A 整改：
- A0(P1 必修) 跨 run 取消竞态：改 per-run cancelled 记录(stale-run guard)；**真正的洞是"旧 run 迟到回调写当前 session"**——
  所有写终态/持久化的点都按 runId 防 stale：两处 catch、late-success、smart 路径、lease 失败分支、markSessionRunStatus、
  finalize、事件 scope(activeRun||lastRun)。加回归单测："cancel run A → 立刻 start run B → A 迟到 reject/success 不污染 B、A 仍记 cancelled"。
- A1(P2)：.gitignore 增 backend/data/agent-runtime/。
- A4(P2)：lease 获取失败分支(agentRoutes.ts:1751-1758/1819-1827)同样按 isSessionRunCancelled 守卫。
- A2/A5(P3,可选)：双 kind 谓词合一或注释区分；兼容 shim 标过渡或清理。

Part B：把 claudeVerifier.ts 的 HARDCODED_MISDIAGNOSIS_PATTERNS 迁到 strategy frontmatter(verifier_misdiagnosis_patterns)，TS 只 load/compile/match。
- Q1：拆两个函数 getVerifierMisdiagnosisPatterns(scene 必填) + getAllVerifierMisdiagnosisPatterns()(测试/工具用)，不要可选 scene 重载。
- Q2：severity 可配但限有界枚举 warning|info，默认 warning，禁止 regex 命中产 error；type 钉死 known_misdiagnosis。
- Q3：learned patterns 本刀保持全局(排 strategy patterns 之后、保留 TTL/occurrences)；scene 归属另开切片。
- B1(P1)：validate:strategies 必须新增校验——new RegExp() 编译每条 pattern(非法 fail CI) + id 唯一/必填/patterns 非空/type 校验
  (当前 validate.ts:915-923 只校验 final_report_contract，根本没碰 verifier frontmatter)。
- B2(P1)：按语义分挂 scene，勿一刀切 scrolling：VSync/VRR→pipeline+touch-tracking+scrolling；Buffer Stuffing→scrolling+pipeline；
  single-frame critical→global/shared(startup 也需)。schema 须支持多 scene 或 global 声明。

【执行顺序，每项独立分支/提交、独立回归】
1) A0(最高优先，含回归单测) → 2) A1 → 3) A4 → 4)(可选)A2/A5 → 5) Part B(strategyLoader schema + validate 扩展 + 三规则迁移 + scene-aware verifyHeuristic + 单测)。

【工作方式，项目强制】
- A0 与 Part B 属非平凡：走 Plan → 只读 reviewer 复审 → 修正 → 执行(根 CLAUDE.md Independent Review Gate)。
- 不在 TS 硬编码 prompt/领域规则(Part B 正是去硬编码)；patterns 放 frontmatter，learned 运行时状态留 JSON。
- 测试按 .claude/rules/testing.md：cd backend；tsc --noEmit + 受影响单测 + test:scene-trace-regression；
  改 verifier + scrolling/pipeline/startup strategy 后跑 Claude scrolling strict E2E(时间允许跑 4-agent matrix)；落地前 npm run verify:pr。
- ⚠️ rtk hook 坑：用 npm run 跑测试若报 Missing script "run"，改**直跑 ./node_modules/.bin/{tsc,jest,tsx} + 看真实退出码**(别被 |tail 掩盖失败码)。
- feature 分支，勿在 main 堆 commit；commit 粒度对齐项；保留无关本地改动。

【必避坑】
- A0：不要只把 marker 加宽；要堵住"旧 run 迟到回调写当前 session"的所有终态/持久化写入点(按 runId)。
- Part B：validate 必须真编译 regex(否则非法规则运行时静默跳过、verifier 覆盖退化)；single-frame 别只挂 scrolling(startup 回归)；
  learned 必须排在 strategy patterns 之后；**别动 focus tracking**(/interaction、/focus、recordUserInteraction 是 live 功能)。
- 别重新引入 prompt-in-TS(A3 刚迁出模板，保持)。

【完成定义】
- A0/A1/A4 修复 + A0 跨 run 竞态回归单测过；Part B 三规则在 frontmatter、TS 无硬编码、severity 有界、verifyHeuristic scene-aware、validate 真编译 regex；
- npm run verify:pr 全绿、6-trace 6/6、verifier scene-aware 单测过、Claude scrolling strict E2E 过；
- 无半成品/死代码；受影响文档更新。

【冲突即停】若 B2 某规则实际 scene 归属与上不符，或 A0 修复触及更广状态机，**停下报告**，不要降质或留半成品。
```

---

## 0. 验证证据（均针对 HEAD `ea571e85`，绕开 rtk hook 直跑二进制）

| 门 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `./node_modules/.bin/tsc --noEmit` | ✅ PASS |
| 6-trace 场景回归 | `tsx tests/skill-eval/scene_trace_regression.ts` | ✅ **6/6 PASS** |
| F13/WS 关键单测（6 suites） | jest（eventStore/sseReplay/sqlWorker/skillExecutor/pi/opencode） | ✅ 167/167 |
| amend 受影响单测（3 suites） | jest（claudeVerifier/pi/finalResultQualityGate） | ✅ 157/157 |
| 路由取消/RBAC | jest（agentRoutesRbac，含 cancelled 状态/事件/SSE/幂等） | ✅ 10/10 |
| 策略/模板校验 | `tsx src/cli/index.ts validate --strategies` | ✅ 0 错误 |

> ⚠️ 过程教训：首跑用 `npm run … | tail`，被 rtk hook 改写成 `npm error Missing script: "run"`，
> 而 `| tail` 把失败退出码掩成 0、后台还报 "exit 0" —— **假绿**。结论一律以直跑二进制 + 显式退出码为准。

---

## 1. Part A —— 实现验收（F12 + F13 + Option 2 + amend）

**总评：高质量、忠实规格、原则到位，所有自动化门绿；但 Codex R2 挖出 1 个 P1 取消并发竞态（单测/回归测不到），须整改后方可合入。** 15 提交与规划 WS 一一对应，外加 1 个正经收尾修复（已 amend）。

| 项 | 决策 | 落地评估 | 结论 |
| --- | --- | --- | --- |
| F12 红测试 | 修 | 修复后随 WS-D 删 harness，registry 断言迁至 `runtimeRegistry.test.ts` | ✅ |
| F13-P1 取消语义 | Scope B | run-bound cancel marker（`cancelState{runId,cancelled,reason}`）；独立 `analysis_cancelled` 事件贯通 event store/replay 终态/SessionStatus；**单 run 的 catch+late-success+smart 路径全守住**；abortSession 用 `Map<sessionId,Set<handle>>`+identity；claude 3 个 query 点全登记；`/interaction`+`/focus` 保留 | ✅ 单 run 正确 / ⚠️ **跨 run 竞态见 A0** |
| F13-P2 SQL 取消 | worker-aware | 新 `traceProcessorCancellation.ts` + worker 线程取消 + **SkillExecutor 全链穿 signal** + 3 adapter；非 fetch-only 糊弄 | ✅ |
| WS-A capabilities | 瘦身+真相源 | `runtimeDescriptors.ts` 单一源；registry 由其派生；**inert 字段全删**（continuationPolicy/classifierPolicy/toolTransport/snapshotState/…）；`providerRuntimeMatrix.ts` 改名 | ✅ |
| WS-C 目录 | 全下沉 | `engines/{claude,openai,opencode,pi}/`；**共享件（claudeMcpServer/mcpToolRegistry/strategyLoader/sessionStateSnapshot/sceneClassifier/claudeSystemPrompt）正确留在 agentv3/**，未误搬 | ✅ 避开最大坑 |
| WS-D harness | 删 | 干净移除，`createAgentOrchestrator` 直返 engine | ✅ |
| WS-I opaque 恢复 | 真实现 | pi=transcript hydrate（messages→`initialState.messages`，`piAgentCoreRuntime.ts:906-927/1546-1571`）；opencode=复用 durable dirs+sessionId，SDK `session.get/messages` 验证可复用否则 degraded fresh（`openCodeRuntime.ts:827-866/2013-2042`） | ✅ **可验证复用+失败降级**（非无条件原生 session restore） |
| WS-K intervention | 删两端 | controller//intervene/事件/前端 `intervention_panel.ts` 全删，无悬挂引用；**focus tracking 完整保留**；前端已重建、子模块 gitlink 可达 `fork/*` | ✅ |
| WS-B/E/F/G/H/J | — | 实验选择收敛、hypothesis 去重、diagnostics 集中、registry 精简、common 拆分、pinning hash | ✅（单测+回归绿） |
| 收尾 `ea571e85` | 计划外 | verifier 缺失小节指令 + pi final-report 续写（`loadPiFinalReportContinuationPrompt`）；让 pi/opencode 可靠产出完整首轮报告 —— 正经补齐，非创可贴 | ✅ |

### Part A 待整改项

| ID | 严重度 | 问题 | 建议 |
| --- | --- | --- | --- |
| **A0** | **P1（必修）** | **跨 run 取消竞态**（Codex R2 发现，已核实）：`cancelState` 只存当前 run，新 run 会重置它（`agentRoutes.ts:333` / `initializeCancelStateForRun`），`isSessionRunCancelled` 只比当前 `cancelState.runId`（`:390-394`）。"取消 run A → 立刻开 run B"时，A 的迟到 reject/success 不再被识别为 cancelled，可能经 `markSessionRunStatus`（写当前 activeRun，`:358-375`）/持久化（scope=activeRun\|\|lastRun，`:647-665`）把新 session 误写 failed/stale 终态。prepareSession 正常复用路径不中止旧 run（`agentAnalyzeSessionService.ts:279-360`），provider snapshot-mismatch 路径（`:286` 起）的 abort 也是 `void` 不 await → 竞态窗口真实存在 | 改为 **per-run cancelled 集合 / stale-run guard**；`markSessionRunStatus`/finalize/事件持久化**按 runId 写或跳过 stale run**；加"cancel A → start B → A 迟到回调"的回归单测 |
| **A1** | **P2（合入前修）** | `backend/data/agent-runtime/`（WS-I 的 opencode opaque 持久化数据，已见 untracked config/package.json）**未加 .gitignore**，而同级 `sessions/`/`secrets/`/`scene-reports/` 均已忽略 → 有误提交运行时数据风险 | `.gitignore` 增 `backend/data/agent-runtime/` |
| A2 | P3 | 仍有两个 runtime-kind 谓词：`isProductionAgentRuntimeKind`（runtimeKinds.ts）+ `isAgentRuntimeKind`（providerRuntimeMatrix.ts） | 若语义等价则合一；若有意区分（production vs valid）则在注释写明，避免再分叉 |
| A3 | ✅ 已解决 | prompt 串硬编码在 `claudeVerifier.ts`（首轮发现） | `ea571e85` 已迁出到 `prompt-final-report-missing-sections-{en,zh}.template.md`，TS 改为 `loadPromptTemplate+renderTemplate` |
| A4 | P2 | **lease 获取失败分支无取消守卫**（`agentRoutes.ts:1751-1758` / `:1819-1827`）：既有 session（客户端已知 sessionId）被取消后，lease failure 仍可能把它覆盖为 failed | 这些 markFailed 分支同样按 `isSessionRunCancelled` 守卫 |
| A5 | P3 | WS-C 迁移后保留了兼容 re-export shim（`agentv3/claudeRuntime.ts:5`、`agentOpenAI/openAiRuntime.ts:5`、`agentRuntime/openCodeRuntime.ts:5`），与"公共层只留抽象"略有偏差 | 文档标为过渡 API，或后续清理；不阻断 |

### Part A 过程清单（非代码缺陷）
- 子模块 gitlink `6119c592` 可达 `fork/*`；合根前确认在目标 AIAssistant fork 分支且已推。
- 真实 provider 的 `/cancel → LLM 中止` 未进 CI（合理）；**建议手动 Deepseek e2e**：analyze → `/cancel` → 确认无后续 LLM turn + 终态 cancelled。
- 规划文档与本 review 文档仍 untracked；随这批提交便于追溯。
- 合入前在分支跑完整 `npm run verify:pr`（本次已覆盖 typecheck/回归/关键单测/validate:strategies，未跑 build/CLI pack 全套）。

---

## 2. Part B —— 计划评审：`HARDCODED_MISDIAGNOSIS_PATTERNS` 迁出 TS

**结论：方向正确，**与 prompts.md / F1（领域规则 → 声明式 strategy，TS 只 load/compile/match）一脉相承，**端倪与 A3 的模板迁移同源**。整体认可，但落地前需处理下列风险，并对 3 个点名问题给出选择。

> 计划前提核实属实：`claudeVerifier.ts:32` 确有 `HARDCODED_MISDIAGNOSIS_PATTERNS`（3 条：vsync / buffer-stuffing / single-frame critical，`type:'known_misdiagnosis'`）；`getKnownMisdiagnosisPatterns()`（:91）返回 `[...HARDCODED, ...learned]`；`verifyHeuristic()`（:175）消费。

### 2.1 三个点名问题的回答

**Q1 `getVerifierMisdiagnosisPatterns(scene?)`：无 scene 返回全部 vs 强制 scene？**
建议 **拆成两个显式函数**，不要用"可选 scene"重载：
- `getVerifierMisdiagnosisPatterns(scene)` —— scene **必填**，生产路径用，只返回该 scene 规则。
- `getAllVerifierMisdiagnosisPatterns()` —— 显式"取全部"，仅测试/工具用。
理由：可选 scene 会让某个生产调用方忘传 scene 时**静默拿到全部规则**（跨场景误报），与 memory 里 AnalysisOptions whitelist 同类的"静默断链"。两个显式函数让"取全部"必须被刻意调用，杜绝 footgun。

**Q2 severity 是否允许 strategy 配置？**
建议 **可配置但受限**：固定为有界枚举（`warning` | `info`），默认 `warning`；**禁止 strategy 通过 regex 命中产出 `error`**。
理由：计划已把 `type` 钉死为 `known_misdiagnosis`（很好，防任意 issue 类型）；severity 应同等约束——一次 regex 误命中不应能把分析**硬失败**（error 可能影响纠正循环/质量门）。给灵活性但封顶。

**Q3 learned patterns 全局 vs 绑定 scene？**
**同意计划：本刀保持 learned 全局**（排在 strategy patterns 之后、保留 TTL/occurrences），scene 归属另开切片。
补充：strategy patterns 变 scene-scoped 后，learned 仍全局意味着"scrolling 学到的规则可能在 startup 命中"——**记为已知限制**，在另开切片里给 learned 补 scene 归属（需迁移 `learned_misdiagnosis_patterns.json` 格式）。本刀可接受（learned 保守 + TTL 限制）。

### 2.2 落地前必须处理的风险/边界

| ID | 严重度 | 风险 | 建议 |
| --- | --- | --- | --- |
| B1 | **P1（必须）** | 计划说"非法 regex 跳过 + console.warn，validate:strategies 应提前抓"——但**当前 `validate.ts:915-923` 只校验 `final_report_contract`**，根本不碰 verifier frontmatter。若不补，非法 regex 会**运行时静默跳过**，verifier 覆盖悄悄退化而 CI 不红 | 在 `validate:strategies` 新增：`new RegExp()` 编译每条 pattern（非法即 fail CI）+ 校验 id 唯一/必填/`patterns` 非空/`type`=known_misdiagnosis；加单测 |
| B2 | **P1（必须核实，Codex 已给归属）** | **scene 覆盖回归**：计划把 3 条全迁到 `scrolling.strategy.md`。但它们不是同一 scene 粒度，一刀切进 scrolling 会让其它场景**丢失误诊防护** | 按实际语义分挂：**VSync/VRR → pipeline+touch+scrolling**（`pipeline.strategy.md:90-94`/`touch-tracking.strategy.md:115-128`/`scrolling.strategy.md:68-83`）；**Buffer Stuffing → scrolling+pipeline**（`scrolling:73-83`/`pipeline:62-71`）；**single-frame critical → global/shared**（startup 也需，`startup.strategy.md:33-36/610-627`）。需 schema 支持多 scene 或 global 声明 |
| B3 | P2 | **ReDoS**：strategy 作者写的 regex 跑在 LLM 结论文本上，灾难性回溯可挂住 verifier | 加 regex 复杂度/超时保护，或在文档明确"strategy 作者对 regex 安全负责" + 校验期做简单复杂度检查 |
| B4 | P2 | frontmatter schema 校验不足 | 校验 `id` 唯一、必填字段齐、`patterns` 非空、`type` 仅 `known_misdiagnosis` |
| B5 | ✅ 认可 | `type` 钉死 `known_misdiagnosis` | 保持；防 strategy 制造任意 verifier issue 类型 |

### 2.3 计划测试计划的补强建议
计划的单测方向（strategyLoader 加载、claudeVerifier 规则来自 strategy、scene-aware 不串场景）到位。**追加**：
- B1 的 regex 编译失败用例（非法 pattern → validate 失败）。
- B2 的跨场景断言（确认每条规则在其声明 scene 触发、在非声明 scene 不触发——尤其 single-frame/vsync 是否需多 scene）。
- Q1 的"忘传 scene"防护用例（如保留可选重载，则需断言无静默全量）。

---

## 3. Review Log

### Round 1 —— Claude 验收 + 计划评审（2026-06-07）
- 实地核对 15 提交 + `ea571e85` amend；6 项门全部直跑二进制验证通过（见 §0）。
- 防住假阳性：`npm run | tail` 掩盖失败退出码（改直跑）；`/interaction` 是 focus tracking 非 intervention（确认未误删）；962f8267 是正经补齐非创可贴。
- 产出：Part A 验收（A1 gitignore 待修、A2 双谓词、A3 已解决）+ Part B 计划评审（Q1/Q2/Q3 回答 + B1/B2 必处理 + B3/B4 建议）。
- 待办：交 Codex 反复 review（重点挑战 Part A 是否漏判实现缺陷、Part B 的 3 个回答与 B2 scene 归属）。

### Round 2 —— Codex 只读复审（2026-06-07，session `019e9c24`）
- 结论：**可交付给实现方整改，但 Part A 不能按"完全验收通过"定稿**。
- **新增 P1（A0，我漏判、已核实）**：跨 run 取消竞态——`cancelState` 只存当前 run，"取消 A→开 B"后 A 的迟到回调不再被识别为 cancelled。Codex 用"找反例"视角发现，我读 prepareSession（不中止旧 run）+ catch（按 oldRunId 比当前 cancelState）确认属实。
- 补充：A4（lease 失败无取消守卫，P2）、A5（兼容 shim 残留，P3）、WS-I 措辞收窄（可验证复用+降级，非无条件原生 restore）。
- Part B：同意 Q1/Q2/Q3；**确认 B2 三规则 scene 归属**（VSync→pipeline+touch+scrolling；Buffer Stuffing→scrolling+pipeline；single-frame→global/shared）；坐实 B1（`validate.ts:915-923` 当前只校验 final_report_contract，须新增 verifier frontmatter 校验）。
- 我对 Codex 反馈的处理：A0/A4/B2 亲自核实代码后采纳；WS-I 收窄措辞；其余按 file:line 一致。
- 输出：本文档更新至含 A0–A5 + B1–B5 + Q1-3 回答。

### Round 3 —— 待定（实现方整改后复验 / 或 Codex 终审本文档）
- 触发：实现方修 A0/A1/A4（+ 计划落地时 B1/B2）后，复跑取消并发回归 + 受影响门；或先让 Codex 终审本文档完整性。

<!-- 后续轮次在此追加 -->
