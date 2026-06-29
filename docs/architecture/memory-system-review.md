# Memory System Review — SmartPerfetto

**Scope:** How the AI agent remembers state across turns, sessions, days, and model
versions. Read-only investigation. No code modified.
**Date:** 2026-06-22
**Method:** code read + on-disk data inspection + 5 rounds of Codex review.

> "Memory 是命根子。模型会忘，仓库不会。长任务跨天、跨会话、跨模型版本，
> 状态必须放在对话之外... 它记录试过什么、通过什么、失败什么、下一轮从哪里继续。"

---

## TL;DR — the one-paragraph verdict

SmartPerfetto designed an **eight-surface agent memory architecture** (cross-session
analysis patterns, negative patterns, quick-path bucket, project memory,
self-improve/supersede pipeline, learned-misdiagnosis memory, curated case
library, SQL error-fix learning) plus a per-session snapshot system and a legacy
checkpoint/fork/expert tree. **In production today, only a few surfaces actually
carry data**: 24 positive pattern entries in `analysis_patterns.json` (all stuck
in `provisional` because the auto-confirm sweep was never wired in), 2 negative
patterns, 5 learned misdiagnosis entries, 2 curated cases, and 20 SQL error-fix
pairs. The supersede store has **0 markers**, the feedback pipeline has
**0 entries**, project memory has **0 entries**, the quick-path bucket and
case-evolution outbox files don't even exist. Of the empty surfaces, some are
genuinely dead (quick-path read side) and some are **operator-gated and awaiting
first use** (project memory, supersede) — the report distinguishes these. 332
persisted sessions exist but **322 of them are single-turn** (2 messages), so the
entire multi-turn resume / cross-session path is exercised by at most 10 sessions.
The architecture is ambitious and coherent on paper; what's actually running is a
thin slice of it. The gaps between design and reality are the real findings.

---

## 1. The naming trap (read this first or you'll waste an hour)

The word "memory" means two completely unrelated things in this codebase:

| Thing | What it actually is | Files |
|---|---|---|
| **Android RAM analysis** | Performance analysis of device memory (RSS, GC, LMK, DMABUF, heap graphs). Nothing is remembered across runs. | `memoryAgent.ts`, `memoryRootCause.ts`, `memory.strategy.md`, `skills/atomic/memory_*.yaml`, `memorySkillSqlSemantics.test.ts` |
| **Agent state memory** | What the agent remembers across turns/sessions/models. **This is the subject of this review.** | `agentv3/analysisPatternMemory.ts`, `agentv3/projectMemory.ts`, `agentv3/selfImprove/*`, `agentRuntime/engines/*/`, `sessionStateSnapshot.ts` |

`memoryRoutes.ts` is the admin/inspection HTTP surface for the agent-state
project memory — not Android RAM.

---

## 2. Architecture: the eight memory surfaces (by design)

### Layer 1 — Cross-session analysis pattern memory (LIVE, partially working)
**File:** `backend/src/agentv3/analysisPatternMemory.ts`
- **Write:** after a non-partial analysis with findings, `claudeRuntime.ts:2058-2069`
  extracts trace features (arch/scene/domain tags), extracts key insights, saves
  as `status: 'provisional'`. Fire-and-forget.
- **Store:** `backend/logs/analysis_patterns.json`. Atomic temp+rename. Max 200
  entries, 60-day TTL, frequency-aware eviction (`evictionScore`, `:127`).
- **Read (auto-inject):** at turn start, `claudeRuntime.ts:3046-3064` builds
  features and calls `buildPatternContextSection()` → weighted Jaccard similarity
  (`:330`), status-weighted, decay-scaled (30-day half-life, `:113`). Top 3
  matches injected into the system prompt as `## 历史分析经验（跨会话记忆）`.
- **Read (agent-queryable):** MCP tool `recall_patterns` (`claudeMcpServer.ts:5170`).
- **Status state machine:** `provisional` → `confirmed` (24h no negative feedback)
  → `disputed` / `disputed_late` / `rejected`. Weights: confirmed 1.0,
  provisional 0.5, disputed 0.2, rejected 0.

### Layer 2 — Negative pattern memory ("what failed") (LIVE, but semantics are off)
**File:** same module, `analysis_negative_patterns.json`.
- **Write:** `claudeRuntime.ts` pushes `FailedApproach` entries from several sources:
  consecutive tool failures (`type: 'tool_failure'`, `:1408`), high aggregate tool
  failure rate (`type: 'strategy_failure'`, `:1458`), persistent verifier/correction
  failures (`type: 'verification_failure'`, `:1737`), max-turn termination
  (`type: 'strategy_failure'`, `:1932`), and persistent SQL errors
  (`type: 'sql_error'`, `:2089`). Capped at 3 SQL errors per session.
- **Store:** `analysis_negative_patterns.json`. Max 100, 90-day TTL.
- **Read:** injected as `## 历史踩坑记录（避免重复失败）` (`:954`).
- **Semantic caveat (important):** the on-disk entries are **agent process
  failures** (tool/verifier/SQL failures, plan deviations), **not analysis-conclusion
  failures**. The 2 current entries are verifier `plan_deviation` failures and a
  60% tool-call failure rate — they tell the next run "this analysis *process*
  broke," not "this root-cause *strategy* was wrong." The layer is named as if it
  were analysis-strategy memory; in practice it is execution-failure memory. That's
  still useful, but the framing matters for anyone relying on it.

