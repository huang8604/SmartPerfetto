# Memory System Review — Codex Review Log

Companion to `docs/architecture/memory-system-review.md`. Records the 5 rounds of
independent read-only Codex review (`codex exec -s read-only`,
`model_reasoning_effort="high"`) that corrected the report. Each round's prompt
focus and the corrections applied are summarized below. Codex ran sandboxed to
the repo root; no files were modified by the reviewer.

---

## Round 1 — Verify the draft's high-stakes claims

**Prompt focus:** verify sweepAutoConfirm-has-no-callers, provider-hash-discard,
dead-code boundary, no-embedding-recall, MCP tool coverage.

**Corrections applied:**
- `backend/src/agent/state/` is **not** dead as a directory. `traceAgentState.ts`
  is live (imported by `EnhancedSessionContext`, persisted in snapshot). Only
  `CheckpointManager` / `SessionStore` / fork / expert trees are dormant. Fixed
  the report to fence at module level, not directory level.
- Quick-path bucket: changed "entire layer never run" → "write side wired
  (`saveQuickPathPattern` at `analysisPatternMemory.ts:672`, called
  `claudeRuntime.ts:2529`), read side not wired, no data on disk."
- Added **Layer 6 — learned misdiagnosis memory** (`claudeVerifier.ts:45-160`,
  5 entries, injection threshold `occurrences >= 2`).
- Added **Layer 7 — case library / case evolution** (`caseLibrary.ts`,
  `caseGraph.ts`, `recall_similar_case` MCP tool at `claudeMcpServer.ts:3916`).
  Prompt-injected at `claudeRuntime.ts:3060-3064`.
- Corrected stale counts: 45→43 checkpoint dirs, 126→124 session files,
  282MB→271MB db size.
- Sharpened "recall is tag-based Jaccard only" → pattern/project memory is
  Jaccard; case recall is tag + evidence-signature/structured.

---

## Round 2 — Concurrency, snapshot safety, negative-memory semantics

**Prompt focus:** write-race safety, snapshot transactionality, negative-memory
framing accuracy, recommendation soundness, self-improve proximity.

**Corrections applied:**
- **Added G13 (HIGH):** pattern-store writes race. `savePatterns`/`saveNegativePatterns`
  use fixed `.tmp` path, no mutex/CAS, read-modify-write → lost-update or JSON
  corruption; `loadPatterns` returns `[]` on parse error → a later save can wipe
  the store. No `fsync`. Affects the only learning surface with real data.
- **Reframed Layer 2 (negative memory):** on-disk entries are agent-*process*
  failures (tool_failure, strategy_failure, verification_failure, sql_error),
  not analysis-*conclusion* failures. Still useful, but the framing matters.
- **Fixed Recommendation 1:** `sweepAutoConfirm` is `async`, prompt builder is
  sync and called sync by four runtimes — "one line" is wrong. Right approach is
  a periodic/background sweep.
- **Downgraded G3 HIGH→MEDIUM:** provider-hash mismatch is already surfaced via
  `providerSnapshotChanged` flag in API/resume responses (`agentResumeRoutes.ts:282,317`,
  `agentRoutes.ts:1909,2136`). Reframed: "partially surfaced; missing durable
  `continuityBreak` record."
- **Found quick-path read side unwired:** `matchQuickPatternsAsBackup()` has zero
  non-test callers. Updated Layer 3 to "write wired, READ NOT WIRED."
- Added snapshot caveat: new-session INSERT+UPDATE not wrapped in transaction
  (`sessionPersistenceService.ts:652`).
- Noted `collectSelfImproveMetrics()` is not zero-write (mkdir/migrate).

---

## Round 3 — Internal consistency + CLI path

**Prompt focus:** contradictions, numbering, CLI resume, snapshot V1 fallback,
residual factual errors.

