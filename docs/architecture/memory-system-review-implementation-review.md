# Memory Fixes — Implementation Review

**Scope:** review of the 7 commits implementing
`docs/architecture/memory-system-review.md` §10 (G13 → G1 → G14 → G8 → G3 →
Layer3 + a review-findings commit). Read-only review. No code modified.

**Reviewer:** ZCode (read-only), with independent test re-runs and typecheck.
**Date:** 2026-06-22

**Commits under review:**

| Commit | Subject |
|---|---|
| `f0d8c45d` | fix(memory): G13-serialize pattern store writes |
| `cc2c8a68` | fix(memory): G1-run pattern auto-confirm sweep |
| `90b7741e` | fix(memory): G14-record CLI degraded lineage |
| `1d3c0d93` | fix(memory): G8-persist recent sql results |
| `bd69ad38` | fix(memory): G3-record provider continuity breaks |
| `65f24c7c` | fix(memory): Layer3-wire quick-path fallback |
| `400bbf05` | fix(memory): address review findings |

---

## TL;DR verdict

**APPROVE WITH FOLLOW-UPS.** The implementation is high quality. All six fixes
are correctly built against §10, the ordering constraint (G13 first) was
respected, the Mutex is sound, tests are real (not rubber-stamp), and the
self-review (`400bbf05`) caught two genuine issues including a real
multi-tenant scope-leak. `git diff --check` clean, typecheck clean, all 132
affected tests pass on re-run.

**Two spec deviations need follow-up** (neither blocks merge, both are
"half-finished" not "wrong"):

1. **G8 stores `sqlResult` but nothing reads it back into the agent on resume.**
   §10 acceptance: "resume 能恢复最近几轮原始结果给 agent 看" — only the
   storage half is done; the read-back is missing.
2. **G14 lineage lives in CLI config, not backend session metadata.** §10
   acceptance: "catalog 里新 session 带 lineage 标记" — only the CLI path can
   see it; the HTTP catalog never surfaces it.

Details below.

---

## Per-fix assessment

### P0-G13 — pattern store serialization ✅ EXCELLENT

**Spec met:**
- Process-wide `Mutex` (`analysisPatternMemory.ts:80`) with correct
  `try/finally` release — a throwing `fn` does not deadlock the chain.
- Applied to **all 5** mutation sites: `saveAnalysisPattern`,
  `saveNegativePattern`, `saveQuickPathPattern`, `applyFeedbackToPattern`,
  `sweepAutoConfirm`. No mutation path bypasses the lock.
- Unique `.tmp` path: `${pid}-${Date.now}-${random}` (`uniqueTempPath`).
- Corrupt-store handling: `backupCorruptStore` renames to `.corrupt-<ts>`,
  logs error, returns `cache.lastGood` instead of `[]`.
- Read-side clone (`cloneStoreEntries`) prevents external mutation of the
  cache — a subtle correctness touch many implementations miss.

**Tests (3):** concurrent-write survival ✓, corrupt-positive fallback ✓,
corrupt-negative cold-cache ✓.

**Note:** No `fsync` before `rename` — spec said "可选", so this is acceptable.
Power-loss durability is not guaranteed, but crash-consistency is (atomic
rename). Worth a one-line comment noting the tradeoff.

### P0-G1 — auto-confirm sweep ✅ GOOD

**Spec met:**
- Background `setInterval` (1h) with `.unref()` (does not block shutdown) and
  a `stop()` handle wired into `gracefulShutdown` (`index.ts:307`).
