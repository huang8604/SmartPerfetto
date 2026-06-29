# SmartPerfetto 源码 Bug 审查报告

- **范围**: 全量源码审查（backend `src/` + 前端插件 `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`）
- **方式**: 只读 review，不修改代码。由主审查通读 + 4 个并行只读子代理分头扫描，主审查对每条 P0/P1 发现逐一回到源码复核（标注 ✅ 复核 / ⚠️ 待复核）。
- **审查日期**: 2026-06-21
- **审查者**: ZCode（主审查）+ Explore 子代理
- **问题分类**:
  1. 前后端逻辑错误
  2. bug 不能闭环（启动后永远不结束 / promise 永远不 resolve / 状态机卡死）
  3. 逻辑自相矛盾（永真/永假分支、契约自相矛盾）
  4. 各 Agent 调用有问题（错误分发、参数不匹配、重复调用、结果被丢弃）

严重度约定：**P0** 崩溃/数据丢失/资源耗尽；**P1** 行为错误（用户可见错误结果）；**P2** 次要。

---

## 一、P0 / 高危发现

### B01. `merge_findings` 合并策略静默丢弃所有子会话 finding  ✅ 复核
- **文件**: `backend/src/agent/fork/mergeStrategies.ts:503-541`，配合 `backend/src/agent/fork/mergeStrategies.ts:347-371` 与 `backend/src/agent/fork/forkManager.ts:685-692`
- **类别**: 4（Agent 调用 / 结果被丢弃）→ 也属 1（逻辑错误）
- **置信度**: 9/10
- **问题**: `MergeStrategyRegistry.merge()` 分别调用 `strategy.mergeResults()`（产出 `mergedResults`，写入 `mergedContext.previousResults`）和 `strategy.mergeFindings()`（产出 `mergedFindings` / `conflicts` / `resolutions`）。但 `mergedFindings` 仅用于算一个 `mergedFindingsCount` 计数返回，**从未写回 `mergedContext`**。
- 对 `MergeFindingsStrategy` 尤其致命：它的 `mergeResults()` 明确「不改变 results」（`mergeStrategies.ts:358-360`，直接返回 `parentResults`），所以子会话的 `previousResults` 根本没进 `mergedContext`；而它真正干活的 `mergeFindings()`（过滤、打 `[Pick: ...]` 标签）产出又被丢弃。`forkManager` 后续靠 `collectFindings(mergedContext.previousResults)`（`forkManager.ts:365`）重抽 finding，此时抽到的只有父会话原有 finding —— **子会话的所有 finding 全部丢失**，而该策略的名字就叫「只合并发现」。
- **影响**: 任何 fork 用 `merge_findings` 策略合并的子会话结论都被吞掉，父会话看不到子会话的任何成果。合并显示「成功」，实际空合并。
- **建议修复方向**: `merge()` 需把 `findingsData.mergedFindings` 写回 `mergedContext` 的某个字段（新增 `mergedFindings` 或把带标签的 finding 注入到 `mergedResults` 里），并让 `collectFindings` 能读到。

### B02. `taskGraphExecutor` 任务分发抛错时 `pending` 不清空，但不会无限循环（子代理误报，已降级）
- **文件**: `backend/src/agent/core/taskGraphExecutor.ts:67-96`
- **类别**: 2（闭环问题）
- **置信度**: 3/10（**子代理原报 P0，复核后为误报**）
- **复核结论**: 该 `while` 循环体**没有 `try/catch`**（已确认整个文件无 try/catch）。若 `messageBus.dispatchTasksParallel(ready)` 抛错，rejection 会直接冒泡出 `executeTaskGraph` 函数，**不会回到 while 顶部重试**。因此「无限重新分发同一批失败任务」的 P0 结论不成立。真正的问题是抛错后整批 abort，但这是正常 fail-fast，不是 bug。**不作为缺陷记录**，仅留此条说明为何剔除。

---

## 二、P1 / 行为错误发现

