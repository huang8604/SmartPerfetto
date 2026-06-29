# Case Knowledge Self-Evolution Design (V1)

Date: 2026-06-21
Status: Design complete — 5 rounds of Codex review done (all APPROVE WITH
CHANGES, 25 findings incorporated). Ready for maintainer review before
implementation. The "never auto-publish" safety invariant was re-traced
end-to-end in round 5 and confirmed clean (9 gates between a captured run
and a published case, only the last of which is human).

> **Scope note (V1).** This design ships the loop for the **Claude runtime
> path** (`agentRuntime/engines/claude/`), which is the production
> orchestrator today. The OpenAI / OpenCode / Pi runtimes are out of scope
> for V1 capture and prompt-inject; they will be wired in a follow-up once
> the runtime-agnostic integration boundary (§6.4) is validated on Claude.
> All storage, validation, retrieval, and promotion machinery is
> runtime-agnostic by construction — only the two thin integration seams
> (capture call site, prompt segment) are Claude-specific in V1.

## Context

A recurring question from sharings and users: *does the system get better the
more it runs?* Specifically, can finished analysis runs be turned into reusable
case knowledge so the next run consults the case library first?

Two systems already exist side by side in SmartPerfetto:

1. **Case Knowledge Platform V1** (`docs/superpowers/specs/2026-06-20-case-knowledge-platform-design.md`)
   — **V1 ingest slice landed** (commit `5f09399d`): the design doc's status
   line still reads "implementation not started" but the code exists —
   `caseIngester.ts`, `caseSchemaValidator.ts`, `caseDomainPacks.ts`,
   `caseMarkdownParser.ts`, the `validate:cases` / `ingest:cases` CLI
   commands, the `CaseKnowledgeExtension` envelope on `CaseNode.knowledge`,
   and two curated example cases under `backend/knowledge/cases/scrolling/`.
   Human-authored Markdown cases → validated → ingested into `CaseLibrary` +
   `CaseGraph` + `RagStore(kind=case_library)`. The `quality` union already
   contains `'curated' | 'imported' | 'weak'`, but **only the curated path
   exists**. Retrieval, evidence-signature matching, and
   `cite_case_in_report` are explicitly **deferred to V1.1/V2** in that
   design. The HTML report renderer for `conclusionContract.caseRecommendations`
   is built and dormant — nothing populates it.

2. **Self-Improving System L1–L4** (`docs/architecture/self-improving-design.md`)
   — landed. Runtime learning over the **skill/strategy/pattern** layer:
   `analysisPatternMemory` (weighted-Jaccard fingerprint bucket store),
   SQLite review-job outbox, background Claude review agent writing
   `.notes.json` skill sidecars, supersede state machine for strategy patches.
   It does **not** write into `CaseLibrary` / `CaseGraph` / `RagStore`. Its
   learning artifacts are short-lived insights (tag fingerprints), not
   durable, reviewable, citable case records.

This design closes the gap: **a feedback-driven loop that turns successful
finished runs into candidate cases, promotes the good ones through the existing
`publishCase()` gate, and makes the resulting cases surface in both the agent
prompt and the report.** It deliberately reuses the storage, validation, and
publish machinery the V1 ingest slice already built, and it mirrors the
risk-layered, shadow-first, regression-gated pattern the self-improving system
proved safe.

### What already exists (reused, not rebuilt)

| Sub-problem | Existing code this design reuses |
|---|---|
| Curated case store + double-control publish gate | `CaseLibrary` (`caseLibrary.ts:109` `saveCase` rejects `published`; `:192` `publishCase` requires `redactionState='redacted'` + reviewer) |
| Typed knowledge envelope | `CaseKnowledgeExtension` on `CaseNode.knowledge` (`caseKnowledge.ts:106`, `sparkContracts.ts:1826`) |
| Case relations | `CaseGraph` 6 named relations (`caseGraph.ts`) |
| Case RAG chunks | `RagStore` `kind=case_library` + `registryOrigin='plan54_cases'` |
| Schema + domain-pack validation | `caseSchemaValidator.ts`, `caseDomainPacks.ts` (`scrolling.v1`) |
| Tag-overlap case recall | `recall_similar_case` MCP tool (`claudeMcpServer.ts:3910`) |
| Report render of case recommendations | `htmlReportGenerator.ts:4928` (dormant, consumer-ready) |
| `conclusionContract.caseRecommendations` slot | `conclusionContract.ts:91` (typed, empty) |
| Generic tenant-scoped storage with `embedding_ref` column | `scopedKnowledgeStore.ts` `upsertScopedKnowledgeRecord` → `memory_entries` table |
| SQLite outbox + atomic lease + dedupe + migrations | `selfImprove/reviewOutbox.ts` (`data/self_improve/self_improve.db`) |
| Background review agent + content scanner + skill-notes writer | `selfImprove/reviewWorker.ts`, `reviewAgentSdk.ts`, `contentScanner.ts`, `skillNotesWriter.ts` |
| Pattern state machine + feedback time windows | `selfImprove/feedbackPipeline.ts`, `analysisPatternMemory.ts` |
| Worktree-isolated patch + regression gate + PR creation | `selfImprove/worktreeRunner.ts`, `proposeStrategyPatch.ts` |
| Post-run save hook | `claudeRuntime.ts:2045` (`saveAnalysisPattern`) — template for `saveCaseFromRun` |
| Post-run conclusion-contract derivation | `agentRoutes.ts:3954` → `agentResultNormalizer.ts:451` |
| Failure-mode hash taxonomy (shared key) | `selfImprove/failureTaxonomy.ts` |

### Gap this design fills

There is **no path today** from a finished analysis run to a candidate case,
and **no path** from candidate cases back into the agent prompt or the report.
The `quality: 'imported' | 'weak'` tiers are typed ahead of their producers.
The "what already exists" table above is mostly the *infrastructure* for
self-evolution; this design specifies the *loop* that wires it together.

## Goals

1. **Learn from runs.** A successful, verified, high-confidence finished run can
   become a **candidate case** (`quality: 'imported'`) without any human action.
2. **Never auto-publish.** A learned case becomes strong report guidance only
   through the existing `publishCase()` gate (reviewer + `redactionState`).
   Auto-promotion `weak → curated` is an explicit Non-Goal, matching the V1
   case-knowledge design.
3. **Close the loop in both directions.** Retrieved cases reach the agent
   prompt (Tier-4 segment, like `patternContext`) **and** the report
   (`conclusionContract.caseRecommendations`, the already-built renderer).
4. **Reuse every storage and validation primitive V1 built.** No new durable
   store for cases; the candidate case is a `CaseNode` with
   `quality: 'imported'`, sourced from a run, validated by the same schema
   and domain-pack gates, and ingested by the same writer.
5. **Mirror the self-improving system's safety posture.** Default-off feature
   flags, shadow mode first, content scanning, regression gates, reviewer
   signoff, no LLM direct file writes, no LLM YAML writes.
6. **Stay within the AI Output Contract.** Case recommendations enter the
   report as typed `caseRecommendations`, never as smuggled free text. The
   deterministic verifier re-checks cited case ids and required evidence
   signatures.

## Non-Goals For V1

