# Case Knowledge Platform V1 Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the reviewed V1 ingest slice for curated Markdown case knowledge. The ingest path validates Markdown cases, builds runtime `CaseNode` records with `CaseKnowledgeExtension`, derives `CaseGraph` edges, writes `RagStore(kind=case_library)` chunks, proves full-rederive convergence after partial failure, and exposes a minimal HTML report rendering surface for already-validated structured case recommendation hits.

**Architecture:** Markdown files are the source of truth. Runtime stores are rebuildable indexes. V1 adds a generic parser/schema layer, one `scrolling.v1` domain pack, and an ingester that writes through existing service gates instead of bypassing them.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Commander CLI, Jest, existing JSON-backed `CaseLibrary`, `CaseGraph`, and `RagStore`.

## Global Constraints

- V1 entry path is ingest. Do not add retrieval services or MCP citation tools
  in this slice. Report work is limited to rendering structured
  `caseRecommendations` already present on `conclusionContract`; it must not
  perform matching or invent case guidance by scanning the global library.
- Durable case content and recommendations live in Markdown case assets, not in
  TypeScript prompt strings.
- `CaseLibrary.saveCase()` must not be bypassed for `published` records.
  Markdown cases with `status: published` must be written first as a
  non-published redacted case, then promoted through `publishCase()`.
- Markdown-sourced cases with `curator:` are considered redacted by
  construction and must be stamped `redactionState: 'redacted'` during ingest.
- Ingest must be full rederive from Markdown for generated case records,
  generated graph edges, and generated RAG chunks.
- Re-ingest must not downgrade runtime-promoted curation state. Preserve
  `status`, `curatedBy`, and `curatedAt` when an existing generated case has a
  higher curation status than the Markdown source, unless schema validation
  accepts an explicit source downgrade policy.
- `CaseGraph` edges are derived only from Markdown frontmatter `relations`.
- `RagStore` case chunks must use `kind: 'case_library'` and
  `registryOrigin: 'plan54_cases'`.
- All touched code must pass focused tests, `npm run build`, and
  `npm run test:scene-trace-regression` when executable.
- Because `/review` is not available here, final review uses a findings-first
  manual architecture review and records `Codex review: NOT AVAILABLE`.

## Task 1 - Parser, Common Schema, And Domain Pack Tests

- [ ] Add `backend/src/services/__tests__/caseMarkdownParser.test.ts`.
  - Verify valid Markdown frontmatter plus body sections parse into a stable
    object with `filePath`, `frontmatter`, and `body`.
  - Verify missing frontmatter returns a validation error with the file path.
  - Verify malformed YAML returns a validation error and does not throw raw
    parser internals.
- [ ] Add `backend/src/services/__tests__/caseSchemaValidator.test.ts`.
  - Verify required fields: `case_id`, `title`, `status`, `quality`, `scene`,
    `domain_pack`, `taxonomy`, `evidence_signatures`, `findings`,
    `recommendations`, and `relations`.
  - Verify `status: published` requires non-empty `curator`.
  - Verify recommendation quality gate requires both `app` and `oem` arrays and
    each recommendation has `id`, `priority`, `action`, `applies_when`, and
    `risks`.
  - Verify duplicate `case_id` across files is rejected.
- [ ] Add `backend/src/services/__tests__/scrollingDomainPackValidator.test.ts`.
  - Verify `scrolling.v1` accepts known evidence fields and reason codes.
  - Verify an unknown evidence field is rejected.
  - Verify an unknown `reason_code` value is rejected.

Expected first run:

```bash
cd backend
npx jest src/services/__tests__/caseMarkdownParser.test.ts \
  src/services/__tests__/caseSchemaValidator.test.ts \
  src/services/__tests__/scrollingDomainPackValidator.test.ts --runInBand
```

The tests should fail because the new modules do not exist yet.

## Task 2 - Implement Types, Parser, Schema Gate, And `scrolling.v1`

- [ ] Add `backend/src/types/caseKnowledge.ts` with the V1 data contract:
  - `CaseKnowledgeQuality = 'curated' | 'imported' | 'weak'`
  - `CaseKnowledgeResponsibility = 'app' | 'oem' | 'mixed' | 'unknown'`
  - `CaseKnowledgeSeverity = 'critical' | 'warning' | 'info'`
  - `CaseKnowledgeRecommendationPriority = 'P0' | 'P1' | 'P2' | 'P3'`
  - `CaseEvidenceSignatureOperator = 'eq' | 'contains_any' | 'gte' | 'lte'`
  - `CaseEvidenceSignature`
  - `CaseKnowledgeRecommendation`
  - `CaseKnowledgeFinding`
  - `CaseKnowledgeRelations`
  - `CaseKnowledgeExtension`
  - parsed/validation helper types used by services.
