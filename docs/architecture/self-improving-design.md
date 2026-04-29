# SmartPerfetto Self-Improving 设计 (v3.3)

**状态**：2026-04-26 经 4 轮 Codex review 全部 LGTM，已完整实施落地（12 个 commit）。
**负责人**：Chris
**最后更新**：2026-04-26

本文档是 Self-Improving 功能的权威设计参考。设计灵感来自 Hermes Agent 的三子系统架构（Memory / Skill / Nudge Engine），但适配了 SmartPerfetto 的"数据管道"特性——SmartPerfetto 的 skill 是 SQL 查询（正确性敏感），而不是 Hermes 那种过程性 Markdown 指南。

---

## 1. 设计哲学

| Hermes 原则 | SmartPerfetto 适配 |
|---|---|
| 后台 fork review agent | 采纳——独立 Claude SDK query，永不 resume 主 session |
| 局部 patch + 安全扫描 + 回滚 | 采纳，但提高门槛：必须 regression test 通过才落盘 |
| 容量上限倒逼压缩 | 采纳——`analysisPatternMemory` 用 bucket 配额 |
| 改 SKILL.md（过程指南） | **拒绝**——永不修改 `.skill.yaml`，只用 `.notes.json` 侧车 |
| User Memory（用户偏好） | 推迟——SmartPerfetto 是单租户分析平台，非 1-on-1 工具 |

**核心原则**：按风险分层。低风险层闭合现有断链。高风险层必须先过 regression test + 人工 review。

---

## 2. 四层架构

```
┌──────────────────────────────────────────────────────────────┐
│  Trace 分析 (claudeRuntime.analyze)                          │
└─────────────┬────────────────────────────────────────────────┘
              │ analysis_completed 事件
              ▼
┌──────────────────────────────────────────────────────────────┐
│  L1 — 闭合断链 (PR1, PR2, PR4, PR5)                          │
│  - saveAnalysisPattern：full + quick path 都覆盖             │
│  - Per-turn pattern + 状态机                                 │
│  - 正向 / 负向 bucket 分离                                   │
│  - SQL error-fix pair 5→10 + token budget 裁剪链             │
│  - Feedback 反查 SessionStateSnapshot                        │
└─────────────┬────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  L2 — 后台 Review Agent (PR6, PR7, PR8)                      │
│  - SQLite outbox（atomic lease，hash dedupe）                │
│  - 独立 Claude SDK（不与主 session map 冲突）                │
│  - 严格 JSON 输出（LLM 永不写文件）                          │
│  - Skill notes 侧车（logs/ 内的 .notes.json，不进 git）       │
│  - 按路径分别 token budget（full 1500 / quick 0 / retry 0）  │
│  - 默认 shadow 模式（write-only，人工 review 后再开 inject）  │
└─────────────┬────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  L3 — Strategy phase_hints 自动 patch (PR3, PR9a/b/c)        │
│  - StrategyVersionFingerprint + patchFingerprint 双层指纹    │
│  - Worktree 隔离的 regression 测试                           │
│  - PR creation（永不 auto-merge）                            │
│  - active_canary 观察期（7 天 / 5 次 full-path）              │
│  - Recurrence detection 自动 rollback                        │
│  - phase_hints 模板化（LLM 永不写 YAML）                      │
└─────────────┬────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  L4 — Skill SQL 自动 patch（未实施）                         │
│  - 占位 stub 返回 NOT_IMPLEMENTED_YET                        │
│  - 保留为未来选项                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Failure Taxonomy（PR4，地基）

整个设计最重要的一个决定：**三种学习产物共享同一个 `failureModeHash`**。

### 3.1 FailureCategory 枚举

```typescript
enum FailureCategory {
  misdiagnosis_vsync_vrr,
  misdiagnosis_buffer_stuffing,
  sql_missing_table,
  sql_missing_column,
  skill_empty_result,
  tool_repeated_failure,
  phase_missing_deep_drill,
  unknown,  // 新失败模式默认归这里；永不触发 supersede
}
```

LLM **只能从这个枚举里选**，再填 `evidenceSummary`。不允许发明新 category。

### 3.2 computeFailureModeHash

```typescript
function computeFailureModeHash(input: {
  sceneType: SceneType;
  archType: ArchitectureType;
  category: FailureCategory;
  toolOrSkillId?: string;
  errorClass?: string;
}): string;
```

Hash 的输入**只用稳定枚举字段**。`canonicalSymptom` 和其它 LLM 生成的文字字段是解释 / 审计字段，**永不参与 hash**。

### 3.3 三种学习产物共享 hash

| 产物 | 存储 | 来源 |
|---|---|---|
| `NegativePatternEntry` | `analysis_negative_patterns.json` | Claude runtime 失败 / feedback |
| `LearnedMisdiagnosisPattern` | `learned_misdiagnosis_patterns.json` | Verifier LLM 反馈 |
| `SkillNote` | `logs/skill_notes/<skillId>.notes.json` | 后台 review agent |

Prompt 注入按 `failureModeHash` 去重——同一个 hash 只注入置信度最高的一条。

---

## 4. Pattern 状态机（PR5）

### 4.1 Per-turn 主键

```typescript
interface PatternKey {
  analysisRunId: string;
  sessionId: string;
  turnIndex: number;
  traceContentHash: string;  // trace 文件内容的 sha256（不是上传 UUID）
}
```

### 4.2 状态转换

```
provisional（默认入库）
    ├─→ confirmed（24h 内收到 positive feedback，或自动晋升）
    ├─→ rejected（negative feedback）
    ├─→ disputed（10s-24h 反向 feedback，权重 ×0.2）
    └─→ disputed_late（>24h 反向，audit-only revision）