- No vector / embedding retrieval. V1 keeps keyword + structured-signature
  retrieval (matches the V1 case-knowledge design's non-goal).
- No automatic `weak → curated` promotion. A learned case can rise to
  `reviewed` by accumulating supporting feedback, but `published` always
  requires human `publishCase()`.
- No new domain packs. V1 ships only the `scrolling.v1` candidate path (same
  as the case-knowledge V1).
- No LLM that writes Markdown case files directly to
  `backend/knowledge/cases/`. The curated Markdown directory stays
  human-authored and version-controlled; learned cases live in the runtime
  `CaseLibrary` as `quality: 'imported'` until a maintainer explicitly
  promotes a chosen one to Markdown via a CLI (see §9).
- No cross-tenant / cross-workspace case sharing beyond what
  `scopedKnowledgeStore` already provides.
- No bulk historical-report import (same non-goal as case-knowledge V1).
- No UI for editing candidate cases (same non-goal).
- No change to the curated-Markdown `ingest:cases` path. It remains the
  authoritative full-rederive path; this design adds a **second, separate**
  writer for runtime-learned cases with its own provenance, exactly as the
  case-knowledge design's §4.1 ("Runtime Storage Mapping") anticipated.

## Architecture

The loop has five stages. Each maps onto an existing subsystem.

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │  STAGE 1 — CAPTURE (run-time, fire-and-forget, after analyze())       │
 │  claudeRuntime.analyze() success path                                 │
 │    └─▶ buildCaseCandidateFromRun(result, session)                     │
 │          • domain pack projects batch_frame_root_cause into clusters   │
 │          • one CaseCandidate per qualifying cluster                    │
 │          • stamped with provenance (runId, turnIndex, traceContentHash)│
 │    └─▶ CaseCandidateOutbox.enqueue (SQLite, atomic)                   │
 │        (mirrors selfImprove/reviewOutbox.ts)                          │
 └───────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │  STAGE 2 — REVIEW (background worker, independent Claude SDK)         │
 │  caseEvolutionWorker.ts (concurrency=1, daily budget, cooldown)       │
 │    └─▶ reviewAgentSdk.caseCandidateReview(candidate)                  │
 │          • independent session, no Write/MCP file tools               │
 │          • strict JSON output: CaseCandidateReview                    │
 │    └─▶ contentScanner.scan(review) — 6 threat classes                 │
 │    └─▶ domain-pack schema re-validation of LLM-proposed fields        │
 │    └─▶ write CandidateCaseNote sidecar (logs/case_candidates/*.json)  │
 │        (shadow mode: write-only, never ingested until flag on)        │
 └───────────────────────────┬───────────────────────────────────────────┘
                             │  (when CASE_EVOLUTION_INGEST_ENABLED=1)
                             ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │  STAGE 3 — INGEST AS IMPORTED CASE (reuses V1 ingester writer shape)  │
 │  caseCandidateIngester.ts                                             │
 │    └─▶ build CaseNode{ quality:'imported', status:'draft',            │
 │          source:'runtime_analysis_candidate', knowledge: extension,   │
 │          redactionState:'redacted' via run-level anonymizer }         │
 │    └─▶ CaseLibrary.saveCase (draft — never publishCase from here)     │
 │    └─▶ CaseGraph edges derived from candidate relations               │
 │    └─▶ RagStore chunk (kind=case_library, registryOrigin='plan54_cases',│
 │          uri='case://learned/<id>')  ← distinct uri prefix, same union  │
 │    └─▶ Crash-convergence: rederive = upsert + demote-to-private (§3.5.1)│
 └───────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │  STAGE 4 — RETRIEVE (run-time, pre-run, structured + keyword)         │
 │  caseRecommendationRetriever.ts                                       │
 │    └─▶ CaseRecommendationQuery ← derived conclusionContract clusters  │
 │          (scene, domainPack, rootCause, responsibility, audiences,    │
 │           evidenceSignatures from DataEnvelope projection)            │
 │    └─▶ two-stage filter:                                              │
 │          (a) structured: scene/domainPack/rootCause/audience/status   │
 │          (b) evidence-signature gate → strong / partial / background  │
 │          (c) keyword ranking over RagStore case_library chunks        │
 │    └─▶ published > reviewed > draft(imported) tie-break               │
 └───────────────────────────┬───────────────────────────────────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
 ┌─────────────────────────┐   ┌─────────────────────────────────────────┐
 │  STAGE 5a — REPORT      │   │  STAGE 5b — PROMPT INJECT               │
 │  (post-run, route layer)│   │  (pre-run, prepareAnalysisContext)      │
 │  attachCaseHitsToContract│   │  caseBackgroundContext = top-K          │
 │    + verifyAndPrune     │   │  (background-only pre-run; strong via   │
 │  → conclusionContract   │   │   recall_similar_case mid-run)          │
 │    .caseRecommendations │   │  Tier-4 segment 'case_background_       │
 │  → htmlReportGenerator  │   │   context', droppable, token-budgeted   │
 │    renders (already     │   │                                         │
 │    built, dormant)      │   │                                         │
 └─────────────────────────┘   └─────────────────────────────────────────┘

 ┌───────────────────────────────────────────────────────────────────────┐
 │  FEEDBACK (cross-cutting, drives candidate state machine)             │
 │  POST /api/agent/v1/:sessionId/feedback                               │
 │    └─▶ applyFeedbackToCandidate(caseCandidateId, rating, metadata)    │
 │          • positive → supportingEvidence++ (toward reviewed)          │
 │          • negative → contradictionCount++ (toward rejected)          │
 │          • time windows reuse self-improving semantics                │
 └───────────────────────────────────────────────────────────────────────┘

 ┌───────────────────────────────────────────────────────────────────────┐
 │  PROMOTION (human-in-the-loop, the only path to published/curated)    │
 │  npm run case-evolution:promote -- <candidateId> [--to-markdown]      │
 │    └─▶ draft → reviewed (after supportingEvidence threshold)          │
 │    └─▶ reviewed → published only via CaseLibrary.publishCase()        │
 │    └─▶ --to-markdown: render reviewed candidate to                    │
 │        backend/knowledge/cases/<scene>/<id>.md for human PR           │
 └───────────────────────────────────────────────────────────────────────┘
```

## 1. Stage 1 — Capture

### 1.1 Trigger site (post-verification, route layer)

**Capture happens in the route layer, NOT in `claudeRuntime.analyze()`.**

The route layer at `agentRoutes.ts:3947-3964` is the only place where all
four required artifacts already exist on a single code path:

1. `result` — the `AnalysisResult` with `confidence`, `findings`,
   `conclusionContract`.
2. `normalizedConclusionContract` — the evidence-backed contract derived at
   `:3954` (`deriveEvidenceBackedConclusionContractForNarrative`), whose
   claims are matched against `session.dataEnvelopes`.
3. `result.claimVerificationResult` — populated by `ensureAnalysisQualityArtifacts`
   at `:3964`, which runs `runClaimVerification`
   (`services/verifier/claimVerificationRunner.ts:104`). This is the
   deterministic verifier output.
4. `session.dataEnvelopes` — the captured SQL/Artifact rows the scrolling pack
   reads (`batch_frame_root_cause` distribution etc.).

`claudeRuntime.ts:2045` is the pattern-save site, but it runs **before** the
route derives the evidence-backed contract and runs the verifier — so it
cannot gate on verification. The new `saveCaseCandidates` fire-and-forget
call is inserted immediately after `:3964`:

```ts
// agentRoutes.ts, inside `if (result.success || result.partial === true)`
if (normalizedConclusionContract) {
  result.conclusionContract = normalizedConclusionContract;
}
ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);

// NEW — fire-and-forget, never throws into the route. All inputs here are
// already in scope at this site: result, normalizedConclusionContract,
// session.dataEnvelopes, the run-scoped traceId/runId. architectureType
// and traceContentHash are derived (not read off the session object, which
// does not carry them) by the same helpers the pattern-memory path uses.
void saveCaseCandidates({
  result,
  conclusionContract: normalizedConclusionContract,
  claimVerificationResult: result.claimVerificationResult,
  dataEnvelopes: session.dataEnvelopes,
  sceneType: result.smartScenePreview?.sceneType ?? classifyScene(query),
  architectureType: resolveArchitectureTypeForSession(session),  // helper
  provenance: {
    sessionId,
    runId: runIdForAnalysis,
    turnIndex: session.turnIndex ?? 0,
    traceContentHash: computeTraceContentHash(session.traceId),  // sha256 of trace bytes; cached
  },
}).catch(err => logger.warn('CaseEvolution', 'capture failed', {err}));
```

`resolveArchitectureTypeForSession` and `computeTraceContentHash` are small
helpers in `caseEvolution/` that reuse the same resolution the
pattern-memory path (`analysisPatternMemory.extractTraceFeatures`) already
does — neither invents a new source of truth. A capture failure is logged
and swallowed — the user's analysis result is already committed at this
point and must not be affected.

**Persistence note (round-4 fix).** `SessionStateSnapshot`
(`sessionStateSnapshot.ts`) persists `dataEnvelopes` but **not**
`conclusionContract` or `caseRecommendations`. The capture therefore reads
`conclusionContract` / `claimVerificationResult` from the live `result`
object in route scope (always present at the capture site), and
`dataEnvelopes` from `session.dataEnvelopes` (also live). It does **not**
rely on `_lastSnapshot` for these fields — `_lastSnapshot` is only a
fallback for `dataEnvelopes` on resume/reconnect. `caseRecommendations`
persist through `result.conclusionContract` (turn context + the
analysis-result snapshot at `analysisResultSnapshotPipeline.ts:445`, which
*does* persist `conclusionContract`). So a learned case's recommendations
survive across turns and process restarts via the analysis-result snapshot,
while the capture's *inputs* are always read live at the route site. V1
adds a resume/reconnect test to the verification plan (§10.2) asserting a
captured candidate is still producible after a simulated reconnect.

### 1.2 Qualification gate (do not capture every run)

A run qualifies for capture only when **all** hold (all checkable at the
route-layer site above):

1. `result.confidence >= CONFIDENCE_HIGH_THRESHOLD` (constant, default
   **0.8**). `AnalysisResult.confidence` is a `number` (`orchestratorTypes.ts:230`),
   not a bucketed string; the threshold is the capture-layer's own
   normalization and is exposed as `verification.confidenceBucket='high'`.
2. `result.claimVerificationResult?.status === 'passed'` AND
   `result.claimVerificationResult.issues.filter(i => i.severity === 'error').length === 0`.
   (`'warning'` issues are allowed — a candidate may still be captured with
   a caveat note.) The verifier status is the authoritative gate; this is
   why capture must happen post-`ensureAnalysisQualityArtifacts`. If
   `claimVerificationResult` is absent (older path), the run does **not**
   qualify — fail closed.
3. The run used the **full** path (not `analyzeQuick`), so a real artifact +
   representative-frame chain exists. Quick-path runs never produce
   candidates. (`result.rounds > 1` is a proxy; the runtime also sets a
   `complexity` field that distinguishes quick from full.)
4. At least one problem cluster meets the domain-pack's "promotable" rule
   (see §3.2) — e.g. for `scrolling.v1`, frame_count ≥ 3 and percentage ≥ 15%,
   mirroring `scrolling.strategy.md:88`.
5. The same `traceContentHash + sceneType + primaryRootCause` is not already
   represented by a `published` case (de-dupe at capture time against
   `CaseLibrary` + the candidate outbox's active rows). This prevents the
   same recurring trace from flooding the outbox.

A run that fails the gate is a no-op. Capturing nothing is always safe.

### 1.3 `CaseCandidate` payload (enqueued, not yet a CaseNode)

All field types below are verified against the real codebase
(`claimVerification.ts:7`, `orchestratorTypes.ts:217`, `dataContract.ts:429`,
`sparkContracts.ts:1365/1769`).

```ts
// backend/src/types/caseEvolution.ts (NEW)
export interface CaseCandidate {
  candidateId: string;                 // sha256(traceContentHash + sceneType + primaryRootCause + runId)
  schemaVersion: 'case_candidate@1';

  // Provenance — same shape as self-improving Provenance so the two systems
  // share an audit vocabulary.
  provenance: {
    sourceSessionId: string;
    sourceAnalysisRunId: string;
    sourceTurnIndex: number;
    traceContentHash: string;
    capturedAt: number;
    engine: string;                    // claude | openai | opencode | pi
    sceneType: string;
    architectureType: string;
  };

  // Cluster projection — exactly the scrolling.v1 cluster shape from the
  // case-knowledge design §"V1 Domain Pack". The domain pack owns this
  // projection; the capture layer is domain-agnostic.
  cluster: {
    scene: string;
    domainPack: string;               // e.g. 'scrolling.v1'
    rootCause: string;                // from batch_frame_root_cause.reason_code
    responsibility: 'app' | 'oem' | 'mixed' | 'unknown';
    severity: 'critical' | 'warning' | 'info';
    frameCount: number;
    percentage: number;
    representativeFrame?: {
      frameId: string;
      durMs: number;
      vsyncMissed: number;
    };
    evidenceSignatures: Record<string, unknown>;
      // e.g. { reason_code: 'shader_compile', render_slices: ['makePipeline'] }
  };

  // Evidence handle — the capture never copies trace bytes; it stores
  // resolvable references. DataEnvelope has no `id` field, so we use the
  // existing `meta.evidenceRefId` derivation pattern from
  // analysisResultSnapshotPipeline.ts:110 (`dataEnvelopeRefId(env)` =
  // `meta.evidenceRefId ?? data:${source}:${stepId}:${contentHash}`). This
  // is the same key the snapshot pipeline already produces, so the review
  // worker can re-resolve envelopes from the analysis snapshot by ref id.
  evidenceHandle: {
    analysisRunId: string;
    clusterIndex: number;
    evidenceRefIds: string[];          // dataEnvelopeRefId() values backing this cluster
    snapshotPath: string;              // path to the SessionStateSnapshot JSON
  };

  // Verifier context — fields aligned to the REAL ClaimVerificationResult
  // (claimVerification.ts:7) and AnalysisResult.confidence (a number).
  verification: {
    claimSupportSummary: string;       // derived from claimSupport
    verifierStatus: ClaimVerificationResult['status'];
      // 'passed' | 'failed' | 'partial' | 'not_checked' — the real union
    verifierIssueSeverities: Array<'error' | 'warning'>;
      // counts only; full issues already live in the snapshot
    verifierErrorCount: number;        // issues.filter(i => i.severity === 'error').length
    verifierWarningCount: number;
    confidenceNumeric: number;         // AnalysisResult.confidence is a number
    confidenceBucket: 'high' | 'medium' | 'low';
      // derived: high >= 0.8, medium >= 0.5, else low. The threshold is the
      // capture-layer's own normalization — AnalysisResult.confidence has no
      // documented bucket scale, so we define one here and expose both forms.
  };
}
```

The qualification gate (§1.2) uses `verification.verifierStatus === 'passed'
&& verification.verifierErrorCount === 0` and
`verification.confidenceBucket === 'high'` (i.e.
`verification.confidenceNumeric >= 0.8`). The thresholds are constants in
`caseEvolution.ts`, not magic numbers inline.

### 1.4 Outbox (SQLite, isolated DB)

New DB: `backend/data/self_improve/case_evolution.db` — **deliberately the
same directory** as `self_improve.db` and `supersede.db`, so all background
self-improvement lives in one place and a corrupt candidate DB cannot take the
analysis path down. Schema mirrors `reviewOutbox.ts:86` and uses the same
versioned-migration discipline (`schema_migrations` table, applied in a
transaction; never raw `CREATE TABLE IF NOT EXISTS` for evolution).

**Single source of truth for "supported" (round-2 fix).** Round-2 review
flagged that having both `state='supported'` and a generated `supported`
column creates two truths. V1 resolves this by making **`supported` a derived
column only** — `state` is the lifecycle enum, `supported` is the fast-filter
boolean. They never disagree because `supported` is `GENERATED ALWAYS AS`.
The state enum below matches the §7.2 machine exactly:
`pending_review → reviewed → (rejected | archived)`. `supported` is not a
state — it is a property of `reviewed`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;             -- required for the FK below

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE case_candidates (
  candidate_id TEXT PRIMARY KEY,
  -- Lifecycle enum — exactly the states in §7.2. `supported` is NOT a state.
  state TEXT NOT NULL CHECK(state IN (
    'pending_review','reviewed','rejected','archived'
  )) DEFAULT 'pending_review',
  dedupe_key TEXT NOT NULL,           -- traceContentHash::sceneType::primaryRootCause
  priority INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Feedback-driven counters (§7.2).
  supporting_evidence INTEGER NOT NULL DEFAULT 0,
  contradicting_evidence INTEGER NOT NULL DEFAULT 0,
  maintainer_promoted INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  -- Derived boolean. Single source of truth for "is this candidate supported".
  -- A candidate is only eligible for publishCase() when supported=1 AND
  -- state='reviewed'. SQLite 3.31+ supports STORED generated columns;
  -- better-sqlite3 ^12 ships SQLite 3.53+, so this is safe.
  supported INTEGER GENERATED ALWAYS AS
    (CASE WHEN (maintainer_promoted = 1 OR supporting_evidence >= 3)
              AND state = 'reviewed'
          THEN 1 ELSE 0 END) STORED,
  -- Soft pointer to the runtime CaseNode once ingested (§3.3). NULL until
  -- the worker's review is ingested. NOTE: this can go stale after
  -- `rederiveLearnedCandidates` rebuilds CaseLibrary (CaseLibrary is not
  -- relational). Feedback resolution MUST fall back to candidate_id and
  -- re-resolve via CaseLibrary.listCases filtered by
  -- knowledge.context['caseEvolution.v1'].candidateId when learned_case_id
  -- no longer resolves. (See §7.2 stale-pointer recovery.)
  learned_case_id TEXT,               -- 'learned:<...>' once ingested
  payload_json TEXT NOT NULL,         -- CaseCandidate
  review_json TEXT,                   -- CaseCandidateReview (filled by worker)
  note_path TEXT,                     -- logs/case_candidates/<id>.json sidecar
  last_error TEXT
);
CREATE INDEX idx_candidates_state_priority
  ON case_candidates(state, priority DESC, created_at);
CREATE INDEX idx_candidates_supported
  ON case_candidates(supported) WHERE supported = 1;
-- Active = pending_review (not yet reviewed) OR reviewed (ingested, may
-- still accumulate feedback). rejected/archived are de-duped against so a
-- re-capture of the same trace does not re-enqueue.
CREATE UNIQUE INDEX idx_candidates_dedupe_active
  ON case_candidates(dedupe_key)
  WHERE state IN ('pending_review','reviewed');

-- Candidate feedback — one row per received rating, with dedup on
-- (candidate_id, source_session_id) so a single session cannot flood.
-- ON DELETE CASCADE: if a candidate is hard-purged (admin op only), its
-- feedback goes with it. Normal lifecycle does NOT delete candidates —
-- rejected ones stay for audit.
CREATE TABLE candidate_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,    -- the session that produced the feedback
  source_analysis_run_id TEXT,        -- optional, for audit
  rating TEXT NOT NULL CHECK(rating IN ('positive','negative')),
  received_at INTEGER NOT NULL,
  received_within_seconds INTEGER,    -- seconds after the candidate was first surfaced
  within_time_window TEXT NOT NULL CHECK(within_time_window IN (
    'mis_tap','short','long','audit_only'
  )),                                -- <10s / 10s-24h / >24h / maintainer
  metadata_json TEXT,
  FOREIGN KEY (candidate_id) REFERENCES case_candidates(candidate_id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_feedback_dedupe
  ON candidate_feedback(candidate_id, source_session_id);
CREATE INDEX idx_feedback_candidate ON candidate_feedback(candidate_id);
```

**Migrations.** V1 ships as migration version 1 (create both tables). The
generated `supported` column is part of the initial schema, so no later
table-rebuild is needed to add it. Future schema changes bump the version
and apply additively; any change to the `supported` expression would require
a table rebuild (SQLite limitation) and must be its own migration with a
backfill. `PRAGMA foreign_keys=ON` is set at every connection open, matching
the existing outbox contract.

The `enqueue` is wrapped in a transaction; a duplicate `dedupe_key` in an
active state is a silent no-op (returns existing candidate id). A failure to
enqueue **must not** block the analysis — same contract as the
self-improving outbox.

## 2. Stage 2 — Review (background worker)

### 2.1 Trust boundary (mirrors self-improving §9)

The review worker is a **separate Claude SDK query**, not a runtime extension:

- Independent session id (never resumes the main session).
- Never writes `claude_session_map.json`.
- No `Write` tool, no MCP file-system tools.
- 90s wall timeout, 8 turn upper bound.
- Default model: `CLAUDE_LIGHT_MODEL` (haiku class).
- The worker's **only** output is a strict-JSON `CaseCandidateReview`. The
  backend does schema validation, domain-pack re-validation, content
  scanning, and atomic write — the LLM never touches a file.

### 2.2 Worker contract

```ts
// backend/src/types/caseEvolution.ts
export interface CaseCandidateReview {
  schemaVersion: 'case_candidate_review@1';
  candidateId: string;

  // LLM judgment — always re-validated against the domain pack.
  decision: 'promote' | 'reject' | 'needs_more_evidence';
  confidence: 'high' | 'medium' | 'low';

  // Structured fields the candidate will carry forward. The worker
  // PROPOSES these; the domain-pack validator ACCEPTS or REJECTS them.
  proposed: {
    title: string;                    // concise, no PII
    primaryRootCause: string;         // must be in scrolling.v1 reason_code vocab
    secondaryRootCauses: string[];
    responsibility: 'app' | 'oem' | 'mixed' | 'unknown';
    severity: 'critical' | 'warning' | 'info';

    // Evidence signatures — REQUIRED set must be non-empty and every field
    // must exist in the pack. The re-validator enforces this exactly like
    // caseSchemaValidator.ts does for Markdown cases.
    evidenceSignatures: {
      required: CaseEvidenceSignature[];
      supportive: CaseEvidenceSignature[];
    };

    findings: CaseKnowledgeFinding[];
    recommendations: {
      app: CaseKnowledgeRecommendation[];
      oem: CaseKnowledgeRecommendation[];
    };

    // The reviewer MUST NOT invent relation targets; it may only propose
    // `similar_root_cause` / `derived_pattern` edges to EXISTING published
    // or reviewed case ids it can cite. The backend verifies each target.
    relations: CaseKnowledgeRelations;
  };

  evidenceSummary: string;            // human-readable audit text
  risks: string[];                    // what could make this case misleading
}
```

### 2.3 Worker resource limits (mirrors self-improving §10)

| Limit | Default | Env override |
|---|---|---|
| Concurrency | 1 | `CASE_EVOLUTION_WORKER_CONCURRENCY` (cap 2) |
| Queue length | 100 | `CASE_EVOLUTION_QUEUE_MAX` |
| Per-candidate cooldown | 5 min | `CASE_EVOLUTION_CANDIDATE_COOLDOWN_MS` |
| Daily candidate budget | 50 | `CASE_EVOLUTION_DAILY_BUDGET` |
| Lease duration | 5 min | `CASE_EVOLUTION_LEASE_MS` |
| Max attempts | 3 | `CASE_EVOLUTION_MAX_ATTEMPTS` |
| Poll interval | 60s | `CASE_EVOLUTION_POLL_INTERVAL_MS` |

The daily budget is lower than the pattern-review budget because candidate
reviews carry more structured output and the downstream ingest has storage
cost. The poll interval is longer (60s vs 30s) because candidate capture is
lower-volume.

### 2.4 Re-validation (defense in depth)

After the worker returns, before any write:

1. JSON-schema validate `CaseCandidateReview`.
2. Re-run `caseDomainPacks.validateCaseDomainPack` on the proposed fields.
   The LLM is allowed to *propose* a `reason_code`, but it must land inside
   the pack's vocabulary — exactly the same gate a human-authored Markdown
   case passes.
3. Run `contentScanner.scan` (6 threat classes) over every free-text field
   (`title`, `evidenceSummary`, `risks`, `findings[].title`,
   `recommendations[].action`, `.applies_when`, `.risks`).
4. For each proposed relation target, confirm the target `caseId` exists in
   `CaseLibrary` with `status` in `published | reviewed`. Drop any unknown
   target with a warning; **never** trust an LLM-invented id.
5. Size cap: total review payload ≤ 16 KB (matches `skillNotesWriter`).

If any check fails, the candidate moves to `rejected` with `last_error`;
the worker does not retry on validation failure (only on infra failure).

### 2.5 Sidecar write (shadow mode)

When `CASE_EVOLUTION_NOTES_WRITE_ENABLED=1` (default off), the backend
writes the validated review as a sidecar:

```
backend/logs/case_candidates/<candidateId>.json
```

The sidecar is **not** ingested as a case yet. Shadow mode lets a maintainer
spot-check review quality, domain-pack classification, and recommendation
specificity before any learned case reaches the library. This is the exact
shadow-first posture the self-improving system shipped with.

## 3. Stage 3 — Ingest as imported case

### 3.1 When it fires

When `CASE_EVOLUTION_INGEST_ENABLED=1` **and** the review `decision` is
`promote` **and** re-validation passed, `caseCandidateIngester.ingest(candidate,
review)` builds and persists a `CaseNode` with `quality: 'imported'`,
`status: 'draft'`.

### 3.2 Domain-pack projection

The ingester is **domain-agnostic**. It asks the pack to project a candidate
into the `CaseKnowledgeExtension` envelope. For `scrolling.v1` this is the
projection already specified in the case-knowledge design §"V1 Domain Pack"
— read the existing `batch_frame_root_cause` distribution and the
representative-frame metadata the strategy already demands; **do not
re-cluster**.

```ts
// backend/src/services/caseEvolution/caseCandidateIngester.ts (NEW)
export interface CaseDomainProjection {
  buildExtension(candidate: CaseCandidate, review: CaseCandidateReview): {
    extension: CaseKnowledgeExtension;
    caseTitle: string;
    tags: string[];
    relations: CaseKnowledgeRelations;
    // CaseFindingLink[] — the real CaseNode.findings shape. The projection
    // converts review.proposed.findings (CaseKnowledgeFinding[]) into
    // CaseFindingLink by mapping: id→id, title→title, confidence→severity
    // (high→critical, medium→warning, low→info), evidence_refs→evidence
    // (as a SparkEvidenceRef). This conversion is the projection's job so
    // the kernel CaseNode stays domain-agnostic.
    findingLinks: CaseFindingLink[];
  };
  /** Pack-specific "is this cluster worth promoting?" rule. */
  isPromotable(cluster: CaseCandidate['cluster']): boolean;
}
```

The `scrolling.v1` projection implements `isPromotable` as
`frameCount >= 3 && percentage >= 15` — the same threshold the scroll
strategy already uses to decide a cluster needs a deep-dive.

The `CaseKnowledgeFinding → CaseFindingLink` conversion is defined once in
the projection (not in the kernel) because the severity mapping is a
domain judgement:

```ts
function findingToLink(f: CaseKnowledgeFinding): CaseFindingLink {
  return {
    id: f.id,
    title: f.title,
    severity:
      f.confidence === 'high'   ? 'critical' :
      f.confidence === 'medium' ? 'warning'  :
                                  'info',
    // evidence_refs are free-form strings from the review; wrap them in the
    // SparkEvidenceRef shape the CaseNode contract expects. The verifier
    // re-checks that these refs resolve against the run's DataEnvelopes.
    evidence: f.evidence_refs.length > 0
      ? {kind: 'data_envelope', refIds: f.evidence_refs}
      : undefined,
  };
}
```

(The exact `SparkEvidenceRef` shape is taken from `sparkContracts.ts` at
implementation time; the field names above are illustrative of the
conversion contract.)

### 3.3 CaseNode shape produced (conforms to the real type)

The actual `CaseNode` type (`sparkContracts.ts:1786`) `extends SparkProvenance`
(flattened `source` / `createdAt` / optional `unsupportedReason` / optional
`notes` — **not** a nested `provenance` object). It has **no `updatedAt`** and
**no top-level `quality`/`sourceFile`**; those live on the
`CaseKnowledgeExtension` envelope, where `sourceFile` is currently
**required** (`caseKnowledge.ts:107`). The learned-case shape therefore is:

```ts
import {makeSparkProvenance} from '../types/sparkContracts';

const learnedCaseId = `learned:${candidate.candidateId.slice(0, 16)}`;

// The extension carries sourceFile even though there is no Markdown file —
// we point it at the candidate sidecar in logs/ so the provenance chain is
// navigable. quality='imported' is the producer tag for runtime-learned.
const extension: CaseKnowledgeExtension = {
  ...projection.extension,                 // taxonomy, evidenceSignatures, recommendations, context, scene, domainPack
  sourceFile: `logs/case_candidates/${candidate.candidateId}.json`,
  body: review.evidenceSummary,            // human-readable audit text
  quality: 'imported',
};

const caseNode: CaseNode = {
  // SparkProvenance fields (flattened by makeSparkProvenance):
  ...makeSparkProvenance({
    source: 'runtime_analysis_candidate',   // distinct from GENERATED_CASE_SOURCE
    notes: `learned from run ${candidate.provenance.sourceAnalysisRunId}; candidate=${candidate.candidateId}`,
  }),
  // CaseNode own fields:
  caseId: learnedCaseId,
  title: review.proposed.title,
  status: 'draft',                          // never 'published' from this path
  redactionState: 'redacted',               // see §3.4 — anonymizer must have run
  tags: projection.tags,
  findings: projection.findingLinks,        // CaseFindingLink[] — conversion in §3.2
  knowledge: extension,                     // CaseKnowledgeExtension (carries quality, sourceFile, body)
  traceArtifactId: undefined,               // we deliberately do not pin the trace
  // curatedBy / curatedAt stay unset until publishCase()
};
```

A small helper `caseCandidateIngester.ts` owns this construction; no other
caller produces `source: 'runtime_analysis_candidate'`.

### 3.4 Redaction before ingest (resolves the publish-gate blocker)

The case-knowledge design called out the `redactionState` blocker: nothing
set it to `'redacted'`, so `publishCase()` could never succeed. For
Markdown-sourced cases the V1 ingester stamps it from the frontmatter
`curator:`. For **learned** cases there is no human curator at capture time,
so a different resolution is required:

**Run-level anonymizer.** Before the candidate becomes a `CaseNode`, a
deterministic anonymizer (`caseEvolution/caseAnonymizer.ts`, NEW) runs over
the candidate payload and strips/replaces:

- Package names → domain bucket (e.g. `com.tencent.mm` → `tencent`).
  Round-3 review flagged that the domain-bucket logic in
  `analysisPatternMemory.extractTraceFeatures` is **inline**, not a reusable
  exported function. V1 therefore **extracts** a small pure helper
  `bucketPackageDomain(packageName: string): string` into
  `caseEvolution/domainBucket.ts` and has `analysisPatternMemory` import it
  too — so the two systems share one definition rather than drifting. This
  is a tiny refactor of an inline expression, not a behavior change, and is
  covered by adding an `analysisPatternMemory` regression assertion that
  the extracted helper produces identical buckets.
- Device serials, MACs, advertising ids, user-account ids → removed.
- Filesystem paths under `/data/data/<pkg>/` → `<app_data_dir>`.
- Any free-text field containing an email, phone, or URL → flagged; the
  review is rejected (not auto-scrubbed — the LLM should not have copied
  such content).

The anonymizer is **pure and deterministic** (same input → same output) and
**fails closed**: on any unhandled structure it omits the field and emits a
warning rather than passing raw content through. Only after the anonymizer
returns a clean result does the ingester stamp
`redactionState: 'redacted'` with `provenance.source: 'runtime_analysis_candidate'`
and the `candidateId` as the curator-equivalent audit anchor.

This is the second option the case-knowledge design contemplated for the
`redactionState` blocker ("extend the gate to accept a
`runtime_analysis_candidate` provenance class"), but it is implemented
narrowly: the **gate itself is unchanged**. We satisfy the gate by genuinely
producing `redactionState: 'redacted'` via the anonymizer, not by special-casing
the gate. `publishCase()` stays a single, auditable gate.

### 3.5 Reuses the V1 ingester's writer shape, not the V1 ingester itself

The V1 ingester (`caseIngester.ts`) is the **sole writer** for
Markdown-derived cases and does a full-rederive from the `cases/` directory.
Learned cases have a different source (the outbox), arrive incrementally, and
must coexist with curated cases without either side wiping the other.

The new `caseCandidateIngester` therefore:

- Writes through the **same** `CaseLibrary.saveCase`,
  `CaseGraph.addEdge`/`removeEdge`, and `RagStore.addChunk`/`removeChunk`
  primitives — but with **distinct provenance** (round-3 fix: use the real
  public APIs, not the V1 ingester's private `replaceGenerated*` helpers,
  which are file-local to `caseIngester.ts`):
  - CaseNode `source: 'runtime_analysis_candidate'` (vs
    `'curated_markdown_case'`). This is the field that lets
    `rederiveLearnedCandidates` find its own rows by in-memory scan (see
    below).
  - CaseGraph edge id prefix `case-learned-edge:` (vs `case-edge:`).
    `rederiveLearnedCandidates` enumerates `CaseGraph.listEdges()` and calls
    `removeEdge(edgeId)` for each id starting with the prefix.
  - RagStore chunk: `registryOrigin: 'plan54_cases'` (the **existing**
    closed-union member at `sparkContracts.ts:1415` — we do **not** add a
    new member in V1). `RagChunk` has no `source` field, so disambiguation
    is by **`uri` prefix**: learned chunks use `case://learned/<caseId>`
    vs curated `case://<caseId>`. `rederiveLearnedCandidates` uses the real
    `RagStore.listChunks({kind:'case_library', registryOrigin:'plan54_cases',
    uriPrefix:'case://learned/'})` (all three filters exist on
    `RagStoreListOptions`, `ragStore.ts:95`) and `removeChunk(chunkId)`.

### 3.5.1 Crash-safe rederive algorithm (round-3 fix)

Round-3 review correctly flagged that (a) "reviewed/supported rows" was
wrong (`supported` is a derived boolean, not a state), (b) a full
wipe-then-rebuild across three non-atomic stores loses all learned cases
on a mid-rederive crash, and (c) rejected/private audit cases must survive
rederive. The corrected algorithm:

```
rederiveLearnedCandidates():
  1. SNAPSHOT: from the outbox, read all candidates with state='reviewed'
     (the only state that has been ingested as a CaseNode). `supported`
     comes along as a column on each row. Rejected/archived rows are NOT
     rebuild sources — but see step 5 for their audit retention.
  2. BUILD off-line: construct the full set of (CaseNode, edges[], RagChunk)
     for every reviewed candidate into local arrays. No store mutation yet.
  3. For each store, do remove-then-add as a single logical pass, but
     order stores so a crash leaves the library *recoverable*, not empty:
       a. CaseGraph: list edges with prefix 'case-learned-edge:', remove
          each, then addEdge the new set. (Edges are an index; a missing
          edge degrades citation traversal but never loses a case.)
       b. RagStore: listChunks({uriPrefix:'case://learned/'}), removeChunk
          each, then addChunk the new set, then flush(). (Same — index.)
       c. CaseLibrary: THIS IS THE CRITICAL ONE. Do NOT wipe. Instead,
          for each reviewed candidate: CaseLibrary.saveCase(newNode). For
          each learned case id that is NOT in the reviewed snapshot (because
          the candidate was rejected since last rederive): move it to
          status='private' via saveCase, do NOT removeCase. This preserves
          the audit trail and matches §7.2's "rejected → private" rule.
  4. Convergence invariant: after rederive, the set of CaseNodes with
     source='runtime_analysis_candidate' AND status in {draft,reviewed}
     equals exactly the outbox's reviewed candidates. Private (rejected)
     nodes are allowed to exist outside this set — they are audit-only and
     the retriever's includeStatuses filter (default [published]) never
     surfaces them.
  5. Audit retention: rejected candidates' CaseNodes stay as 'private'
     across rederive runs. They are only removed by an explicit admin
     `case-evolution:purge-rejected --older-than <days>` (out of V1 scope).
```

The key difference from the V1 curated ingester's convergence: **the
curated ingester wipes by source because Markdown is the source of truth
and a re-run always rebuilds the same set. The learned ingester cannot
wipe, because the outbox is append-only with state transitions — a
rejected candidate must not vanish from audit just because rederive ran.**
So the learned rederive is *upsert + demote-to-private*, not *wipe + rebuild*.

This is exposed as `npm run case-evolution:rederive`. A half-written
rederive is always repairable by re-running, and a crash mid-rederive
leaves the library *partially updated but never emptied* — the worst case
is a stale draft that the next rederive corrects.

### 3.6 What about `CaseLibrary.saveCase` rejecting `published`?

Learned cases are saved with `status: 'draft'`, so they pass the
`saveCase()` gate (`caseLibrary.ts:111` only rejects `published`). The only
route to `published` is `publishCase()`, which learned cases reach only
through the human promotion CLI in §6. This is the single most important
safety invariant of the whole design and it costs zero new code in
`caseLibrary.ts`.

## 4. Stage 4 — Retrieval

This is the slice the case-knowledge design **explicitly deferred to V1.1**.
Self-evolution only pays off if retrieved cases reach the agent and the
report, so this design includes a V1 retriever.

### 4.1 Retriever service

```ts
// backend/src/services/caseEvolution/caseRecommendationRetriever.ts (NEW)
export interface CaseRecommendationQuery {
  scene: string;
  domainPack: string;
  rootCause: string;
  secondaryRootCauses?: string[];
  responsibility?: 'app' | 'oem' | 'mixed' | 'unknown';
  audiences: Array<'app' | 'oem'>;
  context?: Record<string, unknown>;
  evidenceSignatures: Record<string, unknown>;
  textQuery?: string;
  topK?: number;
  /** Default: only 'published'. Set to include 'reviewed'/'draft' for shadow observation. */
  includeStatuses?: Array<'published' | 'reviewed' | 'draft'>;
}

export interface CaseRecommendationHit {
  caseId: string;
  title: string;
  scene?: string;
  primaryRootCause?: string;
  matchStrength: 'strong' | 'partial' | 'background';
  matchedSignatures: string[];
  missingRequiredSignatures: string[];
  recommendations: {
    app: CaseKnowledgeRecommendation[];
    oem: CaseKnowledgeRecommendation[];
  };
  evidenceGap?: string;
}
```

(The shapes match `CaseKnowledgeReportRecommendation` already in
`caseKnowledge.ts:125` so the report renderer consumes them unchanged.)

### 4.2 Retrieval stages (real API shapes — round-3 fix)

**Stage A — structured filter (in-memory post-filter).**
`CaseLibrary.listCases(opts, scope)` (`caseLibrary.ts:158`) only accepts
`status`, `anyOfTags`, `educationalLevel` — it does **not** filter by
`knowledge.scene` / `domainPack` / `taxonomy.primaryRootCause`. The
retriever therefore:

1. Calls `listCases({status: each}, scope)` once per status in
   `query.includeStatuses` (default just `'published'`) and concatenates.
   This pushes the status filter into the store where it is supported.
2. Post-filters the result **in memory** on the `knowledge.*` fields:
   - `knowledge.scene === query.scene`
   - `knowledge.domainPack === query.domainPack`
   - `knowledge.taxonomy.primaryRootCause === query.rootCause`
     (or `query.secondaryRootCauses` contains it)
   - `knowledge.taxonomy.responsibility` compatible with `query.responsibility`
     (`'mixed'` compatible with both app and oem)

This is a documented V1 scaling decision, not an oversight: the curated +
learned corpus today is ~2 cases and will grow slowly (curated cases are
human-authored, learned cases pass a review gate). At <1000 cases the
in-memory filter is sub-millisecond. The case-knowledge design's own
"Future Extensions" names vector retrieval as the scaling step; we do not
pre-optimize.

**Stage B — evidence-signature gate.** This is the strong/partial/background
decision. For each surviving case, evaluate every signature in
`knowledge.evidenceSignatures.required` against `query.evidenceSignatures`
using the four operators (`eq`, `contains_any`, `gte`, `lte`):

- All `required` satisfied AND ≥ 1 `supportive` satisfied → **`strong`**.
- All `required` satisfied, no `supportive` → **`partial`**.
- Any `required` unsatisfied → **`background`** (cited as context with an
  `evidenceGap`, never as direct guidance).

**Strict signature evaluation rules (round-2 fix).** Signatures evaluate
against `Record<string, unknown>` evidence, so the helper defines strict,
fail-closed coercion:

| Operator | Required operand shape | Fail-closed behavior |
|---|---|---|
| `eq` | both sides scalars (string/number/boolean) | type mismatch → **unsatisfied**; deep-equal on scalars only |
| `contains_any` | `value` is `string[]`; evidence field is `string` or `string[]` (auto-flatten) | evidence missing/wrong type → **unsatisfied**; at least one token in both → satisfied |
| `gte` / `lte` | both sides **finite numbers** | either side NaN/Infinity/non-numeric → **unsatisfied**; numeric compare otherwise |

Missing evidence field (key absent from `query.evidenceSignatures`) is
**always** unsatisfied for every operator — it is not treated as "matches
anything". This is the conservative choice: an unknown evidence state can
never satisfy a required signature, so it can never produce a `strong` match.
The helper returns `{satisfied: boolean, reason: 'matched'|'missing'|'type_mismatch'|'non_numeric'}`
so the retriever can populate a precise `evidenceGap` and the verifier can
cross-check.

**Stage C — keyword ranking + tie-break (join, not push-down).**
`RagStore.search(query: string, opts)` (`ragStore.ts:325`) takes a **string**
query and returns hits over the whole `case_library` index — it cannot be
restricted to "only the cases that survived Stage A+B". The retriever
therefore **joins** rather than pushes down:

1. Run `search(query.textQuery ?? '', {kinds:['case_library'], topK: 50})`
   once to get a keyword-scored batch (topK 50 is generous; the join will
   discard most).
2. Build a `Map<caseId, keywordScore>` from the hits (the chunk `uri`
   `case://<caseId>` or `case://learned/<caseId>` carries the caseId).
3. Among the Stage A+B survivors, rank by `matchStrength` first, then by
   the joined keyword score, then by the tie-break chain:
   `published > reviewed > draft`, then `supported > not supported`
   (learned cases only), then `curated > imported > weak`.

So a curated published case always outranks a learned draft at equal
evidence strength — learned cases only surface when no curated case covers
the same evidence, and even then as `draft` (background) unless the
maintainer has reviewed them.

### 4.3 Why this is safe even with learned drafts in the library

Because of the status/quality tie-break, a `draft` `imported` case can only
appear in results when:

1. `includeStatuses` explicitly contains `'draft'` (off by default for the
   report path; on for the **prompt** path in shadow observation mode), AND
2. No `published`/`reviewed` case matched the same root cause + evidence
   signatures.

So learned cases never crowd out curated guidance; they only fill gaps the
curated library does not yet cover.

## 5. Stage 5a — Report integration (post-run)

### 5.1 Insertion point + ordering (round-3 fix)

`agentRoutes.ts:3953-3964` is the real derivation block:

```ts
const normalizedConclusionContract = deriveEvidenceBackedConclusionContractForNarrative(...);
if (normalizedConclusionContract) {
  result.conclusionContract = normalizedConclusionContract;
}
ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);
```

Round-3 review correctly flagged the original §5.1 ordering was
underspecified and risked a race with capture. The attach and the capture
are **two separate calls at two separate sub-sites**, ordered so the
verifier sees the attached hits:

```ts
const normalizedConclusionContract = deriveEvidenceBackedConclusionContractForNarrative(...);

if (normalizedConclusionContract) {
  // (5a) ATTACH retriever hits to the contract BEFORE the verifier runs.
  // Synchronous in-process call; retriever is a fast in-memory filter.
  const caseHits = attachCaseHitsToContractSync({
    conclusionContract: normalizedConclusionContract,
    dataEnvelopes: session.dataEnvelopes,
    sceneType: result.smartScenePreview?.sceneType,
    architectureType: resolveArchitectureTypeForSession(session),
    knowledgeScope,
  });
  if (caseHits.length > 0) {
    normalizedConclusionContract.caseRecommendations = caseHits;
  }
}
// (5b) Existing verifier — populates result.claimVerificationResult.
ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);

// (5c) NEW — prune + dedupe case hits (§7.1.1). Re-checks evidence
// signatures, drops background-strength cases mis-attached as strong,
// dedupes against narrative citations (§6.6). Returns a NEW contract.
if (normalizedConclusionContract?.caseRecommendations?.length) {
  const pruned = verifyAndPruneCaseRecommendations({...});
  normalizedConclusionContract = pruned.contract;
  // merge pruned.issues into result.claimVerificationResult for audit
}
if (normalizedConclusionContract) {
  result.conclusionContract = normalizedConclusionContract;
}

// (1) CAPTURE — fire-and-forget, AFTER the verifier + prune, so the
// qualification gate keys off the final claimVerificationResult.
void saveCaseCandidates({...}).catch(err => logger.warn(...));
```

(The full code with issue-merging is in §7.1.1; the above is the
condensed route view.) Two important properties of this ordering:

1. **Attach is before the verifier; prune is after.** The verifier
   populates `result.claimVerificationResult` (used by both the §1.2
   capture gate and as input context to the prune). The prune then
   re-checks evidence signatures and removes any hit that does not hold
   up, so the user never sees an unverified strong case citation. The
   pruned contract is what gets assigned, snapshotted, and rendered.
2. **Capture is after the verifier + prune.** This is the §1.1 invariant.
   The capture's qualification gate reads `result.claimVerificationResult`,
   which is populated by `ensureAnalysisQualityArtifacts`. Ordering capture
   last guarantees the gate has real verifier data.

`attachCaseHitsToContractSync` does:

1. Project the derived contract's claim clusters into a
   `CaseRecommendationQuery` (one query per major problem cluster, using the
   domain-pack projection from §3.2 in reverse).
2. Call the retriever (§4).
3. Map each `CaseRecommendationHit` to a `CaseKnowledgeReportRecommendation`
   (1:1 shape match — `caseKnowledge.ts:125`), filling `learnedProvenance`
   when the hit traces to a learned case.
4. Cap at 8 hits (matches the renderer's existing cap at
   `htmlReportGenerator.ts:4968`).

It is synchronous because the retriever is a pure in-memory operation over
a small corpus (Stage A post-filter, Stage B signature eval, Stage C join —
no I/O, no LLM). There is no latency concern.

### 5.2 The renderer is already built

`htmlReportGenerator.ts:4928` reads `caseRecommendations` /
`case_anchors` / `similar_cases`, renders strong matches as direct guidance
with `applies_when` + `risks`, and renders partial/background matches with an
explicit `evidence_gap` "Context only" label. **No frontend work is required
for V1.** This is the single biggest leverage point of the design: a
dormant, tested renderer is waiting for a producer.

### 5.3 Final-report contract gate

`scrolling.strategy.md`'s `final_report_contract` gains a
`case_recommendations` section gate (the case-knowledge design deferred this;
we include it because the retriever now exists). The gate enforces: *when a
strong case match existed for a problem cluster, the cluster's report section
must cite it*. This keeps the agent from silently ignoring a strong match.

## 6. Stage 5b — Prompt injection (split: pre-run + mid-run)

### 6.1 The pre-run vs evidence-gated distinction (round-1 fix)

Round-1 review correctly flagged that **strong/partial evidence-signature
matching cannot run pre-run**: the root-cause clusters and
DataEnvelope-derived evidence signatures are not known until the agent has
executed SQL and produced DataEnvelopes. A pre-run retriever query can only
match on `scene + architecture + surface trace features` (the same inputs
`analysisPatternMemory` uses), so any case it returns is, by definition, a
**background** match at that point — it has not been evidence-gated.

V1 therefore splits prompt injection into two distinct edges, with different
match-strength semantics, instead of pretending pre-run retrieval can produce
strong matches:

| Edge | When | Inputs available | Allowed `matchStrength` in prompt |
|---|---|---|---|
| **Pre-run recall** | `prepareAnalysisContext` (before SDK query) | scene, architecture, surface trace features | **`background` only** — labelled "可能相关的历史案例，需用本 trace 证据验证" |
| **Mid-run recall** (agent-driven) | agent calls `recall_similar_case` after it has DataEnvelopes | full evidence signatures the agent has gathered | retriever returns proper strong/partial/background |
| **Post-run attach** | route layer, after verifier | derived conclusion contract + verifier-checked evidence | strong/partial/background → `caseRecommendations` |

This is honest about what each edge can know. The pre-run edge is a *hint*;
the agent is explicitly told these cases are unverified and it must confirm
the evidence chain (or call `recall_similar_case` with real signatures). The
strong-guidance path is the post-run report attachment (§5), where the
verifier re-checks signatures.

### 6.2 Pre-run insertion point (background-only)

`claudeRuntime.ts:3046-3058` builds `patternContext` /
`negativePatternContext`. A new `caseBackgroundContext` is built next to it,
gated by `CASE_EVOLUTION_PROMPT_INJECT_ENABLED`. It is added as a Tier-4
segment in `backend/src/agentv3/claudeSystemPrompt.ts` immediately after the
`patternContext` block at `:659-665`, so it rides the same droppable-chain +
token-budget machinery.

The pre-run retriever query is **structural-only**: filter by `scene` +
`domainPack` + compatible `responsibility`, rank by `published > reviewed >
draft(curated) > draft(imported)`, take top-K (default K=3). It deliberately
does **not** compute evidence-signature strength — every returned case is
tagged `background` in the segment header.

```
## 可能相关的历史案例（case library — 待证据验证）

以下案例的 scene/architecture 与本 trace 相似，但尚未经过本 trace 证据验证。
分析时请用实际证据确认是否适用，不要直接作为结论依据。
- scroll_shader_compile_pixel8_001 — 滑动中 RenderThread shader 编译导致连续掉帧
  关键证据条件：RenderThread 出现 shader/makePipeline 编译且与掉帧帧窗口重叠
  如需确认匹配度，调用 recall_similar_case 并提供 reason_code / render_slices
- ...
```

### 6.3 Mid-run: `recall_similar_case` enhancement (the strong-match path)

The existing `recall_similar_case` MCP tool (`claudeMcpServer.ts:3910`) is
tag/key-only today, with a specific scoring + tie-break contract. V1
**enhances it** (does not add a new tool) with **optional** structured
inputs, preserving the existing contract when they are absent (round-3 fix):

```ts
// Enhanced tool input — ALL new fields are OPTIONAL. When omitted, the
// tool behaves exactly as today (tag/key scoring, published>reviewed tie-break,
// same return shape). Existing callers and tests are unaffected.
recall_similar_case({
  tags?,                    // existing
  app_id?, device_id?, cuj?, include_unpublished?, top_k?,  // existing
  scene?,                   // NEW optional
  evidence_signatures?,     // NEW optional: Record<string, unknown>
})
```

When `evidence_signatures` is provided, the tool delegates to the shared
retriever (§4) and returns `matchStrength` per hit. When it is absent, the
tool runs the existing tag/key path verbatim. This is the agent-driven
strong-match path: once the agent has run `scrolling_analysis` and has
`reason_code` / `render_slices` in hand, it calls
`recall_similar_case({scene, evidence_signatures:{...}, ...})` and gets
back strong/partial/background hits through the same two-stage matcher as
§4.2. The agent can then cite a strong case in its conclusion, which the
post-run verifier (§7.1) re-checks.

**Plumbing (round-3 fix).** The existing handler closure has
`getCaseLibrary()` and `knowledgeScope` in scope; the shared retriever is
constructed from those same objects, so wiring is a single import + call,
not a new dependency-injection path. The retriever module lives at
`backend/src/services/caseEvolution/caseRecommendationRetriever.ts` and
exports a factory `createCaseRetriever({library, ragStore, scope})` that
the MCP handler and the route-layer `attachCaseHitsToContractSync` both
call — one shared retriever, two call sites.

**Tool classification (round-4 fix).** `recall_similar_case` is `public`
today and stays `public`. Adding optional `evidence_signatures` does not
change the risk profile: the tool remains read-only, tenant-scoped (via
`knowledgeScope`), and never surfaces `draft`/`private` cases by default
(`include_unpublished` defaults to false and only lifts to `reviewed`, never
`draft`/`private`). Evidence signatures make results *more* precise, not
more exposing. The public-surface tests and the tool description are
updated to document the new optional inputs; no reclassification to
`internal` is needed. (If a future change let the tool surface `draft`
learned cases, that *would* warrant reclassification — but V1 does not.)

### 6.4 Prompt integration — concrete (round-4 fix)

Round-4 review correctly flagged that the prompt integration is not "free":
`ClaudeAnalysisContext` (`agentv3/types.ts:80`) has `patternContext` /
`negativePatternContext` but **no `caseBackgroundContext`**, and
`buildSystemPromptParts` has a concrete `dropOrder` array
(`claudeSystemPrompt.ts:694`) that must gain the new label. V1 specifies
the changes precisely:

1. **Add the field.** `ClaudeAnalysisContext` gains
   `caseBackgroundContext?: string` next to `patternContext` (`types.ts:102`).
   Optional, so existing callers and tests are unaffected.
2. **Build it in `prepareAnalysisContext`** (`claudeRuntime.ts:3046`), next
   to the `buildPatternContextSection` call. A new
   `buildCaseBackgroundContext(sceneType, archType, knowledgeScope)` helper
   returns the §6.2 segment string or `undefined` (gated by
   `CASE_EVOLUTION_PROMPT_INJECT_ENABLED`).
3. **Push the segment with a label.** In `buildSystemPromptParts`, after
   the `patternContext` push at `:660`:
   ```ts
   if (context.caseBackgroundContext) {
     push(4, 'case_background_context', context.caseBackgroundContext, true);
   }
   ```
4. **Add to `dropOrder`** at `:694`, positioned **after**
   `negative_pattern_context` and **before** `sql_error_pairs` — so when
   token budget is tight, case background is dropped after negative patterns
   (more critical for correctness) but before SQL error pairs (also
   droppable). The full order with the addition:
   `['knowledge_base','trace_completeness','pattern_context',
   'negative_pattern_context','case_background_context','sql_error_pairs',
   'sub_agents','plan_history']`.
5. **Token budget — dedicated, not reused.** Round-4 flagged that
   `SkillNotesBudget` is per-`invoke_skill` and keyed by skill id, so it
   cannot be reused for a prompt segment. V1 adds a small
   `PromptSegmentBudget` (or extends the existing prompt-token accounting)
   with a dedicated `caseBackgroundContext` sub-budget: default **600
   tokens** for the full path, **0** for quick path, **0** for correction
   retry, with silent drop + metric when over budget. This mirrors the
   discipline without forcing the skill-notes shape onto it.

### 6.5 Runtime-agnostic integration boundary (round-1 fix)

V1 ships the Claude integration only (scope note at top of doc). The
integration is deliberately kept to **two thin seams** so the
OpenAI/OpenCode/Pi runtimes can adopt it later without redesign:

1. **Capture seam** — `saveCaseCandidates(...)` is a plain async function
   that takes a serializable `CaseCandidateCaptureInput` (result fields +
   conclusion contract + verifier result + data envelopes + provenance). It
   has no dependency on the Claude runtime internals. Each runtime calls it
   from its own post-verification site.
2. **Prompt seam** — `buildCaseBackgroundContext(sceneType, archType,
   knowledgeScope)` returns a string segment. Each runtime's prompt builder
   calls it and concatenates the result. It has no dependency on Claude's
   `buildSystemPromptParts`.

Only these two functions plus the `recall_similar_case` tool enhancement
touch runtime code. Everything else (outbox, worker, ingester, retriever,
promotion) is runtime-agnostic and lives under
`backend/src/services/caseEvolution/`.

### 6.6 Why both prompt and report? (and the narrative-citation rule — round-4 fix)

- **Prompt injection (pre-run background + mid-run tool)** lets the agent
  *use* a prior case's reasoning during analysis. This is the "越跑越好"
  the question asked about: the next run literally starts with the library's
  accumulated knowledge available.
- **Report attachment** gives the *user* the typed, cited, evidence-gated
  recommendation in the deliverable.

Round-4 review flagged a contradiction: §6.3 lets the agent cite a strong
case in its free-text conclusion, but the AI Output Contract rule (AGENTS.md)
says "Keep chat readable without deleting report/snapshot provenance" and
the chat surface renders the narrative. V1 resolves this with an explicit
**narrative-citation rule**:

- The agent **may** reference a prior case in its narrative reasoning
  ("这与历史案例 scroll_shader_compile_pixel8_001 的证据模式一致"), because
  that is reasoning, not a deliverable recommendation.
- The agent **must not** copy a case's `recommendations` (the P0/P1 actions,
  `applies_when`, `risks`) into the narrative. Those belong in the typed
  `caseRecommendations` slot, which the chat fallback renderer ignores
  (`sse_event_handlers.ts` does not render `caseRecommendations`) and the
  HTML report renders fully. This keeps chat readable and the report
  authoritative, exactly as the AI Output Contract demands.
