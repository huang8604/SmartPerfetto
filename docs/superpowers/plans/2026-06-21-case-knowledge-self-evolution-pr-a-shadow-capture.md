# Case Knowledge Self-Evolution PR A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement PR A for Case Knowledge Self-Evolution V1: default-off shadow capture, SQLite candidate outbox, read-only background review, validated sidecar writes, and metrics skeleton, without ingesting learned cases or surfacing them to reports/prompts.

**Architecture:** PR A creates a runtime-agnostic `backend/src/services/caseEvolution/` subsystem and a thin route-layer capture seam after existing claim verification. It mirrors the self-improving outbox/worker trust boundary, but case-review prompt content lives in a Markdown template under `backend/strategies/` to preserve the current prompt-content rule. Runtime output remains unchanged: PR A writes only `backend/data/self_improve/case_evolution.db` and, when explicitly enabled, `backend/logs/case_candidates/*.json`.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Jest, better-sqlite3, Claude Agent SDK, existing `CaseLibrary`, `CaseGraph`, `RagStore`, `DataEnvelope`, and `ClaimVerificationResult` contracts.

## Global Constraints

- Implement the reviewed design faithfully; do not redesign Case Self-Evolution V1.
- PR A only covers infrastructure + shadow capture: §1 capture, §1.4 outbox, §2 worker/review boundary, §2.5 sidecar, §11.1 metrics skeleton.
- No automatic publish. PR A must not call `CaseLibrary.saveCase()` for learned cases and must never call `CaseLibrary.publishCase()`.
- All seven feature flags default off. PR A introduces the shared config reader with all seven flags defaulting off; the full §8.1 cross-flag fail-closed validator is PR C scope per the requested PR split.
- Shadow mode writes only runtime/ignored artifacts: `backend/data/self_improve/case_evolution.db` and `backend/logs/case_candidates/*.json`.
- Do not write `backend/knowledge/cases/` from runtime code.
- Do not hardcode durable prompt content in TypeScript. Case-review prompt text belongs in `backend/strategies/case-candidate-review.template.md`; this prompt asset is the only new non-`caseEvolution/` runtime content file in PR A, required by the current prompt rule.
- Keep the AI Output Contract unchanged. PR A does not attach `caseRecommendations`, does not alter chat/report projection, and does not change `recall_similar_case`.
- Preserve existing worktree changes. Current `agentRoutes.ts`, runtime files, and contract files are already modified by other work; execution must inspect diffs before editing and stage only PR A files.
- Current source truth: `backend/skills/composite/scrolling_analysis.skill.yaml` is the actual scrolling skill path; the design's plain `backend/skills/scrolling_analysis.skill.yaml` reference is stale.
- Verification must use current project commands only. For PR A completion: focused Jest suites, then `cd backend && npm run build`, `npm run validate:strategies`, `npm run validate:skills`, `npm run validate:cases`, `npm run ingest:cases`, `npm run test:scene-trace-regression`, and root `npm run verify:pr` when ready to open/land.
- If `/simplify` or `code-simplifier` is not available after implementation, run manual simplification review plus `git diff --check` and record the tool as `NOT AVAILABLE`.
- Codex cannot independently review its own diff. If no read-only reviewer tool/subagent is available at execution time, record `Codex review: NOT AVAILABLE`, perform findings-first manual architecture review, and fix confirmed issues.

## Maintainer Checkpoint Before Execution

The PR split creates two handoff questions:

- The design says `state='reviewed'` is the reviewed/ingested candidate state, but PR A has review + sidecar and PR B has ingest. To avoid reprocessing the same promoted shadow review forever without inventing a new state, this plan's default interpretation is `reviewed` in PR A means "review passed and sidecar persisted; `learned_case_id` remains NULL until PR B ingest." PR B then ingests reviewed rows and fills `learned_case_id`.
- The design's `CaseCandidate.evidenceHandle.snapshotPath` says "path to the SessionStateSnapshot JSON," but current source persists unified snapshots in `SessionPersistenceService` session metadata rather than a standalone JSON file. This plan's default interpretation is to keep the field name and store a resolver string for the existing snapshot location, `session-persistence://sessions/<sessionId>/metadata/sessionStateSnapshot`, so the worker can re-load through `SessionPersistenceService.loadSessionStateSnapshot(sessionId)` without inventing a new runtime file writer.

Confirm both interpretations before implementation. If the intended invariant is "`reviewed` only after CaseNode ingest," PR A needs a design-level alternative such as a new non-terminal shadow-review state or a lease exclusion keyed by `review_json IS NOT NULL`. If `snapshotPath` must be a real filesystem path, PR A needs an explicit snapshot-export writer in scope before capture can be implemented.

## File Structure

Create:

- `backend/src/types/caseEvolution.ts`
  Shared PR A contracts: `CaseCandidate`, `CaseCandidateReview`, capture input, candidate states, metrics types, thresholds, and resource-limit defaults.
- `backend/src/services/caseEvolution/caseEvolutionConfig.ts`
  Default-off flag readers and PR A resource limit parsing.