### Layer 3 — Quick-path bucket (write wired, READ NOT WIRED, no data)
- Weaker patterns from 10-turn budget runs (no verifier) go to a separate 7-day
  bucket `analysis_quick_patterns.json`, designed to be injected only as fallback
  at ×0.3 weight.
- **Write side IS wired:** `saveQuickPathPattern()` (`analysisPatternMemory.ts:672`)
  is called from `claudeRuntime.ts:2529` on the quick-analysis branch. Full-path
  runs call `promoteQuickPatternIfMatching()` (`claudeRuntime.ts:2073`) to lift a
  matching quick pattern into long-term memory (≥0.65 similarity).
- **Read side is NOT wired:** `matchQuickPatternsAsBackup()` (`:717`) has **zero
  non-test callers**. `buildPatternContextSection()` (`:909-914`) only calls
  `matchPatterns()`. So even if `analysis_quick_patterns.json` existed and held
  data, **it would never be injected** — the fallback path is dead.
- **Reality:** the file does **not exist** on disk. The write side runs on quick
  analyses; the read side is unreachable; no data survives.

### Layer 4 — Project / world memory (OPERATOR-GATED, awaiting first use)
**File:** `backend/src/agentv3/projectMemory.ts`
- Curated, operator-promotable memory with scopes `world` / `project` (session
  scope deliberately refused, `:389`). Promotion is **admin-only by design** with
  hard invariants (`memoryRoutes.ts:108`, `POST /api/memory/promote`); world
  promotion requires reviewer approval. Auto-promotion is explicitly forbidden.
- Recall via MCP tool `recall_project_memory` (`claudeMcpServer.ts:3879`),
  pure-read by design.
- **Reality:** `analysis_project_memory.json` does **not exist** and the enterprise
  `memory_entries` table has **0 rows**. **Important nuance:** this is not broken —
  it is operator-gated and awaiting first curation. The empty state likely reflects
  "no operator has promoted an entry yet," not a wiring bug.

### Layer 5 — Self-improve / supersede pipeline (OPERATOR-GATED, not bootstrapped)
**Files:** `backend/src/agentv3/selfImprove/*` — `supersedeStore.ts`,
`feedbackPipeline.ts`, `strategyPatchApplier.ts`, `worktreeRunner.ts`,
`reviewOutbox.ts`, `reviewWorker.ts`, etc.
- `supersede.db` (SQLite) tracks "did the fix hold?" markers with a state machine
  `pending_review → active_canary → active / failed / rejected / drifted / reverted`.
  This lifecycle is **patch/PR/canary-driven by design**, not normal analysis traffic.
- `feedbackPipeline.ts` is a feedback→case_draft→skill_draft→reviewed→merged graph
  requiring a reviewer.
- `checkAndRecordRecurrence()` flips a `failed` marker when a superseded failure
  mode reappears.
- **Primitives exist:** the outbox (SQLite queue, dedupe, leases, retry), the
  worker (polling, concurrency cap, daily budget, skill-note writing), the
  worktree runner, and strategy-patch proposer are all implemented and tested.
  `package.json` exposes `skill-notes:promote` and `self-improve:migrate-failure-mode-hash`.
- **Missing piece:** there is **no production caller that enqueues `review_jobs`
  and no production bootstrap that starts a `ReviewWorker`**. `SELF_IMPROVE_REVIEW_ENABLED`
  gates `start()` but no live `new ReviewWorker(...)` exists.
- **Reality:** `supersede.db` has **0 markers**. `self_improve.db` `review_jobs`
  has **0 rows**. `feedback_pipeline.json` does not exist. So the loop has never
  run end-to-end — but this is closer to "operator workflow not bootstrapped" than
  "dead code." The quick-path read side (Layer 3) is the genuinely dead part.

### Layer 6 — Learned misdiagnosis memory (LIVE, small)
**Files:** `backend/src/agentRuntime/engines/claude/claudeVerifier.ts:45-160`,
`backend/logs/learned_misdiagnosis_patterns.json`.
- When the verifier flags a misdiagnosis (conclusion contradicted by evidence), it
  learns a `{keywords, message, occurrences}` pattern via `saveLearnedPatterns()`
  (`claudeVerifier.ts:66`). On subsequent runs, matching keywords surface the
  warning (`:220-229`, injection threshold `occurrences >= 2`).
- Also surfaced through the `recall_patterns` MCP tool response
  (`claudeMcpServer.ts:5224-5249`).

### Layer 7 — Case library / case evolution (LIVE for curated, NOT for evolution)
**Files:** `backend/src/services/caseLibrary.ts`, `backend/src/services/caseGraph.ts`,
`backend/src/services/caseEvolution/*`.
- `case_library.json` / `case_graph.json` hold **curated** cases (manually ingested
  via `cli/commands/ingest.ts`). These are injected into the Claude system prompt as
  case background (`claudeRuntime.ts:3060-3064`, `claudeSystemPrompt.ts:667-668`) — a
  real cross-session recall surface that the original five-layer model missed
  (now Layer 7).
- `recall_similar_case` MCP tool (`claudeMcpServer.ts:3916`, registered `:5683`,
  `public`) queries the case library. Its retrieval is **tag + evidence-signature /
  structured** matching (`services/caseEvolution/caseRecommendationRetriever.ts:98-123`), not pure Jaccard
  and not embeddings.
