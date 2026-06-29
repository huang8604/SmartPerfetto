# E2E + Memory-Effect Findings — for implementer

**来源:** DeepSeek e2e(startup + scrolling 两个 suite)+ 存储/日志扫描。
**日期:** 2026-06-22
**性质:** memory 改动上线后的真机验证。发现 1 个 memory 改动在生产数据流里失效(G8),1 个 e2e 暴露的既有解析 bug(不在 memory scope,但影响 e2e 判定)。

完整实现 review 见 `memory-system-review-implementation-review.md`。本文档只列**需要修的新发现**。

---

## ✅ 已验证有效(不用动)

- **G1 sweep 真起效。** `analysis_patterns.json` 里 24 条 pattern **全部从 `provisional` → `confirmed`**。sweep 上线后,之前卡在半权重(0.5)的经验升到全权重(1.0)。
- **case library recall 活跃。** scrolling run 调了 6 次 `recall_similar_case`、5 次 `lookup_knowledge`。
- **SQL error-fix learning(Layer 8)正常。** 仍 20 条(本次无新 SQL 错误,符合预期)。
- **两个 e2e suite 的 claimVerifier 都 passed**(12 claim 全过,0 unsupported)。
- G3 `continuityBreaks`、G14 `lineage` 在 DB 里 0 条——符合预期(e2e 没触发 provider hash 变化或 CLI Level-3)。

---

## ❌ 必须修:G8 在真实数据流里完全失效(BLOCKER)

### 现象
`messages.sql_result` 列在本次 e2e 后仍然 **688 条消息全 0 字节非空**。G8 上线前后无区别。IF1 的 read-back 代码写得再好,也没有数据可读。

### 根因
G8 的写入过滤条件**命不中真实数据流**。

`backend/src/services/persistAgentSession.ts:129` 的 `isSqlResultEnvelope` 只认 `meta.type === 'sql_result'`:
```ts
function isSqlResultEnvelope(value: unknown): value is PersistableSqlEnvelope {
  return Boolean(value && typeof value === 'object' && (value as any).meta?.type === 'sql_result');
}
```

但实际 run 产出的 envelope 类型分布(最近 5 个 session 统计):
- `skill_result`: **99 个**(其中大量内含真实 SQL 结构 `data: {columns, rows}`)
- `sql_result`: **3 个**(只在 MCP 工具直返 SQL 时产生,见 `claudeMcpServer.ts:5892,5958`)

也就是说 **97% 的真实 SQL 结果(skill 产出的)被 G8 过滤掉了**。本次 e2e 的 startup run 产出 35 个 envelope,全是 `skill_result`,**0 个 `sql_result`**——所以 4 条新 assistant 消息的 `sql_result` 列全空。

### 为什么单测没发现
单测(`persistAgentSession.test.ts` 的 "persists sql_result message bundle")直接喂的是 `meta.type: 'sql_result'` 的 envelope,**不反映真实数据流**。这是典型的"测试绿但生产不 work"。

### 修复方向
`isSqlResultEnvelope` 要同时识别 `skill_result` 类型里内含 SQL 结构的 envelope。判断条件建议:
- `meta.type === 'sql_result'`,**或**
- `meta.type === 'skill_result'` 且 `data` 是对象且含 `columns` 和 `rows` 字段

可参考已有逻辑:`analysisResultSnapshotPipeline.ts:367` 已经在做 `sql_result` vs `skill` 的区分,可复用。

### 修复后要补的测试
- 用真实形态的 envelope(类型 `skill_result`,`data: {columns, rows}`)喂 `buildAssistantSqlResult`,断言产出非空 bundle。
- 跑一次真实 e2e(或集成测试),断言 `messages.sql_result` 列有非空值。

### 影响范围
G8 + IF1(G8 read-back)在修好前**形同虚设**。agent 仍然无法回看过去的原始 SQL 结果——这正是 G8 要解决的核心伤害。

---

## ❌ 必须修:结论 markdown 表格被误解析为 finding,导致假 partial/degraded

**这个 bug 不在 memory 改动 scope 里,但 e2e 把它暴露了,且影响 e2e 判定的可信度。强烈建议一并修。**

### 现象
scrolling e2e 虽然 `claimVerifierStatus: passed`,但:
- `analysisCompletedPartial: true`
- `terminationReason: "plan_incomplete"`
- `terminationMessage: "CRITICAL 发现 \"|\" 缺少证据支撑"`
- `confidence: 0.55`(被打低)
- `fallback: "verification_failed"`

也就是说:分析其实是成功的,但被错误标记为 partial/degraded、提前终止、confidence 暴跌。