### B03. OpenAI runtime 还原 session mapping 时写错 key 命名空间 ✅ 复核
- **文件**: `backend/src/agentRuntime/engines/openai/openAiRuntime.ts:597-604`
- **类别**: 1（逻辑错误）/ 2（闭环断开）
- **置信度**: 9/10
- **问题**: `restoreSessionMapping(sessionId, sdkSessionId)` 直接用原始 `sessionId` 读写：
  ```ts
  const existing = this.sessionMap.get(sessionId);          // 错：原始 sessionId
  this.sessionMap.set(sessionId, { ... });                  // 错：原始 sessionId
  ```
  而其它所有路径（`getSdkSessionId:590-595`、`forgetOpenAILastResponseId:610`、`analyze`、`restoreFromSnapshot:1384`）都走 `buildRuntimeSessionMapKey(sessionId, referenceTraceId)`，当设置了 `referenceTraceId` 时 key 是 `${sessionId}:ref:${referenceTraceId}`。
- **影响**: 当 session 带有 `referenceTraceId` 时，还原写入的 `lastResponseId` 存在一个**永远不会被读取**的 key 下 —— OpenAI previous-response 连续性在下次 `analyze()` 静默丢失，模型失去上下文。
- **建议修复**: `restoreSessionMapping` 也应接收并使用 `referenceTraceId`，经 `buildSessionMapKey` 命名空间化。

### B04. `valuesMatch` 数值比较用 `Number.EPSILON`，容差实际为零 ✅ 复核
- **文件**: `backend/src/services/evidence/evidenceContractBuilder.ts:96-105`
- **类别**: 1（逻辑错误）
- **置信度**: 9/10
- **问题**:
  ```ts
  return Math.abs(expectedNumber - actualNumber) <= Number.EPSILON;  // ≈ 2.2e-16
  ```
  `Number.EPSILON` 远小于 Perfetto trace 数据任何真实浮点误差。SQL 工具报 `1234.5600000001`、结论引用 `1234.56`，二者差 `~1e-10`，远大于 `EPSILON`，被判 `mismatch`。
- **影响**: evidence/claim 验证器把大量本应 `matched` 的数值证据误判为 `mismatch`，可信结论被错误降级为 partial/unsupported。这直接影响「evidence/claim verification」这个独立 AI 输出面。
- **建议修复**: 用业务相关容差（例如绝对差 `<= 1e-3` 或相对容差 `<= 1e-6 * max(|a|,|b|)`），而不是 `Number.EPSILON`。

### B05. `sharedKeyShouldUseClaudeAuthToken` 漏掉 5 个 dual-surface 厂商 ✅ 复核
- **文件**: `backend/src/services/providerManager/providerRuntimeMatrix.ts:79-94`
- **类别**: 4（Agent 调用 / 鉴权参数错误）/ 1
- **置信度**: 9/10
- **问题**: `DUAL_SURFACE_PROVIDER_TYPES`（`providerTypes.ts:3-20`）含 `glm, qwen_coding, kimi_code, xiaomi, siliconflow`，但 `sharedKeyShouldUseClaudeAuthToken` 的数组里**这 5 个全缺**（只有 `deepseek, qwen, kimi, doubao, minimax, tencent_*, hunyuan, qianfan, stepfun, huawei`）。
- **影响**: 对 GLM / Qwen-Coding / Kimi-Code / Xiaomi / SiliconFlow 这 5 家，`applyClaudeAuth` 与 `testAnthropic` 会把共享 `apiKey` 当 `x-api-key`（Anthropic 头）发出，而这些厂商实际要 `Authorization: Bearer`。Claude surface 调用全部 401，用户看到莫名其妙的鉴权失败。CLAUDE.md 明确要求「Keep Provider Manager/runtime provider pinning semantics intact」，此为该语义的直接破坏。
- **建议修复**: `sharedKeyShouldUseClaudeAuthToken` 应直接复用 `DUAL_SURFACE_PROVIDER_TYPES`（或 `.includes(type) && !ANTHROPIC_NATIVE_TYPES.includes(type)`），消除两份手工列表漂移。

