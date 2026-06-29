# SmartPerfetto Bug 修复验收报告

- **对应审查报告**: `docs/architecture/source-code-bug-review.md`
- **验收范围**: 实践方对确认 P0/P1 的逐条修复（B01、B03、B04、B05、B06、B07、B08、B09、B10、B11）
- **验收方式**: 只读复核。逐条回到源码确认修复正确性 + 逐条确认回归测试确实覆盖原 bug 场景 + 独立重跑实现方声称通过的验证命令。
- **验收日期**: 2026-06-21
- **验收方**: ZCode

---

## 一、验收结论

**整体结论: 通过（带 2 条说明）**

- 8 条确认 P0/P1（B01、B04、B05、B06、B07、B08、B09、B10）+ 1 条报告外 P1（B11）修复**正确且回归测试到位**。
- 1 条（B03）修复**正确但属深度防御**：原 bug 在生产代码不可达（`restoreSessionMapping` 无任何生产调用方，接口注释已标 `@deprecated Dead code`）。原报告 P1 定级偏高，实践方按 P1 修了没错，但实际影响为 0。
- 1 条 B08 子分支（`getFocusedTimeRangeFromUserFocus` 从用户焦点派生时间窗）**无测试覆盖**。主路径（保留已有 focusedTimeRange）有测试。非回归，属覆盖缺口。

---

## 二、逐条验收

| 编号 | 修复正确 | 测试覆盖原 bug | 验收 |
|---|---|---|---|
| **B01** merge_findings 静默丢 finding | ✅ | ✅ | **通过** |
| **B03** OpenAI session map key 命名空间 | ✅ | ✅ | **通过（降级说明）** |
| **B04** evidence `Number.EPSILON` 零容差 | ✅ | ✅ | **通过** |
| **B05** 5 家 dual-surface 厂商漏鉴权 | ✅ | ✅ | **通过** |
| **B06** `terminalRunStatus` 契约漂移 | ✅ | ✅ | **通过（含契约核查）** |
| **B07** conclude 不设 stopReason | ✅ | ✅ | **通过** |
| **B08** deep_dive 重置成全局 | ✅ | ⚠️ 部分 | **通过（带缺口）** |
| **B09** Vertex 401/403 误报成功 | ✅ | ✅ | **通过** |
| **B10** 质量门 partial 早返回 | ✅ | ✅ | **通过** |
| **B11** OpenCode 异步轮询取到上一轮（报告外） | ✅ | ✅ | **通过** |

### B01 — merge_findings 策略静默丢 finding ✅
- **修复** (`mergeStrategies.ts:526-532`): `merge()` 对 `strategy === 'merge_findings'` 调用新方法 `injectMergedFindingsResult`，把 `mergeFindings()` 产出的、与父会话去重后的**新 finding** 注入一个合成 `StageResult`（`stageId: merge_findings:<childId>`），追加进 `mergedResults`。`mergedContext.previousResults` 现在含子会话 finding。
- **去重逻辑正确**: `getFindingIdentity` 用 `id/category/type/severity/title/description` 组合作 key，`countFindings` 多实例计数，正确处理父会话里已有同 id finding 的情况。
- **测试** (`mergeStrategies.test.ts:43-67`): 直接断言 `mergedContext.previousResults` 里 `flatMap(findings)` 同时含 `parent-finding` 和 `child-finding`。去掉 `injectMergedFindingsResult` 即失败。刚性回归。

### B03 — OpenAI session map key 命名空间 ✅（降级说明）
- **修复** (`openAiRuntime.ts:597-604`): `restoreSessionMapping` 新增 `referenceTraceId?` 参数，经 `buildSessionMapKey` 命名空间化。`claudeRuntime.ts:766` 同步修。
- **测试** (`openAiRuntime.test.ts` 新增): 验证 `restoreSessionMapping('s1', 'resp', 'trace-b')` 后 `getSdkSessionId('s1')` 为 undefined、`getSdkSessionId('s1','trace-b')` 为 `'resp'`。
- **降级说明**: 复核发现 `restoreSessionMapping` **在生产代码无任何调用方**（`grep` 全仓只有定义和测试）。真正的 snapshot 还原路径 `restoreFromSnapshot` (`openAiRuntime.ts:1387`) **本来就正确用了** `buildSessionMapKey(sessionId, snapshot.referenceTraceId)`。`IOrchestrator` 接口上该方法已标 `@deprecated P1-7: Dead code`。
- **结论**: 修复本身正确（方法体现已健壮），但原报告把它列为 P1「正常代码路径中 OpenAI 连续性静默丢失」是**定级偏高** —— 实际生产影响为 0。实践方按报告修了没错，验收通过，但记录此差异供 severity 校准。