### 根因
模型在结论里输出了一个标准的 markdown 表格(根因分布表):
```
| 类型 | 帧数 | 占比 | 根因 | 严重度 |
|------|------|------|------|--------|
| `CustomScroll_longFrameLoad` | 6 | 85.7% | ANIMATION 回调同步重载 | [CRITICAL] |
```

`extractFindingsFromText`(`backend/src/agentv3/claudeFindingExtractor.ts:43`)用 `SEVERITY_REGEX` 扫描 `[CRITICAL]` 等标记,把**标记前面的捕获组**当成 finding 的 title(line 56)。在表格行里,`[CRITICAL]` 前面的片段被错误捕获,产生了一个 **title 为 `|`(表格分隔符)的 critical finding,且无 evidence**。

然后 `verifyHeuristic`(`claudeVerifier.ts:200-208`)发现这个 title 为 `|` 的 critical finding 没有 evidence,触发 `missing_evidence` error → `verification_failed` → partial/plan_incomplete。

### `extractFindingsFromText` 对 markdown 表格毫无防御
`claudeFindingExtractor.ts:43-76` 假设 `[SEVERITY]` 标记出现在 heading/列表上下文,没有处理"表格单元格里出现 `[CRITICAL]`"的情况。任何模型在结论表格里用 `[CRITICAL]`/`[HIGH]` 标记严重度的场景都会触发。

### 影响范围(可能比单次更广)
- startup e2e 也 hit 了(`plan_incomplete`/`verification_failed` 出现 2 次)。
- **最近 20 个 session 全部 `analysisCompletedPartial = true`**。这个高比例可能由多种原因导致(表格解析、真缺证据、预算耗尽等),不全是这一个 bug,但这个 bug 很可能是主要贡献者之一。建议实现方查一下这 20 个 session 的 `terminationMessage`,统计有多少是 `"|" 缺少证据支撑` 这个特征。

### 修复方向
`claudeFindingExtractor.ts` 的 `extractFindingsFromText` 在扫描前应**跳过/屏蔽 markdown 表格行**(类似它已经 `maskCodeBlocksForFindingScan` 屏蔽代码块的做法)。或者:`SEVERITY_REGEX` 的 title 捕获组要排除以 `|` 开头/结尾或全是 `|`/`-`/空格的片段。

判断一个表格行的启发式:该行含 `|` 且去掉 `|` 和空白后是 `---`/空,或单元格数(被 `|` 分割)≥ 3。

### 修复后要补的测试
- 喂一个含 markdown 表格 + `[CRITICAL]` 单元格的 conclusion,断言不产生 title 为 `|`/`---` 的 finding。
- 喂一个含 markdown 表格 + `[CRITICAL]` 的 conclusion,断言不触发 `missing_evidence`。
- 回归:正常 heading 里的 `[CRITICAL] 发现 XXX` 仍能正确解析。

---

## ⚠️ 次要观察(非阻塞)

1. **scrolling run `claimVerifierStatus: passed` 但 `partial: true` 的矛盾。** claim verifier(结构化 claim 校验)过了,但 heuristic verifier(发现级检查)因为上面的表格 bug 挂了。两者判定标准不一致。修了表格 bug 后建议复核两者的优先级关系——一个 passed 一个 failed 时,最终 `partial` 该信谁。

2. **e2e suite 的 "passed" 判定只看 claimVerifier。** `run-deepseek-agent-e2e.cjs` 报 "Deepseek Agent SSE E2E passed",但 scrolling 其实是 partial/plan_incomplete。e2e 的 pass 门槛可能偏低,掩盖了上面这类问题。建议 e2e 在 `partial === true` 或 `terminationReason === 'plan_incomplete'` 时至少 warn,不要静默 pass。

---

## 给实现方的优先级

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | G8 envelope 过滤条件修复 | memory 改动里的核心项在生产失效,单测掩盖了。修了 G8+IF1 才真正生效 |
| **P0** | 结论表格解析 bug | 导致几乎所有分析假 partial,confidence 暴跌,可能影响线上质量判定。虽不在 memory scope,但 e2e 暴露了,影响面大 |
| P1 | 统计历史 20 个 session 的 terminationMessage | 搞清楚表格 bug 的真实影响面,决定要不要回溯历史数据 |
| P2 | e2e pass 门槛 + verifier 优先级 | 让 e2e 更可信 |

---

## 验证用例(实现方修完后我用这些复验)

1. 修 G8 后:跑一次 startup e2e,断言 `messages.sql_result` 有非空值。
2. 修表格 bug 后:跑一次 scrolling e2e,断言 `partial === false`、`terminationReason` 不是 `plan_incomplete`(或至少不再是 `"|" 缺少证据支撑`)。
3. 复查 `analysis_patterns.json` 的 24 条仍是 `confirmed`(G1 回归)。