- `backend/src/services/caseEvolution/dataEnvelopeRef.ts`
  Local case-evolution helper that exactly mirrors the existing `analysisResultSnapshotPipeline.ts` evidence-ref derivation. Do not modify the snapshot pipeline in PR A.
- `backend/src/services/caseEvolution/caseCandidateOutbox.ts`
  SQLite v1 migration, enqueue, atomic lease, review/reject/fail state transitions, feedback table creation, and metrics queries.
- `backend/src/services/caseEvolution/scrollingCandidateProjector.ts`
  Domain-pack-owned projection from `DataEnvelope[]` to promotable `scrolling.v1` clusters. Reads existing `batch_frame_root_cause` rows; does not re-cluster.
- `backend/src/services/caseEvolution/caseCandidateBuilder.ts`
  Qualification gate and candidate construction. Pure/testable; no IO.
- `backend/src/services/caseEvolution/saveCaseCandidates.ts`
  Runtime-agnostic fire-and-forget seam called by the route layer. Reads flags, builds candidates, enqueues, logs failures, and never throws to analysis.
- `backend/src/services/caseEvolution/caseCandidateReviewValidator.ts`
  Strict JSON/schema validation, domain-pack re-validation, relation target filtering, content scanning, and 16KB cap.
- `backend/src/services/caseEvolution/caseCandidateSidecar.ts`
  Atomic writer for `backend/logs/case_candidates/<candidateId>.json`.
- `backend/src/services/caseEvolution/caseCandidateReviewAgentSdk.ts`
  Independent Claude SDK review call. Loads `case-candidate-review.template.md` and renders variables with `strategyLoader.renderTemplate`.
- `backend/src/services/caseEvolution/caseEvolutionWorker.ts`
  Worker that leases candidates, executes review, validates output, writes sidecars when enabled, and marks outbox state.
- `backend/src/services/caseEvolution/caseEvolutionWorkerBootstrap.ts`
  Backend startup helper. Creates outbox + worker and starts no-op unless stage-1 flags enable it.
- `backend/src/services/caseEvolution/caseEvolutionMetricsAggregator.ts`
  Failure-tolerant snapshot for `/api/admin/case-evolution/metrics`.
- `backend/strategies/case-candidate-review.template.md`
  Review-agent prompt template.
- `backend/src/services/caseEvolution/__tests__/dataEnvelopeRef.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseEvolutionConfig.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseCandidateOutbox.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseCandidateBuilder.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseCandidateReviewValidator.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseCandidateSidecar.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseEvolutionWorker.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseEvolutionMetricsAggregator.test.ts`
- `backend/src/services/caseEvolution/__tests__/caseEvolutionShadowIntegration.test.ts`
- `backend/src/routes/__tests__/strategyAdminRoutes.caseEvolution.test.ts`

Modify:

- `backend/src/routes/agentRoutes.ts`
  Add the fire-and-forget `saveCaseCandidates()` call immediately after `ensureAnalysisQualityArtifacts(...)` in the success/partial route block.
- `backend/src/routes/strategyAdminRoutes.ts`
  Add `GET /api/admin/case-evolution/metrics` next to the self-improve metrics endpoint.
- `backend/src/index.ts`
  Call `startCaseEvolutionWorker()` during backend bootstrap; the helper must be a no-op while flags are off.
- `backend/package.json`
  Add focused script `test:case-evolution` for PR A's case-evolution Jest suites. Do not add it to `verify:pr` in PR A; the objective already requires the focused suite plus the existing project gates.

Do not modify in PR A:

- `backend/knowledge/cases/**`
- `backend/src/services/caseIngester.ts`
- `backend/src/services/caseRecommendationRetriever.ts` (PR B creates retrieval; PR A must not create it)
- `backend/src/agentv3/claudeMcpServer.ts`
- `backend/src/agentv3/claudeSystemPrompt.ts`
- `backend/src/services/htmlReportGenerator.ts`
- `backend/src/agent/core/conclusionContract.ts`
- `backend/src/services/analysisResultSnapshotPipeline.ts`

## Task 1: Case-Evolution Evidence Ref Helper

**Files:**
- Create: `backend/src/services/caseEvolution/dataEnvelopeRef.ts`
- Test: `backend/src/services/caseEvolution/__tests__/dataEnvelopeRef.test.ts`

**Interfaces:**
- Produces: `dataEnvelopeRefId(env: DataEnvelope, duplicateEvidenceRefIds?: Set<string>): string`
- Consumes: existing local logic in `analysisResultSnapshotPipeline.ts` as the behavior source of truth, without editing that file in PR A.

- [ ] **Step 1: Write failing tests**

```ts
expect(dataEnvelopeRefId(envWithEvidenceRef)).toBe('ev-1');
expect(dataEnvelopeRefId(envWithDuplicateEvidenceRefAndTool, new Set(['ev-1']))).toBe('ev-1:tool:tool-1');
expect(dataEnvelopeRefId(envWithTimestampOnly)).toBe('data:scrolling_analysis:batch_frame_root_cause:123');
expect(dataEnvelopeRefId(envWithoutTimestamp)).toMatch(/^data:scrolling_analysis:batch_frame_root_cause:[a-f0-9]{16}$/);
```