### B04 — evidence `Number.EPSILON` 零容差 ✅
- **修复**: 抽出新模块 `src/services/evidence/valueComparison.ts`，用绝对容差 `1e-3` + 相对容差 `1e-6 * scale`（`scale = max(1, |a|, |b|)`）。`evidenceContractBuilder.ts` 和 `deterministicClaimVerifier.ts` 两处 `valuesMatch` 都改为 import 这个共享实现 —— **消除了原本两份重复且都有同 bug 的代码**。
- **容差选择合理**: Perfetto trace 数据是 ns/ms 级，`1e-3` 绝对 + `1e-6` 相对对 `1234.5600000001` vs `1234.56` 这类浮点漂移足够宽松，对真正的数值错误（如差 10%）仍判 mismatch。
- **测试** (`claimVerificationRunner.test.ts`): 结论引用 `120`，数据含 `120.0000000001`，断言 `supportLevel === 'verified'`。旧 `Number.EPSILON` 下此差 `~1e-10` 远大于 `EPSILON` 会判 mismatch，测试会失败。刚性回归。另含独立 `valueComparison.test.ts`。

### B05 — 5 家 dual-surface 厂商漏鉴权 ✅
- **修复** (`providerRuntimeMatrix.ts:79-81`): `sharedKeyShouldUseClaudeAuthToken` 直接 `return isDualSurfaceProviderType(type)`，消除两份手工列表漂移 —— 永远不可能再漏。
- **测试** (`providerService.test.ts`): 遍历全部 16 个 `DUAL_SURFACE_PROVIDER_TYPES`，对每个断言 `ANTHROPIC_AUTH_TOKEN === sk-<type>-test` 且 `ANTHROPIC_API_KEY === undefined`。含原漏的 `glm/qwen_coding/kimi_code/xiaomi/siliconflow`。刚性回归。

### B06 — `terminalRunStatus` 契约漂移 ✅（含契约核查）
- **修复**: 我原报告标 ⚠️「需确认运行时是否在 schema 外发射该字段」。验收时已确认 —— 运行时**确实发射**，且实践方判断正确（契约漂移而非死分支）。修了 4 处：
  - `src/types/dataContract.ts:957` — `AnalysisCompletedEvent.data` 加 `terminalRunStatus?: 'completed' | 'quota_exceeded'`
  - `scripts/generateFrontendTypes.ts:646` — 生成器同步
  - `scripts/checkTypesSync.ts:252` — 类型同步检查加该校验
  - `src/types/__tests__/dataContract.test.ts` — 断言源码含该字段
- **契约核查（实践方未明说，我补查确认）**: 实践方把类型收窄成 2 值（`completed | quota_exceeded`），去掉了前端原本的 `cancelled`。**这是正确的**：
  - `terminalRunStatusForResult` (`agentRoutes.ts:222-227`) 对 `analysis_completed` 只产 `completed`/`quota_exceeded`/`failed`，**不发 `cancelled`**。
  - `cancelled` 出现在**另一个事件** `analysis_cancelled` (`agentRoutes.ts:568`)，前端 `sse_event_handlers.ts:4919` 按 `eventType === 'analysis_cancelled'` 直接设 `status: 'cancelled'`，**不依赖 `terminalRunStatus` 字段**。
  - 所以前端解析器 `sse_event_handlers.ts:180` 仍接受 3 值是过度宽松（无害），后端类型 2 值与实际发射一致。无矛盾。

### B07 — conclude 不设 stopReason ✅
- **修复** (`hypothesisExecutor.ts:308-314`): conclude 分支设 `stopReason = 'Strategy concluded'` 并发 `early_stop` progress 事件。
- **测试** (`hypothesisExecutor.test.ts`): 新增用例断言 `result.stopReason === 'Strategy concluded'` 且 emitted updates 含 `phase: 'early_stop'`。另把 3 处原本 `expect(stopReason).toBeNull()` 的旧断言改成 `'Strategy concluded'`（这些场景实际也走 conclude 出口，旧断言反而在掩盖 bug）。

### B08 — deep_dive 重置成全局 ✅（带覆盖缺口）
- **修复** (`hypothesisExecutor.ts:345-351`): 不再无条件 `focusedTimeRange = options.timeRange`。改为：若已有 `focusedTimeRange` 则保留；否则尝试 `getFocusedTimeRangeFromUserFocus(topFocuses)` 从 `type==='timeRange'` 的用户焦点派生；都没有则不动。
- **测试**: 仅覆盖「保留已有 focusedTimeRange」主路径 —— 预置 `{1000..2000}`、全局 `{0..9999}`、触发 deep_dive，断言仍为 `{1000..2000}`。旧代码下会被重置成 `{0..9999}`，测试会失败。主路径刚性回归。
- **覆盖缺口**: 新方法 `getFocusedTimeRangeFromUserFocus`（从用户焦点派生）**无测试**。非回归，但建议补一个用例：无 focusedTimeRange + 有 timeRange 用户焦点 → 派生成功；无 focusedTimeRange + 无 timeRange 焦点 → 不修改。

