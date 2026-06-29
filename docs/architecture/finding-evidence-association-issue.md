# Finding-Evidence Association Bug — for implementer

**来源:** DeepSeek e2e scrolling run(表格 P0 修复后),`docs/architecture/memory-e2e-findings.md` 的"次要观察"延伸。
**日期:** 2026-06-22
**性质:** 表格解析 P0 修好后暴露的下一个独立问题。**不是**表格 bug 的残留,是 finding 与 evidence 关联的另一条路径。不阻塞已推送的两个 commit,建议单独追。

---

## 现象

scrolling e2e 仍 `analysisCompletedPartial: true` / `terminationReason: "plan_incomplete"`,但 terminationMessage 已经从表格 bug 的 `CRITICAL 发现 "|"` 变成一个**有意义的真实标题**:

```
CRITICAL 发现 "Frame 2 — 主线程 ANIMATION 同步重载" 缺少证据支撑
```

- `fallback: "verification_failed"`
- `confidence: 0.55`
- `claimVerifierStatus: "passed"`(12 claim 全过)—— **claim verifier 过了,但 heuristic verifier 挂了,两者判定矛盾**

## 根因线索(实现方据此深挖)

这个 finding **不是模型这次产出的结构化 finding**,也**不在 conclusion 文本里**。证据:

1. **structured findings 数组为空。** snapshot 里 `findings`(protocol)= **0 条**,`claudeFindings/hypotheses` = 2 条(不含这个标题)。
2. **conclusion 里没有 `[CRITICAL]` 行,也没有 "Frame 2" 作为 heading。** conclusion 只有 535 字符(流式截断显示),实际约 4800 字符,但全文 grep "Frame 2" + "ANIMATION 同步" 在 heading/CRITICAL 上下文里**零命中**。
3. **这个字符串只出现在两个地方:**
   - `Update: degraded` 事件(就是错误消息本身)
   - `Update: agent_task_dispatched` 事件:`fetch_artifact` 调用,args 是 `{artifactId: "art-44", detail: "full", purpose: "获取Frame 2诊断详情"}`
4. **不在 memory 里。** `analysis_patterns.json` / `analysis_negative_patterns.json` grep 不到这个字符串。

### 推断(需实现方确认)
finding 标题 `"Frame 2 — 主线程 ANIMATION 同步重载"` 很可能是从 **agent 对话/响应流(agentDialogue / agentResponses / 某个 task 派发的描述)** 里被 `extractFindingsFromText` 提取出来的——模型在派发 `fetch_artifact(art-44)` 取 Frame 2 详情时,在对话里提到了这个标题,extractor 把它当成一个 `[CRITICAL]` finding 抽出来了,但**对应的 evidence(art-44 的实际内容)没有被关联到这个 finding**。

所以这是 **finding 提取 vs evidence 关联的脱节**:extractor 能从对话流里抽出 finding 标题,但 finding 的 `evidence` 字段为空(因为 evidence 在 artifact 里,没有被回填到 finding)。

## 为什么 claim verifier 过了但 heuristic 挂了

两个 verifier 标准不一致:
- **claim verifier**(结构化 claim 校验):检查的是结论里的 claim 有没有支撑,过了。
- **heuristic verifier**(`claudeVerifier.ts:200-208` `verifyHeuristic`):检查的是 **finding 级别**——`f.severity === 'critical'` 且 `f.evidence` 为空就报 `missing_evidence`。它抓到了那个从对话流抽出来的、无 evidence 的 critical finding。

两者都返回 issue,但最终 `partial` 似乎由 heuristic 的 `verification_failed` 主导。这个优先级关系本身也值得审视(见下面 P2)。

## 实现方要做的