- The post-run dedupe (§7.1.1) removes a case from `caseRecommendations`
  if the agent already cited the same `caseId` in a way that would
  duplicate. So the worst case is a single clean narrative mention + a
  typed slot, never a doubled recommendation dump.

The strong-guidance guarantee lives in the report path; the prompt path is
explicitly a hint the agent must verify.

## 7. Cross-cutting: verifier, feedback, promotion

### 7.1 Verifier re-checks case citations (new plumbing — round-3 fix)

Round-3 review correctly flagged that the original §7.1 hand-waved
"shared helper" — the real `deterministicClaimVerifier.ts` consumes
`ClaimSupportV1` / `EvidenceAnchorV1`, not case evidence signatures, so
sharing is not free. V1 is explicit about the new plumbing:

A new **case-citation check pass** runs as a separate step inside
`ensureAnalysisQualityArtifacts` (or a sibling helper it calls), *after*
the existing `runClaimVerification`. It is **not** a change to
`runDeterministicClaimVerifier` itself — that function's contract stays
focused on claim-support anchors. The new pass:

```ts
// backend/src/services/caseEvolution/verifyCaseCitations.ts (NEW)
export interface CaseCitationCheckInput {
  caseRecommendations?: CaseKnowledgeReportRecommendation[];
  evidenceSignaturesByCluster: Record<string, Record<string, unknown>>;
  // ^ the same projection the retriever used, re-derived from DataEnvelopes
  library: CaseLibrary;
  scope?: KnowledgeScope;
}
export interface CaseCitationCheckResult {
  droppedHits: Array<{caseId: string; reason: string}>;
  issues: ClaimVerificationIssue[];   // severity: 'warning'
}
```