### B06. 前端 `terminalRunStatus` 字段在后端契约里不存在，配额事件分支永不触发 ⚠️ 待复核（需看运行时发射点）
- **文件**: 前端 `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts:179-181` 对比后端 `backend/src/types/dataContract.ts:941-955`
- **类别**: 3（前后端契约自相矛盾）/ 1
- **置信度**: 7/10
- **问题**: 前端 `toAnalysisCompletedPayload` 读 `terminalRunStatus`，只接受 `'completed' | 'cancelled' | 'quota_exceeded'`；但后端 `AnalysisCompletedEvent.data` schema 定义的字段是 `terminationReason` 和 `terminationMessage`，**没有 `terminalRunStatus`**。结果前端从真实后端事件拿到的 `terminalRunStatus` 基本恒为 `undefined`，`handleAnalysisCompletedEvent` 里 `status: 'quota_exceeded'` 的分支永远不会命中。
- **复核状态**: ✅ 已确认 `dataContract.ts` schema 无此字段；⚠️ 但需复核后端运行时是否在 schema 之外额外塞了该字段（某些 runtime 发射点可能 `...spread` 了运行时字段）。若有，则降级为「契约文档与实现不同步」；若无，则为确定的死分支。
- **影响**: 配额耗尽时前端不会切到配额态 UI，用户看到的是通用完成/失败，无配额引导。
- **建议**: 二选一 —— 后端在 schema 里补 `terminalRunStatus` 并发射；或前端改读 `terminationReason`。

### B07. `hypothesisExecutor` 的 `conclude` 退出路径不设 `stopReason` ✅ 复核
- **文件**: `backend/src/agent/core/executors/hypothesisExecutor.ts:308-311`
- **类别**: 2（闭环：正常退出缺终态标记）
- **置信度**: 9/10
- **问题**: 当策略 planner 返回 `strategy === 'conclude'` 时直接 `break`，**不赋值 `stopReason`**。其余退出路径（soft-budget `322-335`、hard-budget、early-stop）都设了。导致最常见的「正常收敛退出」反而带着空 stopReason 返回，下游（CLI 输出、`finalResultQualityGate` 日志）无法区分「干净收敛」与「异常终止」。
- **影响**: 与 B11 叠加（partial 结果早返回会跳过质量门），一个 partial + conclude 的运行既无 stopReason 又不过质量门，两条安全检查同时失效。
- **建议修复**: conclude 分支补 `stopReason = 'Strategy concluded'`，并 `emitUpdate('progress', { phase: 'early_stop', ... })`。

### B08. `deep_dive` 策略把 `focusedTimeRange` 重置回全局 trace 范围 ✅ 复核
- **文件**: `backend/src/agent/core/executors/hypothesisExecutor.ts:340-342`
- **类别**: 1（逻辑错误）
- **置信度**: 8/10
- **问题**:
  ```ts
  if (lastStrategy.strategy === 'deep_dive' && lastStrategy.focusArea) {
    ctx.sharedContext.focusedTimeRange = ctx.options.timeRange;  // 重置成全局！
  ```
  deep_dive 的语义是「缩小范围到 `focusArea` 深挖」，这里却把聚焦范围写回整个 trace 范围。`focusArea` 被 log 了但从未作为时间/选择器约束应用。
- **影响**: deep_dive 后续查询跑的是整条 trace 而非聚焦区域，分析范围被错误放大，耗时增加且结论可能被无关数据稀释。
- **建议修复**: 应将 `lastStrategy.focusArea` 转成时间窗约束写入 `focusedTimeRange`，而非回退到 `options.timeRange`。

### B09. Vertex 连接测试在 401/403 时返回 `success: true` ✅ 复核（子代理描述与代码一致）
- **文件**: `backend/src/services/providerManager/connectionTester.ts:271-274`
- **类别**: 1（逻辑错误 —— 把鉴权失败误报为成功）
- **置信度**: 8/10
- **问题**: Vertex 返回 401/403 时，tester 返回 `{ success: true, modelVerified: false }`，理由「Endpoint reachable but OAuth required」。但对该 URL 的未鉴权 POST 几乎必然返回 401/403，无法验证 project ID 是否有效。
- **影响**: 用户配错/伪造 project ID 或用错 service account，Provider Manager UI 显示绿色「成功」，随后每次分析运行时失败。`success: true` 的契约语义被破坏。
- **建议修复**: 401/403 应判 `success: false` 并提示鉴权/项目配置问题；只有真正能取到模型列表或成功完成一次极小推理调用才算 `success`。