```

### 4.3 反向 feedback 时间窗口

| 窗口 | 行为 |
|---|---|
| <10 秒 | last-write-wins + 留 audit（视为误点） |
| 10s-24h | → `disputed`，注入权重 ×0.2 |
| >24h | 记录 revision，**不**自动改 confirmed/rejected → `disputed_late` |

### 4.4 注入权重表

| 状态 | 权重 |
|---|---|
| `confirmed` | ×1.0 |
| `provisional` | ×0.5 |
| `disputed` / `disputed_late` | ×0.2 |
| `rejected` | 直接排除 |
| `superseded`（PR9b） | ×0.1 |
| `superseded.active_canary` | ×0.5 |
| `superseded.failed` | 恢复 ×1.0 |
| `superseded.drifted` | ×0.5 |
| `superseded.reverted` | 恢复 ×1.0 |
| Quick-path bucket entry | ×0.3 |

---

## 5. Bucket 分离（PR5）

正向和负向 pattern 用**不同的 bucket key 公式**：

| Bucket | Key 公式 | 原因 |
|---|---|---|
| 正向 | `${sceneType}::${archType}::${domainHash}` | Domain（如 `com.tencent.mm` → `tencent`）聚合相似 app 行为 |
| 负向 | `${sceneType}::${archType}::${failureModeHash}` | "什么出错了"的天然分组维度 |
| Quick-path | `${sceneType}::${archType}::quick_recent` | 短 TTL（7 天），与长期 memory 隔离 |

每 bucket 配额 10-50 条。全局上限 200 正向 / 100 负向（淘汰先动高配额 bucket 内 matchCount 低的项）。

---

## 6. Quick-Path 晋升（PR5）

Quick path 写到 `quick_pattern_recent` bucket。要晋升到长期 memory 需要：

1. 同 `sceneType + archType + domainHash`
2. 加权 Jaccard 相似度 ≥ 0.65
3. Full-path verifier 通过
4. 至少一个 matching insight / finding category
5. Quick pattern 没有 negative / disputed feedback
6. （加分）full `packageName` 完全相等

晋升后是**新建一条长期 pattern**，不是把 quick entry 原样搬过去。

---

## 7. SQLite Outbox（PR6）

独立 DB：`backend/data/self_improve/self_improve.db`（不与 sessions DB 混）。

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE review_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','leased','done','failed')),
  dedupe_key TEXT NOT NULL,    -- sessionId::turnIndex::skillId::failureModeHash
  priority INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX idx_state_priority ON review_jobs(state, priority DESC, created_at);
CREATE UNIQUE INDEX idx_dedupe_active ON review_jobs(dedupe_key) WHERE state IN ('pending','leased');
```

所有操作走 transaction。`enqueue` 失败**不能** block 主分析。原子 lease 通过 `UPDATE ... WHERE state='pending' RETURNING ... LIMIT 1` 实现。

---

## 8. Token Budget（PR8）

**单位**：估算 tokens（不是 bytes——中文字符更"重"）。

| 路径 | Total | Per-Skill | 同 skill 同次分析 |
|---|---|---|---|
| Full | 1500 | 200 | 只一次 |
| Quick | 0（env 可 override 上限 100） | 0 | N/A |
| Correction retry | 0 | 0 | N/A |

优先级链（裁剪顺序，最低优先级先丢）：
1. P0（保留）：watchdog warning
2. P1：verifier correction prompt
3. P2：negative pattern context
4. P3（先丢）：skill notes

超 budget 的 skill notes → silent drop + 记 metric，不报错。

---

## 9. Trust Boundary（PR7）

Review agent 是一次 **Claude SDK query**，不是 runtime 扩展。具体约束：

- 独立 SDK 进程（`sdkQuery()` 直调，不走 `ClaudeRuntime.analyze`）
- 独立 session ID（**不**resume 主 session）
- **不**写 `claude_session_map.json`
- 不暴露 `Write` tool
- 不通过 MCP 访问文件系统
- 90s wall timeout，8 turn 上限
- 默认模型：`CLAUDE_LIGHT_MODEL`（haiku 4.5）

Review agent 的唯一输出：符合 schema 的严格 JSON。Backend 做：
1. JSON schema 校验
2. `failureCategoryEnum` 白名单检查
3. `contentScanner` 安全扫描（6 类 threat pattern）
4. 容量检查（size 限制）
5. 原子写入 `logs/skill_notes/`

---

## 10. Worker 资源限制（PR7）

| 限制 | 默认 | Env override |
|---|---|---|
| 并发 | 1 | `SELF_IMPROVE_WORKER_CONCURRENCY`（上限 2） |
| 队列长度 | 100 | `SELF_IMPROVE_QUEUE_MAX` |
| Per-skill+hash 冷却 | 5 分钟 | `SELF_IMPROVE_SKILL_COOLDOWN_MS` |
| 每日 job 预算 | 100 | `SELF_IMPROVE_DAILY_BUDGET` |
| Lease 时长 | 5 分钟 | `SELF_IMPROVE_LEASE_MS` |
| 重试上限 | 3 | `SELF_IMPROVE_MAX_ATTEMPTS` |
| 轮询间隔 | 30s | `SELF_IMPROVE_POLL_INTERVAL_MS` |

不做 SDK 调用 batching（保留失败隔离 + provenance）。Queue age metric；超阈值的 job 自动 drop（低优先级先丢）。

---

## 11. Strategy 版本指纹（PR9a）

```typescript
interface StrategyVersionFingerprint {
  strategyFile: string;            // 'scrolling.strategy.md'
  strategyContentHash: string;     // 整个文件内容的 sha256
  patchFingerprint: string;        // 仅目标 phase_hints 条目的 hash
  gitCommit: string;               // 该版本所在的 main 上 commit
  appliedAt: number;
}
```

`patchFingerprint` 由目标 `phase_hints` 条目的 normalized form 计算（`id + 排序后 keywords + constraints + criticalTools`）。

### 11.1 三级 drift 处理