For each attached hit:

- The `caseId` exists in `CaseLibrary` (by `getCase`).
- The `matchStrength` it claims is consistent with the evidence signatures
  actually present in the run's DataEnvelopes — **re-run `evaluateSignature`**
  (the §4.2 helper, shared via a pure function import, not via the verifier's
  claim-support machinery). This is the actual sharing point: one pure
  `evaluateSignature` function, imported by both the retriever and this
  check. It is *not* shared with `runDeterministicClaimVerifier`, which is a
  different concern.
- A `background`-strength case must not appear in a `recommendation`-kind
  claim's `references` as if it were strong guidance.

A failed check emits a `ClaimVerificationIssue` at `warning` severity and
adds the hit to `droppedHits`; the route (§5.1) removes dropped hits from
`normalizedConclusionContract.caseRecommendations` before final assignment.
The run is not failed. This catches the case where the retriever and the
re-check disagree about evidence strength — the re-check always wins.

### 7.1.1 Concrete prune-and-assign path (round-4 fix)

Round-4 review correctly flagged that "the verifier drops hits" was
underspecified — `runClaimVerification` only consumes claim/evidence
contracts and does not mutate `caseRecommendations`. The route must call
the prune explicitly and assign the pruned contract. The corrected §5.1
flow:

```ts
if (normalizedConclusionContract) {
  // (5a) Attach retriever hits.
  const hits = attachCaseHitsToContractSync({...});
  if (hits.length > 0) normalizedConclusionContract.caseRecommendations = hits;

  // (5b) Run the existing verifier (populates result.claimVerificationResult).
  ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);

  // (5c) NEW — prune case hits that fail the §7.1 re-check, and dedupe
  // against narrative citations (§6.6). Returns a NEW contract object;
  // does not mutate in place beyond the caseRecommendations field.
  const pruned = verifyAndPruneCaseRecommendations({
    contract: normalizedConclusionContract,
    evidenceSignaturesByCluster: projectClustersFromDataEnvelopes(session.dataEnvelopes),
    narrative: result.conclusion,
    library: getCaseLibrary(),
    scope: knowledgeScope,
  });
  // issues flow into the verifier result for audit; the contract is replaced.
  normalizedConclusionContract = pruned.contract;
  if (pruned.issues.length > 0) {
    result.claimVerificationResult = {
      ...(result.claimVerificationResult ?? emptyVerifierResult()),
      issues: [...(result.claimVerificationResult?.issues ?? []), ...pruned.issues],
    };
  }

  result.conclusionContract = normalizedConclusionContract;
}
// (1) CAPTURE — after the verifier + prune, so the gate sees final state.
void saveCaseCandidates({...}).catch(...);
```