- [ ] Update `backend/src/types/sparkContracts.ts` so `CaseNode` has
  `knowledge?: CaseKnowledgeExtension`.
- [ ] Add `backend/src/services/caseMarkdownParser.ts`.
  - Parse YAML frontmatter with the existing YAML dependency.
  - Keep body as Markdown text; do not render HTML.
  - Return structured validation errors instead of throwing for user input.
- [ ] Add `backend/src/services/caseDomainPacks.ts`.
  - Register immutable `scrolling.v1`.
  - Define allowed evidence fields:
    `reason_code`, `render_slices`, `main_slices`, `jank_responsibility`,
    `vsync_missed`, and `critical_path`.
  - Define allowed operators per common schema:
    `eq`, `contains_any`, `gte`, `lte`.
  - Define V1 allowed reason codes from existing scrolling analysis vocabulary:
    `buffer_stuffing`, `sf_composition_slow`, `binder_sync_blocking`,
    `gc_jank`, `gc_pressure_cascade`, `input_handling_slow`,
    `small_core_placement`, `sched_delay_in_slice`, `shader_compile`,
    `gpu_fence_wait`, `render_thread_heavy`, `workload_heavy`,
    `thermal_throttling`, `cpu_max_limited`, `big_core_low_freq`,
    `freq_ramp_slow`, `cpu_saturation`, `scheduling_delay`,
    `main_thread_file_io`, `uninterruptible_wait`, `binder_timeout`,
    `lock_binder_wait`, and `unknown`.
- [ ] Add `backend/src/services/caseSchemaValidator.ts`.
  - Validate common fields and enums.
  - Validate recommendation shape.
  - Validate relation blocks are arrays.
  - Delegate domain-specific evidence checks to `caseDomainPacks.ts`.
  - Export `validateCaseKnowledgeFiles(rootDir)` for CLI use.

Validation:

```bash
cd backend
npx jest src/services/__tests__/caseMarkdownParser.test.ts \
  src/services/__tests__/caseSchemaValidator.test.ts \
  src/services/__tests__/scrollingDomainPackValidator.test.ts --runInBand
```

## Task 3 - Ingester And Store Behavior Tests

- [ ] Add `backend/src/services/__tests__/caseIngester.test.ts`.
  - Use temp directories and explicit store paths.
  - Verify ingest writes `CaseLibrary` records with `knowledge` extension.
  - Verify frontmatter `relations` produce deterministic `CaseGraph` edges.
  - Verify `RagStore` chunks use `kind='case_library'` and
    `registryOrigin='plan54_cases'`.
  - Verify unchanged re-ingest is idempotent at the observable data level.
  - Verify changed Markdown upserts by `case_id`.
  - Verify stale generated graph edges and case chunks are removed on full
    rederive.
  - Verify simulated crash after the first store write leaves partial state,
    and the next full ingest converges `CaseLibrary`, `CaseGraph`, and
    `RagStore` back to the Markdown source.
  - Verify runtime-promoted published status is preserved when Markdown has a
    lower status and the ingester emits a warning.
- [ ] Add `backend/src/services/__tests__/casePublishGate.test.ts`.
  - Verify a Markdown-sourced published case with `curator` passes the existing
    `publishCase()` gate.
  - Verify a published case without `curator` fails validation before ingest.

Expected first run:

```bash
cd backend
npx jest src/services/__tests__/caseIngester.test.ts \
  src/services/__tests__/casePublishGate.test.ts --runInBand
```

The tests should fail until Task 4 is implemented.

## Task 4 - Implement Full-Rebuild Ingester

- [ ] Add `backend/src/services/caseIngester.ts`.
  - Export `ingestCaseKnowledge(options)`.
  - Options include `casesDir`, explicit storage paths for tests, optional
    service instances, optional `knowledgeScope`, and test-only
    `failAfterStore?: 'caseLibrary' | 'caseGraph' | 'ragStore'`.
  - Run validation before any write.
  - Convert validated Markdown to `CaseNode`.
  - Use `source: 'curated_markdown_case'` or another stable generated-source
    string so stale generated cases can be identified.
  - Stamp Markdown curator provenance into `curatedBy`/`curatedAt` as
    appropriate.
  - Stamp `redactionState: 'redacted'` for Markdown curated cases with
    `curator`.
  - For `status: published`, call `saveCase()` with `status: reviewed` first,
    then `publishCase()`.
  - Preserve existing higher runtime curation state and emit a warning instead
    of downgrading.
  - Remove stale generated cases whose source matches the generated-source
    string and whose `caseId` is absent from current Markdown.
  - Remove stale generated graph edges before adding derived frontmatter edges.
  - Remove stale generated RAG chunks before writing current chunks.
  - Return a summary with parsed case count, written case count, edge count,
    chunk count, warnings, and store paths.