- **Case evolution** (auto-growing the library from runs) defines
  `backend/data/self_improve/case_evolution.db` and `backend/logs/case_candidates/`
  (`caseEvolution/caseCandidateOutbox.ts:69,105-146`), but **neither exists on disk**
  today — the auto-growth side, like Layer 5, has never run.
- **Reality:** 2 curated cases, 1 graph edge. The curated side is a genuine,
  prompt-injected memory surface. The evolution side is empty.

### Layer 8 — SQL error-fix learning (LIVE, real data)
**Files:** `backend/src/agentv3/claudeMcpServer.ts:769-810,2385,2682`,
`backend/src/agentRuntime/engines/claude/claudeRuntime.ts:3113`,
`backend/src/agentv3/claudeSystemPrompt.ts:656`,
`backend/logs/sql_learning/<tenant>/<workspace>/error_fix_pairs.json`.
- When the agent auto-fixes a SQL error, `logSqlErrorFixPair()` persists
  `{errorSql, errorMessage, timestamp, fixedSql}` to a tenant/workspace-scoped
  JSON file. On the next run, `loadLearnedSqlFixPairs(5, knowledgeScope)` loads
  the last 5 fixes and they are injected into the system prompt as
  `## SQL 踩坑记录（避免重复犯错）` (`claudeSystemPrompt.ts:656`).
- This is a genuine, working cross-session learning surface — **the report's
  earlier drafts missed it entirely.** It is the cleanest example of "record what
  failed, reuse it next time" in the codebase.
- **Reality:** 20 fixed pairs on disk, all with `fixedSql`, scoped to
  `default-dev-tenant/default-workspace`.

---

## 3. Per-session memory: snapshots & working memory

### Session State Snapshot (LIVE, working)
**File:** `backend/src/agentv3/sessionStateSnapshot.ts:437`
- Single source of truth for (a) atomic persistence, (b) report generation,
  (c) session restoration. Replaced an older "7-phase cascade."
- **Written once per turn** at analysis completion via
  `persistAgentSession.ts:128` → `saveSessionStateSnapshot` (atomic single
  UPDATE, `sessionPersistenceService.ts:635`). No mid-turn checkpoint.
- **Dual-written** as both V2 `sessionStateSnapshot` and V1 `runtimeArraysSnapshot`
  in `sessions.metadata` JSON blob for backward compat (`sessionPersistenceService.ts:681-696`).
- **Contents:** conversationSteps, dataEnvelopes, agentDialogue, hypotheses
  (protocol + agentv3-rich), analysisNotes, analysisPlan, planHistory,
  uncertaintyFlags, artifacts, architecture cache, engine state (tagged union:
  claude-agent-sdk / openai-agents-sdk / pi-agent-core / opencode), run tracking.
- **Engine state is runtime-specific:** each runtime writes only its own branch.
  A Claude session's `sdkSessionId` means nothing to the OpenAI runtime.

### In-session working memory (volatile)
**File:** `backend/src/agent/context/enhancedSessionContext.ts`
- `WorkingMemoryEntry[]` + `findings` Map, **process memory only**.
- Hard caps: turns ≤30 (`:594`), turnLog ≤30, experiments ≤80, contradictions
  ≤40, evidence ≤500, workingMemory ≤12. Eviction is **silent, no archive** —
  older reasoning is permanently deleted, only the compressed digest survives.
- Injected into prompt as a digest (`:858`).

### Legacy checkpoint/fork/expert tree (DORMANT) vs live `traceAgentState`
**Important distinction:** not everything under `backend/src/agent/` is dead. The
**dormant** parts are module-level, not directory-level.

**Dormant (only tests/scripts instantiate):**
- `CheckpointManager` (`agent/state/checkpointManager.ts:42`) — JSON to
  `backend/agent-checkpoints/<sid>/<id>.json`. Only live caller is legacy
  `baseExpert.ts:298`, which is itself dormant.
- `SessionStore` (`agent/state/sessionStore.ts`) — JSON to
  `backend/agent-sessions/<sid>.json`. **No live callers.**
- `ForkManager` + `SessionTree` (`agent/fork/`) — in-memory only.
  `serialize()` exists but no live caller persists it. `DEFAULT_FORK_CONFIG.enabled = false`.
- `baseExpert.ts` and its subclasses (`LaunchExpert`, `InteractionExpert`,
  `SystemExpert`, `ScrollingExpertAgent`) — instantiated **only in tests**.
  The live path uses `claudeAgentDefinitions.ts` which builds same-named agents
  via a different mechanism.

**Live (do NOT call dead):**
- `agent/state/traceAgentState.ts` — **actively used.** `TraceAgentState`,
  `createInitialTraceAgentState`, `migrateTraceAgentState`, `summarizeTraceAgentState`
  are imported by `EnhancedSessionContext` (`enhancedSessionContext.ts:31-37`), held
  as a field (`:68`), injected into prompts (`:794-852`), and persisted in the
  snapshot via `persistAgentSession.ts:126-134` / `sessionPersistenceService.ts:502-535`.
- `agent/core/orchestratorTypes.ts` — **live type source.** `IOrchestrator`,
  `AnalysisOptions`, `AnalysisResult` are imported by all four runtimes, services,
  routes, and CLI. Only `stateMachine.ts` and `pipelineExecutor.ts` in `core/` are
  `@deprecated`.

**Disk residue:** `agent-checkpoints/` (43 dirs) and `agent-sessions/` (124 files),
both from January 2026, still sit on disk but are never read by the live v5.0 path.