`verifyAndPruneCaseRecommendations` returns
`{contract: ConclusionContract, issues: ClaimVerificationIssue[]}`. The
contract is the input with `caseRecommendations` filtered to the surviving
hits; `issues` carries the `warning`-severity drops for audit. This is the
explicit pruned-contract return path round-4 asked for.

### 7.2 Feedback drives candidate state — end to end (round-1 fix)

Round-1 review correctly flagged that the original §7.2 named a `supported`
state in prose but never carried it through the SQL states, the `CaseNode`,
the retriever tie-break, or the report hit. V1 makes the feedback signal
**end-to-end concrete**.

**Feedback intake.** `POST /api/agent/v1/:sessionId/feedback` already exists
(self-improving PR1). It gains an optional `caseCandidateId` (resolved from
the report's `caseRecommendations[].caseCandidateId`, which the retriever
fills whenever the hit traces to a learned case). The feedback row is
written to `candidate_feedback` with `received_within_seconds` (time since
the candidate was first surfaced in a report for that session).

**Candidate state machine** (states live in `case_candidates.state`):

```
pending_review (captured, awaiting worker)
    ├─→ reviewed    (worker decision=promote AND re-validation passed AND ingested)
    │                   supportingEvidence: 0
    │                   ├─→ supported      (supportingEvidence ≥ 3 from distinct
    │                   │                    sessions, OR 1 maintainer-positive
    │                   │                    via the promotion CLI)
    │                   │                   └─→ eligible for publishCase() (human §7.3)
    │                   └─→ rejected       (≥2 distinct-session negatives within 24h,
    │                                        OR 1 maintainer-negative via CLI)
    └─→ rejected     (worker decision=reject OR re-validation failed OR PII flagged)
```