### P1 — 查清 finding 的真实提取来源
1. 在 `claudeVerifier.ts` 的 `verifyHeuristic` line 200 加临时日志:打印传入的 `findings` 数组里每个 finding 的 `title` / `source` / `evidence`,确认 "Frame 2" 这个 finding 的 `source` 字段是什么(`claude-agent`?`skill:xxx`?)。
2. 反向追踪:这个 finding 是从哪个文本 extract 出来的?在 `extractFindingsFromText` 的调用方(openAiRuntime.ts 的 4 个调用点:1052/1098/1989/2088)加日志,看喂进去的 `text` 参数里 "Frame 2" 出现在哪段(是 conclusion?是 agentResponses?是 task dispatch 描述?)。
3. 确认后,把发现写进这个文档的"根因确认"小节。

### P1 — 修复 finding-evidence 关联(基于上面的根因)
方向取决于根因:
- **如果是 extractor 从对话流/task 描述里误抽 finding:** `extractFindingsFromText` 要么不扫对话流,要么扫到时要求更强的结构信号(不能光凭 `[CRITICAL]` + 一段文字就抽)。
- **如果是 finding 抽出来了但 evidence 没回填:** 修复 evidence 回填逻辑——当 finding 引用了某个 artifact(`fetch_artifact` 的结果),要把那个 artifact 的内容关联进 finding.evidence。可能需要在 finding 里记录 `sourceArtifactId`,verifier 检查 evidence 时认可 artifact 引用。
- **如果是模型这次真没产出结构化 finding(只口头提了 Frame 2):** 这是模型质量问题,不该靠 verifier 兜底降级——见下面 P2。

### P2 — 审视 claim verifier vs heuristic verifier 的优先级
当前:heuristic 报 `missing_evidence` 就触发 `verification_failed` → `partial`,即使 claim verifier passed。
- 一个 finding 缺 evidence,但所有结构化 claim 都有支撑——这种情况下整个分析被判 partial、confidence 0.55、提前终止,是否合理?
- 建议:heuristic 的 `missing_evidence` 改成 **warning 而非 error**,或者只在 claim verifier 也 fail 时才升级为 error。否则一个边缘 finding 的 evidence 缺失会拖垮整个分析的质量分。

### P2 — 统计历史影响面
之前发现"最近 20 个 session 全 partial"。表格 bug(已修)是贡献者之一,但这个 finding-evidence 问题可能也是贡献者。实现方跑一下:
```sql
SELECT id, json_extract(metadata,'$.sessionStateSnapshot.analysisCompletedTerminationMessage') as msg
FROM sessions
WHERE json_extract(metadata,'$.sessionStateSnapshot.analysisCompletedPartial') = 1
ORDER BY updated_at DESC LIMIT 30;
```
统计 terminationMessage 的特征分布:多少是 `"|" 缺少证据`(表格 bug,应已消除)、多少是真实标题缺证据(本 issue)、多少是其他原因(预算耗尽等)。这能定位本 issue 的真实影响面。

## 验证用例(实现方修完后我用这些复验)

1. 重跑 scrolling e2e,断言 `terminationReason` 不再是 `plan_incomplete`(或 terminationMessage 不再是 "缺少证据支撑" 类)。
2. 如果改了 verifier 优先级:断言 claim verifier passed + heuristic warning 时,最终 `partial === false`。
3. 统计历史 session 的 terminationMessage 分布,对比修复前后 partial 比例。

## 复现数据(实现方可用)

- scrolling run session id:`agent-1782126296522-8v9z8hfw`
- session log:`backend/logs/sessions/session_agent-1782126296522-8v9z8hfw_2026-06-22T11-04-56-522Z.jsonl`
- e2e 输出:`backend/test-output/e2e-deepseek-scrolling-real.json`
- 关键事件:degraded at timestamp `2026-06-22T10:41:16.752Z`(注:log 时间戳是 UTC 10:41,文件名 11:04 是本地时区,同一事件)
- 触发 finding 的 task:`fetch_artifact(art-44)`,taskId `call_02_Qe5o80FVn3tw0uDZczM09901`