- [ ] **Step 2: Run red test**

Run:

```bash
cd backend
npx jest src/services/caseEvolution/__tests__/dataEnvelopeRef.test.ts --runInBand
```

Expected: fail because `services/dataEnvelopeRef.ts` does not exist.

- [ ] **Step 3: Implement local mirror**

Implement the current `stableEnvelopeContentHash()` and `dataEnvelopeRefId()` behavior in `services/caseEvolution/dataEnvelopeRef.ts`. Keep it behavior-equivalent to `analysisResultSnapshotPipeline.ts`; do not refactor the snapshot pipeline in PR A.

- [ ] **Step 4: Re-run focused test and snapshot pipeline test**

Run:

```bash
cd backend
npx jest src/services/caseEvolution/__tests__/dataEnvelopeRef.test.ts --runInBand
```

Expected: pass and produce ids matching the snapshot-pipeline examples.

## Task 2: Case Evolution Types And Default-Off Config

**Files:**
- Create: `backend/src/types/caseEvolution.ts`
- Create: `backend/src/services/caseEvolution/caseEvolutionConfig.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseEvolutionConfig.test.ts`

**Interfaces:**
- Produces: `CaseCandidate`, `CaseCandidateReview`, `CaseCandidateCaptureInput`, `CaseEvolutionConfig`
- Produces: `loadCaseEvolutionConfig(env?: NodeJS.ProcessEnv): CaseEvolutionConfig`
- Produces: `isCaseEvolutionCaptureEnabled(config): boolean`, `isCaseEvolutionReviewEnabled(config): boolean`, `isCaseEvolutionNotesWriteEnabled(config): boolean`

- [ ] **Step 1: Write failing config tests**

```ts
expect(loadCaseEvolutionConfig({})).toMatchObject({
  captureEnabled: false,
  reviewEnabled: false,
  notesWriteEnabled: false,
  ingestEnabled: false,
  retrieveEnabled: false,
  promptInjectEnabled: false,
  includeDrafts: false,
  workerConcurrency: 1,
  queueMax: 100,
  dailyBudget: 50,
});
expect(loadCaseEvolutionConfig({CASE_EVOLUTION_CAPTURE_ENABLED: '1'}).captureEnabled).toBe(true);
expect(loadCaseEvolutionConfig({CASE_EVOLUTION_WORKER_CONCURRENCY: '99'}).workerConcurrency).toBe(2);
expect(loadCaseEvolutionConfig({CASE_EVOLUTION_DAILY_BUDGET: 'bad'}).dailyBudget).toBe(50);
```

- [ ] **Step 2: Define contracts**

`backend/src/types/caseEvolution.ts` must include the exact design shapes, adjusted only for current source truth:

```ts
export type CaseCandidateState = 'pending_review' | 'reviewed' | 'rejected' | 'archived';
export const CASE_CANDIDATE_SCHEMA_VERSION = 'case_candidate@1' as const;
export const CASE_CANDIDATE_REVIEW_SCHEMA_VERSION = 'case_candidate_review@1' as const;
export const CONFIDENCE_HIGH_THRESHOLD = 0.8;

export type CaseEvolutionEngine = 'claude' | 'openai' | 'opencode' | 'pi' | (string & {});
export type CaseEvolutionConfidenceBucket = 'high' | 'medium' | 'low';

export interface CaseCandidate {
  candidateId: string;
  schemaVersion: typeof CASE_CANDIDATE_SCHEMA_VERSION;
  provenance: {
    sourceSessionId: string;
    sourceAnalysisRunId: string;
    sourceTurnIndex: number;
    traceContentHash: string;
    capturedAt: number;
    engine: CaseEvolutionEngine;
    sceneType: string;
    architectureType: string;
  };
  cluster: {
    scene: string;
    domainPack: 'scrolling.v1';
    rootCause: string;
    responsibility: CaseKnowledgeResponsibility;
    severity: CaseKnowledgeSeverity;
    frameCount: number;
    percentage: number;
    representativeFrame?: {
      frameId: string;
      durMs: number;
      vsyncMissed: number;
    };
    evidenceSignatures: Record<string, unknown>;
  };
  evidenceHandle: {
    analysisRunId: string;
    clusterIndex: number;
    evidenceRefIds: string[];
    snapshotPath: string;
  };
  verification: {
    claimSupportSummary: string;
    verifierStatus: ClaimVerificationResult['status'];
    verifierIssueSeverities: Array<'error' | 'warning'>;
    verifierErrorCount: number;
    verifierWarningCount: number;
    confidenceNumeric: number;
    confidenceBucket: CaseEvolutionConfidenceBucket;
  };
}

export interface CaseCandidateReview {
  schemaVersion: typeof CASE_CANDIDATE_REVIEW_SCHEMA_VERSION;
  candidateId: string;
  decision: 'promote' | 'reject' | 'needs_more_evidence';
  confidence: CaseEvolutionConfidenceBucket;
  proposed: {
    title: string;
    primaryRootCause: string;
    secondaryRootCauses: string[];
    responsibility: CaseKnowledgeResponsibility;
    severity: CaseKnowledgeSeverity;
    evidenceSignatures: {
      required: CaseEvidenceSignature[];
      supportive: CaseEvidenceSignature[];
    };
    findings: CaseKnowledgeFinding[];
    recommendations: {
      app: CaseKnowledgeRecommendation[];
      oem: CaseKnowledgeRecommendation[];
    };
    relations: CaseKnowledgeRelations;
  };
  evidenceSummary: string;
  risks: string[];
}

export interface CaseCandidateCaptureInput {
  result: AnalysisResult;
  conclusionContract?: ConclusionContract;
  claimVerificationResult?: ClaimVerificationResult;
  dataEnvelopes: DataEnvelope[];
  sceneType: string;
  architectureType?: string;
  knowledgeScope?: KnowledgeScope;
  snapshotPath: string;
  provenance: {
    sessionId: string;
    runId: string;
    turnIndex: number;
    engine: CaseEvolutionEngine;
    traceContentHash: string | null;
  };
}
```