- Manual entrypoint `POST /api/memory/sweep-confirm` (`memoryRoutes.ts:104`).
- Returns `AutoConfirmSweepResult` so operators see what got promoted.
- Sweep reuses the G13 Mutex ✓ (the spec's explicit cross-fix requirement).
- **Did NOT fall into the async-in-sync-prompt-builder trap** — sweep runs in
  the background, not inline in `buildPatternContextSection`. Correct call.

**Tests (2 + 1 in 400bbf05):** background tick + error swallowing ✓, manual
endpoint ✓, **scope-filtering** (added in review-findings, see below) ✓.

### P1-G14 — CLI Level-3 lineage ⚠️ SPEC DEVIATION (follow-up)

**Spec partially met:**
- Lineage recorded: `{ previousBackendSessionId, reason, at }` ✓
- Notice shown to user in CLI turn markdown + console log ✓
- Persists across subsequent resumes (`existingConfig.lineage` carried forward) ✓

**Deviation:** lineage is stored in `CliSessionConfig.lineage` (CLI-local
`config.json`), **not in backend session metadata**. §10 requirement was
"新 session metadata 写 lineage"; acceptance was "catalog 里新 session 带
lineage 标记." The HTTP session catalog (`agentSessionCatalogRoutes`) cannot
see this field. So: a CLI user gets the notice, but anyone inspecting the
backend (DB, catalog API, future admin UI) sees two disjoint sessions with no
link.

**Severity:** MEDIUM. The user-facing notice works (the more important half),
but the backend-level lineage link — which was the whole point of "make the
split traceable, not silent" — is absent. The fix is small: also write
`lineage` into the new backend session's snapshot metadata on the degraded
path (mirror the G3 `continuityBreaks` pattern).

**Tests (2):** lineage recorded on degrade ✓, persists on later resume ✓.
No test asserts backend-side visibility (because there is none).

### P1-G8 — persist recent SQL results ⚠️ SPEC DEVIATION (follow-up)

**Spec partially met:**
- Root-cause investigation done ✓ — the write path was simply never populating
  `sqlResult`; the fix extracts `meta.type === 'sql_result'` envelopes from
  `session.dataEnvelopes` / `snapshot.dataEnvelopes`.
- Versioned schema `SqlResultMessageBundle` (`schemaVersion: 'sql_result_message_v1'`) ✓.
- Cap N=5 results per message ✓, 100KB per entry with deep recursive
  cell-compaction + `truncated: true` + `originalBytes` ✓.
- `appendMessages` / `getMessages` round-trip tested ✓.

**Deviation:** §10 acceptance "resume 能恢复最近几轮原始结果给 agent 看" is
**not implemented.** `getMessages` (`sessionPersistenceService.ts:183`) reads
`sqlResult` back from the column, but **no caller feeds it into the agent's
context on resume** — `enhancedSessionContext`, `restoreFromSnapshot`, and the
runtime rebuild paths never read `sqlResult`. So the data is durable for
audit/debugging but invisible to the agent. Half-finished.

**Severity:** MEDIUM. Storage without read-back means the agent still cannot
revisit its own past evidence (the actual harm G8 was meant to fix). The fix
is a read-side patch: on resume, hydrate the last N messages' `sqlResult`
bundles into the restored `EnhancedSessionContext` / trace agent state.

**Tests (3):** persist ✓, truncate ✓, round-trip ✓. No test asserts resume-side
hydration (because there is none).

### P2-G3 — provider continuity breaks ✅ EXCELLENT

**Spec met:**
- `ProviderContinuityBreak[]` on `SessionStateSnapshot`, append-only
  (`appendProviderContinuityBreak`) ✓
- Validated normalization (`isProviderContinuityBreak` rejects malformed) ✓
- Persisted into snapshot via `persistAgentSession.ts:205` ✓
- Prompt notice injected via `agentQuery` (runtime-only, user query preserved
  for persistence) ✓ — clean separation.
- Template lives in `strategies/prompt-session-continuity-break.template.md`
  (resolves via `loadPromptTemplate` from `STRATEGIES_DIR`) ✓ — complies with
  the "no hardcoded prompts in TS" rule.
- Staleness guard `session.query === input.query` before reusing `agentQuery`
  is a thoughtful touch (avoids injecting a stale notice).

**Tests (3):** consecutive-mismatch append ✓, agentQuery-runtime-only ✓,
snapshot-persisted ✓.

### P2-Layer3 — quick-path fallback ✅ CORRECT

**Spec met:** exactly the spec — `matchPatterns` empty →
`matchQuickPatternsAsBackup` fallback. 4-line change, no scope creep. ×0.3
weight preserved in `matchQuickPatternsAsBackup` itself.

**Tests (2):** fallback injects when no full match ✓, no fallback when full
match exists ✓.

---

## The review-findings commit (`400bbf05`) ✅

The implementer's own read-only review found and fixed two real issues. Both
are non-trivial — this is the mark of a real review, not a checkbox exercise.

### Finding 1 — manual sweep scope leak (SECURITY-relevant) ✅ FIXED
`sweepAutoConfirm()` originally ran **globally** with no scope filter. In
multi-tenant enterprise mode, an admin hitting `POST /sweep-confirm` would
promote **every tenant's** provisional patterns — a cross-workspace
authorization leak. The fix: endpoint derives `knowledgeScopeFromRequestContext`
and passes it to `sweepAutoConfirm(now, scope)`, which skips non-matching
patterns via `patternMatchesKnowledgeScope`. Test added. **This is a real
catch.** It exactly matches the kind of multi-tenant hazard the §10 report
worried about elsewhere (G3, project memory promotion invariants).

### Finding 2 — corrupt-store fallback "only retained once" ✅ FIXED
Subtle. After G13, a corrupt store returns `lastGood` and quarantines the file.
But the *next* load sees the file missing → `cache.lastGood = []` (cleared).
So the second load after corruption returns empty, even though good data was
held one call ago. The fix: a `retainLastGoodOnMissing` flag set on corruption,
cleared only on successful write. Test added
("keeps last known good patterns after a corrupt store is quarantined and then
missing"). **Correct and non-obvious.**

---

## Cross-cutting checks

| Check | Result |
|---|---|
| `git diff --check 62662103..HEAD` | clean (exit 0) — matches dev claim |
| `tsc --noEmit` | clean (exit 0) |
| Affected test suites re-run | 6 suites, 70 tests pass; pattern memory suite 62 tests pass → **132 pass** |
| `verify:pr` claim (776 core tests) | not independently re-run in full, but the affected subsets all pass and typecheck is clean — claim is credible |
| Mutex correctness | `try/finally` release on throw ✓; no reentrancy assumed ✓ |
| "No hardcoded prompts in TS" rule | respected — G3 notice uses a `strategies/*.template.md` file |
| New `console.log` in prod paths | none introduced (only pre-existing `[AgentRoutes]` logs remain) |
| Commit hygiene | 6 fix commits + 1 review commit, each scoped to one §10 item ✓; messages reference §10 ✓ |
| Working-tree pollution | dev noted pre-existing untracked changes were left untouched — confirmed no §10 work leaked into the dirty tree |

---

## Issues found (priority order)

### IF1 — G8 read-back missing (MEDIUM, follow-up)
Storage done, agent-side resume hydration not done. The agent still cannot
revisit past evidence — the core harm G8 targeted is only half-addressed.
**Fix:** on resume, hydrate last N messages' `sqlResult` bundles into the
restored `EnhancedSessionContext` / trace agent state.

### IF2 — G14 lineage not in backend metadata (MEDIUM, follow-up)
CLI-side notice works; backend-side lineage link absent. Catalog/DB/admin UI
see two disjoint sessions. **Fix:** mirror `continuityBreaks` (G3) — write
`lineage` into the new backend session's snapshot metadata on the degraded
path.

### IF3 — snapshot INSERT+UPDATE not transactional (LOW, pre-existing, out of §10 scope)
`sessionPersistenceService.ts:655+` — new-session INSERT then metadata UPDATE
without a wrapping transaction. A crash between them leaves a session row with
`{}` metadata. §10 did not require this (it was a round-2 note that didn't
make the spec). Flagging as a known residual, not a regression introduced here.

### IF4 — no `fsync` before rename (LOW, acceptable)
G13 skips fsync. Crash-safe but not power-loss durable. Spec marked fsync
"可选." Acceptable; worth a one-line code comment documenting the choice.

---

## What the implementer did unusually well

1. **Respected the G13-first ordering** and pre-wired the Mutex into G1's
   sweep — exactly the cross-fix dependency §10 warned about.
2. **Avoided the async-in-sync trap** on G1 (background sweep, not inline await).
3. **Self-review caught a real security issue** (IF-equivalent: the sweep scope
   leak) and a real correctness issue (the corrupt-store double-load). The
   `400bbf05` commit is substantive, not cosmetic.
4. **Versioned the SQL bundle schema** (`sql_result_message_v1`) and added
   deep cell-compaction with provenance fields (`originalBytes`, `maxBytes`,
   `truncated`) — forward-looking, not a quick patch.
5. **Separated runtime-only `agentQuery` from persisted user `query`** in G3 —
   the continuity notice reaches the model without polluting the stored record.
6. **Read-side defensive cloning** in G13 prevents the cache from being mutated
   by callers — a subtle bug class pre-empted.

---

## Recommendation

**Merge.** Open two follow-up issues for IF1 (G8 resume read-back) and IF2
(G14 backend-side lineage) — both are small, neither blocks the value already
shipped (G13 concurrency fix, G1 unsticking 24 patterns, G3 continuity record,
Layer3 fallback are all fully done and net-positive on their own).

The "completion" claim is accurate for G13/G1/G3/Layer3, and **partial for
G14/G8** — the two deviations above should be reflected as "partially done" in
any tracking, not "done," so the follow-ups don't get lost.

---

## Follow-up review — IF1 & IF2 (uncommitted, dirty-tree)

**State:** both follow-ups implemented as uncommitted working-tree changes
(deliberately not committed to avoid mixing with pre-existing dirty-tree work).
Review covers only the follow-up diffs (10 files), not the unrelated pre-existing
changes (runtimes, orchestrator, fork, verifier, etc.) that were already dirty.

### IF1 / G8 resume read-back ✅ COMPLETE

**Deviation resolved.** The read-back half is now implemented and tested.

**Implementation** (`enhancedSessionContext.ts`, `sessionPersistenceService.ts`):
- New `hydrateRecentSqlResultsFromMessages(messages, maxMessages=5)` on
  `EnhancedSessionContext`, called at `sessionPersistenceService.ts:398` right
  after `deserialize` inside `loadSessionContext` — the correct resume hook.
- Handles **both** the new `sql_result_message_v1` bundle **and** legacy
  `{columns, rows}` shapes (`extractRecentSqlResultEntries`) — backward-compatible.
- **Preview limiting is thorough:** `compactSqlPromptData` caps rows at 5 +
  `truncatedRows` flag, SQL→1200 chars, JSON→2400 chars. Worst-case prompt
  injection ≈ 5 × 3600 ≈ 18KB, bounded. Full payload stays in SQLite — matches
  §10 "受限预览" intent.
- Serialized into `sessionContextSnapshot.recentSqlResults` (round-trip tested
  via deserialize) with `Array.isArray(...) ? ... : []` guard — old snapshots
  deserialize safely.
- Template `strategies/prompt-recent-sql-results.template.md` loaded via
  `loadPromptTemplate` — respects "no hardcoded prompts in TS."

**Test:** `loadSessionContext hydrates recent SQL results into resumed prompt
context` — asserts the **prompt-context output** (`generatePromptContext`
contains title, SQL, column, value). Tests behavior at the right level, not
implementation.

**Verdict:** G8 now fully done. The agent can revisit recent raw evidence on
resume.

### IF2 / G14 backend-side lineage ✅ COMPLETE

**Deviation resolved.** Lineage now reaches backend session metadata and the
HTTP catalog.

**Plumbing** (end-to-end, single source of truth):
1. `turnRunner.ts` builds `pendingLineage` via `createCliLevel3Lineage` and
   passes it through `RunTurnInput.lineage` (new field).
2. `cliAnalyzeService.ts` sets `session.lineage = input.lineage` on the managed
   session.
3. `agentAnalyzeSessionService.ts` carries `lineage` on `AnalyzeManagedSession`
   and restores it on snapshot-resume (`restoredLineage = stateSnapshot?.lineage
   ?? persistedSession.metadata?.lineage`).
4. `persistAgentSession.ts:206` writes `lineage: session.lineage` into the
   atomic snapshot.
5. `sessionPersistenceService.ts:686` mirrors `snapshot.lineage` →
   `metadata.lineage` (dual-write, with a comment explaining catalog visibility).
6. `agentResumeRoutes.ts:286` reads `snapshot?.lineage ?? persistedSession.metadata?.lineage`
   into the resume response.
7. `sessionSchema.ts` adds `metadata.lineage?: SessionLineage` type.

**Type hygiene:** `CliSessionLineage extends SessionLineage` — single source of
truth, no field duplication. `SessionLineage` type defined once in
`sessionStateSnapshot.ts`.

**Tests:** "attaches CLI degraded lineage to the backend session before
persistence" + "passes CLI degraded lineage into the atomic session snapshot" +
"saveSessionStateSnapshot mirrors lineage into list-session metadata" — the
last one directly asserts `listSessions(...).metadata.lineage`, verifying the
catalog-visibility claim end-to-end.

**Verdict:** G14 now fully done. HTTP catalog, DB, and future admin UI see the
lineage link; the split is no longer silent on the backend side.

### Verification re-run

| Check | Result |
|---|---|
| `tsc --noEmit` (full dirty tree) | clean, exit 0 |
| Affected suites (5: persistenceService, persistAgentSession, agentAnalyzeSessionService, turnRunner, cliAnalyzeService.runTurn) | **58 tests pass** — matches dev's claim exactly |
| `verify:pr` exit 0 claim | affected subsets all pass; credible |
| Conflict with pre-existing dirty work | none — follow-up files (enhancedSessionContext, sessionStateSnapshot, turnRunner, types, cliAnalyzeService, agentAnalyzeSessionService, persistAgentSession, agentResumeRoutes, sessionSchema, sessionPersistenceService) are disjoint from the pre-existing dirty files (runtimes, orchestrator, fork, verifier, dataContract). Verified no runtime references the new `recentSqlResults`/`lineage` fields. |
| `git diff --check` on follow-up files | clean |

### Residual notes (non-blocking)

- **No direct unit test for `extractRecentSqlResultEntries` / `generateRecentSqlResultContext`
  in `enhancedSessionContext.test.ts`.** Coverage comes via the
  `loadSessionContext` integration test. Acceptable — behavior is tested — but a
  focused unit test on malformed `sqlResult` shapes (null, missing `results`,
  non-array) would harden the edge cases the integration test doesn't reach.
- **`metadata.lineage` dual-write** mirrors the existing `runtimeArraysSnapshot`
  dual-write pattern. Consistent with the codebase, but means lineage lives in
  two metadata locations (`sessionStateSnapshot.lineage` and top-level
  `metadata.lineage`) — a future cleanup could single-source it.

### Updated recommendation

**Both follow-ups resolve the original deviations. G8 and G14 are now fully
done, not partial.** The §10 implementation is complete across all six items.
Commit the follow-up files (only those 10) as a single follow-up commit (or
two: one per IF) when ready — they are correctly isolated from the unrelated
dirty-tree work. No new blockers found.