| 检测情况 | 状态 | 权重 |
|---|---|---|
| 整个文件 hash 变了，但 patchFingerprint 仍在 | 保持 `active` | 不变 + 打 metric |
| `patchFingerprint` 变了 | → `drifted` | ×0.1 → ×0.5 |
| Patch 条目被完全删除 | → `reverted` | 恢复 ×1.0 |

### 11.2 Run snapshot 冻结

每次 `analyze()` 只 snapshot 当前 scene 的 strategy（KB 级，不是全部 strategies）。中途 `update_plan_phase` 从 snapshot 读。`invalidateStrategyCache()` 只影响**新启动**的 run。

---

## 12. Supersede 状态机（PR9b）

```
pending_review（PR 已创建，权重不变）
    ├─→ active_canary（PR 已 merge，观察期，权重 ×0.5）
    │       ├─→ active（观察期内无 recurrence，权重 ×0.1）
    │       └─→ failed（recurrence 检测到，恢复 ×1.0）
    │       └─→ drifted（patchFingerprint 变了）
    │       └─→ reverted（git revert 检测到）
    └─→ rejected（PR 关闭未 merge，权重恢复）
```

### 12.1 观察期窗口

`active_canary` 观察期，下面两个条件**任一**先满足即结束：
- 7 自然天，或
- 同 `sceneType + archType` 的 5 次 full-path 分析

### 12.2 Recurrence detection

观察期内若出现新的 negative pattern 命中同 `failureModeHash`：
1. Supersede marker → `failed`
2. 旧 negative pattern 注入权重恢复 ×1.0
3. Metric `supersede_failed{hash=xxx}` 触发人工 review
4. 自动 rollback 防止 false-fix 永久压低有效 pattern

### 12.3 Squash-aware merge

因为 PR squash merge 会改变 commit SHA：
1. Merge 事件触发后，pull main 最新代码
2. 从 main 读 strategy 文件内容（merge 后的）
3. 重新计算 `strategyContentHash` + `patchFingerprint`
4. 用 main 上的 `gitCommit`（不是 PR branch 的）
5. 写入 `active_canary` marker

### 12.4 PR 状态同步

- 后台轮询每 10 分钟，batch 查所有 `pending_review` PR
- `analyze()` 只在距上次轮询 >10 分钟时才触发一次 batch 查
- 可选 GitHub webhook（与 poller idempotent）
- 永远**不**做 per-analyze 的 GitHub 调用

---

## 13. Phase Hints 模板化 patching（PR9c）

LLM **永不直接写 YAML**。流程：

1. 模板按 `failureCategoryEnum` 索引：`backend/strategies/phase_hint_templates/<category>.template.yaml`
2. Review agent 输出严格 JSON：
   ```json
   {
     "failureCategoryEnum": "misdiagnosis_vsync_vrr",
     "evidenceSummary": "...",
     "candidateKeywords": ["vsync", "vrr"],
     "candidateConstraints": "必须先调用 vsync_dynamics_analysis",
     "candidateCriticalTools": ["vsync_dynamics_analysis"]
   }
   ```
3. Backend 校验：
   - `failureCategoryEnum` ∈ 白名单
   - `candidateKeywords` 长度 capped
   - `candidateConstraints` 过 `contentScanner`
   - `candidateCriticalTools` 必须存在于 tool / skill registry
4. Backend 渲染 **deterministic** YAML（同样 input 永远同样 output）
5. 没模板的 category → 不自动 patch，只生成人工建议

### 13.1 单文件 patch（首版）

一次 patch = 一个 `failureModeHash` + 一个 `strategyFile` + 一个 PR。多文件 patch v1 不支持。

### 13.2 Worktree 隔离

```bash
git worktree add /tmp/sp-autopatch-<jobId> main
# 在 worktree 内 apply patch
# 跑 validate:strategies
# 跑 test:scene-trace-regression
# 跑 e2e startup + scrolling
# 全过 → push branch + 创建 PR
git worktree remove /tmp/sp-autopatch-<jobId>
```

DB 锁：同 `strategyFile` 或同 `failureModeHash` 同时只允许一个 active job。

---

## 14. Feature Flags

所有 flag 默认 `false`。三阶段 rollout：

| Flag | 阶段 | 行为 |
|---|---|---|
| `SELF_IMPROVE_REVIEW_ENABLED` | Stage 1 | Worker 启动，调 review agent SDK |
| `SELF_IMPROVE_NOTES_WRITE_ENABLED` | Stage 1 | Backend 把 JSON 写到 `logs/skill_notes/` |
| `SELF_IMPROVE_NOTES_INJECT_ENABLED` | Stage 2 | `invoke_skill` 把 notes 注入 prompt |
| `SELF_IMPROVE_AUTOPATCH_ENABLED` | Stage 3 | PR9c worktree patch 创建 |

**Shadow 模式** = `REVIEW=on, WRITE=on, INJECT=off`。Notes 被收集 + 人工 review，但 agent 还看不到。

---

## 15. Provenance Schema（所有学习产物共用）

```typescript
interface Provenance {
  schemaVersion: 1;
  sourceSessionId: string;
  sourceAnalysisRunId: string;
  sourceTurnIndex: number;
  traceContentHash: string;
  failureModeHash: string;
  verifierStatus: 'passed' | 'warning' | 'error';
  feedbackStatus: 'provisional' | 'confirmed' | 'rejected' | 'disputed' | 'disputed_late';
  appliedAt: number;
  expiresAt?: number;
  supersededBy?: StrategyVersionFingerprint;
}
```

---

## 16. 测试策略

### 每 PR 必过的门槛

1. `cd backend && npx tsc --noEmit`
2. `cd backend && npm run test:scene-trace-regression`（6 traces）
3. `cd backend && npm run validate:skills`（PR4+ 后）
4. `cd backend && npm run validate:strategies`（PR9+ 后）