Use `import type` only for `AnalysisResult`, `ConclusionContract`, `ClaimVerificationResult`, `DataEnvelope`, `KnowledgeScope`, and the case-knowledge types. Do not introduce prompt text or runtime writes here.

- [ ] **Step 3: Implement config reader**

Truthy values: `1`, `true`, `yes`. Defaults: all flags off, concurrency 1 capped at 2, queue max 100, cooldown 5 min, daily budget 50, lease 5 min, max attempts 3, poll interval 60s.

- [ ] **Step 4: Validate**

```bash
cd backend
npx jest src/services/caseEvolution/__tests__/caseEvolutionConfig.test.ts --runInBand
```

## Task 3: Candidate Outbox Schema And API

**Files:**
- Create: `backend/src/services/caseEvolution/caseCandidateOutbox.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseCandidateOutbox.test.ts`

**Interfaces:**
- Produces: `openCaseCandidateOutbox(opts?: {dbPath?: string}): CaseCandidateOutboxHandle`
- Produces: `CaseCandidateOutboxHandle.enqueue(candidate, opts)`
- Produces: `leaseNext({workerOwner, leaseDurationMs, maxAttempts})`
- Produces: `markReviewed(candidateId, {review, notePath})`, `markRejected(candidateId, reason)`, `markFailed(candidateId, reason, maxAttempts?)`, `releaseLease(candidateId)`, `expireStaleLeases(now?)`
- Produces: metrics helpers `countCandidatesByState()`, `countSupported()`, `dailyCounts(now?)`, `workerHealth(now?)`

- [ ] **Step 1: Write failing tests**

Cover:

- migration version 1 is applied;
- `PRAGMA foreign_keys` is on;
- generated `supported` column computes 0 for pending and 1 when `state='reviewed'` and `supporting_evidence >= 3`;
- active dedupe rejects duplicate `dedupe_key` while state is `pending_review` or `reviewed`;
- lease sets `lease_owner`, `lease_until`, increments `attempts`, and keeps lifecycle `state='pending_review'`;
- stale lease expires back to leasable;
- `markFailed` retries until max attempts then `state='rejected'`;
- `candidate_feedback` unique index rejects duplicate `(candidate_id, source_session_id)`.

- [ ] **Step 2: Implement v1 migration**

Use the SQL from design §1.4 with these PR A notes:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

Lifecycle states stay exactly:

```sql
CHECK(state IN ('pending_review','reviewed','rejected','archived'))
```

Do not add a `leased` state. Leasing is represented by `lease_owner` and `lease_until`, so the lifecycle enum stays aligned with the design.

- [ ] **Step 3: Implement outbox handle**

Mirror `selfImprove/reviewOutbox.ts` style:

- create parent directory for file DB;
- migrations run in transactions;
- enqueue failure returns structured `{enqueued:false, reason:'duplicate_active'|'queue_full'|'error'}` and never throws to capture;
- row JSON parse failures mark candidate rejected with `last_error` instead of throwing from the worker loop;
- close DB explicitly in tests.

- [ ] **Step 4: Validate**

```bash
cd backend
npx jest src/services/caseEvolution/__tests__/caseCandidateOutbox.test.ts --runInBand
```

## Task 4: Scrolling Candidate Projection And Capture Gate

**Files:**
- Create: `backend/src/services/caseEvolution/scrollingCandidateProjector.ts`
- Create: `backend/src/services/caseEvolution/caseCandidateBuilder.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseCandidateBuilder.test.ts`

**Interfaces:**
- Produces: `projectScrollingCandidateClusters(dataEnvelopes: DataEnvelope[]): CaseCandidateCluster[]`
- Produces: `buildCaseCandidatesFromRun(input: CaseCandidateCaptureInput, deps?: {existingPublishedCaseKeys?: Set<string>}): CaseCandidate[]`
- Consumes: `DataEnvelope.meta.skillId`, `meta.stepId`, `meta.evidenceRefId`, `data.columns`, `data.rows`