### B09 — Vertex 401/403 误报成功 ✅
- **修复** (`connectionTester.ts:271-277`): 401/403 改返回 `{ success: false, modelVerified: false, error: 'Vertex auth failed (...)' }`。
- **测试** (`connectionTester.test.ts`): mock 401 响应，断言 `success === false`、`modelVerified === false`、error 含 `'Vertex auth failed (401)'`。刚性回归。

### B10 — 质量门 partial 早返回跳过 kernel-blocking 检查 ✅
- **修复** (`finalResultQualityGate.ts:343-350`): 不再 `partial → return undefined`。改为 partial 时仍对分析类 query 跑 `assessKernelBlockingClaimBoundary`，只跳过「完整性」类检查（空结论等）。修复范围精准 —— 正是我报告里建议的「partial 仍应跑结构性 claim 边界检查，只跳过完整性检查」。
- **测试** (`finalResultQualityGate.test.ts`): 构造一个 `partial: true` + 结论含「blocked_function 是完整内核调用栈」的 I/O 场景，断言仍触发 `kernel_blocking_claim_boundary`。旧代码 partial 早返回会让此断言失败。刚性回归。

### B11 — OpenCode 异步轮询取到上一轮（报告外 P1）✅
- **修复** (`openCodeRuntime.ts`): 引入 baseline 机制 —— promptAsync 前快照现有 assistant 消息签名（`getOpenCodeAssistantMessageSignature`，优先 message id，回退 completed/finish/text），轮询时用 `getOpenCodeAssistantMessagesAfterBaseline` 过滤掉 baseline 及之前的消息，只返回本轮新消息。
- **签名设计鲁棒**: id 优先，id 缺失时回退内容指纹，处理了 OpenCode 可能不返回 id 的情况。
- **测试** (`openCodeRuntime.test.ts`): 构造 `oldAssistant`(id=msg-old) 已存在 → prompt → 新增 `newAssistant`(id=msg-new)，断言 `extractOpenCodeAssistantText === '本轮新报告'` 而非 `'上一轮旧报告'`。旧 `getLatestOpenCodeAssistantMessage` 下第二次轮询返回 `[oldAssistant]` 会判定完成并返回旧文本，测试会失败。刚性回归。

---

## 三、独立重跑验证命令（全部通过）

| 命令 | 结果 | 与实现方声称一致 |
|---|---|---|
| `npm run typecheck` | ✅ 通过（无错误） | ✅ |
| `npm run generate:frontend-types` | ✅ 通过（No changes，已同步） | ✅ |
| `npm run check:types` | ✅ 通过（Frontend types in sync） | ✅ |
| 10 个相关 jest suite（含 `valueComparison.test.ts`） | ✅ 245/245 通过 | ✅（9 suite/245 与实现方一致，我多跑了 valueComparison 单测） |
| `npm run test:scene-trace-regression` | ✅ 6/6 trace 通过 | ✅ |
| `git diff --check` | ✅ exit 0，无空白错误 | ✅ |

**注**: `code-simplifier` / 独立 Codex reviewer 实现方报 NOT AVAILABLE，已做人工架构 review —— 与上轮审查的约束一致（ZCode 本环境无 codex MCP），可接受。

---

## 四、工作区与契约合规核查

- `AGENTS.md` / `CLAUDE.md` mtime 为任务前（2026-06-20），**未被本次修改触碰** —— 与实现方声称一致。
- `perfetto` 子模块 dirty 仅来自重新生成的插件契约类型文件（`generated/`），**未更新 submodule gitlink**（`git diff --submodule` 只显示 modified content，无 new commit）—— 符合 `AGENTS.md`「Do not push a root commit that points at a local-only perfetto submodule commit」。
- 未跟踪的 docs/report/test output 文件保留未动。
- 22 个文件改动（含 4 个新测试文件），413 insertions / 61 deletions，范围聚焦，无越界改动。

---

## 五、给实践方的后续建议（非阻塞）

1. **B08 补一个测试**: 覆盖 `getFocusedTimeRangeFromUserFocus` 的派生路径与「无可用焦点则不修改」路径。当前只有「保留已有」主路径有覆盖。
2. **B03 考虑彻底删除 `restoreSessionMapping`**: 它是 `@deprecated Dead code`，无生产调用方。既然这次为了健壮性修了方法体，不如直接删掉接口和两个实现，消除未来再次被误用的可能（如果担心外部插件依赖，至少加个运行时 warn log）。
3. **severity 校准**: 下一轮审查我会把「方法存在但无生产调用方」类问题降为 P2/信息项，避免实践方在不可达路径上投入 P1 工作量。

---

## 六、最终判定

**验收通过。** 10 条确认项全部修复正确，回归测试覆盖到位，验证命令独立复现通过，工作区合规。2 条说明（B03 降级、B08 子分支缺测试）为非阻塞信息项，不影响合并。

建议实践方：补 B08 子分支测试后即可提交。