---

## 4. Storage map — where bytes actually land

| Store | Path | Format | Live rows | Designed capacity |
|---|---|---|---|---|
| Cross-session patterns | `backend/logs/analysis_patterns.json` | JSON array | **24** | 200 / 60d |
| Negative patterns | `backend/logs/analysis_negative_patterns.json` | JSON array | **2** | 100 / 90d |
| Quick-path bucket | `backend/logs/analysis_quick_patterns.json` | JSON | **file absent** (wired, no data) | 100 / 7d |
| Project/world memory | `backend/logs/analysis_project_memory.json` | JSON | **file absent** | — |
| Feedback pipeline | `backend/logs/feedback_pipeline.json` | JSON | **file absent** | — |
| Supersede markers | `backend/data/self_improve/supersede.db` | SQLite | **0** | — |
| Review jobs | `backend/data/self_improve/self_improve.db` | SQLite | **0** | — |
| Learned misdiagnosis | `backend/logs/learned_misdiagnosis_patterns.json` | JSON array | **5** (≥2 occurrences injectable) | — |
| Case library (curated) | `backend/logs/case_library.json` | JSON | 2 cases | — |
| Case graph (curated) | `backend/logs/case_graph.json` | JSON | 1 edge | — |
| Case evolution outbox | `backend/data/self_improve/case_evolution.db`, `backend/logs/case_candidates/` | SQLite + files | **both absent** | — |
| SQL error-fix learning | `backend/logs/sql_learning/<tenant>/<workspace>/error_fix_pairs.json` | JSON array | **20** (all with fixedSql) | — |
| **Sessions (live)** | `backend/data/sessions/sessions.db` `sessions` table | SQLite + JSON blob | **332** | 30d retention |
| **Messages (live)** | `backend/data/sessions/sessions.db` `messages` table | SQLite | **684** | cascade |
| Enterprise `memory_entries` | same DB | SQLite | **0** | — |
| Enterprise `runtime_snapshots` | same DB | SQLite | **0** (used only for SDK session map, also 0) | — |
| Enterprise `conversation_turns` | same DB | SQLite | **0** (only test scripts INSERT) | — |
| Enterprise `agent_events` | same DB | SQLite | **0** (only test scripts INSERT) | — |
| Legacy checkpoints | `backend/agent-checkpoints/<sid>/` | JSON | 43 dirs (Jan 2026, dormant) | 24h / 10 per session |
| Legacy sessions | `backend/agent-sessions/<sid>.json` | JSON | 124 files (Jan 2026, dormant) | 7d |

**The 271MB `sessions.db` is dominated by the `sessions.metadata` JSON blobs
(~221MB across 332 sessions). `messages.sql_result` is currently 0 bytes across
all 684 messages** — raw SQL results are not being persisted to that column in
practice, which sharpens G8 (raw evidence is genuinely not durable). The DB size
is session/report/resume state, not any of the memory layers.

---

## 5. Cross-session, cross-day, cross-model — what actually survives

### Cross-session (new session reads old session's state)
**Limited and explicit, not free-form.**
- **Same-session resume:** `agentSessionCatalogRoutes.ts:34` lists recoverable
  sessions; `agentResumeRoutes.ts:61` + `agentAnalyzeSessionService.ts:380-579`
  rebuild the orchestrator and call `restoreFromSnapshot`. Product state (turns,
  findings, entity store) is restored.
- **Cross-session learning:** only via Layer 1/2 pattern files (tag-based Jaccard
  match). **No semantic/vector retrieval over past session transcripts.** The
  `services/rag/` subsystem is RAG over *source code* (kernel/AOSP/app), not
  session history.
- **Comparison mode:** reads prior *result snapshots*, not live session state.

### Cross-day
- Sessions persist in SQLite (30d retention, `cleanupOldSessions`).
- Pattern files persist on disk (60d/90d TTL).
- **Risk:** in-session working memory is volatile; if the process dies mid-turn,
  everything since the last completed turn is lost (snapshot is per-turn, not
  per-step).

### Cross-model (the silent killer)
**File:** `backend/src/assistant/application/agentAnalyzeSessionService.ts:268-342`
- Each session records a `providerSnapshotHash`. On resume, if the hash mismatches
  (provider changed, API key rotated, model version bumped), the code **aborts the
  old orchestrator, cleans up the SDK session, and creates a fresh one**
  (`:286-342`). Product state (turns, findings) is kept; the **model-side
  conversation handle (`sdkSessionId` / `lastResponseId`) is discarded**.
- The runtime kind is read from the snapshot (`getSnapshotRuntimeKind`,
  `sessionStateSnapshot.ts:251`) and used to spin up the matching runtime. So a
  Claude session resumes as Claude. **Switching runtimes mid-session is not
  translated** — the other runtime's engine-state branch is ignored.
- **Impact:** changing model version between days breaks multi-turn model
  continuity. The break is **partially surfaced** — the API/resume response carries
  a `providerSnapshotChanged` flag and message (see G3 for detail) — but no durable
  record is persisted to the session, so the resumed session does not "know" it was
  handed off. The user sees a "fresh" model that has lost the thread.

---

## 6. The gap analysis — where state is lost or never created

Ranked by severity.