- [ ] **Step 1: Write failing qualification tests**

Use minimal DataEnvelope fixtures shaped like existing tests:

```ts
{
  meta: {type:'skill_result', version:'2.0.0', source:'scrolling_analysis:batch_frame_root_cause', skillId:'scrolling_analysis', stepId:'batch_frame_root_cause', evidenceRefId:'ev-root', timestamp: 2},
  display: {layer:'list', format:'table', title:'掉帧列表'},
  data: {columns:['reason_code','jank_responsibility','frame_count','percentage','frame_id','dur_ms','vsync_missed','render_slices_json'], rows:[['shader_compile','APP',4,18,'f1',58.8,3,'["makePipeline"]']]}
}
```

Assert:

- no candidate when `CASE_EVOLUTION_CAPTURE_ENABLED` is off (tested through Task 5 seam);
- no candidate for `confidence < 0.8`;
- no candidate when verifier missing, `status !== 'passed'`, or any `severity='error'`;
- no candidate for `result.rounds <= 1`;
- no candidate below `frameCount >= 3 && percentage >= 15`;
- one candidate per promotable cluster;
- dedupe key is `traceContentHash::sceneType::primaryRootCause`;
- candidate id includes run id so separate runs have distinct audit ids;
- `evidenceHandle.evidenceRefIds` uses shared `dataEnvelopeRefId()`;
- `evidenceHandle.snapshotPath` copies the maintainer-confirmed snapshot resolver string from the capture input;
- `traceContentHash: null` fails closed unless the design explicitly allows external-RPC traces later.

- [ ] **Step 2: Implement projection**

Rules:

- only `scrolling.v1` in PR A;
- read existing `batch_frame_root_cause`, do not re-cluster;
- support rows as `data.rows` plus `data.columns`;
- parse JSON string fields such as `render_slices_json` defensively;
- map `jank_responsibility` to responsibility:
  - `APP` -> `app`
  - `SF` / display-pipeline values -> `oem`
  - mixed evidence -> `mixed`
  - missing/unknown -> `unknown`
- severity from percentage/vsync: keep deterministic and documented in tests.

- [ ] **Step 3: Implement builder**

The builder is pure. It must not open SQLite, `CaseLibrary`, or files. It returns candidates or `[]`.

- [ ] **Step 4: Validate**

```bash
cd backend
npx jest src/services/caseEvolution/__tests__/caseCandidateBuilder.test.ts --runInBand
```

## Task 5: Fire-And-Forget Save Seam

**Files:**
- Create: `backend/src/services/caseEvolution/saveCaseCandidates.ts`
- Modify: `backend/src/routes/agentRoutes.ts`
- Test: extend `backend/src/services/caseEvolution/__tests__/caseCandidateBuilder.test.ts` or add `saveCaseCandidates.test.ts`

**Interfaces:**
- Produces: `saveCaseCandidates(input: CaseCandidateCaptureInput, deps?: SaveCaseCandidatesDeps): Promise<SaveCaseCandidatesResult>`
- Consumes: `computeTraceContentHash(getTraceProcessorService(), traceId)` from route layer

- [ ] **Step 1: Write seam tests**

Assert:

- flag off returns `{captured:0, skipped:'disabled'}` and does not open outbox;
- enqueue duplicate returns skipped duplicate without throwing;
- outbox error is returned/logged and never thrown;
- external-RPC/no hash returns skipped fail-closed;
- when enabled, qualifying input enqueues candidates.

- [ ] **Step 2: Implement seam**

Dependencies should be injectable for tests:

```ts
interface SaveCaseCandidatesDeps {
  config?: CaseEvolutionConfig;
  outbox?: CaseCandidateOutboxHandle;
  logger?: {
    warn(component: string, message: string, metadata?: Record<string, unknown>): void;
    info(component: string, message: string, metadata?: Record<string, unknown>): void;
  };
  existingPublishedCaseKeys?: Set<string>;
}
```

The production path opens `case_evolution.db` lazily only when capture is enabled.

- [ ] **Step 3: Wire route call**

In `backend/src/routes/agentRoutes.ts`, inside the existing success/partial block immediately after:

```ts
ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);
```

add the fire-and-forget call:

```ts
void (async () => {
  const traceContentHash = await computeTraceContentHash(getTraceProcessorService(), traceId);
  await saveCaseCandidates({
    result,
    conclusionContract: normalizedConclusionContract,
    claimVerificationResult: result.claimVerificationResult,
    dataEnvelopes: session.dataEnvelopes || [],
    sceneType: result.smartScenePreview?.sceneType ?? sceneIdHint,
    architectureType: resolveCaseEvolutionArchitectureType(session, traceId),
    knowledgeScope: options.knowledgeScope,
    snapshotPath: buildCaseEvolutionSnapshotPath(sessionId),
    provenance: {
      sessionId,
      runId: runIdForAnalysis,
      turnIndex: session.activeRun?.sequence ?? session.queryHistory?.at(-1)?.turn ?? 0,
      engine: 'claude',
      traceContentHash,
    },
  });
})().catch(err => logger.warn('CaseEvolution', 'capture failed', {err}));
```