`supportingEvidence` and `contradictingEvidence` counts are **columns on
`case_candidates`** (added to the §1.4 schema below), incremented
transactionally with each feedback insert. `supported` is a **derived
boolean column** (`(supportingEvidence >= 3) OR maintainerPromoted`) so SQL
queries can filter on it directly.

**Carrying the signal onto the CaseNode.** When a learned case moves to
`supported`, the ingester updates its `CaseNode.knowledge.context` with a
typed marker under a **namespaced key** (round-2 fix: the leading-underscore
convention is weak — a human curator could legitimately write a context key
starting with `_`. We use a clearly-namespaced key that cannot collide with
any reasonable domain-pack context field):

```ts
knowledge.context = {
  ...extension.context,
  'caseEvolution.v1': {              // namespaced key; domain packs never use dotted keys
    candidateId,
    supportingEvidence: number,
    contradictingEvidence: number,
    maintainerPromoted: boolean,
    supportedAt: number,             // epoch ms; undefined until supported
  },
};
```

(The `context` field is already a free `Record<string, unknown>`
(`caseKnowledge.ts:75`), so this is additive and non-breaking. The
`.v1` suffix lets a future schema change coexist rather than migrate in
place — same immutability discipline as domain-pack versioning.)

**Carrying the signal into retrieval.** The retriever tie-break
(§4.2 Stage C) gains one more rank key, in this order:

1. `matchStrength` (strong > partial > background)
2. `status` (published > reviewed > draft)
3. **`context['caseEvolution.v1'].supported`** — a `supported` learned case
   ranks **above** an unsupported learned case at equal strength/status, but
   **below** any curated case (curated has no `caseEvolution.v1` marker,
   which the tie-break treats as "not a learned case" and ranks first among
   equals).
4. `quality` (curated > imported > weak)
5. keyword score

**Carrying the signal into the report hit.** `CaseRecommendationHit` /
`CaseKnowledgeReportRecommendation` gain an optional field so the renderer
can badge provenance:

```ts
// additive on the existing type — backwards compatible
interface CaseKnowledgeReportRecommendation {
  ...existing fields...
  /** Present only when the hit traces to a runtime-learned case. */
  learnedProvenance?: {
    candidateId: string;
    supportingEvidence: number;
    contradictingEvidence: number;
    supported: boolean;
  };
}
```

The HTML renderer (already built for the core `caseRecommendations` slot)
renders this as a small badge:
"📚 学习案例 · 3 次正向反馈" or "📚 学习案例（未验证）". This makes it
visible to the user that a recommendation comes from learned-vs-curated
knowledge, and is the second safety layer on top of the `draft` default.

> **Renderer note (round-2 fix).** The existing
> `renderCaseRecommendationsSection` (`htmlReportGenerator.ts:4928`)
> consumes the core `caseRecommendations` fields (caseId, title,
> matchStrength, evidenceGap, recommendations). The new `learnedProvenance`
> field is **additive and optional**, so the existing renderer continues to
> work unchanged for curated cases. Rendering the badge **is a required,
> small V1 change** to `htmlReportGenerator.ts` — it is not "already built."
> Round-2 review correctly flagged that the original wording overstated
> this. The change is ~15 lines: read `learnedProvenance` if present and
> append the badge to the card header. It is covered by the existing
> `htmlReportGenerator.test.ts` (extend with a learned-case fixture).

**Stale-pointer recovery (round-2 fix).** `learned_case_id` on the
candidate row is a soft pointer into `CaseLibrary`, which is file-backed
and not relational. After `rederiveLearnedCandidates` rebuilds the library,
the `learned:<id>` may have been re-created (same id) or, if the candidate
was rejected in the meantime, removed. Feedback resolution therefore:

1. Tries `CaseLibrary.getCase(learned_case_id)`.
2. If missing, re-resolves via `CaseLibrary.listCases` filtered by
   `knowledge.context['caseEvolution.v1'].candidateId === candidate_id`.
3. If still missing, the feedback is recorded against the candidate row
   only (audit), and the counters still drive the candidate state machine —
   the CaseNode will be re-ingested on the next `rederive` if the candidate
   returns to `reviewed`.

So feedback never silently drops; at worst it affects the candidate
metadata without a live CaseNode to badge.

**Time windows** reuse the self-improving semantics (`<10s` mis-tap → ignore,
`10s–24h` → counts at weight 1.0, `>24h` → audit-only, does not change
counts). A `rejected` candidate's ingested `CaseNode` (if any) is moved to
`private` status so it stops surfacing in retrieval but is retained for audit.

### 7.3 Promotion CLI (the only human path to `published`)

```bash
# Bump a learned case from draft → reviewed after observing supporting feedback
cd backend && npm run case-evolution:promote -- <candidateId> --to reviewed

# The final human step to published — goes through CaseLibrary.publishCase()
cd backend && npm run case-evolution:promote -- <candidateId> --to published --reviewer <name>

# Render a reviewed/published learned case into the curated Markdown tree
# so it joins the human-authored, version-controlled source of truth.
cd backend && npm run case-evolution:promote -- <candidateId> --to-markdown
# writes backend/knowledge/cases/<scene>/<case_id>.md
# (the file then goes through the normal git review + ingest:cases path)
```

`--to published` is the **only** code path that calls `publishCase()` for a
learned case. It requires `--reviewer`, which becomes the curator signoff
the gate demands. `--to-markdown` is the bridge from the runtime world to
the curated world: once a learned case has earned its place, a maintainer
freezes it into Markdown, at which point it is indistinguishable from any
other curated case and the runtime copy can be archived.

## 8. Feature flags (default off, three-stage rollout)

| Flag | Stage | Behavior |
|---|---|---|
| `CASE_EVOLUTION_CAPTURE_ENABLED` | 1 | Capture qualifying runs into the outbox |
| `CASE_EVOLUTION_REVIEW_ENABLED` | 1 | Background worker runs, calls review SDK |
| `CASE_EVOLUTION_NOTES_WRITE_ENABLED` | 1 | Write sidecar reviews to `logs/case_candidates/` |
| `CASE_EVOLUTION_INGEST_ENABLED` | 2 | Ingest promoted reviews as `draft imported` cases |
| `CASE_EVOLUTION_RETRIEVE_ENABLED` | 2 | Retriever runs; report attachment on |
| `CASE_EVOLUTION_PROMPT_INJECT_ENABLED` | 3 | Inject retrieved cases into the agent prompt |
| `CASE_EVOLUTION_INCLUDE_DRAFTS` | 3 | Let retriever surface `draft` learned cases (shadow observation) — default off |

**Shadow mode** (Stage 1+2, recommended 1–2 weeks): capture + review + sidecar
write ON; ingest/retrieve/inject OFF. A maintainer inspects
`logs/case_candidates/*.json` to judge review quality and anonymizer safety
before any learned case touches the library.

**Curated retrieval** (Stage 2 partial): with curated cases already in the
library, `RETRIEVE_ENABLED` can be turned on **independently** of the
evolution pipeline. This delivers the deferred V1.1 retrieval slice for
curated cases alone — a useful incremental win that does not depend on any
learned case existing yet.

### 8.1 Flag dependency matrix + runtime validator (round-5 fix)

Round-5 review flagged the flags are not orthogonal and V1 relied on
operator discipline. V1 adds an explicit dependency matrix and a runtime
validator `validateCaseEvolutionConfig()` called at backend startup and
before each worker poll:

| Flag | Requires | Effect if required flag is off |
|---|---|---|
| `CAPTURE_ENABLED` | — | (root) |
| `REVIEW_ENABLED` | `CAPTURE_ENABLED` | **warning + no-op** (nothing to review) |
| `NOTES_WRITE_ENABLED` | `REVIEW_ENABLED` | **warning + no-op** (no reviews to write) |
| `INGEST_ENABLED` | `REVIEW_ENABLED` | **warning + no-op** (no promoted reviews) |
| `RETRIEVE_ENABLED` | — | (independent — works on curated cases alone) |
| `PROMPT_INJECT_ENABLED` | `RETRIEVE_ENABLED` | **fail-closed**: the prompt segment builder refuses to run, logs an error. Injecting cases that were never retrieved is undefined. |
| `INCLUDE_DRAFTS` | `RETRIEVE_ENABLED` + `PROMPT_INJECT_ENABLED` | **fail-closed**: surfacing drafts in the prompt without explicit shadow-mode intent is the highest-risk flag and must not silently activate. |