### G1 — `sweepAutoConfirm` is dead code (HIGH — explains the data)
`sweepAutoConfirm()` (`analysisPatternMemory.ts:889`) is the function that
promotes `provisional` → `confirmed` after 24h. **It has zero non-test callers.**
The comment says "Run lazily from the system prompt builder," but
`buildPatternContextSection()` (the prompt builder) does **not** call it. Result:
**all 24 patterns are stuck at `provisional`**, injected at half-weight (0.5)
forever. The status state machine is half-built — the write side exists, the
auto-transition side does not. This is a consequential wiring gap: the "memory
earns trust over time" design property is inert. Note: fixing it is **not** a
one-liner — `sweepAutoConfirm` is `async` while the prompt builder is sync and
called sync by four runtimes; see Recommendations.

### G13 — Pattern-store writes race and can corrupt the only learning surface with data (HIGH)
`savePatterns()` / `saveNegativePatterns()` (`analysisPatternMemory.ts:303-322`)
use a **fixed** `.tmp` path with **no mutex, lock, CAS, or per-call unique temp**.
Writes are read-modify-write: two concurrent analyses both load the same JSON,
append independently, last `rename` wins → **lost update**. Worse, two overlapping
`fs.promises.writeFile` calls target the same `.tmp` path → the temp file can be
interleaved/truncated before either rename → **JSON corruption**. And
`loadPatterns()` / `loadNegativePatterns()` **swallow parse errors and return
`[]`** (`:284`, `:295`), so a later successful save after a corruption event
**silently replaces the entire store with a tiny fresh array**. This affects the
only cross-session learning surface that actually has data (24 patterns). No
`fsync`, so namespace-atomic but not power-loss durable.

### G2 — Most memory surfaces carry no data, but for different reasons (HIGH)
Layer 4 (project memory) and Layer 5 (self-improve/supersede) have **zero
entries** — but these are **operator-gated** surfaces (admin promotion, reviewer
approval, patch/canary lifecycle), so "empty" likely means "no operator has driven
the workflow yet," not "broken." The feedback→case→skill pipeline has never run
end-to-end. `checkAndRecordRecurrence` has no markers to check. The
"self-improving agent" described in the docs (`Self-Improving v3.3`) is, in
production, a set of empty tables. By contrast, Layer 3 (quick bucket) is
**genuinely partly-dead**: write-wired but read-unwired, no surviving data. The
case-evolution auto-growth subpath of Layer 7 also has no data
(`case_evolution.db` and `case_candidates/` absent) though its capture seam and
worker bootstrap exist behind flags. The distinction between "operator-gated and
unused" and "dead" matters for prioritization.

### G3 — Cross-model continuity breaks on provider change (MEDIUM, partially surfaced)
`agentAnalyzeSessionService.ts:286-342` + `agentResumeRoutes.ts:170-321` +
`agentRoutes.ts:1909,2136`. A hash mismatch (provider/key/model-version changed)
destroys the SDK conversation handle; product state survives.
- **Already partially surfaced:** the API and resume responses carry a
  `providerSnapshotChanged` flag and a human message (`agentResumeRoutes.ts:282,317`,
  `agentRoutes.ts:1909,2136`). So it is **not** "only a log line" — the client gets
  a signal.
- **Still missing:** there is no durable `continuityBreak` record persisted to the
  snapshot, so the session itself has no memory that its model thread was severed.
  A resumed session does not "know" it was handed off. Recovery is still "start
  over at the model level."

### G4 — Single-turn traffic means the multi-turn path is barely exercised (HIGH)
**322/332 sessions have exactly 2 messages** (1 user + 1 assistant). **0 sessions
have >4 messages.** The entire resume / cross-turn / working-memory-eviction
machinery is validated only by tests, not by real traffic. Latent bugs in the
restore path would not surface in current usage.

### G5 — In-session working memory is volatile + silently truncated (MEDIUM)
- Hard caps (turnLog ≤30, experiments ≤80, contradictions ≤40, evidence ≤500,
  workingMemory ≤12, turns ≤30) **silently delete oldest entries with no archive**.
  Long sessions lose their earliest reasoning permanently. Only the compressed
  digest survives.
- No mid-turn checkpoint. A crash mid-turn loses the whole turn.

### G6 — Recall is tag/structure-based, not semantic (MEDIUM)
Pattern memory (`matchPatterns`) and project memory (`recallProjectMemory`) rely
on tag overlap / weighted Jaccard. Case recall (`recall_similar_case`) uses tag +
evidence-signature / structured matching (`services/caseEvolution/caseRecommendationRetriever.ts:98-123`).
**None of the memory paths use embeddings or vector similarity.** A novel trace
with no tag/structure overlap to stored entries gets nothing — the MCP tool
returns "no matching patterns." As the stores grow, recall precision on unusual
traces will not improve.

### G7 — Legacy checkpoint/fork/session tree is dormant dead weight (MEDIUM)
43 checkpoint dirs + 124 session JSON files from January 2026 sit on disk, never read.
`SessionTree.serialize()`/`deserialize()` exist but no live caller persists fork
lineage — forking carries memory only in the dead legacy path. The live path has
**no fork-with-memory primitive at all**. This is confusing for anyone reading the
code and wastes disk.

### G8 — Raw tool results / SQL rows are not durable (MEDIUM/HIGH)
Only digests (≤260 chars, `enhancedSessionContext.ts:1427`) survive in the
session context. The `messages.sql_result` column — the designed home for raw SQL
output — is **currently 0 bytes across all 684 messages**, so in practice no raw
SQL output is persisted at all. Re-running or re-checking a past tool call after
restart is impossible. The agent cannot revisit its own past evidence. (Note: SQL
*error→fix* pairs ARE learned separately as Layer 8 — but correct results are not.)