At the primary `/api/agent/v1/analyze` call site, pass `knowledgeScope: knowledgeScopeFromRequestContext(requestContext)` into `runAgentDrivenAnalysis(...)`. At the smart deep-dive call site, forward `options.knowledgeScope`. Add local route helpers:

```ts
function resolveCaseEvolutionArchitectureType(session: AnalysisSession, traceId: string): string {
  const orchestrator = (session as AnalysisSession & {
    orchestrator?: Pick<IOrchestrator, 'getCachedArchitecture'>;
  }).orchestrator;
  return String(orchestrator?.getCachedArchitecture?.(traceId)?.type || 'unknown');
}

function buildCaseEvolutionSnapshotPath(sessionId: string): string {
  return `session-persistence://sessions/${sessionId}/metadata/sessionStateSnapshot`;
}
```

If the maintainer rejects the resolver-string interpretation for `snapshotPath`, stop here and update the plan before implementation.

- [ ] **Step 4: Add route-level regression test**

Add a narrow exported helper around the post-quality capture call so tests can assert order without booting the full Express route. The test must prove `ensureAnalysisQualityArtifacts(...)` runs first, the capture helper receives `result.claimVerificationResult`, failures from the helper are caught and logged, and `completeAgentDrivenSessionWithResult(...)` still runs.

## Task 6: Review Validator And Sidecar Writer

**Files:**
- Create: `backend/src/services/caseEvolution/caseCandidateReviewValidator.ts`
- Create: `backend/src/services/caseEvolution/caseCandidateSidecar.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseCandidateReviewValidator.test.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseCandidateSidecar.test.ts`

**Interfaces:**
- Produces: `validateCaseCandidateReview(raw, candidate, deps): CaseCandidateReviewValidationResult`
- Produces: `writeCaseCandidateSidecar(candidate, review, opts): WriteCaseCandidateSidecarResult`

- [ ] **Step 1: Write validator tests**

Cover:

- accepts valid strict JSON review;
- rejects non-object / missing schema version / mismatched candidate id;
- rejects unknown `decision`, `confidence`, `responsibility`, or `severity`;
- reuses `validateCaseDomainPack()` by building a synthetic `CaseKnowledgeFrontmatter` from candidate + proposed fields;
- rejects unknown `reason_code`;
- scans all free-text fields with `contentScanner.scanContent`;
- drops unknown relation target ids with warning while preserving the candidate;
- rejects payload above 16KB.

- [ ] **Step 2: Write sidecar tests**

Assert:

- writes `<notesDir>/<candidateId>.json` atomically;
- creates parent directory;
- output includes candidate, review, validation warnings, and `writtenAt`;
- invalid candidate id cannot path-traverse.

- [ ] **Step 3: Implement validator**

Use structured checks, not broad `as` casts. Relation target lookup uses injected `CaseLibrary` and accepts only status `published` or `reviewed`.

- [ ] **Step 4: Implement sidecar writer**

Default directory: `backendLogPath('case_candidates')`. Use tmp + rename. Do not write when `CASE_EVOLUTION_NOTES_WRITE_ENABLED` is false; the worker owns that flag decision.

## Task 7: Review Agent SDK With Template Prompt

**Files:**
- Create: `backend/src/services/caseEvolution/caseCandidateReviewAgentSdk.ts`
- Create: `backend/strategies/case-candidate-review.template.md`
- Test: extend validator/worker tests or add SDK prompt render unit tests

**Interfaces:**
- Produces: `executeCaseCandidateReviewViaSdk(candidate, opts?): Promise<CaseCandidateReviewExecutionResult>`
- Produces: `buildCaseCandidateReviewPrompt(candidate): string`

- [ ] **Step 1: Write prompt render tests**

Assert:

- template loads via `loadPromptTemplate('case-candidate-review')`;
- rendered prompt includes candidate JSON and the exact allowed `decision` enum;
- rendered prompt does not include markdown fence requirements that conflict with strict JSON output;
- missing template returns `sdk_invalid` or throws a controlled setup error in tests.

- [ ] **Step 2: Add template**

Template variables:

```md
{{candidate_json}}
{{allowed_reason_codes}}
{{allowed_relation_kinds}}
```

Template requirements:

- independent reviewer;
- no file writes;
- output exactly one JSON object;
- no recommendation text copied from prompt instructions;
- choose `needs_more_evidence` when uncertain.

- [ ] **Step 3: Implement SDK wrapper**

Mirror trust boundary from `selfImprove/reviewAgentSdk.ts`:

- `tools: []`;
- `settingSources: []`;
- no MCP tools;
- `maxTurns: 8`;
- timeout 90s;
- model from `CLAUDE_LIGHT_MODEL` fallback to the current light model;
- parse first balanced JSON object;
- return structured `{ok:false, reason:'sdk_timeout'|'sdk_error'|'sdk_invalid'}`.

## Task 8: Case Evolution Worker

**Files:**
- Create: `backend/src/services/caseEvolution/caseEvolutionWorker.ts`
- Create: `backend/src/services/caseEvolution/caseEvolutionWorkerBootstrap.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseEvolutionWorker.test.ts`

**Interfaces:**
- Produces: `CaseEvolutionWorker`
- Produces: `startCaseEvolutionWorker(env?: NodeJS.ProcessEnv): {started:boolean; stop():void}`

- [ ] **Step 1: Write worker tests**

Mirror `selfImprove/__tests__/reviewWorker.test.ts`:

- `start()` returns false when `CASE_EVOLUTION_REVIEW_ENABLED` is unset;
- successful executor + valid review writes sidecar when notes flag is on and marks candidate reviewed per maintainer checkpoint;
- successful executor + notes flag off stores review JSON but no sidecar, or records a clear no-op result;
- schema/content rejection marks candidate rejected permanently;
- SDK timeout/error retries until max attempts then rejects;
- daily budget blocks leasing;
- concurrency caps at 2;
- stale leases expire.

- [ ] **Step 2: Implement worker**

The worker owns:

- lease recycle;
- daily budget check;
- SDK execution injection for tests;
- validation;
- sidecar write;
- outbox state transition;
- stats.

The worker must not import `CaseLibrary.saveCase`, `CaseGraph`, or `RagStore`; PR A is shadow-only.

- [ ] **Step 3: Bootstrap in `index.ts`**

Add startup after middleware/routes are configured but before server listen is acceptable. The bootstrap must be safe in tests and must return a stopper for graceful shutdown if the existing server shutdown path has one.

## Task 9: Metrics Skeleton And Admin Endpoint

**Files:**
- Create: `backend/src/services/caseEvolution/caseEvolutionMetricsAggregator.ts`
- Modify: `backend/src/routes/strategyAdminRoutes.ts`
- Test: `backend/src/services/caseEvolution/__tests__/caseEvolutionMetricsAggregator.test.ts`
- Test: `backend/src/routes/__tests__/strategyAdminRoutes.caseEvolution.test.ts`

**Interfaces:**
- Produces: `collectCaseEvolutionMetrics(opts?): CaseEvolutionMetrics`
- Endpoint: `GET /api/admin/case-evolution/metrics`

- [ ] **Step 1: Write metrics tests**

Assert:

- zeros when DB/log dir absent;
- counts candidates by `pending_review`, `reviewed`, `rejected`, `archived`;
- counts `supported`;
- counts sidecar files;
- reports worker daily budget values when DB is present;
- corrupt DB or invalid sidecar JSON becomes `warnings[]`, not throw.

- [ ] **Step 2: Implement aggregator**

Return the §11.1 skeleton fields available in PR A:

```ts
{
  collectedAt,
  candidates: {byState, supported, learnedCasesInLibrary: 0, privateRetained: 0},
  outbox: {todayEnqueued, todayReviewed, todayIngested: 0, todayFailed, dailyBudgetUsed, dailyBudgetLimit},
  worker: {running, lastPollAt, attemptsHistogram},
  feedback: {totalPositive: 0, totalNegative: 0, distinctSessions: 0},
  retriever: {todayQueries: 0, todayStrongHits: 0, todayPruned: 0, avgLatencyMs: 0},
  prompt: {todaySegmentsBuilt: 0, todayDroppedForBudget: 0},
  flags,
  warnings,
}
```

Use zero placeholders only for PR B/C systems not implemented yet; name them as unavailable rather than pretending data exists.

- [ ] **Step 3: Add route**

Add route under existing authenticated `strategyAdminRoutes.ts`:

```ts
router.get('/case-evolution/metrics', (_req, res) => {
  try {
    res.json(collectCaseEvolutionMetrics());
  } catch {
    res.status(500).json({success:false, error:'Failed to aggregate case evolution metrics'});
  }
});
```

- [ ] **Step 4: Add route auth/smoke test**

Add `backend/src/routes/__tests__/strategyAdminRoutes.caseEvolution.test.ts` using the existing route-test auth helper style. Assert unauthenticated requests are rejected and an authenticated `GET /api/admin/case-evolution/metrics` returns JSON with `collectedAt`, `candidates.byState`, `flags`, and `warnings`.

## Task 10: PR A Integration Smoke And Safety Invariant Review

**Files:**
- No new production files beyond Tasks 1-9.
- Test: `backend/src/services/caseEvolution/__tests__/caseEvolutionShadowIntegration.test.ts`

**Interfaces:**
- Consumes: all PR A modules.

- [ ] **Step 1: Write shadow integration test**

Use `:memory:` outbox, fake executor, temp sidecar dir, and DataEnvelope fixture:

1. Build a qualifying capture input.
2. `saveCaseCandidates()` enqueues one candidate.
3. Worker leases it.
4. Fake review returns `decision:'promote'`.
5. Validator passes.
6. Sidecar is written.
7. No `CaseLibrary`, `CaseGraph`, or `RagStore` writes occur.

- [ ] **Step 2: Add resume/reconnect-focused test**

PR A version: simulate capture input built from live `result` + `session.dataEnvelopes` after a reconstructed session object. Assert the capture builder never reads `_lastSnapshot.conclusionContract` and still uses `dataEnvelopes`. This covers the design's persistence caveat without implementing PR B report/prune behavior.

- [ ] **Step 3: Add prune-step guard coverage for PR A**

`verifyAndPruneCaseRecommendations` is not created in PR A, but the PR still needs §10.2 coverage for the prune integration point. Add a guard test proving PR A does not mutate `conclusionContract.caseRecommendations`, does not attach report hits, and leaves the verifier/prune route ordering available for PR B. PR B will add the positive prune test where a strong hit is removed and a warning issue is merged.

- [ ] **Step 4: Manual auto-publish invariant trace**

Before PR A completion, trace the only states/actions implemented:

```text
capture -> case_candidates.pending_review
worker promote -> sidecar + case_candidates.reviewed (or confirmed alternative)
NO CaseLibrary write
NO CaseGraph write
NO RagStore write
NO publishCase call
NO backend/knowledge/cases write
```

Any code path reaching `CaseLibrary.publishCase()` in PR A is a release blocker.

## Task 11: Focused Verification

- [ ] **Step 1: Run focused PR A tests**

```bash
cd backend
npx jest \
  src/services/caseEvolution/__tests__/dataEnvelopeRef.test.ts \
  src/services/caseEvolution/__tests__/caseEvolutionConfig.test.ts \
  src/services/caseEvolution/__tests__/caseCandidateOutbox.test.ts \
  src/services/caseEvolution/__tests__/caseCandidateBuilder.test.ts \
  src/services/caseEvolution/__tests__/caseCandidateReviewValidator.test.ts \
  src/services/caseEvolution/__tests__/caseCandidateSidecar.test.ts \
  src/services/caseEvolution/__tests__/caseEvolutionWorker.test.ts \
  src/services/caseEvolution/__tests__/caseEvolutionMetricsAggregator.test.ts \
  src/services/caseEvolution/__tests__/caseEvolutionShadowIntegration.test.ts \
  src/routes/__tests__/strategyAdminRoutes.caseEvolution.test.ts \
  --runInBand