**Corrections applied:**
- Fixed TL;DR: "five-layer" → seven surfaces (then eight after round 4).
- Fixed G2: "Four of seven layers" → accurate count with operator-gated nuance.
- Fixed G7 count drift (45/126 → 43/124).
- Fixed §5 "Only a log warning" to match corrected G3 ("partially surfaced").
- **Added G14 (MEDIUM):** CLI Level-3 degraded resume (`turnRunner.ts:243,297`)
  creates a new backend session id while CLI id stays stable; prior backend state
  not restored; continuity reduced to ≤3 turns / ≤4000 chars preamble. Silently
  fragments memory lineage.
- **Added G15 (LOW):** snapshot V1 fallback loses `agentDialogue`/`agentResponses`/
  `runSequence`/`conversationOrdinal` (`sessionPersistenceService.ts:748-771`).
  Not material for current 332 sessions (all have V2).
- Added Recommendation 10 (multi-turn/resume test coverage — G4 was HIGH with no
  rec) and 11 (CLI lineage link).

---

## Round 4 — Adversarial attack on the thesis

**Prompt focus:** try to break "design vs. reality gap" thesis. Attack the
empty-layers framing, the sweepAutoConfirm conclusion, find missed flows,
challenge G13 severity.

**Outcome:** thesis survived; 3 revisions required.
- **Added Layer 8 (SQL error-fix learning):** the cleanest working cross-session
  memory. `logSqlErrorFixPair` writes `{errorSql, errorMessage, fixedSql}` to
  `logs/sql_learning/<tenant>/<workspace>/error_fix_pairs.json` (20 pairs);
  `loadLearnedSqlFixPairs(5)` injects as `## SQL 踩坑记录`
  (`claudeSystemPrompt.ts:656`). This was missed by the draft entirely.
- **Reframed empty layers:** project memory + supersede + feedback pipeline are
  **operator-gated** (admin promotion, reviewer approval, patch/canary lifecycle),
  not broken. "Empty" = "no operator has driven the workflow yet." Quick-path
  read side is the genuinely dead part. Updated G2 + Layer 4/5 text.
- **Corrected DB-size claim:** `messages.sql_result` is 0 bytes across all 684
  messages; the 271MB is ~221MB of `sessions.metadata`. Sharpened G8 (raw
  evidence genuinely not durable).
- Attacks that FAILED (report survived): sweepAutoConfirm-dead (feedback path
  exists but doesn't rescue the unwired sweep), G13-HIGH (structural bug is real
  even with single-turn traffic — concurrent single-turn analyses can still
  collide on the shared file).

---

## Round 5 — Final sign-off

**Prompt focus:** citation spot-check, prior-fix completeness, final consistency,
last adversarial pass, executive readiness.

**Verdict: ready-with-caveats.** All r1-r4 corrections confirmed present. Three
report-hygiene issues found and fixed:
- Wrong case-retriever citation path: `caseRecommendationRetriever.ts` →
  `services/caseEvolution/caseRecommendationRetriever.ts`.
- G14 line drift: `:239`→`:243`, `:294`→`:297`; clarified the cap is
  `RESUME_MAX_TURNS=3` × `RESUME_TURN_MAX_CHARS=1200` ≤ `RESUME_CONTEXT_MAX_CHARS=4000`
  (constants at `:39-41`).
- G7 count drift (45/126 → 43/124) in the G7 entry itself.

No new architecture-breaking finding. No severity changes. The report is
substantively accurate and decision-ready after the citation cleanup.

---

## Aggregate correction tally

| Category | Count |
|---|---|
| Omitted memory surfaces added | 3 (Layers 6, 7, 8) |
| New gaps discovered | 2 (G13 concurrency, G14 CLI lineage) |
| Wrong/reframed claims | ~6 (dead-code boundary, negative-memory semantics, quick-path wiredness, DB-size, G3 severity, empty-layer framing) |
| Citations / counts corrected | ~15 |
| Recommendations added/revised | 4 |

The draft's central thesis ("design vs. reality gap is the real finding") survived
all 5 rounds including the adversarial round.