### G9 — Provisional patterns can sit indefinitely (MEDIUM, downstream of G1)
Because of G1, `provisional` entries never promote and never get rejected — they
just decay. The "24h window then auto-confirm" design is inert.

### G10 — No persisted forward intent ("what to do next") (LOW)
The negative store records what failed (with optional workaround). There is no
persisted record of the agent's own forward plan/intent across sessions beyond the
per-session `analysisPlan` in the snapshot. A resumed session knows its own plan,
but a *new* session on a similar trace gets hints, not a handoff.

### G11 — `recall_project_memory` and `recall_patterns` are decoupled (LOW)
Project memory and analysis patterns can describe the same insight but live in
separate stores with separate scoring. No cross-store reconciliation.

### G12 — Enterprise schema tables are built but unwritten (LOW)
`memory_entries`, `runtime_snapshots`, `conversation_turns`, `agent_events` tables
exist (enterprise schema migrations v1–v11 ran) but the agent-driven persistence
path writes only to legacy `sessions`/`messages`. Enterprise write is gated by
`enterpriseKnowledgeDbWritesEnabled()` (env flag), default off. Forward-looking,
unused today.

### G14 — CLI Level-3 degraded resume splits session lineage (MEDIUM)
**File:** `backend/src/cli-user/services/turnRunner.ts:243,297,39-41`.
The CLI writes to the **same** backend memory stores as HTTP
(`CliAnalyzeService` → `SessionPersistenceService` against `sessions.db`), so this
is not a separate memory universe. The gap is the Level-3 fallback: when the trace
must be reloaded, the runner sets `requestedSessionId = undefined`
(`turnRunner.ts:243`) and marks the resume degraded. This **creates a new backend
session id** while the CLI-visible session id stays stable and
`config.backendSessionId` is repointed to the new id (`:297`). Prior backend
snapshot / session context / entity store / SDK continuity are **not restored into
the new backend session** — continuity is reduced to a textual preamble built from
the CLI transcript, capped at **last 3 turns × 1200 chars each (≤4000 chars total)**
(constants `RESUME_MAX_TURNS=3`, `RESUME_TURN_MAX_CHARS=1200`,
`RESUME_CONTEXT_MAX_CHARS=4000` at `:39-41`). So a degraded CLI resume silently
fragments the agent's memory lineage; the user sees one continuous CLI session but
the backend now has two disjoint sessions.

### G15 — Snapshot V1 fallback loses dialogue fields (LOW, not material today)
`sessionPersistenceService.ts:748-771`. The V1 read fallback reconstructs a
snapshot from legacy `runtimeArraysSnapshot`, but `agentDialogue`, `agentResponses`,
`runSequence`, and `conversationOrdinal` are **not in the legacy format and default
to empty/zero**. Real, but **not material for the current 332 sessions**: all 332
have V2 `sessionStateSnapshot` AND `runtimeArraysSnapshot`. Only matters for
hypothetical V1-only imported/old sessions.

---

## 7. What actually works well

To be fair, not everything is broken:
- **The per-turn snapshot is largely solid:** for existing sessions it's an atomic
  single UPDATE, dual-written for backward compat, normalized on read. 332/332
  sessions have well-formed snapshots. (Caveat: the new-session path does
  INSERT + UPDATE without a wrapping transaction — see Recommendation 5.)
- **Pattern write is correctly fire-and-forget** — never blocks analysis. (But the
  write has a race/corruption risk — see G13.)
- **The supersede read path is genuinely zero-write by design** — dual handles
  (`openSupersedeStoreReadOnly` for recall) so the `recall_patterns` MCP tool can
  be classified `public-readonly`. (Caveat: `collectSelfImproveMetrics()` calls the
  writable factories, which mkdir/migrate — so the metrics endpoint is not
  zero-write.)
- **Negative pattern *mechanism* is sound** — recording `FailedApproach` with
  type/reason/workaround and injecting as "avoid these" is exactly the shape the
  brief asks for. (Caveat: the current *semantics* are agent-process failures, not
  analysis-conclusion failures — see Layer 2.)
- **Tag weighting (arch/scene 3.0, domain 2.0) is sensible** — these are the
  real determinants of analysis path.
- **Confidence decay (30d half-life) + frequency-aware eviction** is the right
  shape — a highly-matched old pattern retains priority.

---

## 8. Recommendations (priority order)

These are findings-level, not committed work.

1. **Fix the pattern-store write race first** (fixes G13). Before adding any new
   write path, add a mutex/queue around `savePatterns`/`saveNegativePatterns`, use
   a per-call unique `.tmp` file, and stop returning `[]` on parse error (back up
   the corrupt file and keep the old data). This protects the only learning surface
   with real data.
2. **Wire `sweepAutoConfirm`** (fixes G1/G9). **Not a one-liner:** the sweep is
   `async` while `buildPatternContextSection` is sync and called sync by four
   runtimes. Right approach is a separate periodic/background sweep (or a sync
   sweep variant), not an inline `await` in the prompt builder. Immediately promotes
   24 stuck patterns to full weight once running.