- [ ] Add narrow `RagStore` list support in `backend/src/services/ragStore.ts`.
  - Prefer `listChunks(opts?: {kind?: RagSourceKind; registryOrigin?:
    RagChunk['registryOrigin']; uriPrefix?: string; scope?: KnowledgeScope})`.
  - Keep existing `search()` semantics unchanged.
- [ ] Use deterministic IDs.
  - Case edge id: `case-edge:${fromCaseId}:${relation}:${toCaseId}`.
  - RAG chunk id: `case:${caseId}:summary`.
  - RAG uri: `case://${caseId}`.

Validation:

```bash
cd backend
npx jest src/services/__tests__/caseIngester.test.ts \
  src/services/__tests__/casePublishGate.test.ts --runInBand
```

## Task 5 - CLI, Scripts, And Curated Cases

- [ ] Modify `backend/src/cli/commands/validate.ts`.
  - Add `--cases`.
  - When `--cases` is set without `skillId` and without unrelated validate
    modes, run pure case validation and exit non-zero on errors.
  - Print a concise summary with file count and error count.
- [ ] Add `backend/src/cli/commands/ingest.ts`.
  - Add `ingest --cases`.
  - Default `casesDir` to `backend/knowledge/cases`.
  - Write default stores under backend logs via existing runtime path helpers.
  - Support useful local flags such as `--cases-dir <path>` and `--dry-run`
    only if they stay small and testable.
- [ ] Modify `backend/src/cli/index.ts` to register `ingestCommand`.
- [ ] Modify `backend/package.json`.
  - Add `validate:cases`: `tsx src/cli/index.ts validate --cases`.
  - Add `ingest:cases`: `tsx src/cli/index.ts ingest --cases`.
  - Add `npm run validate:cases` to `verify:pr`.
- [ ] Add two curated Markdown cases under `backend/knowledge/cases/scrolling/`.
  - One `status: published` case with `curator`.
  - One `status: reviewed` case that exercises mixed App/OEM guidance.
  - Both cases must include app and OEM recommendations.
  - Case bodies should be concise but useful; avoid raw trace PII.

Validation:

```bash
cd backend
npm run validate:cases
npm run ingest:cases
```

If `npm run ingest:cases` writes runtime logs, inspect status and avoid staging
generated log data unless intentionally tracked.

## Task 6 - Full Verification And Review

- [ ] Run focused test suite:

```bash
cd backend
npx jest src/services/__tests__/caseMarkdownParser.test.ts \
  src/services/__tests__/caseSchemaValidator.test.ts \
  src/services/__tests__/scrollingDomainPackValidator.test.ts \
  src/services/__tests__/caseIngester.test.ts \
  src/services/__tests__/casePublishGate.test.ts --runInBand
```

- [ ] Run required project verification:

```bash
cd backend
npm run build
npm run test:scene-trace-regression
```

- [ ] If trace regression command is absent or impossible in this environment,
  record `trace regression: NOT CONFIGURED` or the concrete blocker.
- [ ] Run simplification fallback because `/simplify` and `code-simplifier` are
  not available as callable tools:

```bash
git diff --check
```

Also manually review changed code for unnecessary abstraction, duplicate logic,
and accidental prompt hardcoding.

- [ ] Review fallback:
  - Record `Codex review: NOT AVAILABLE`.
  - Perform findings-first manual architecture review over the final diff.
  - Fix any confirmed correctness, data-loss, safety, concurrency/lifecycle,
    performance, missing-test, or architecture-boundary issue.

## Task 7 - Post-Review Report Display Addendum

- [ ] Add a structured `CaseKnowledgeReportRecommendation` contract for report
  consumption.
- [ ] Allow `ConclusionContract` to carry `caseRecommendations`.
- [ ] Render `caseRecommendations` in `HTMLReportGenerator` without performing
  retrieval or evidence matching inside the renderer.
- [ ] Show `case_id`, `applies_when`, and `risks` for direct strong
  recommendations.
- [ ] Render partial/background matches with an explicit `evidence_gap` note
  and "context only" wording.
- [ ] Cover the report section in `htmlReportGenerator.test.ts`.

## Completion Criteria

- All Task 1-5 and Task 7 tests pass.
- `npm run validate:cases` passes.
- `npm run build` passes.
- `npm run test:scene-trace-regression` passes or is recorded with a valid
  project/environment reason.
- `git diff --check` passes.
- Manual architecture review has no unresolved severe findings.