### E2E 门槛（L3 / strategy 改动必须跑）

- 启动：`verifyAgentSseScrolling.ts --trace lacunh_heavy.pftrace --query "分析启动性能"`
- 滑动：`verifyAgentSseScrolling.ts --trace scroll-demo-customer-scroll.pftrace --query "分析滑动性能"`
- Flutter TextureView + SurfaceView（涉及 pipeline skill 时）

### Self-improving 自身的回归

- `analysis_patterns.json` / `analysis_negative_patterns.json` schema 合法性
- Hash collision 测试（不同 input → 不同 hash）
- 状态机转换测试
- `contentScanner` 6 类 threat pattern 覆盖
- SQLite migration up / down
- Worktree patch 失败时的清理

---

## 17. 4 轮 Codex Review 关键决策

### Round 1
- 确认：`saveAnalysisPattern` 已经在 `claudeRuntime.ts:1089`（full path）调用
- 确认：SQL error-fix pair 已注入（5 条）于 `claudeSystemPrompt.ts:434`
- 洞察：SmartPerfetto 没有 `_MEMORY_THREAT_PATTERNS`（必须新建 contentScanner）

### Round 2
- Outbox 必须用 SQLite（filesystem lease 有 race condition）
- Token budget 必须区分 full / quick（quick 没 `ArtifactStore`）
- 三种学习产物必须共享 `failureModeHash` taxonomy

### Round 3
- `failureModeHash` 输入必须只用 enum（LLM 措辞不稳定）
- `dedupe_key` 必须包含 `failureModeHash`（同 skill 不同失败模式不能互吞）
- SQLite migration 必须从 day one 就有（`schema_migrations` 表）
- Quick-path pattern 必须进短 TTL bucket（避免污染长期 memory）

### Round 4
- `patchFingerprint` 必须加（whole-file hash 太粗）
- `active_canary` 状态必须存在（PR merge ≠ patch 真的修好了）
- Phase hints 必须模板化（LLM 永不写 YAML）
- Squash-merge 后 fingerprint 必须从 main 重算

---

## 18. 不在范围内

- **L4 Skill SQL 自动 patch**：占位 stub 返回 `NOT_IMPLEMENTED_YET`。等 L1-L3 稳定后再考虑。
- **多文件 phase_hints patch**：v1 仅单文件。
- **跨租户 skill notes 共享**：SmartPerfetto 是单租户，不需要。
- **用户偏好 Memory**（Hermes USER.md）：无限期推迟。
- **L3 PR 自动 merge**：设计上禁止。永远人工 review。

---

## 19. 已知风险（可接受）

1. **`active_canary` 7 天观察窗口**：有些失败模式复发慢。已通过 `failed` 状态恢复 + metric 告警 mitigate。
2. **`unknown` category 累积**：新失败模式默认归 `unknown` 不触发 supersede。需要每季度人工 triage 加新 enum。
3. **L2 review agent 成本**：典型负载下 ~$1-2.5/天。换来质量提升可接受。
4. **SQLite 竞争**：better-sqlite3 sync API 在 enqueue 时阻塞 event loop——分析完成时低频写入可接受。如果 metric 显示有竞争，可后续切 worker thread。

---

## 20. 已交付功能清单（2026-04-26）

设计经 4 轮 Codex review LGTM 后，**12 个 commit 顺序落地**：

| Commit | PR | 内容 |
|---|---|---|
| `3628892` | PR1 | Feedback schema 扩展（向后兼容 additive） |
| `d4fc3d4` | PR2 | SQL error-fix pair 注入上限 5 → 10 |
| `7e162d6` | PR3 | Worktree runner + strategy hot-reload + contentScanner |
| `0b61db7` | PR4 | Failure taxonomy + 历史 pattern 迁移脚本 |
| `c1c6d04` | PR5 | Pattern 状态机 + Quick-path bucket |
| `233f45f` | PR6 | SQLite outbox + 版本化 migrations |
| `818f2a9` | PR7 | Review worker + Claude SDK + skill-notes writer |
| `eb9879d` | PR8 | Skill notes 注入 + token budget + promote CLI |
| `59ae766` | PR9a | StrategyVersionFingerprint + Run snapshot |
| `9b4e8fc` | PR9b | Supersede 状态机 + recurrence detection |
| `a8eee95` | PR9c | Phase_hints 模板 + patch 流水线 |
| `e578796` | PR10 | 监控仪表板 metrics aggregator + endpoint |

**累计**：~5800 行新代码，340 个 unit test 全过，6 个 trace 的 scene-trace-regression 在每个 PR 后都跑通。

---

## 21. 各 PR 详细功能 / 用法 / 收益

### PR1：Feedback Schema 扩展（additive）

**做了什么**
- `POST /api/agent/v1/:sessionId/feedback` 接受可选 metadata：`traceId / sceneType / architecture / packageName / findingIds / patternId / schemaVersion`
- 端点会用 `assistantAppService.getSession()` 自动反查 `traceId / referenceTraceId`
- 落盘到 `logs/feedback/feedback.jsonl` 时带版本号 + `enrichedFromSession` 标志位
- 新建 `backend/src/agentv3/selfImprove/feedbackEnricher.ts`（21 单测）

**怎么用**
- 旧客户端（只传 `rating / comment / turnIndex`）继续 work，无需改动
- 新客户端可以带 `patternId` —— 端点会调 `applyFeedbackToPattern()` 自动驱动状态机（PR5 接入）
- 响应增加 `schemaVersion` 字段方便后续兼容判断

**带来的好处**
- Negative feedback 立即转成 pattern memory 中的 `rejected` 状态，agent 下次注入时自动排除
- Positive feedback 把 provisional pattern 提升到 confirmed，注入权重 ×1.0
- 所有 metadata 入库，PR4-PR9 的所有反向利用都基于这个 schema