3. **Decide the fate of Layers 4/5 and the quick-path read side.** Either wire them
   into a real trigger (quick-path read side actually injecting, an operator
   promoting, a reviewer merging), or mark them explicitly experimental and stop
   carrying them as "live" in docs. For Layer 5, `selfImprove` has the primitives
   (outbox, worker, worktree runner) but no production enqueue/start — adding a
   production `ReviewWorker` bootstrap + enqueue site is the concrete missing piece.
   Empty tables cost confusion, not just disk.
4. **Persist a `continuityBreak` record on provider-hash mismatch** (fixes G3). The
   client already gets a `providerSnapshotChanged` signal; what's missing is a
   *durable* record in the snapshot so a resumed session knows its model thread was
   severed, not just the current turn's response.
5. **Add mid-turn checkpointing for long turns** (mitigates G5). Or at least
   document that a crash mid-turn loses the turn. Also: the snapshot INSERT+UPDATE
   path for new sessions is not wrapped in a transaction (`sessionPersistenceService.ts:652`),
   so a crash between them can leave a session row with `{}` metadata — wrap in a
   transaction.
6. **Archive evicted working-memory entries** instead of deleting (fixes G5).
   Even an append-only overflow file would let post-hoc debugging recover
   reasoning.
7. **Add embedding-based recall alongside tag matching** (fixes G6). Tag recall
   tops out on novel traces; semantic recall would let the pattern store actually
   grow in usefulness. (Architectural project — needs tenancy/scope, eval data,
   freshness, and prompt-budget design.)
8. **Delete or clearly fence the dormant legacy tree** (fixes G7). 43 dormant
   checkpoint dirs + 124 dormant session files + a `SessionTree` that nothing
   persists is a trap for future readers. Note `traceAgentState.ts` and
   `orchestratorTypes.ts` are live — fence at module level, not directory level.
9. **Persist raw tool results for the last N turns** (fixes G8) so the agent can
   revisit evidence.
10. **Add real multi-turn / resume coverage to the test suite** (fixes G4). G4 is
    HIGH because 322/332 sessions are single-turn — the resume path is validated
    only by unit tests. Add integration tests that actually drive multi-turn resume
    (and CLI Level-3 degraded resume, G14) so latent restore bugs surface before
    users hit them.
11. **Surface the CLI Level-3 lineage split** (fixes G14). Either restore prior
    backend state into the new session, or persist a link between the two backend
    session ids so the lineage is traceable instead of silently fragmented.

---

## 9. Review log

This report was reviewed by Codex (independent read-only reviewer, `codex exec`
in `read-only` sandbox, reasoning effort `high`) across **5 rounds**. Full
per-round findings are recorded in
`docs/architecture/memory-system-review-codex-log.md`. Summary of corrections
incorporated:

- **Round 1 (verify claims):** fixed 5 errors and 4 omissions —
  `backend/src/agent/state/` is not dead as a directory (`traceAgentState.ts` is
  live); quick-path bucket is write-wired not "never run"; added Layer 6 (learned
  misdiagnosis) and Layer 7 (case library); corrected stale counts (45→43 dirs,
  126→124 files, 282→271MB); sharpened "recall is tag-based" to cover case
  evidence-signature matching.
- **Round 2 (concurrency + semantics):** added G13 (pattern-store write race,
  fixed `.tmp` path, no lock, parse-error-returns-`[]` → corruption/lost-update);
  reframed negative memory as agent-process failures not analysis-conclusion
  failures; fixed Recommendation 1 (sweepAutoConfirm is async, prompt builder is
  sync — not a one-liner); downgraded G3 from "silently dropped" to "partially
  surfaced"; found quick-path read side is unwired.
- **Round 3 (consistency):** fixed internal contradictions (TL;DR layer count,
  G2 "four of seven," stale 45/126 in G7, "only a log warning" in §5);
  added G14 (CLI Level-3 resume splits session lineage) and G15 (snapshot V1
  fallback, low severity); added Recommendation 10 (multi-turn test coverage)
  and 11 (CLI lineage).
- **Round 4 (adversarial):** added Layer 8 (SQL error-fix learning, the cleanest
  working cross-session memory, 20 pairs); reframed empty layers as
  "operator-gated and awaiting first use" vs "dead"; corrected DB-size claim
  (`messages.sql_result` is 0 bytes, not a memory surface); confirmed G13 HIGH
  and sweepAutoConfirm-dead survive the adversarial attack.
- **Round 5 (final sign-off):** fixed wrong case-retriever citation path, G14
  line drift (`:239`→`:243`, `:294`→`:297`), G7 count drift; verdict
  **ready-with-caveats** (caveats were the citation cleanup, now applied).

**Net result of the review process:** the draft's central thesis ("design vs.
reality gap is the real finding") survived every adversarial round, but 3
omitted memory surfaces were added (Layers 6, 7, 8), 2 new gaps were discovered
(G13 concurrency, G14 CLI lineage), and ~15 citations/counts were corrected. The
report is substantially more accurate than the draft.

---

## 10. Implementation spec — high-priority fixes

本节是实现方的完整工作规格,**自包含**,实现方可直接据此拆解执行。

### 通用约束(所有条目共用)

- **按 §10.1 → §10.6 的顺序做**,顺序很关键:G13 必须先修,因为 G1 的 sweep、Layer3 的
  fallback 都读写同一个 pattern 文件,race 不先修,新代码上线就会撞车。