```

- [ ] **Step 2: Run affected existing tests**

```bash
cd backend
npx jest \
  src/agentv3/selfImprove/__tests__/reviewOutbox.test.ts \
  src/agentv3/selfImprove/__tests__/reviewWorker.test.ts \
  src/agentv3/selfImprove/__tests__/metricsAggregator.test.ts \
  --runInBand
```

- [ ] **Step 3: Run project-defined gates from the objective**

```bash
cd backend
npm run build
npm run validate:strategies
npm run validate:skills
npm run validate:cases
npm run ingest:cases
npm run test:scene-trace-regression
```

- [ ] **Step 4: Run root PR gate before opening/landing**

```bash
npm run verify:pr
```

- [ ] **Step 5: Simplification check**

If `/simplify` or `code-simplifier` is unavailable:

```bash
git diff --check
```

Then manually review changed code for duplicated schema logic, accidental prompt text in TS, route bloat, and any unneeded abstraction.

## Task 12: Independent Review Gate Before Execution Continues To PR B

- [ ] Use available read-only reviewer/subagent if present. Reviewer prompt:

```text
Review PR A only. Do not edit files. Focus on:
- any path from captured/reviewed candidate to CaseLibrary.publishCase()
- runtime writes outside backend/data/self_improve and backend/logs/case_candidates
- feature flags not default-off
- SQLite lease/dedupe correctness
- route capture ordering after ensureAnalysisQualityArtifacts
- prompt content accidentally hardcoded in TypeScript
- missing tests for shadow capture, review validation, sidecar writes, metrics
```

- [ ] If no stable reviewer is available, record:

```text
Codex review: NOT AVAILABLE
Review fallback: findings-first manual architecture review over final diff.
```

- [ ] Fix any confirmed P0/P1 issues and rerun the smallest affected focused tests plus `git diff --check`.

## Completion Criteria

- PR A writes no learned cases into `CaseLibrary`, `CaseGraph`, `RagStore`, or `backend/knowledge/cases/`.
- All case-evolution flags default off.
- With only `CASE_EVOLUTION_CAPTURE_ENABLED=1`, qualifying full verified runs enqueue candidates but do not run the reviewer.
- With capture + review + notes enabled, worker writes sidecars and marks rows according to the maintainer-confirmed PR A/PR B state handoff.
- `/api/admin/case-evolution/metrics` returns a failure-tolerant snapshot.
- Focused Jest suites pass.
- `cd backend && npm run build` passes.
- `cd backend && npm run validate:strategies` passes.
- `cd backend && npm run validate:skills` passes.
- `cd backend && npm run validate:cases` passes.
- `cd backend && npm run ingest:cases` passes.
- `cd backend && npm run test:scene-trace-regression` passes.
- Root `npm run verify:pr` passes before opening/landing.
- Simplification review completed; `git diff --check` passes if no simplifier tool is available.
- Manual/independent review has no unresolved severe findings.