---

### PR2：SQL Error-Fix Pair 注入扩容 5 → 10

**做了什么**
- `claudeSystemPrompt.ts:435` 把 `slice(0, 5)` 改成 `slice(0, 10)`
- 加测试断言 cap 为 10：`should cap SQL error fix pairs at 10 entries`

**怎么用**
- 自动生效——agent 启动新分析时 system prompt 中的 "SQL 踩坑记录" 段从 5 条变 10 条
- 受现有 droppable chain 保护，token 预算超限时整段会被裁掉

**带来的好处**
- Agent 看到的历史 SQL 错误样本翻倍，重复犯同样 SQL 错误的概率降低
- 在 token 预算正常时获得更多学习样本，预算紧张时自动让位（droppable）

---

### PR3：Worktree 工具 + Strategy 热重载 + 内容扫描器

**做了什么**
- `selfImprove/worktreeRunner.ts`：`createWorktree / removeWorktree / withWorktree`，jobId 严格白名单 `/^[a-zA-Z0-9_-]{1,64}$/` 防 shell 注入
- `selfImprove/contentScanner.ts`：6 类威胁检测——`prompt_injection / sys_prompt_override / deception_hide / exfil_curl / sql_destructive / shell_destructive`
- `routes/strategyAdminRoutes.ts`：新增 `POST /api/admin/strategies/reload` 调用 `invalidateStrategyCache()`

**怎么用**
- Strategy 改文件后，生产环境调一下 reload endpoint（带 auth）就生效，不用重启 backend
- Worktree runner 在 PR9c 被实际使用，PR3 阶段是基础设施先就位
- contentScanner 在 PR7 / PR9c 校验 review agent 输出

**带来的好处**
- 生产 strategy 改动从"必须重启"变成"一个 admin POST"
- 任何 LLM 输出走入 system prompt 之前都过安全扫描，jailbreak / 凭证泄漏 / 破坏性指令早期拦截
- L3 自动 patch 永远在隔离 worktree 里跑，不会污染 dev 工作区

---

### PR4：Failure Taxonomy + 历史 pattern 迁移

**做了什么**
- `selfImprove/failureTaxonomy.ts`：8 个 `FailureCategory` enum + `computeFailureModeHash` + `inferCategoryFromText` 启发式
- `agentv3/types.ts`：`AnalysisPatternEntry / NegativePatternEntry / FailedApproach` 加 optional `failureModeHash` 字段（不破坏旧数据）
- `selfImprove/migrateFailureModeHash.ts`：CLI 迁移脚本，dry-run + `--apply`

**怎么用**

```bash
# 默认 dry-run，输出报告（按 category 分类计数 + 样例 + 影响范围）
cd backend && npm run self-improve:migrate-failure-mode-hash

# 人工 review 报告后再 apply
cd backend && npm run self-improve:migrate-failure-mode-hash -- --apply
```

**带来的好处**
- Negative pattern / verifier learned misdiagnosis / skill notes 三种产物从此能识别"我们说的是同一个失败"——cross-artifact 去重
- 历史数据（无 hash）不会丢，迁移工具能基于 reason 文本推断 category 后回填
- LLM 永远只能从固定 enum 选择，hash 稳定性被治理（不会因为 LLM 措辞漂移就变 hash）

---

### PR5：Pattern 状态机 + Quick-Path Bucket

**做了什么**
- 5 态状态机：`provisional / confirmed / rejected / disputed / disputed_late`
- 注入权重按状态加权（confirmed×1.0 / provisional×0.5 / disputed×0.2 / rejected 排除）
- 新增 `analysis_quick_patterns.json` 7 天 TTL bucket
- `promoteQuickPatternIfMatching` 6 项判定（同 scene/arch + Jaccard ≥0.65 + verifier passed + insight 重叠 + 无 negative）
- `applyFeedbackToPattern` 三时间窗规则（<10s 误点 / 10s-24h disputed / >24h disputed_late）
- `sweepAutoConfirm` 24h 后 provisional → confirmed
- POST `/feedback` 接 `applyFeedbackToPattern`：feedback 立即驱动状态转换

**怎么用**
- 自动生效——新分析自动写 `provisional`，24h 内有 positive feedback 就 confirmed，有 negative 就 rejected
- 用户在前端点踩时如果带上 `patternId`（PR1 已接受这个字段）就立即生效；否则走 24h 默认晋升

**带来的好处**
- Agent 看到的"历史经验"被用户实际反馈过滤过——错的不会再来误导下次分析
- Quick path 的弱结论不污染长期记忆——必须 full path 复现并通过 verifier 才能晋升
- 同一 turn 误点 / 长期反思 / 短期反复都各有不同处理，不一刀切

---

### PR6：SQLite Outbox + 版本化 Migrations

**做了什么**
- 独立 DB：`backend/data/self_improve/self_improve.db`（不与 sessions 混）
- `schema_migrations` 表 + 版本化迁移系统（不靠 `CREATE TABLE IF NOT EXISTS` 滥用）
- `review_jobs` 表：state（pending/leased/done/failed）、dedupe_key 唯一索引（仅 active 状态）、原子 lease via transaction
- API：`enqueue / leaseNext / markDone / markFailed / releaseLease / expireStaleLeases / countByState / dailyJobCount`
- WAL + busy_timeout=5000 + foreign_keys ON

**怎么用**
- PR7 worker 通过这个 outbox 拉 job——不需要直接调用
- 监控通过 `countByState()` + `dailyJobCount()` 暴露给 PR10 的 metrics endpoint

**带来的好处**
- 进程崩溃 / 重启 / 部署不会丢 review job
- 重复任务（相同 sessionId+turnIndex+skillId+failureModeHash）自动 dedupe，不会重复 review
- 同时多 worker 抢同一个 job 不会出 race（atomic lease）
- 失败重试有上限（默认 3 次），超过转 failed 不再纠缠