### B10. `finalResultQualityGate` 在 `result.partial === true` 时早返回，跳过所有后续门检查 ⚠️ 待复核
- **文件**: `backend/src/services/finalResultQualityGate.ts:343`（据子代理）
- **类别**: 3（永真分支 / 守卫失效）
- **置信度**: 6/10
- **问题**: `assessFinalResultQuality` 据报在 `result.partial === true` 时早返回 `undefined`，导致 partial 结果**跳过所有后续检查**，包括 `kernel_blocking_claim_boundary`（专门防「凭空声称拿到完整 kernel 阻塞栈」的幻觉）和 phase-summary fallback 检测。
- **复核状态**: ⚠️ 行号需复核（子代理给的 343 与另一处 327-332 略有出入），但「partial 早返回跳过 kernel-blocking 检查」的语义若属实则属真实缺陷。
- **影响**: 一个 partial 结果若谎称「拿到 blocked_function 完整 kernel 栈」会静默通过质量门 —— 恰是这道门要拦的幻觉。
- **建议修复**: partial 仍应跑结构性 claim 边界检查，只跳过「完整性」类检查。

### B11. OpenCode runtime 异步轮询可能取到上一轮的 assistant 文本 ⚠️ 待复核
- **文件**: `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts:1176-1200`（据子代理）
- **类别**: 1（逻辑错误）/ 4（结果错配）
- **置信度**: 6/10
- **问题**: 轮询终止条件是 `isOpenCodeSessionIdle && 有 assistant 文本`。messages 查询用 `order: 'asc', limit: 50`，`getLatestOpenCodeAssistantMessage` 取最后一条 assistant。若两个 prompt 排队、session 在第一个后就 idle，轮询可能把**上一轮的** assistant 消息（同样带 `finish`/`completed` 标记）当作本轮响应返回，本轮响应被漏掉。
- **复核状态**: ⚠️ 需复核是否有 message-id / prompt-id 关联逻辑（子代理说没看到，但该文件较大）。
- **影响**: 高并发 OpenCode prompt 下，响应文本可能张冠李戴（返回旧答案）。
- **建议**: 用本轮 prompt 产生的 message id 来 correlate，而非仅靠 role + 完成标记。

### B12. `hypothesisExecutor` `conclude` 与 B07 关联（重复，合并入 B07）
（见 B07，不单列）

---

## 三、P2 / 次要与鲁棒性问题

### B13. 饼图 / 柱图除零与空数据 ✅ 复核
- **文件**: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/chart_visualizer.ts:113-125`（饼图）、`chart_visualizer.ts:182`（柱图）、`chart_visualizer.ts:281`（直方图委托柱图）
- **类别**: 1
- **置信度**: 9/10
- **问题**: `renderPieChart` 算 `total` 后直接 `data.map(d => (d.value / total) * 100)`，`total === 0`（空数据或全零）时产生 `NaN` 角度和坐标，渲染出空白/损坏 SVG。`renderBarChart` 用 `Math.max(...[])` 得 `-Infinity`，柱高与标签变 `Infinity`/`-Infinity`/`"-Infinity"`。
- **建议**: 空数据 / `total === 0` 早返回占位图。

### B14. provider_switcher 键盘 Enter 激活漏掉 `onActivate` 回调 ✅ 复核
- **文件**: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/provider_switcher.ts:87`
- **类别**: 1
- **置信度**: 9/10
- **问题**: 键盘 Enter 分支 `void this.activate(p.id)` 不传 `vnode`，而点击分支（约 431 行）传了。`activate(id, vnode?)` 成功后 `vnode?.attrs.onActivate?.()` 才会触发。键盘激活下该回调被跳过 → `onProviderSelectionChange`（清 `agentSessionId`、刷新服务端状态）不执行。
- **复现**: 打开 switcher → 键盘上下选中 provider → Enter。服务端状态徽标和 agentSessionId 不会重置。
- **建议**: `activate` 内部统一触发回调，或键盘分支也传 `vnode`。