The validator runs at startup and emits a startup log line per
violation. `PROMPT_INJECT` without `RETRIEVE` and `INCLUDE_DRAFTS` without
both are **fail-closed** (the feature refuses to engage); the rest are
**warn-and-no-op** (the dependent subsystem stays dormant but the backend
still starts). This mirrors the self-improving system's default-off posture
but adds the cross-flag discipline that system did not need (its flags were
strictly sequential pipeline stages).

## 9. Data & file layout

| Path | Contents | Gits |
|---|---|---|
| `backend/data/self_improve/case_evolution.db` | Candidate outbox + feedback (WAL) | ignored |
| `backend/logs/case_candidates/<candidateId>.json` | Review sidecars (shadow) | ignored |
| `backend/logs/case_library.json` | CaseLibrary (curated + learned, coexist) | ignored |
| `backend/logs/case_graph.json` | CaseGraph (mixed edge provenance) | ignored |
| `backend/logs/rag_store.json` | RagStore chunks (`registryOrigin='plan54_cases'` for both curated and learned; disambiguated by `uri` prefix — `case://learned/<id>` vs `case://<id>`) | ignored |
| `backend/knowledge/cases/<scene>/<id>.md` | Curated Markdown (human PRs only) | **tracked** |

No `backend/knowledge/` file is ever written by the runtime. The runtime
writes only to `logs/` and `data/`. The only way a learned case enters the
tracked Markdown tree is `case-evolution:promote --to-markdown` run by a
human, followed by a normal git review. This keeps the AGPL source-of-truth
directory honest: every tracked case file has a human author of record.

### 9.1 Migration & backward compatibility (round-5 fix)

Round-5 review asked for an explicit migration story per new persistent
shape. Each is additive; old data loads unchanged:

| New shape | Persisted where | Migration story |
|---|---|---|
| `case_evolution.db` (new DB) | `backend/data/self_improve/` | New file, created on first open. Migration v1 creates both tables with the generated `supported` column inline (no later rebuild needed). Future expression changes bump version and require a SQLite table rebuild — documented as a known cost. |
| `learnedProvenance` on `CaseKnowledgeReportRecommendation` | `conclusionContract.caseRecommendations[]` inside analysis-result snapshots (`analysisResultSnapshotPipeline.ts:445`) | Additive optional field. Old snapshots load (JSON is structural; missing field = curated case, no badge). No snapshot rewrite. |
| `caseEvolution.v1` context key | `CaseNode.knowledge.context` inside `case_library.json` | `context` is `Record<string, unknown>`; old rows simply lack the key. The retriever treats absence as "not a learned case" (curated). No rewrite. |
| `ClaudeAnalysisContext.caseBackgroundContext` | (runtime only, not persisted) | Not in `SessionStateSnapshot`; no migration. |
| `case_background_context` in `dropOrder` | (code only) | No persisted state. |
| `runtime_analysis_candidate` CaseNode source | `case_library.json` | Coexists with `curated_markdown_case`. `CaseLibrary.load()` accepts `schemaVersion: 1` and stores full objects; the new source value is just a string. No rewrite. |
| `case://learned/<id>` RAG uris | `rag_store.json` | `RagStore` reads v1/v2 and backfills `registryOrigin`; the new uri prefix is just a string filter. No rewrite. |

**No existing persisted file is rewritten or invalidated by V1.** A
deployment can enable the feature flags, run for a week in shadow mode,
and disable them again, leaving only `case_evolution.db` +
`logs/case_candidates/` as new artifacts (both gitignored). The curated
`case_library.json` / `rag_store.json` only gain entries when
`INGEST_ENABLED` is on, and those entries are removable by
`case-evolution:rederive`.

## 10. Verification plan

### 10.1 Unit tests (new files, colocated `__tests__/` convention)

- `caseEvolution/__tests__/caseCandidateBuilder.test.ts` — qualification
  gate (confidence/verifier/full-path/cluster threshold/dedupe); one
  candidate per qualifying cluster; no candidate on quick path.
- `caseEvolution/__tests__/caseCandidateOutbox.test.ts` — migration up/down;
  atomic lease; dedupe on active `dedupe_key`; retry cap; stale-lease
  expiry; enqueue failure does not throw to caller.
- `caseEvolution/__tests__/caseAnonymizer.test.ts` — package → domain
  bucket; PII patterns (email/phone/MAC/URL) flagged; unknown structure
  omitted + warning; deterministic (same input → same output).
- `caseEvolution/__tests__/caseCandidateReviewValidator.test.ts` — JSON
  schema; domain-pack re-validation (rejects unknown `reason_code`);
  content-scanner 6 classes; relation target existence check; size cap.