---

### PR7：Review Worker + Claude SDK + Skill-Notes Writer

**做了什么**
- `reviewWorker.ts`：30s 轮询 outbox，concurrency=1（env 上限 2），per-skill+hash 5min 冷却，每日 100 jobs 预算
- `reviewAgentSdk.ts`：独立 sdkQuery 调用 haiku 4.5，90s 超时，8 turn 上限，inline prompt 强制 JSON 输出
- `skillNotesWriter.ts`：strict schema 校验 + 安全扫描 + 4KB/note + 16KB/file 容量上限 + 同 provenance+hash 去重 + atomic 写入
- 默认 disable，依赖 `SELF_IMPROVE_REVIEW_ENABLED=1` 才启动

**怎么用**

```bash
# 生产启用 shadow 模式（worker 跑 + 写盘，但下游不读）
SELF_IMPROVE_REVIEW_ENABLED=1 \
SELF_IMPROVE_NOTES_WRITE_ENABLED=1 \
./scripts/start-dev.sh
```

观察：`logs/skill_notes/<skillId>.notes.json` 文件每天会增加 review agent 写入的 note。

**带来的好处**
- 每次主分析跑完之后，后台 review agent 自动总结踩坑经验
- 出错 / 超时 / schema 不合规等失败的 review 自动重试或永久 failed，不会无限循环
- LLM 永远不能直接写文件——所有产出都先过 backend 校验
- 安全：prompt injection / 凭证泄漏 / 破坏性命令在写盘前直接拦截

---

### PR8：Skill Notes 注入 + Token Budget + Promote CLI

**做了什么**
- `skillNotesInjector.ts`：`SkillNotesBudget` 类，按 path 分别预算
  - Full：1500 tokens total / 200 per skill / 同 skill 同次分析一次
  - Quick：默认 0（env 可 override 上限 100）
  - Correction retry：硬 0
- `loadSkillNotes(skillId)` 合并 curated 基线 + runtime notes（curated 优先，dedupe by id）
- `claudeMcpServer.ts` 修改 `invoke_skill`：成功后 prefix skill notes 到返回 text
- `promoteSkillNote.ts` CLI：`logs/skill_notes/<skillId>.notes.json` 中的 note 晋升到 `backend/skills/curated_skill_notes/<skillId>.notes.json`（进 git）
- 默认 disable，依赖 `SELF_IMPROVE_NOTES_INJECT_ENABLED=1` 才注入

**怎么用**

```bash
# Shadow 模式 1-2 周 + 人工 review logs/skill_notes/ 后
# 把高价值 note 晋升到 git baseline
cd backend && npm run skill-notes:promote -- <skillId> <noteId>

# Dry run（只看会动什么文件，不实际改）
cd backend && npm run skill-notes:promote -- <skillId> <noteId> --dry-run

# 启用真正的注入
SELF_IMPROVE_NOTES_INJECT_ENABLED=1 ./scripts/start-dev.sh
```

**带来的好处**
- Agent 调用 skill 时自动看到该 skill 的历史踩坑经验（针对当前 trace 类型）
- Token 预算严格隔离 quick / full / retry 三条路径，不会因为注入挤压关键修正空间
- 人工 review + curated baseline 进 git——保证 note 质量经得起代码 review
- "Notes 太长被裁掉"是 silent drop + metric，不会让 invoke_skill 报错

---

### PR9a：Strategy 版本指纹 + Run Snapshot

**做了什么**
- `strategyFingerprint.ts`：双层指纹
  - `strategyContentHash` —— 整个 .strategy.md 文件的 sha256
  - `patchFingerprint` —— 仅目标 phase_hint 条目的 normalized hash
- `detectDrift(fingerprint, currentHints, currentContentHash)` 三级 drift 判定
- `RunSnapshotRegistry` 单例：每次 `analyze()` 启动时 `runSnapshots.capture(sessionId, sceneType)`，结束时 `release()`

**怎么用**
- 自动生效——`claudeRuntime.analyze()` 已接入 capture/release
- PR9b 的 supersede marker 写入时使用这两层指纹
- `runSnapshots.size()` 暴露给 PR10 监控用（leak 检测）

**带来的好处**
- Hot-reload strategy 的中途，已经在跑的 analyze 不会出现"前半段用旧 strategy，后半段用新 strategy"的 split-brain
- patchFingerprint 让 drift 检测精确——人手改文件的无关部分不会让所有 supersede marker 失效
- 三级 drift 区分 "无关改动 / 我们的 patch 被改了 / 我们的 patch 被删了"，分别用不同处理策略

---

### PR9b：Supersede 状态机 + Recurrence Detection

**做了什么**
- 独立 SQLite DB：`backend/data/self_improve/supersede.db`，schema_migrations + supersede_markers 表
- 7 状态机：`pending_review / active_canary / active / failed / drifted / reverted / rejected`
- `startCanaryObservation` / `recordObservation` / `recordRecurrence` / `markRejected` / `markDrifted` / `markReverted`
- `injectionWeightForSupersede(marker)` 按状态返回权重（active=0.1, active_canary=0.5, drifted=0.5, 其它=1.0）
- `analysisPatternMemory.matchNegativePatterns` 调用 supersede store，注入分数 ×supersede 权重
- `saveNegativePattern` 自动调 `checkAndRecordRecurrence`：新负向 pattern 命中 active_canary 的 hash → 翻 failed

**怎么用**
- 自动生效——新负向 pattern 自动检测 recurrence，注入自动按 supersede 状态降权
- PR9c merge 后调 `startCanaryObservation()` 把 marker 推进 canary 期
- 需要后续手动接 GitHub PR webhook（推迟项）