### B15. provider_switcher `switchRuntime` 失败静默 ✅ 复核
- **文件**: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/provider_switcher.ts:163-167`
- **类别**: 2（闭环：失败无反馈）
- **置信度**: 7/10
- **问题**: `switchRuntime` 只检查 `runtimeRes.ok`，失败时 `return` 吞掉错误，不 `loadProviders()`、不 toast。`finally` 重置 `activating=false / open=false`，用户无任何失败反馈，下拉框还显示旧 runtime 为 active。
- **建议**: 失败时 `showToast` + `loadProviders()` 回滚显示。

### B16. `sqlSemaphore` 按 traceId 建 key 但 trace 删除时不清理 → 内存泄漏 ✅ 复核（语义）
- **文件**: `backend/src/services/traceProcessor/sqlSemaphore.ts:48`
- **类别**: 2（资源泄漏）
- **置信度**: 7/10
- **问题**: `smartSemaphores` Map 按 `traceId` 建 key，但 `traceProcessorService.deleteTrace` 不清对应 semaphore。每个 trace 永久泄漏一个 `SqlSemaphore` 条目。
- **影响**: 长期运行的服务端，trace 数积累后内存单调增长。
- **建议**: `deleteTrace` 时 `smartSemaphores.delete(traceId)`。

### B17. `ExternalRpcProcessor` 进程重启后 `_criticalModulesLoaded` 不重置 ✅ 复核（代码内 TODO 自述）
- **文件**: `backend/src/services/workingTraceProcessor.ts:1156-1162`
- **类别**: 1（代码内自述 TODO）
- **置信度**: 9/10
- **问题**: 代码内联 TODO 明说：外部 `trace_processor` 在同端口重启后，`_criticalModulesLoaded` 仍为 `true` 但模块表已空，依赖 Tier-0 stdlib view 的后续查询会「no such table」。该 flag 在查询出错时从不重置。
- **建议**: 查询返回「no such table/module」时重置 `_criticalModulesLoaded = false` 并触发重载。

### B18. stdlib 模块部分失败仍标记 `_criticalModulesLoaded = true` ✅ 复核（修正子代理原结论）
- **文件**: `backend/src/services/workingTraceProcessor.ts:742-774`
- **类别**: 1
- **置信度**: 8/10
- **问题**: `_loadCriticalModulesSequentially` 的 finally 前只检查 `!this.isDestroyed`，不检查 `failed > 0`。部分模块失败（含关键 Tier-0 模块真失败）也会 `_criticalModulesLoaded = true`，后续永不重试。
- **注意（修正子代理误报）**: 子代理原报「失败计数器永不自增导致无限重试」是**误报** —— 失败时 `_criticalModulesLoaded` 直接置 true，所以恰恰相反，是「过早放弃」而非「无限重试」。
- **建议**: 区分「模块可选缺失」（如 GPU 模块无 GPU 数据，可忽略）与「关键模块真失败」（应不置 true、计入 `_criticalModulesLoadFailures` 允许重试）。

### B19. `abandonFork` 异步 `saveState` 未 await ✅ 复核
- **文件**: `backend/src/agent/fork/forkManager.ts:737-754`
- **类别**: 2（持久化闭环）/ 4
- **置信度**: 8/10
- **问题**: `abandonFork` 声明为同步 `boolean`，但 `this.saveState(rootSessionId)`（763 行 `async`）返回的 Promise 既不 await 也不 return。进程退出或紧接的调用下，磁盘 JSON 仍保留该子 fork 为 active，重载后被放弃的 fork 会重现且可能被选中合并。
- **建议**: `abandonFork` 改 `async`，或内部 fire-and-forget 但 `.catch` 记录。

### B20. `htmlReportGenerator` timeline 模板 SQL 未转义 ✅ 复核
- **文件**: `backend/src/services/htmlReportGenerator.ts:833`
- **类别**: 1（HTML 注入面）
- **置信度**: 8/10
- **问题**: `${result.sql.substring(0, 100)}` 直接插进 `<code>`，无 `escapeHtml`。SQL 含 `<`/`>`/`&`/`"`（EXPLAIN 输出、字符串字面量常见）会破坏 HTML 结构或注入标记。同文件其它字段都过了 `escapeHtml`，此处不一致。
- **影响**: 生成报告的 HTML 结构破坏 / 轻量注入面（报告是本地 HTML，影响相对有限，但仍是契约不一致）。
- **建议**: `escapeHtml(result.sql.substring(0, 100))`。