- `caseEvolution/__tests__/caseCandidateIngester.test.ts` — produces
  `quality=imported`, `status=draft`, `source=runtime_analysis_candidate`,
  `redactionState=redacted`; distinct edge prefix; distinct RagStore origin;
  rederive converges after simulated mid-ingest crash (mirrors
  `caseIngester.test.ts`'s convergence test).
- `caseEvolution/__tests__/caseRecommendationRetriever.test.ts` —
  strong/partial/background classification; required-signature gating (a
  case with unmatched required signatures **cannot** return `strong`);
  status/quality tie-break; `includeStatuses` filtering.
- `caseEvolution/__tests__/attachCaseHitsToContract.test.ts` — caps at 8;
  maps hits to `CaseKnowledgeReportRecommendation`; empty result leaves
  contract untouched.
- `caseEvolution/__tests__/caseCandidateFeedback.test.ts` — state machine
  transitions; time windows; `rejected` → case moved to `private`.
- `caseEvolution/__tests__/casePromoteCli.test.ts` — `--to reviewed`;
  `--to published` calls `publishCase()` with reviewer; `--to-markdown`
  writes a valid Markdown file that passes `validate:cases`.

### 10.2 Integration

- `npm run test:scene-trace-regression` after each stage is enabled — must
  stay green (the loop is additive; it never changes a passing run's
  conclusion).
- A new `npm run test:case-evolution:e2e` that runs one full analyze() over
  a fixture trace with `CASE_EVOLUTION_*` flags on and asserts: (a) a
  candidate was captured, (b) the worker produced a review, (c) a
  `draft imported` case exists in `CaseLibrary`, (d) a second analyze()
  over a similar trace has the case in `caseBackgroundContext` and in the
  report's `caseRecommendations`.
- A **resume/reconnect test** (round-4): simulate a process restart between
  turn N (which produced `caseRecommendations`) and turn N+1. Assert (i)
  the analysis-result snapshot still carries the contract, (ii) the capture
  on turn N+1 still succeeds reading live `result` + `session.dataEnvelopes`,
  (iii) no field is read from `_lastSnapshot` that the snapshot does not
  actually persist.
- A **prune-step test** (round-4): given a retriever hit at `strong` whose
  evidence signatures do not survive the §7.1 re-check,
  `verifyAndPruneCaseRecommendations` removes it from the contract, emits a
  `warning` issue, and the issue is merged into
  `result.claimVerificationResult.issues`.

### 10.3 Existing gates (must stay green)

```bash
cd backend
npm run build
npm run validate:strategies
npm run validate:skills
npm run validate:cases          # curated Markdown still valid
npm run ingest:cases            # curated rederive still converges
npm run test:scene-trace-regression
```

`verify:pr` from the repo root must pass unchanged.

## 11. Failure modes

Each row now names the **specific mechanism** (service / CLI / SQL
constraint / code path), not just a promise (round-5 fix). Round-5
inconsistencies resolved: invented-relation-target now consistently
"drop target + warning, keep candidate" (§2.4) unless a *required* field
fails (then reject); feedback dedupe keyed on `(candidate_id,
source_session_id)` (matches the §1.4 `idx_feedback_dedupe` unique index,
not `sourceAnalysisRunId`); promotion-misuse retraction path made explicit.

| Codepath | Failure | Mechanism (specific) | User-visible |
|---|---|---|---|
| Capture | `saveCaseCandidates` throws | Route wraps the call in `void … .catch(err => logger.warn(...))`; the `result` is already assigned upstream, so the throw cannot reach the response. Metric `case_evolution_capture_failed` incremented via the §11.1 metrics sink. | none |
| Outbox enqueue | SQLite `SQLITE_BUSY` / disk full | `caseCandidateOutbox.enqueue` runs inside a `transaction()` with `busy_timeout=5000`; on unrecoverable error it returns `{ok:false, error}` and the capture `catch` logs it. Never throws to the route. Metric `case_evolution_enqueue_failed`. | none |
| Review worker | SDK timeout / 8-turn cap / non-JSON / schema-invalid | `caseCandidateReviewValidator` rejects → `markFailed(candidateId, last_error)`; `attempts++`; at `MAX_ATTEMPTS` (default 3) state → `rejected`. Worker re-leases on next poll only while `attempts < MAX_ATTEMPTS`. Metric `case_evolution_review_failed`. | none (shadow) |
| Review re-validation | LLM proposed unknown `reason_code` | `caseDomainPacks.validateCaseDomainPack` throws → candidate `rejected`. **Required**-field failure always rejects. | none |
| Review re-validation | LLM invented a relation target id | Each target looked up via `CaseLibrary.getCase`; unknown targets **dropped from the proposed relations + a warning recorded on the candidate** (candidate survives — §2.4). Only if *all* proposed relations are invalid AND the pack requires at least one does the candidate reject. | none |
| Anonymizer | unhandled structure | `caseAnonymizer` omits the field + emits a `warnings[]` entry on the candidate; the review proceeds with the clean fields. | none |
| Anonymizer | PII detected in a free-text field | If the field is **required** (title, finding title, recommendation action) → candidate `rejected`. If optional (evidenceSummary, risks) → field scrubbed + warning. | none |
| Ingest | crash between CaseLibrary and RagStore write | `rederiveLearnedCandidates()` (§3.5.1) runs as `npm run case-evolution:rederive` — operator-triggered. The §11.1 metrics endpoint surfaces `ingested != reviewed` drift so an operator knows to run it. V1 does **not** auto-run rederive on startup (round-5: no startup hook specified; the drift metric is the signal). | library self-heals on CLI run |
| Retriever | no case matches | `attachCaseHitsToContractSync` returns `[]`; `caseRecommendations` stays unset; `renderCaseRecommendationsSection` omits the section; `case_background_context` segment omitted. | "no similar case" — acceptable |
| Retriever vs re-check disagreement | retriever says `strong`, re-check says signatures don't match | `verifyAndPruneCaseRecommendations` (§7.1.1) drops the hit, emits `warning` issue, returns pruned contract; route assigns the pruned contract. Metric `case_evolution_hit_pruned`. | rec preserved, no false strong citation |
| Feedback flood | one session sends 100 positives | `idx_feedback_dedupe` UNIQUE on `(candidate_id, source_session_id)` — the 2nd–100th inserts throw `SQLITE_CONSTRAINT_UNIQUE` and are caught + logged. Counter increments once per session. Round-5: dedupe is session-level (not run-level) so a multi-run session still only counts once — this is intentional (one user's repeated thumbs shouldn't stack). | none |
| Promotion misuse | maintainer publishes a bad learned case | `publishCase()` requires reviewer name (curator signoff) and `redactionState='redacted'`. **Retraction path (round-5):** `npm run case-evolution:retract -- <caseId>` sets status back to `private` via `saveCase` (allowed — only `published` is rejected by `saveCase`), removes it from retrieval, and records a `retracted` audit note. Git history only shows the reviewer for the `--to-markdown` + PR path; runtime publishes record the reviewer in `curatedBy` on the CaseNode (queryable via the admin endpoint). | case retractable |
| Junk draft surfaces | `INCLUDE_DRAFTS` on, low-quality learned draft reaches prompt | Token-budgeted (600 tokens) + droppable (dropOrder); tie-break keeps curated above; flag default off + §8.1 requires `PROMPT_INJECT` + `RETRIEVE` on + fail-closed otherwise. | controlled by flag |

### 11.1 Observability (round-5 fix)

Round-5 review flagged the self-improving system shipped a metrics endpoint
(PR10) and this design did not. V1 adds a parallel metrics surface. A new
`caseEvolutionMetricsAggregator.ts` collects a health snapshot, exposed at
`GET /api/admin/case-evolution/metrics` (bearer auth, same pattern as
`/api/admin/self-improve/metrics`):

```json
{
  "collectedAt": 1718400000000,
  "candidates": {
    "byState": {"pending_review": 12, "reviewed": 8, "rejected": 3, "archived": 0},
    "supported": 2,
    "learnedCasesInLibrary": 8,
    "privateRetained": 3
  },
  "outbox": {
    "todayEnqueued": 14, "todayReviewed": 9, "todayIngested": 5,
    "todayFailed": 1, "dailyBudgetUsed": 14, "dailyBudgetLimit": 50
  },
  "worker": {
    "running": true, "lastPollAt": 1718399990000,
    "attemptsHistogram": {"1": 40, "2": 6, "3": 1, "rejected": 3}
  },
  "feedback": {"totalPositive": 22, "totalNegative": 4, "distinctSessions": 18},
  "retriever": {
    "todayQueries": 47, "todayStrongHits": 3, "todayPruned": 1,
    "avgLatencyMs": 4
  },
  "prompt": {"todaySegmentsBuilt": 47, "todayDroppedForBudget": 2},
  "flags": {"capture": true, "review": true, "ingest": true, "retrieve": true,
            "promptInject": false, "includeDrafts": false},
  "warnings": []
}
```

Failure-tolerant like the self-improving aggregator: a corrupt
`case_evolution.db` produces a `warnings[]` entry, not a 500. This is the
operator's single dashboard for the loop's health and is the signal that
triggers a `rederive` run when `candidates.reviewed != learnedCasesInLibrary`.

## 12. Relationship to the two existing systems

| Concern | Self-Improving L1–L4 | Case-Knowledge V1 | This design (Self-Evolution V1) |
|---|---|---|---|
| What is learned | Skill notes, pattern fingerprints, strategy phase_hints | Nothing (ingest-only) | Durable, citable case records |
| Source | Runtime + feedback + background review | Human-authored Markdown | Successful runs + background review |
| Store | `analysis_patterns.json`, skill_notes, supersede.db | CaseLibrary/Graph/RagStore (Markdown-derived) | **Same** CaseLibrary/Graph/RagStore (run-derived, distinct provenance) |
| Lifetime | Short (pattern buckets, 60-day TTL) | Permanent (curated) | Permanent once promoted; `draft` candidates retractable |
| Reaches agent via | Tier-4 `patternContext`, `negativePatternContext`, skill notes | (deferred) | Tier-4 `caseBackgroundContext` + report `caseRecommendations` |
| Promotion gate | PR + regression + canary (strategy) | `publishCase()` curator signoff | **Same** `publishCase()` curator signoff |
| Safety posture | Shadow-first, content-scan, no LLM file writes | Markdown review | **Same** shadow-first, content-scan, no LLM file writes |

The three systems are **complementary, not overlapping**: self-improving tunes
*how* the agent runs (skills/strategies/patterns); case-knowledge curates
*what* the agent knows (human-authored cases); self-evolution grows the case
library *from experience* under the same publish gate. The shared
`failureModeHash` taxonomy and `Provenance` shape let all three cite the same
run as the origin of a learning.

## 13. Open questions (to resolve in review)

1. Should the candidate outbox live in `self_improve.db` (one DB, simpler
   ops) or its own `case_evolution.db` (blast radius isolation, matches the
   supersede.db precedent)? **Tentative: separate DB** (matches supersede.db
   precedent; a corrupt candidate queue must not stall pattern review).
2. Should `--to-markdown` also delete the runtime `imported` copy, or keep
   both with the Markdown copy taking precedence on next `ingest:cases`?
   **Tentative: keep both; `ingest:cases` already preserves runtime
   curation state via `mergeRuntimeCuration`, and the Markdown copy is the
   higher-status one so it wins tie-breaks naturally.**
3. First pack beyond `scrolling.v1`? Out of scope for V1; listed for
   sequencing only.

## 14. First-version scope (the cut line)

**In V1:**

- Capture path (Stage 1) with qualification gate + outbox.
- Review worker (Stage 2) with re-validation + content scan + shadow sidecar.
- Ingest path (Stage 3) producing `quality=imported, status=draft` cases
  with anonymizer-backed `redactionState=redacted`.
- Retriever (Stage 4) with two-stage structured + evidence-signature
  matching — **this also delivers the V1.1 retrieval slice for curated
  cases**, so the design pays for itself even before any learned case exists.
- Report attachment (Stage 5a) — the dormant renderer finally has a producer.
- Prompt injection (Stage 5b) — gated to Stage 3 rollout.
- Feedback-driven candidate state machine + promotion CLI.
- Feature flags + shadow-first rollout.
- Full unit + integration test plan above.

**Deferred from V1 (separate slices):**

- Vector / embedding retrieval (depends on a sqlite-vec or hosted embeddings
  decision; the retriever's `search()` shape is already abstracted).
- `cite_case_in_report` as an agent-callable MCP tool (the report path is
  sufficient for V1; the MCP tool is a second entry path and waits for its
  own design pass, per Plan 54's single-entry-path rule).
- Domain packs beyond `scrolling.v1`.
- Cross-workspace case federation.
- Bulk historical-report import (same non-goal as case-knowledge V1).

## 15. Risks and mitigations

- **Risk:** Learned cases pollute the library with low-quality or
  case-specific noise.
  **Mitigation:** Qualification gate (high-confidence, verified, full-path,
  promotable cluster); anonymizer; re-validation; default `draft`; status
  tie-break keeps curated above; never auto-publish; `rejected` → `private`.
- **Risk:** Anonymizer leaks PII.
  **Mitigation:** Pure deterministic anonymizer; fails closed; PII in any
  free-text field rejects the candidate; shadow mode lets a human audit
  sidecars before any ingest; `publishCase()` still requires a human reviewer
  who can spot residual issues.
- **Risk:** Retriever returns a misleading strong match.
  **Mitigation:** Required-signature gate; verifier re-check; renderer's
  explicit `evidence_gap` for non-strong matches; final-report contract gate
  requires citation when a strong match exists.
- **Risk:** Runtime writes drift from curated Markdown.
  **Mitigation:** Distinct provenance (`source`, edge prefix, RagStore
  origin); `ingest:cases` and `rederiveLearnedCandidates` are both
  full-rederive and never cross streams.
- **Risk:** Cost of background review agent.
  **Mitigation:** Lower daily budget (50) and longer poll interval (60s)
  than pattern review; haiku-class model; cooldown per candidate.
- **Risk:** Prompt injection from a poisoned case (a learned case whose
  `recommendations.action` contains a jailbreak).
  **Mitigation:** Every free-text field from a review passes
  `contentScanner` (6 threat classes) before ingest; curated cases come from
  human-reviewed Markdown; the prompt segment is built by the backend, not
  by copy-pasting raw case text verbatim — fields are templated into a fixed
  structure.

## Review Status

| Review | Trigger | Runs | Status | Verdict |
|---|---|---|---|---|
| Codex round 1 | Overall design soundness | 1 | done | APPROVE WITH CHANGES — 5 findings incorporated (capture site moved post-verifier; prompt retrieval split pre-run/mid-run; feedback state made end-to-end; learned-case types aligned to real CaseNode + closed RAG union; scope narrowed to Claude runtime with runtime-agnostic seams called out) |
| Codex round 2 | Data model & schema | 1 | done | APPROVE WITH CHANGES — 8 findings incorporated (confidence→numeric with threshold + bucket; verifierStatus aligned to real ClaimVerificationResult union; dataEnvelopeIds→evidenceRefIds via existing snapshot-pipeline derivation; session.architectureType/traceContentHash computed via helpers not read off session; CaseKnowledgeFinding→CaseFindingLink conversion defined in projection with severity mapping; RagChunk has no `source` field → disambiguate learned chunks by `case://learned/` uri prefix; single source of truth for `supported` (derived column, not a state); strict fail-closed signature-evaluation rules per operator; `_evolution`→`caseEvolution.v1` namespaced context key; FK ON DELETE CASCADE + foreign_keys pragma; `learnedProvenance` renderer change acknowledged as required V1 work; stale `learned_case_id` pointer recovery by candidateId fallback) |
| Codex round 3 | Retrieval/ingest pipeline correctness | 1 | done | APPROVE WITH CHANGES — 7 findings incorporated (rederive rewritten as upsert+demote-to-private over real CaseGraph.addEdge/removeEdge + RagStore.listChunks uriPrefix APIs, not the V1 private replaceGenerated helpers; crash-safe algorithm preserves rejected/private audit cases instead of wiping; Stage A acknowledged as in-memory post-filter since listCases doesn't support knowledge.* filters — documented V1 scaling decision; Stage C rewritten as a join over RagStore.search(string) with Map<caseId,score> since search can't be restricted to a candidate set; §5.1 attach ordering fixed so hits are verifier-visible before ensureAnalysisQualityArtifacts, capture after; recall_similar_case enhancement made strictly additive with all-new-fields-optional so existing contract + tests preserved; verifier case-citation check made explicit new plumbing in verifyCaseCitations.ts rather than hand-waved shared helper; domain-bucket logic extracted to shared helper since it was inline in analysisPatternMemory) |
| Codex round 4 | Integration points & AI output contract | 1 | done | APPROVE WITH CHANGES — 5 findings incorporated (no direct AI Output Contract violation — caseRecommendations is a typed slot the chat fallback renderer ignores; §6.3/§6.6 contradiction resolved with an explicit narrative-citation rule allowing reasoning mentions but forbidding recommendation-text duplication in the narrative + dedupe; verifier-drops-hits replaced with concrete verifyAndPruneCaseRecommendations plumbing returning {contract, issues} with explicit pruned-contract assignment before report/SSE/snapshot; prompt Tier-4 integration made concrete — add caseBackgroundContext to ClaudeAnalysisContext, push 'case_background_context' label, insert into the real dropOrder array after negative_pattern_context, use a dedicated PromptSegmentBudget not the per-skill SkillNotesBudget; persistence clarified — SessionStateSnapshot does not carry conclusionContract so capture reads live result + session.dataEnvelopes, recommendations persist via analysisResultSnapshotPipeline; recall_similar_case stays public with documented rationale since evidence signatures are additive and do not expose draft/private) |
| Codex round 5 | Failure modes, migration, completeness | 1 | done | APPROVE WITH CHANGES — 5 findings incorporated (observability: new `/api/admin/case-evolution/metrics` endpoint + `caseEvolutionMetricsAggregator` mirroring the self-improving PR10 pattern, failure-tolerant, surfaces drift that triggers rederive; flag dependency matrix §8.1 with `validateCaseEvolutionConfig()` — PROMPT_INJECT-without-RETRIEVE and INCLUDE_DRAFTS-without-both are fail-closed, others warn-and-no-op; §11 rewritten so every row names a specific mechanism — invented-relation-target handling made consistent (drop+warn unless all relations invalid), feedback dedupe corrected to session-level matching the real unique index, promotion retraction path added via `case-evolution:retract` setting status back to private; §9.1 migration table proves every new persistent shape is additive and old data loads unchanged — no existing file is rewritten; stale contradictions fixed — RagChunk chunk-`source` wording → uri prefix, round-1 `_evolution` → `caseEvolution.v1`, §12 table `caseContext` → `caseBackgroundContext`; **auto-publish invariant re-confirmed clean** — full trace captured→published has 9 gates, no automatic path reaches status='published**) |

### Round-1 findings, resolved

1. **CRITICAL — capture before verifier.** §1.1 now places capture in the
   route layer at `agentRoutes.ts` after `ensureAnalysisQualityArtifacts`
   populates `result.claimVerificationResult`. The qualification gate (§1.2)
   keys off the verifier status.
2. **CRITICAL — pre-run retrieval cannot evidence-gate.** §6 is rewritten:
   pre-run injection is explicitly `background`-only and labelled as
   unverified; the strong-match path is the mid-run `recall_similar_case`
   enhancement and the post-run report attachment.
3. **MAJOR — feedback not feeding retrieval.** §7.2 now carries
   `supportingEvidence` / `supported` through SQL columns, onto the
   `CaseNode.knowledge.context['caseEvolution.v1']` marker, into the
   retriever tie-break, and into a new optional `learnedProvenance` field
   on the report hit.
4. **MAJOR — learned-case type mismatches.** §3.3 now produces a
   `CaseNode` that conforms to the real type (flattened `SparkProvenance`,
   `quality`/`sourceFile` on the extension not the node, no `updatedAt`).
   §3.5/§9 use the existing closed `registryOrigin='plan54_cases'` union
   member and disambiguate by chunk `source`.
5. **MAJOR — Claude-only vs platform-wide.** Scope note at the top narrows
   V1 to the Claude runtime; §6.5 defines the two thin runtime-agnostic
   seams (`saveCaseCandidates`, `buildCaseBackgroundContext`) that other
   runtimes adopt later.

### Round-5 findings, resolved

1. **Observability gap.** §11.1 adds `/api/admin/case-evolution/metrics` +
   `caseEvolutionMetricsAggregator`, mirroring the self-improving PR10
   endpoint, failure-tolerant, surfacing candidate/outbox/worker/feedback/
   retriever/prompt health + the drift signal that triggers rederive.
2. **Flag consistency.** §8.1 adds a dependency matrix +
   `validateCaseEvolutionConfig()`; the two highest-risk combos
   (`PROMPT_INJECT` without `RETRIEVE`, `INCLUDE_DRAFTS` without both) are
   fail-closed, the rest warn-and-no-op.
3. **§11 hand-waves.** Every row now names a specific mechanism; the
   invented-relation-target inconsistency (§2.4 vs §11), the feedback-dedupe
   key mismatch (`sourceAnalysisRunId` vs the real `source_session_id`
   index), and the missing retraction path are all fixed.
4. **Migration.** §9.1 proves each new persistent shape is additive — old
   `case_library.json` / `rag_store.json` / analysis snapshots load
   unchanged; no existing file is rewritten.
5. **Stale contradictions.** `RagChunk` chunk-`source` wording → uri prefix
   (`case://learned/`); round-1 resolution bullet `_evolution` →
   `caseEvolution.v1`; §12 table `caseContext` → `caseBackgroundContext`.
   The auto-publish invariant was re-traced end-to-end: 9 gates, only the
   last (human `publishCase()` with reviewer) reaches `status='published'`.