**带来的好处**
- "PR merge 了" ≠ "问题真的修好了"——加了 7 天 / 5 次 full-path 的观察期
- 观察期内问题复发自动 rollback 到旧负向权重——false-fix 不会永久压低有效 pattern
- Drift 检测捕获人手改 strategy 文件的情况，相关 marker 自动降权

---

### PR9c：Phase_hints 模板 + Patch 流水线

**做了什么**
- 模板目录：`backend/strategies/phase_hint_templates/<failureCategory>.template.yaml`（首版含 `misdiagnosis_vsync_vrr` 一个示例）
- `phaseHintsRenderer.ts`：strict JSON 校验 + 安全扫描 + tool registry 检查 + deterministic YAML 渲染（同输入永远同输出）
- `strategyPatchApplier.ts`：YAML round-trip 把 rendered entry 追加到 `phase_hints` 块，保留 markdown body；冲突 id 默认拒绝（除非原 entry `auto_generated: true`）
- `proposeStrategyPatch.ts`：5 步流水线 render → worktree create → apply → validate hook → 返回 handle 给 caller 决定后续

**怎么用**
- Review agent 提交 JSON 提案后，调 `proposeStrategyPatch({proposal, scene, jobId, validate})`
- 成功返回 `{handle, patchFingerprint, phaseHintId, renderedYaml, strategyFilePath}`
- Caller 在返回的 worktree handle 里跑 `validate:strategies / test:scene-trace-regression / e2e`，全过后 push branch + 创建 PR
- 失败任何一步自动 cleanup worktree

**带来的好处**
- LLM 永远不直接写 YAML——backend 渲染 deterministic，相同 input 永远同 output
- patchFingerprint 跨 re-render 稳定，supersede marker 可以可靠绑定
- 不会覆盖人写的 phase_hint（`auto_generated: true` 是必要条件）
- Worktree 隔离让 patch 测试失败不污染 dev 工作区

---

### PR10：监控仪表板

**做了什么**
- `metricsAggregator.ts`：聚合所有子系统快照——pattern memory（按状态分桶）、supersede（按状态分桶）、outbox（按状态 + 当日 jobs）、skill notes（runtime + curated 文件 / 条目数）、feedback（positive / negative tally）、active run snapshots
- 失败容忍：单一 store 损坏 → `warnings` 数组里有这条 + 其它正常返回
- `routes/strategyAdminRoutes.ts` 新增 `GET /api/admin/self-improve/metrics`

**怎么用**

```bash
curl -H "Authorization: Bearer $SMARTPERFETTO_API_KEY" \
  http://localhost:3000/api/admin/self-improve/metrics
```

返回示例：

```json
{
  "collectedAt": 1714152000000,
  "patterns": {
    "positive": { "total": 50, "byStatus": { "confirmed": 30, "provisional": 18, "legacy": 2 } },
    "negative": { "total": 25, "byStatus": { ... } },
    "quick": { ... }
  },
  "outbox": { "byState": { "pending": 2, "leased": 0, "done": 15, "failed": 3 }, "dailyJobs": 17 },
  "supersede": { "pending_review": 0, "active_canary": 1, "active": 3, "failed": 1, ... },
  "skillNotes": { "runtimeFiles": 8, "runtimeNotes": 24, "curatedFiles": 3, "curatedNotes": 9 },
  "feedback": { "total": 50, "positive": 35, "negative": 15 },
  "activeRunSnapshots": 0,
  "warnings": []
}
```

**带来的好处**
- 一个 endpoint 看所有 self-improving 子系统的健康——dashboard 直接 poll
- 失败容忍：corrupt 文件 / 未初始化的 DB 不会让 endpoint 挂掉
- `activeRunSnapshots` 暴露 leak 信号——长期非零意味着 analyze() 没正常 release

---

## 22. 渐进启用流程（推荐）

设计明确 default-off。生产启用按以下三阶段推进：

### 阶段 1：Shadow Mode（建议跑 1-2 周）

```bash
# .env
SELF_IMPROVE_REVIEW_ENABLED=1
SELF_IMPROVE_NOTES_WRITE_ENABLED=1
# 注入暂时关闭
# SELF_IMPROVE_NOTES_INJECT_ENABLED=0
```

**作用**：Review worker 启动 + 写盘到 `logs/skill_notes/`，但 agent 看不到。
**目的**：人工抽查 note 质量、failure category 命中是否合理、有没有误报安全扫描。

### 阶段 2：Curated 注入

每周走一次 review：

```bash
# 1. 看监控
curl /api/admin/self-improve/metrics | jq .skillNotes

# 2. 抽 5-10 个 note 人工 review，把高价值的晋升进 git baseline
cd backend && npm run skill-notes:promote -- <skillId> <noteId>

# 3. 跑回归确认 baseline note 没破坏现有分析
npm run test:scene-trace-regression
```

确认 baseline 质量后启用注入：

```bash
# .env 增加
SELF_IMPROVE_NOTES_INJECT_ENABLED=1
```

**作用**：`invoke_skill` 在 prompt 里看到 curated baseline + runtime notes（按 token budget）
**目的**：让 agent 实际从历史踩坑中获益

### 阶段 3：Auto-Patch（最高风险，最后启用）

需要先把 GitHub PR webhook + squash-aware merge fingerprint 这两个推迟项实施。然后：

```bash
SELF_IMPROVE_AUTOPATCH_ENABLED=1
```

**作用**：Review agent 提议 phase_hints 改动 → worktree 隔离 → regression + e2e 全过 → 生成 PR（人工 review + merge）
**关键**：永远**不**自动 merge。

---

## 23. 新增 CLI / 端点 / 环境变量速查

### CLI 命令

```bash
# 一次性迁移历史 pattern 加 failureModeHash 字段
cd backend && npm run self-improve:migrate-failure-mode-hash             # dry-run
cd backend && npm run self-improve:migrate-failure-mode-hash -- --apply  # 实际应用

# 把 logs/ 下的 runtime note 晋升进 git curated baseline
cd backend && npm run skill-notes:promote -- <skillId> <noteId>          # 实际晋升
cd backend && npm run skill-notes:promote -- <skillId> <noteId> --dry-run
```