### B21. `localSecretStore` 解密失败返回 `{}`，静默丢失密钥 ✅ 复核（子代理描述）
- **文件**: `backend/src/services/providerManager/localSecretStore.ts:288-313`（据子代理）
- **类别**: 1（静默数据丢失）
- **置信度**: 7/10
- **问题**: 主 key 轮换/文件损坏时 `crypto_secretbox_open_easy` 返回 false，`get()` catch 后返回 `{}`。`providerFromEnterpriseRow` 把空 secret merge 进连接配置，provider 看似已配但无 API key，每次分析报模糊鉴权错，无操作员可见信号。
- **复核状态**: ⚠️ 行号待复核；语义属实则成立。
- **建议**: 解密失败应抛出/打明显日志并标记 provider 为 `degraded`。

### B22. `decisionTreeExecutor` 用未转义 key 构造 RegExp ⚠️ 待复核
- **文件**: `backend/src/agent/decision/decisionTreeExecutor.ts:299-301`（据子代理）
- **类别**: 1（正则元字符误触发 / 可能抛 SyntaxError）
- **置信度**: 6/10
- **问题**: 对每个 `collectedData` key 构造 `new RegExp('\\{${key}\\}', 'g')`，key 含 `.`/`+`/`(`/`{`（如 `cpu.time`、`foo{bar}`）时替换静默失效或抛错。
- **建议**: 用 `String.split().join()` 或先 `escapeRegExp(key)`。

### B23. StoryController SSE 不可取消 ⚠️ 待复核
- **文件**: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/story_controller.ts:247-251, 361-371`（据子代理）
- **类别**: 2（流不关闭）
- **置信度**: 7/10
- **问题**: `connectToSSE` 自建本地 `AbortController` 与 5 分钟超时，但未暴露给 StoryController 实例。trace 卸载 / panel 移除 / 用户开新分析时无法中断 reader，它会继续读最长 5 分钟。`ai_panel.ts` 有 `cancelSSEConnection`/`onremove` 管线，StoryController 没有。
- **建议**: 把 abortController 提到实例字段，在 `destroy()`/trace 卸载时 abort。

### B24. `handleChatMessage` 缺 `isLoading` 守卫，可并发 /analyze 竞态 ⚠️ 待复核
- **文件**: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts:6601-6619`（据子代理）
- **类别**: 2 / 1（并发竞态）
- **置信度**: 6/10
- **问题**: `handleChatMessage` 只查 `!state.backendTraceId` 就 `setLoadingState(true)` 并进 `/analyze`，不校验 `isLoading` 是否已 true。预设按钮（`4178/4314/4352/5827/5940` 行调 `sendMessage()` 时已预置 input）和 `handleSmartAnalysisCommand` 可在首个流仍在时再起一个 `/analyze` POST + SSE listener，争用 `agentSessionId`、`sseAbortController`、streamingFlow/Answer。
- **复核状态**: ⚠️ 行号需复核；预设按钮是否真有绕过 guard 的路径要确认。
- **建议**: `handleChatMessage` / `sendMessage` 入口显式判 `state.isLoading` 守卫。

### B25. SQL 复杂度评分含死分支 `\bSUBQUERY\b` ✅ 复核（子代理描述合理）
- **文件**: `backend/src/agent/tools/sqlValidator.ts:377`（据子代理）
- **类别**: 3（永假分支）
- **置信度**: 8/10
- **问题**: 复杂度公式含 `(...|\bSUBQUERY\b|...)`，但真实 SQL 里子查询写为嵌套 `SELECT`，从不出现字面量 `SUBQUERY`，该分支永不命中。子查询计数实际靠 `\bSELECT\b` 匹配，减 1 减掉外层。功能上无害，但说明该启发式从未被校准。
- **建议**: 删死分支，加注释说明子查询靠 SELECT 计数。

### B26. `aggregateResponses` 以「最长响应」作为多模型共识 ⚠️ 待复核
- **文件**: `backend/src/agent/core/modelRouter.ts:645-655`（据子代理）
- **类别**: 3（逻辑可疑）
- **置信度**: 5/10
- **问题**: 多模型 fan-out 的共识是「取最长的那个响应」。长度与正确性无关，冗长的错答会压过简洁的正确答。代码注释自承是占位实现。
- **复核状态**: ⚠️ 需确认是否仅用于 fan-out tie-break 场景。
- **建议**: 至少改成「多数投票 + 置信度」，长度仅作末位 tiebreak。