- **每条独立 commit**,commit message 以 `fix(memory): G13-...` / `fix(memory): G1-...` 开头,
  body 引用本节对应小节。
- **每条带回归测试**,测试要求写在各小节"验收"里,照着写。
- **交付前跑 `npm run verify:pr`**(从仓库根),全过才算完成。
- **不修改本文件以外的任何 docs**,除非是实现本身需要的(如新增 CLI 命令的帮助文本)。
- **遇到规格里没覆盖的边界或与现状冲突,先停下来问**,不要自行扩大改动面。
- 参考 `.claude/rules/backend.md`、`.claude/rules/testing.md` 的代码与测试规范。

### P0-G13 — pattern 存储写入 race + 解析失败清空 store(最高优先)

`backend/src/agentv3/analysisPatternMemory.ts` `savePatterns()`/`saveNegativePatterns()`
(`:295`、`:312`)用固定 `.tmp`、无锁、read-modify-write;`loadPatterns()`/`loadNegativePatterns()`
(`:281-285`、`:292-296`)解析失败 `return []` → 一次成功保存清空整个 store。

**坑点:** 这是唯一有真实数据的跨会话学习面(24 条),坏了不可逆。

**要求:**
1. 进程内 `Mutex`(覆盖 save+load 临界区)
2. `.tmp` 名带 pid+随机后缀
3. 解析失败:备份成 `<file>.corrupt-<ts>`,logger.error,**返回上次已知好数据**,不要 `return []`
4. 可选:rename 前 fsync

**验收:**
- 并发测试:两个 `savePatterns` 同时跑,断言两条新 pattern 都在、JSON 可解析
- 损坏测试:写坏 JSON,断言 `loadPatterns` 不抛、返回空、坏文件被备份、logger 有 error
- 现有单测全过

### P0-G1 — sweepAutoConfirm 死代码,24 条 pattern 卡 provisional

`sweepAutoConfirm()`(`analysisPatternMemory.ts:889`)零非测试调用方。

**坑点:别在 prompt builder 里 await。** `sweepAutoConfirm` 是 async,`buildPatternContextSection`
(`:909`)是 sync,被四个 runtime 同步调。简单 `await` 会改签名阻塞 prompt 构建。

**要求:**
1. 进程启动后 `setInterval`(建议 1h)后台跑 sweep,错误吞掉只记 logger.error
2. 加手动入口:`POST /api/memory/sweep-confirm`(`memoryRoutes.ts`)
3. 幂等
4. sweep 走 P0-G13 的锁(同文件读写)

**验收:**
- 单测:`createdAt` 早于 24h 的 provisional → confirmed;24h 内的不动
- 集成:手动 POST sweep-confirm 返回 200 + promote N 条
- 跑完检查 `logs/analysis_patterns.json` 那 24 条状态确实变了

### P1-G14 — CLI Level-3 降级 resume 切断 session 血统

`backend/src/cli-user/services/turnRunner.ts:243,297`,Level-3 时新建 backend session id,
旧 snapshot/entity/SDK 不恢复。用户看着一个连续 session,backend 是两个。

**要求:**
1. 新 session metadata 写 `lineage: { previousBackendSessionId, reason: 'cli-level3-degraded', at }`
2. resume 检测到 lineage 时,chat 投影显示"此会话因 trace 重载已从原会话降级续接"
3. (可选,难度高)把旧 session 的 EnhancedSessionContext 摘要注入新 session preamble

**验收:** 单测断言 lineage 写入;手动 CLI 触发 Level-3,catalog 里新 session 带 lineage 标记

### P1-G8 — messages.sql_result 列全空,原始 SQL 结果没存

684 条消息 sql_result 全 0 字节。**先排查根因**:grep `sql_result` 在写入路径,确认是漏写还是有意置空。

**要求:**
1. 修写入路径,最近 N 轮(建议 N=5)SQL 结果存进 `messages.sql_result`
2. 单条 > 100KB 截断 + `truncated: true`
3. resume 能恢复最近几轮原始结果

**验收:** 单测断言 assistant 消息 sql_result 非空;超大结果截断带标记

### P2-G3 — 跨模型 provider hash 变化丢 SDK 连续性

`agentAnalyzeSessionService.ts:286-342`。API 已有 `providerSnapshotChanged` 信号,但 snapshot 无持久记录。

**要求:**
1. mismatch 重建时往 metadata 追加 `continuityBreaks: [{ at, previousProviderHash, reason }]`(追加不覆盖)
2. resume 检测到 continuityBreaks 非空时,prompt 注入提示让 agent 知道上下文重置了

**验收:** 单测断言追加;连续两次 mismatch 有两条

### P2-Layer3 — quick-path 读取端接线

`matchQuickPatternsAsBackup()`(`analysisPatternMemory.ts:721`)零非测试调用方。

**要求:** `buildPatternContextSection()`(`:909`)里,`matchPatterns()` 返回空时调
`matchQuickPatternsAsBackup()` 做 fallback,按原设计 ×0.3 权重注入。

**验收:** 单测 quick pattern 命中时 prompt section 有注入;full-path 命中时不走 fallback

### 不在本任务范围

- Layer 4(project memory)/ Layer 5(self-improve/supersede)的空 —— **operator-gated,等运营驱动,不是 bug**
- G6(embedding recall)/ G7(删 legacy 目录)—— 架构级,单独评估
- Layer 2 负面 pattern 语义偏 —— 要改 FailedApproach 采集点,影响面大,先讨论