### HTTP 端点

| Method | Path | 作用 | Auth |
|---|---|---|---|
| POST | `/api/admin/strategies/reload` | 清 strategy 缓存，新 analyze 重新读盘 | bearer |
| GET | `/api/admin/self-improve/metrics` | 全子系统健康快照 | bearer |
| POST | `/api/agent/v1/:sessionId/feedback` | 增强版 feedback（含 patternId 驱动状态机） | bearer |

### 环境变量

| Env | 默认 | 作用 |
|---|---|---|
| `SELF_IMPROVE_REVIEW_ENABLED` | `0` | 是否启动后台 review worker |
| `SELF_IMPROVE_NOTES_WRITE_ENABLED` | `0` | 是否允许 backend 写 skill notes 到 logs/ |
| `SELF_IMPROVE_NOTES_INJECT_ENABLED` | `0` | 是否在 invoke_skill 时注入 notes |
| `SELF_IMPROVE_AUTOPATCH_ENABLED` | `0` | 是否启用 PR9c 自动 patch 流水线 |
| `SELF_IMPROVE_QUICK_NOTES_BUDGET` | `0` | quick path 注入 token 上限（最大 100） |
| `SELF_IMPROVE_WORKER_CONCURRENCY` | `1` | review worker 并发上限（最大 2） |
| `SELF_IMPROVE_QUEUE_MAX` | `100` | outbox 队列长度 |
| `SELF_IMPROVE_DAILY_BUDGET` | `100` | 每日 review jobs 上限 |
| `SELF_IMPROVE_SKILL_COOLDOWN_MS` | `300000` | per-skill+hash 冷却 |
| `SELF_IMPROVE_LEASE_MS` | `300000` | outbox lease 时长 |
| `SELF_IMPROVE_MAX_ATTEMPTS` | `3` | 失败重试上限 |
| `SELF_IMPROVE_POLL_INTERVAL_MS` | `30000` | worker 轮询间隔 |

### 文件 / DB 路径

| 路径 | 内容 |
|---|---|
| `backend/data/self_improve/self_improve.db` | PR6 review jobs outbox |
| `backend/data/self_improve/supersede.db` | PR9b supersede markers |
| `logs/feedback/feedback.jsonl` | PR1 feedback 落盘 |
| `logs/analysis_patterns.json` | 长期正向 pattern memory（≤200） |
| `logs/analysis_negative_patterns.json` | 长期负向 pattern memory（≤100） |
| `logs/analysis_quick_patterns.json` | PR5 quick-path 短 TTL bucket（7 天，≤100） |
| `logs/skill_notes/<skillId>.notes.json` | PR7 review agent 产出（runtime） |
| `backend/skills/curated_skill_notes/<skillId>.notes.json` | PR8 promote 后的 curated baseline（进 git） |
| `backend/strategies/phase_hint_templates/<category>.template.yaml` | PR9c 模板 |

---

## 24. 测试覆盖

### 总规模

- **340 个 unit test 全过**（19 个 test suites）
  - selfImprove 模块自身测试 261 个
  - analysisPatternMemory 测试 52 个（含 PR5 状态机扩展）
  - claudeSystemPrompt 测试 27 个（含 PR2 cap=10 验证）
- **scene-trace-regression 12+ 次跑通**（每个 PR 后强制跑，6 traces 全过）
- **typecheck 12 次跑通**（每个 commit 前都 `npx tsc --noEmit`）

### 关键测试覆盖点

- Pattern 状态机所有 5 态转换 + 时间窗规则
- Failure taxonomy hash 稳定性（cosmetic reordering 不变）
- Quick → Full promote 6 项判定
- Outbox migration / atomic lease / dedupe / retry / 过期 lease 回收
- contentScanner 6 类 threat pattern 各个变体
- Worktree jobId 验证（含 path traversal 测试）+ 并发 collision 防护
- Skill notes 容量上限 + duplicate detection + atomic write
- Token budget 三路径行为 + 优先级裁剪
- Strategy fingerprint 三级 drift 判定
- Supersede 状态机所有合法转换 + 非法转换拒绝
- Phase_hints 模板 deterministic 渲染（同输入 = 同输出）
- Metrics aggregator 失败容忍

### Self-improving 的 e2e 验证（推荐启用 shadow mode 后）

虽然单测覆盖了所有逻辑，启用 shadow mode 后建议：
1. 跑 1-2 周看 `logs/skill_notes/` 累积质量
2. 抽样人工 review 10+ 条 note
3. 启用 INJECT 后跑一次 `npm run test:scene-trace-regression` 确认 6 traces 仍过
4. 启用 INJECT 后跑一次 e2e startup + scrolling 看 agent 行为变化是否合理

---

## 25. 后续工作（推迟项）

下面是各 PR commit message 中明确声明的"out of scope"，等 shadow mode 跑稳后逐步补上：

1. **GitHub PR webhook 集成**（PR9b 推迟）：当前 supersede 状态推进需要外部触发，未来用 webhook 自动 `startCanaryObservation` / `markRejected`
2. **Squash-aware merge fingerprint 重算**（PR9b 推迟）：merge 后从 main 重读 strategy 文件，用 main 的 commit SHA 而不是 PR branch 的
3. **Drift detection cron**（PR9b 推迟）：定时扫描 active marker 检测 patchFingerprint 变化，自动调 `markDrifted`
4. **多文件 phase_hints patch**（PR9c 推迟）：v1 仅单文件，未来支持跨 scene 的共享 fix
5. **L4 Skill SQL 自动 patch**（永久推迟）：仅占位 stub，等 L1-L3 至少跑半年后再考虑——SQL patch 风险高