---

## 四、剔除的误报（供实践方参考，避免重复排雷）

- **`taskGraphExecutor` 无限重分发（原 P0）**: 整个函数无 try/catch，dispatch 抛错直接冒泡出函数，不回 while 顶部。非 bug。→ 见 B02。
- **stdlib 失败计数器导致无限重试**: 实际是 `_criticalModulesLoaded` 置 true 后就不再重试，方向相反。真实问题是「过早放弃」（已记为 B18）。
- **`raceWithTraceProcessorCancellation` listener 泄漏**: 子代理自报 `resolve`/`reject` 两支都 `removeEventListener`，复核后确认无泄漏。
- **Bedrock SigV4 content-type 大小写**: HTTP 头大小写不敏感，签名规范一致。子代理自撤。
- **`auth.ts` 企业 SSO 错误吞掉后落到 dev identity（原 P1）**: 复核后这是**非企业模式的既定行为** —— 非 enterprise 部署下，SSO/API-key 凭证失败后落到 dev identity 或 legacy API-key 校验是有意设计（`resolveFeatureConfig().enterprise` 为 false 时 dev 回退）。catch 吞错只是为了让流程继续到下一道校验，不是鉴权绕过。**不作为缺陷**，仅留说明。若担心 enterprise 边界，建议补一条 telemetry：非 enterprise 模式收到 SSO 凭证却失败时记一条 warn。

---

## 五、优先修复建议（按影响 × 置信度排序）

| 优先级 | 编号 | 一句话 | 类别 |
|---|---|---|---|
| 1 | **B01** | `merge_findings` 策略静默吞掉所有子会话 finding | 4 / 1 |
| 2 | **B03** | OpenAI runtime 还原 session mapping 写错 key 命名空间 | 1 / 2 |
| 3 | **B04** | evidence `valuesMatch` 用 `Number.EPSILON`，容差实际为零 | 1 |
| 4 | **B05** | `sharedKeyShouldUseClaudeAuthToken` 漏 5 家 dual-surface 厂商 | 4 / 1 |
| 5 | **B07** | `conclude` 退出路径不设 `stopReason` | 2 |
| 6 | **B08** | `deep_dive` 把 focusedTimeRange 重置回全局 | 1 |
| 7 | **B09** | Vertex 连接测试 401/403 误报成功 | 1 |
| 8 | **B10** | 质量门在 partial 时跳过 kernel-blocking 检查（需复核） | 3 |
| 9 | **B06** | 前端 `terminalRunStatus` 契约字段后端不存在（需复核发射点） | 3 / 1 |
| 10 | **B11** | OpenCode 异步轮询可能取到上一轮响应（需复核） | 1 / 4 |

后续 P2（B13–B26）建议按文件聚批修复（如 chart_visualizer 一次清、provider_switcher 一次清、workingTraceProcessor 一次清），降低返工。

---

## 六、待实践方确认的复核项（我无法在不改代码/不跑运行时的情况下 100% 确认）

1. **B06**: 后端运行时发射 `analysis_completed` 时是否在 schema 外额外塞了 `terminalRunStatus`。
2. **B10**: `finalResultQualityGate.ts:343` 的 partial 早返回是否真的跳过 `kernel_blocking_claim_boundary`。
3. **B11**: OpenCode runtime 是否有 message-id 关联逻辑我没扫到。
4. **B24**: `ai_panel.ts` 预设按钮路径是否真能绕过 `isLoading` 守卫并发起第二个 `/analyze`。

这几条我标了 ⚠️，实践方在改之前请先就这几点给个确认，避免改错。

---

## 七、验收说明（供后续验收用）

- 本报告为**只读 review**，未修改任何源码。
- 我（审查方）对每条 P0/P1 都回了源码复核，标 ✅ 的为已亲眼确认；标 ⚠️ 的为需运行时/更大上下文才能 100% 确认。
- 实践方修复后，请按本报告编号逐条回归，并重点验证 B01（fork 合并）、B04（evidence 数值容差）、B05（5 家厂商鉴权）这三条行为可观测的修复。
- 建议实践方对每个修复补一个回归测试（尤其 B01 的 `merge_findings` 合并、B04 的浮点容差、B05 的 5 家 dual-surface 鉴权头），再由我做验收。
