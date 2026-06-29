# Case Knowledge Platform Design

Date: 2026-06-20
Status: Approved design, implementation not started

## Context

This design extends [Plan 54: Case Graph、公共 Case 库与社区实验](../../superpowers/spark/plans/54-case-graph-library.md)
(Spark #162, #179, #180, #195, #196, #203). Plan 54 landed the minimum
scaffolding; this doc specifies the richer curated-case schema, validation
gates, and domain-pack concept that Plan 54 deferred as "complex strategy
留给后续迭代." Plan 54's hard rule applies: **接入路径只选一个主入口 — do not
lay out multiple main entry paths in one slice.** This doc's V1 cut
(see "First Version Scope") honors that by choosing the ingest path as the
primary entry, plus a narrow report renderer that only consumes already
structured case hits. Retrieval, evidence matching, and citation tools land as
later slices.

### What already exists (Plan 54 M0/M1)

| Component | Status | Notes |
|---|---|---|
| `CaseLibrary` (`backend/src/services/caseLibrary.ts`) | Built | File + enterprise-DB store; `publishCase()` double-control gate (reviewer + `redactionState='redacted'`). **Disk store is empty today** — `backend/logs/case_library.json` does not exist. |
| `CaseGraph` (`backend/src/services/caseGraph.ts`) | Built | 6 named relations (`similar_root_cause`, `same_app`, `same_device`, `before_after_fix`, `derived_pattern`, `contradicts`) + open string. No FK enforcement to CaseLibrary. |
| `RagStore` `kind=case_library` | Plumbed, **not written** | `RagSourceKind` includes `case_library` and `registryOrigin='plan54_cases'`, but **no ingester publishes CaseNodes as RagChunks**. The keyword-search path exists; `case_library` chunks do not. |
| `recall_similar_case` MCP tool | Built (read-only) | Filters by `tags` / `key` (appId/deviceId/cuj); **no evidence-signature matching, no scene/root-cause filtering.** Drafts/private never surface. |
| `CaseNode` / `CaseEdge` types (`sparkContracts.ts:1784,1833`) | Built | Minimum-field shape per Plan 54; does **not** carry domain-pack, evidence-signature, recommendation, or responsibility fields this design needs. |
| Markdown case source (`backend/knowledge/cases/**/*.md`) | **Does not exist** | Proposed here. |
| `validate:cases` / `ingest:cases` scripts | **Do not exist** | Proposed here. |
| `cite_case_in_report` MCP tool | Deferred | Comment at `claudeMcpServer.ts:3906` explicitly defers it; lands as its own commit. |
| Anything that sets `redactionState='redacted'` | **Does not exist** | `publishCase` *checks* the field; nothing *produces* it. This is a hard blocker for getting any case to `published` via the existing gate. |

Strategy and Skill rules (`.claude/rules/prompts.md`, `.claude/rules/skills.md`)
require durable analysis knowledge to live in strategy, Skill, docs, or
knowledge assets instead of hardcoded TypeScript prompt strings.

The product gap is not only that reports need more text. Reports need a
structured way to connect trace evidence, prior cases, and role-specific
optimization guidance. For mixed problems such as a long scroll containing
many dropped frames with several causes, the system must cluster problems,
quantify their proportions, and attach App-side and OEM/vendor-side actions
with evidence boundaries.

## Goals

1. Build a generic case knowledge platform that can support scrolling,
   startup, ANR, power, memory, and future domains.
2. Use human-maintained Markdown/YAML files as the source of truth for curated
   cases so changes can be reviewed, diffed, and rebuilt.
3. Reuse existing runtime stores:
   `CaseLibrary`, `CaseGraph`, and `RagStore(kind=case_library)`.
4. Support both App and OEM/vendor recommendations for each applicable problem.
5. Make report recommendations evidence-bound, citation-backed, and explicit
   about applicability and risks.
6. Keep domain-specific logic in domain packs, not in the generic platform
   kernel or report generator.

## Non-Goals For V1

- No bulk historical report import.
- No embedding/vector database requirement. Existing keyword retrieval is
  acceptable for the first version.
- No full knowledge graph UI.
- No automatic generation of publishable cases from raw trace analysis.
- No complete domain-pack coverage across every SmartPerfetto scene.
- No private report-only prompt path that bypasses DataEnvelope, snapshots, or
  evidence contracts.

## Architecture

The platform has four layers.

### 1. Source Layer

Curated cases live as Markdown files with YAML frontmatter:

```text
backend/knowledge/cases/**/*.md
```

Markdown is the authoritative source. Runtime stores are rebuildable indexes.
The source layer is optimized for human curation, code review, and version
control.

### 2. Validation And Ingest Layer

The ingester parses frontmatter and body, validates common schema, validates
domain-pack rules, normalizes fields, and writes derived records to the
runtime stores.

```text
Markdown case files
  -> common schema validation
  -> domain pack validation
  -> recommendation quality gate
  -> CaseLibrary
  -> CaseGraph
  -> RagStore(kind=case_library)
```

V1 should expose local commands. These extend the existing `validate` command
at `backend/src/cli/commands/validate.ts` (same shape as `validate --strategies`
and `validate --contracts --all`), not a new CLI binary:

```bash
cd backend
npm run validate:cases    # tsx src/cli/index.ts validate --cases
npm run ingest:cases      # tsx src/cli/index.ts ingest --cases
```

`validate:cases` runs without touching runtime stores (pure parse + schema +
domain-pack + recommendation gate). `ingest:cases` runs validation first, then
writes to `CaseLibrary` / `CaseGraph` / `RagStore(kind=case_library)` and is
idempotent (re-ingesting an unchanged Markdown file is a no-op; changed files
upsert by `case_id`). The `validate` subcommand registry in `cli/index.ts`
gains a `--cases` flag; the existing `verify:pr` chain (`backend/package.json`
line 76) should be amended to include `validate:cases` once it exists.

### 3. Retrieval Layer

Retrieval is two-stage:

1. Structured filtering by scene, root cause, audience, pipeline, vendor,
   architecture, status, and evidence signatures.
2. Text retrieval/ranking with `RagStore` over title, body chunks, finding text,
   recommendation text, and evidence summary.

This prevents a semantically similar but evidence-incompatible case from being
used as strong guidance.

### 4. Report Integration Layer

Reports consume case knowledge through problem clusters, not through raw user
query text. A domain pack converts analysis output into clusters, then the case
retriever attaches matching cases and App/OEM recommendations to each cluster.

```text
Analysis DataEnvelope/artifacts
  -> domain problem clusters           (projection of batch_frame_root_cause distribution)
  -> evidence signatures               (one signature set per cluster)
  -> case retrieval                    (strong/partial/background matching)
  -> recommendation selection          (strong only becomes direct guidance)
  -> report sections and citations     (case id + applies_when + risks)
```

#### Integration surface (AI Output Contract)

Case recommendations must not be smuggled into a free-text conclusion string.
They enter the report through one of these typed surfaces (pick at
implementation time, prefer the first to keep the change smallest):

1. **`conclusionContract` claim with a `case` evidence anchor.** Each
   recommendation becomes a claim of `kind: 'recommendation'`
   (`conclusionContract.ts`) whose `references[]` carries a new
   `EvidenceAnchorV1.producerKind: 'case_library'` pointing at the matched
   `caseId`. The Evidence Contract builder
   (`evidenceContractBuilder.ts:567`) renders the provenance; the HTML report
   renders the recommendation through `renderConclusionClaimSourcesSection`.
2. **New read-only MCP tool** (the deferred `cite_case_in_report`) the agent
   calls when its cluster analysis points at a strong match. Output joins the
   agent's conclusion text, but the tool's return shape is typed so the
   verifier (`deterministicClaimVerifier.ts`) can re-check that the case id
   actually exists and the required signatures matched.

Option 1 is the smaller diff and keeps the AI Output Contract intact (the
recommendation is a verified claim, not prompt text). Option 2 is larger but
matches how `recall_similar_case` already works. Whichever is chosen, the
`final_report_contract` in `scrolling.strategy.md` should gain a
`case_recommendations` section gate so the contract checker enforces presence
when a strong match existed.

## Core Case Schema

The common schema defines stable fields shared by all domains.

```yaml
case_id: scroll_shader_compile_pixel8_001
title: 滑动中 RenderThread shader 编译导致连续掉帧
status: draft | reviewed | published
quality: curated | imported | weak
scene: scrolling
domain_pack: scrolling.v1

taxonomy:
  primary_root_cause: shader_compile
  secondary_root_causes: [render_thread_heavy]
  responsibility: app | oem | mixed | unknown
  severity: critical | warning | info

context:
  app_architecture: android_view_standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll

evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: shader_compile
    - field: render_slices
      op: contains_any
      value: ["compileShader", "makePipeline", "Shader"]
  supportive:
    - field: jank_responsibility
      op: eq
      value: APP
    - field: vsync_missed
      op: gte
      value: 1

findings:
  - id: f1
    title: Shader 编译落在关键帧路径内
    evidence_refs: []
    confidence: high

recommendations:
  app:
    - id: app_precompile_shader
      priority: P0
      action: 提前 warm-up / precompile shader，避免首次滑动时同步编译
      applies_when: RenderThread 出现 shader/makePipeline 编译且与掉帧帧窗口重叠
      risks: 预热会增加启动或首屏内存/CPU，需要选择低影响窗口
  oem:
    - id: oem_gpu_freq_floor
      priority: P1
      action: 检查 GPU/CPU 频率响应和 RenderThread 调度优先级
      applies_when: shader 编译不可完全消除，且同帧存在低频、小核或调度延迟证据
      risks: 频率策略会影响功耗，需要按场景白名单或短时 boost

relations:
  # Frontmatter relations are the AUTHORITATIVE source for authored knowledge.
  # The ingester derives CaseGraph edges from this block (single source of truth).
  # Do not write relations to CaseGraph by any other path, or the two will drift.
  similar_root_cause: []
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: []
  contradicts: []
```

### Domain-pack versioning

`domain_pack: scrolling.v1` is part of the case identity, not metadata.
Versioning rules:

- A pack version is **immutable once published**. `scrolling.v1` can never
  rename or remove an evidence-signature field, change an operator's meaning,
  or repurpose a `reason_code` value. Additive changes (new optional fields,
  new `reason_code` values) are allowed within `v1`.
- Breaking changes require a new version: `scrolling.v2`. The retriever
  matches a case only against the pack version it declares, so old cases stay
  valid under their pack and never silently re-resolve against new semantics.
- The validator rejects a case whose `domain_pack` is unknown or whose
  evidence-signature fields reference names the declared pack version does not
  define. This is the guard that makes immutability real.

This matters because evidence signatures are the strong/weak gate. If a pack
could silently redefine `reason_code: shader_compile` to mean something else,
every previously-ingested case would start matching (or stop matching) without
anyone reviewing the diff.

The Markdown body should use stable headings:

```md
## Symptom

## Evidence Chain

## Critical Path

## App Guidance

## OEM Guidance

## Anti-patterns
```

These headings are not the only content the report can use. They are the
curation format for humans and the text source for RAG chunks.

## Domain Packs

A domain pack defines how a scene extends the common case platform. It owns:

- Accepted root-cause taxonomy for the domain.
- Evidence signature fields and operators.
- Cluster extraction rules from DataEnvelope/artifact output.
- Structured retrieval weights.
- Required report sections.
- Domain-specific validation rules.

The platform kernel must not know scrolling-specific fields such as
`reason_code`, `frame_id`, or `vsync_missed`. Those belong in `scrolling.v1`.

### V1 Domain Pack

V1 implements the generic platform with one minimal domain pack:

```text
scrolling.v1
```

The pack should support the current `scrolling_analysis` output, especially:

- `batch_frame_root_cause`
- `reason_code`
- `jank_responsibility`
- `primary_cause`
- `dur_ms`
- `vsync_missed`
- `top_slice_name`
- `main_slices_json`
- `render_slices_json`
- `freq_timeline_json`
- representative frame metadata

The pack should group frames into problem clusters. **Do not rebuild the
distribution** — `batch_frame_root_cause` already produces a
`(jank_responsibility, reason_code) → frame_count` distribution via its
`synthesize` block (`scrolling_analysis.skill.yaml:1864`, `groupBy:
[jank_responsibility, reason_code]`). The scroll strategy already forbids
concluding from that batch alone (`scrolling.strategy.md:88` — must deep-dive
each `>15% / >3 frame` cluster). The pack's job is to read that existing
distribution and the per-cluster representative frames the strategy already
demands, and project them into the case-retrieval cluster shape — not to
re-cluster.

A `scrolling.v1` cluster is the projection the retriever consumes:

```yaml
cluster:
  scene: scrolling
  root_cause: shader_compile           # from batch_frame_root_cause.reason_code
  responsibility: app                  # from batch_frame_root_cause.jank_responsibility (APP|SF|HIDDEN|BUFFER_STUFFING)
  frame_count: 18                      # from the synthesize distribution
  percentage: 25.0                     # derived: frame_count / total_jank_frames
  severity: critical                   # domain-pack rule on percentage + vsync_missed
  representative_frame:                # already required by scrolling.strategy.md:66
    frame_id: "59668095"
    dur_ms: 58.87                      # real field: ROUND(actual_dur/1e6,2)
    vsync_missed: 3
  evidence_signatures:
    reason_code: shader_compile        # matched against the reason_code vocabulary in scrolling_analysis.skill.yaml:2985-3085
    render_slices: ["makePipeline"]    # matched against render_slices_json array
```

## Validation Rules

### Schema Gate

The common schema gate requires:

- `case_id`
- `title`
- `status`
- `quality`
- `scene`
- `domain_pack`
- `taxonomy.primary_root_cause`
- `taxonomy.responsibility`
- `recommendations.app`
- `recommendations.oem`

`case_id` must be globally unique. `status=published` cannot be created by
direct save from Markdown. Published promotion must keep using
`CaseLibrary.publishCase()` so redaction and curator signoff stay auditable.

**`redactionState` blocker — must be resolved before V1 can publish anything.**
`publishCase()` requires `existing.redactionState === 'redacted'`
(`caseLibrary.ts:212`), and nothing in the codebase currently *sets* that field.
For Markdown-sourced curated cases (which are already human-written and contain
no raw trace PII by construction), the ingester must either:

- stamp `redactionState: 'redacted'` on ingest with provenance
  `source: 'curated_markdown'` + the curator recorded in frontmatter, so the
  existing gate passes; **or**
- extend the gate to accept a `curated_markdown` provenance class that skips
  the anonymizer requirement the runtime-path cases still need.

The first option is the smaller diff and keeps the gate auditable. The ingester
must refuse to publish if frontmatter lacks an explicit `curator:` field —
that is the human signoff this path relies on instead of an anonymizer run.

### Domain Pack Gate

Each domain pack validates fields it owns. For `scrolling.v1`, V1 should
require at least one required evidence signature that can be matched against
analysis output, such as `reason_code`, `render_slices`, `main_slices`,
`jank_responsibility`, or critical-path fields.

### Recommendation Gate

Each recommendation must include:

- `id`
- `priority`
- `action`
- `applies_when`
- `risks`

Recommendations missing applicability or risk boundaries must not be emitted as
strong report guidance. They can remain in draft or review status.

## Runtime Storage Mapping

### CaseLibrary

Store the structured case node:

- `caseId`
- `title`
- `status`
- `key` when available
- `tags`
- `findings`
- curation metadata
- provenance

The source schema (this doc) is richer than the current `CaseNode` type
(`sparkContracts.ts:1784`), which carries no domain-pack, evidence-signature,
recommendation, responsibility, or audience fields. **Do not** paper over the
gap with tag-string concatenation or freeform note packing — that loses the
typed structure the retrieval contract depends on.

The concrete mapping target (pick during implementation, not at design time):

```text
backend/src/types/caseKnowledge.ts   (NEW — typed extension envelope)

interface CaseKnowledgeExtension {
  schemaVersion: 'case_knowledge@1';
  domainPack: string;
  taxonomy: { primaryRootCause; secondaryRootCauses?; responsibility; severity };
  evidenceSignatures: { required; supportive };
  recommendations: { app; oem };
  context: Record<string, unknown>;   // device_vendor, os_version, refresh_rate_hz, workload
}
```

The CaseNode gains one optional `knowledge?: CaseKnowledgeExtension` slot. This
keeps Plan 54's `CaseNode` minimum-field shape stable for existing consumers
(caseRoutes, recall_similar_case, educational filters) while letting the
ingester and retriever read the richer payload through a typed accessor. All
new fields live behind this envelope — the kernel `CaseNode` stays
domain-agnostic, matching the "platform kernel must not know scrolling-specific
fields" rule below.

### CaseGraph

Store relations **derived from** the source frontmatter `relations:` block
during ingest. One frontmatter entry → one `CaseEdge`. The ingester is the
**only** writer of case edges derived from curated Markdown; any other path
(runtime feedback, manual route) writes its own edges with distinct provenance
so the two sources do not silently overwrite each other.

Relations (matching the existing `CaseEdge.relation` union,
`sparkContracts.ts:1833`):

- `similar_root_cause`
- `same_app`
- `same_device`
- `before_after_fix`
- `derived_pattern`
- `contradicts`

Graph edges are useful for report citations and follow-up exploration, but V1
retrieval works without graph traversal — the frontmatter relations are the
retrieval input, and the graph is a queryable index over them.

### RagStore

Chunk the Markdown body plus selected structured summaries under
`kind=case_library`. The chunk text should include:

- title
- scene
- root causes
- evidence chain
- App guidance
- OEM guidance
- anti-patterns

The chunk metadata should preserve `case_id`, scene, root cause tags, and
domain pack identity where the current contract supports it.

## Retrieval Contract

The report path should call a case-retrieval service with structured input:

```ts
interface CaseRecommendationQuery {
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
}
```

The output should separate strong and weak matches:

```ts
interface CaseRecommendationHit {
  caseId: string;
  title: string;
  matchStrength: 'strong' | 'partial' | 'background';
  matchedSignatures: string[];
  missingRequiredSignatures: string[];
  recommendations: {
    app: Recommendation[];
    oem: Recommendation[];
  };
}
```

Only `strong` matches can be used as direct optimization guidance. `partial` or
`background` matches may be cited as context, with an explicit evidence gap.

## Report Output

For each major problem cluster, the report should include:

```md
### 问题簇：shader_compile / RenderThread

- 影响：18/72 帧，25.0%
- 代表帧：frame_id=59668095
- 证据链：RenderThread shader compile 与掉帧窗口重叠
- 相似案例：scroll_shader_compile_pixel8_001

App 侧建议：
1. P0: 提前 warm-up / precompile shader，避免首次滑动时同步编译
   适用条件：RenderThread 出现 shader/makePipeline 编译且与掉帧帧窗口重叠
   风险：预热会增加启动或首屏内存/CPU，需要选择低影响窗口
   来源：case scroll_shader_compile_pixel8_001

OEM/厂商侧建议：
1. P1: 检查 GPU/CPU 频率响应和 RenderThread 调度优先级
   适用条件：shader 编译不可完全消除，且同帧存在低频、小核或调度延迟证据
   风险：频率策略会影响功耗，需要按场景白名单或短时 boost
   来源：case scroll_shader_compile_pixel8_001
```

If required signatures do not match, the report must not present the case as a
direct recommendation. It should say that a similar background case exists but
current trace evidence is insufficient.

## First Version Scope

V1 includes:

- Common Markdown case schema (`backend/knowledge/cases/**/*.md`).
- `scrolling.v1` domain pack definition as the first working pack.
- `validate:cases` and `ingest:cases` (extending `backend/src/cli/commands/validate.ts`).
- Runtime writes into `CaseLibrary` (with `CaseKnowledgeExtension`),
  `CaseGraph` (edges derived from frontmatter), and `RagStore(kind=case_library)`
  (the first code that actually publishes `case_library` chunks).
- Cross-store convergence as a V1 exit criterion: simulate an ingest crash
  after one store write, rerun `ingest:cases`, and assert `CaseLibrary`,
  `CaseGraph`, and `RagStore` converge back to the Markdown source of truth.
- `redactionState` resolution so Markdown-sourced cases can pass the existing
  `publishCase()` gate.
- At least two curated scrolling example cases.
- Unit tests for parser, schema gate, domain-pack gate, ingester idempotency,
  and RagStore chunk writes (see Verification).
- Minimal HTML report renderer support for
  `conclusionContract.caseRecommendations`: it displays `case_id`,
  `applies_when`, `risks`, and explicit evidence-gap wording for
  partial/background matches. The renderer consumes structured hits; it does
  not retrieve cases or perform evidence-signature matching.

V1.1 / V2 (deferred — separate entry paths, separate PRs):

- Structured retrieval service / `recall_similar_case` enhancement with
  scene/root-cause/audience filtering and evidence-signature matching.
- `cite_case_in_report` MCP tool or another write-back path that attaches
  evidence-gated case hits to the conclusion contract.
- `final_report_contract` `case_recommendations` gate.

V1 does not include:

- Bulk import from historical report artifacts.
- Embedding service or vector index.
- UI for editing cases.
- Automatic case promotion from weak/imported to curated.
- Complete domain-pack coverage beyond the initial scrolling pack.

## Verification

For implementation that touches runtime code, run the project-defined commands
that are executable in the current environment:

```bash
cd backend
npm run build
npm run validate:strategies
npm run validate:skills
npm run validate:cases
npm run test:scene-trace-regression
```

Focused tests should cover (concrete files, matching the colocated
`__tests__/` + `*.test.ts` convention used by `caseLibrary.test.ts`,
`caseGraph.test.ts`, `ragStore.test.ts`):

- `backend/src/services/__tests__/caseMarkdownParser.test.ts` — frontmatter
  parse, body-heading stability, malformed-YAML rejection, `case_id` uniqueness
  across files.
- `backend/src/services/__tests__/caseSchemaValidator.test.ts` — common schema
  gate (missing required fields, invalid `status`, invalid `responsibility`).
- `backend/src/services/__tests__/scrollingDomainPackValidator.test.ts` — at
  least one matchable required evidence signature; rejected when only unknown
  fields are referenced.
- `backend/src/services/__tests__/caseIngester.test.ts` — idempotency
  (re-ingest unchanged = no write; changed = upsert by `case_id`); `CaseNode`
  extension written correctly; `CaseGraph` edges derived from frontmatter
  relations; `RagStore` chunks written under `kind=case_library` with
  `registryOrigin='plan54_cases'`; simulated mid-ingest crash followed by
  full-rederive `ingest:cases` converges all three stores back to the Markdown
  source.
- `backend/src/services/__tests__/caseRecommendationRetriever.test.ts` —
  structured retrieval by scene/root cause/audience; strong vs partial vs
  background matchStrength classification; **required-signature gating**: a
  case with unmatched required signatures cannot return `matchStrength='strong'`.
- `backend/src/services/__tests__/casePublishGate.test.ts` — Markdown-sourced
  case reaches `published` only with `curator:` in frontmatter (proves the
  `redactionState` resolution above actually unblocks the gate).
- `backend/src/services/__tests__/htmlReportGenerator.test.ts` — assert the
  rendered report includes `case_id`, `applies_when`, and `risks` for each
  strong recommendation, and that a partial match is rendered with an explicit
  evidence-gap note rather than as direct guidance.

If trace regression is unavailable in a future environment, record
`NOT CONFIGURED`. In this repository, `npm run test:scene-trace-regression`
is already an expected verification path.

## Risks And Mitigations

- Risk: Weak or over-broad cases pollute recommendations.
  Mitigation: V1 prioritizes curated Markdown cases and requires recommendation
  applicability/risk fields.

- Risk: Generic platform becomes a lowest-common-denominator schema.
  Mitigation: Keep the kernel small and move domain-specific fields into domain
  packs.

- Risk: Report generator hardcodes case logic.
  Mitigation: Use a retrieval service and domain-pack cluster contract. Report
  rendering should consume structured recommendation hits.

- Risk: Evidence does not match a retrieved case.
  Mitigation: Required signatures must be checked before a case can contribute
  strong guidance.

- Risk: Case source and runtime indexes drift.
  Mitigation: Treat Markdown as source of truth and make runtime stores
  rebuildable via `ingest:cases`.

## Future Extensions

- Add bulk import for historical reports as `quality=imported` or `weak`.
- Add promotion workflow from imported case to curated case.
- Add vector retrieval when keyword search no longer scales.
- Add domain packs for startup, ANR, power, memory, and interaction.
- Add `cite_case_in_report` when report write-back semantics are clear.
- Add before/after case bundles for verified optimizations.

## What Already Exists (reused, not rebuilt)

| Sub-problem | Existing code this design reuses |
|---|---|
| Curated case store + publish gate | `CaseLibrary` (`caseLibrary.ts:78`), `publishCase()` double-control gate |
| Case relations | `CaseGraph` (`caseGraph.ts:80`) and its 6 named `CaseEdge.relation` values |
| RAG chunk store plumbing | `RagStore` with `kind=case_library` + `registryOrigin='plan54_cases'` already in the type union |
| Tag-based case recall | `recall_similar_case` MCP tool (`claudeMcpServer.ts:3910`) |
| Scroll frame root-cause distribution | `batch_frame_root_cause` skill step + `synthesize groupBy` (`scrolling_analysis.skill.yaml:1860,1864`) — **do not rebuild the clusterer** |
| Representative-frame requirement | `scrolling.strategy.md:66` `representative_frames` contract |
| `reason_code` vocabulary | `scrolling_analysis.skill.yaml:2985-3085` (the values evidence signatures match against) |
| CLI validate subcommand pattern | `backend/src/cli/commands/validate.ts` (`--strategies`, `--contracts --all`) |
| Evidence contract + claim verification | `evidenceContractBuilder.ts`, `deterministicClaimVerifier.ts` (the surfaces recommendation claims attach to) |
| Case type minimum shape | `CaseNode` (`sparkContracts.ts:1784`) — extended via `CaseKnowledgeExtension`, not replaced |

## NOT In Scope (deferred, with rationale)

- **Structured retrieval service / evidence-signature matching** — deferred to V1.1.
  Rationale: Plan 54's single-entry-path rule. V1 ships the ingest path; retrieval
  is a second entry path that needs its own contract test surface.
- **Case retrieval, evidence-signature matching, and `cite_case_in_report`** —
  deferred to V1.1/V2. Rationale: V1 report rendering consumes structured hits;
  selecting those hits and attaching them to a conclusion contract is a separate
  entry path.
- **`final_report_contract` `case_recommendations` gate** — deferred with the
  retrieval/citation path above.
- **Vector / embedding retrieval** — V1 keeps keyword retrieval (already in
  `RagStore.search`). Rationale: no embedding driver exists; adding one is a
  separate Plan 55-adjacent effort.
- **Bulk historical-report import, auto-promotion, editing UI** — explicit
  Non-Goals; no path to them from V1.
- **Domain packs beyond `scrolling.v1`** — V1 proves the pack abstraction with
  exactly one pack. startup/ANR/power/memory land as their own designs.

## Failure Modes

For each new codepath V1 introduces, one realistic production failure and
whether V1 accounts for it:

| Codepath | Failure | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| Markdown parser | Malformed YAML frontmatter | ✅ `caseMarkdownParser.test.ts` | validator exits non-zero with file + line | clear (CLI error) |
| Schema gate | Case missing `curator:` but `status: published` | ✅ `caseSchemaValidator.test.ts` + `casePublishGate.test.ts` | ingester refuses to publish | clear (CLI error) |
| `redactionState` resolution | Markdown case reaches `publishCase` still `raw` | ✅ `casePublishGate.test.ts` | gate throws (existing behavior) | clear (route 4xx) |
| Ingest idempotency | Re-ingest overwrites curator edits made via route | ✅ `caseIngester.test.ts` | ingester must NOT downgrade a runtime-promoted case; upsert by `case_id` while preserving runtime curation fields (`status`, `curatedBy`, `curatedAt`) unless Markdown explicitly moves the source backward through validation | clear CLI warning when runtime curation state is preserved |
| RagStore chunk write | Chunk write succeeds but `CaseNode` write fails mid-transaction | ✅ V1 required: simulated crash + full-rederive convergence test in `caseIngester.test.ts` | no cross-store transaction today; full rederive must repair drift | explicit V1 invariant |
| Domain-pack validation | Case references `reason_code` value the pack doesn't know | ✅ `scrollingDomainPackValidator.test.ts` | validator rejects | clear (CLI error) |
| RagStore search (V1 read path) | `case_library` chunks exist but token-overlap search returns nothing for a real query | ⚠️ keyword search recall is weak; no recall eval | returns empty `RagRetrievalResult` | agent sees "no similar case" — acceptable but worth a recall fixture |

**Critical gap:** no atomic write across `CaseLibrary` + `CaseGraph` + `RagStore`.
If the ingester crashes between writing the `CaseNode` and writing the `RagStore`
chunk (or the `CaseGraph` edge), the three stores drift with no automatic
reconciliation. The mitigation is documented (Markdown is source of truth,
re-run `ingest:cases`) but V1 must make `ingest:cases` a full re-derive from
source on each run — not an incremental patch — so re-running always converges.
This is a V1 exit criterion, backed by a simulated-crash convergence test.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 11 issues fixed inline, 1 critical gap (cross-store drift) tracked |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI in V1) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**UNRESOLVED:** 0 (all findings applied inline; user declined per-issue questions
in favor of reviewer judgment with analytical-accuracy as the sole criterion).

**VERDICT:** ENG CLEARED (PLAN) — ready to implement the V1 ingest slice. V1.1
retrieval and V2 report integration are separate entry paths and need their own
design pass before implementation.

### Review decisions applied (summary)

1. Context section rewritten with an honest "built vs proposed" table; Plan 54
   cross-reference added so this doc is no longer read as duplicating an
   approved plan.
2. Evidence-signature example fixed: `render_thread_heavy_pct` is not a real
   field; replaced with `jank_responsibility` (real, from
   `scrolling_analysis.skill.yaml`).
3. `CaseNode` mapping gap made explicit: a typed `CaseKnowledgeExtension`
   envelope instead of a vague "compatibility layer."
4. `redactionState` blocker surfaced and resolved: Markdown-sourced cases get
   `redactionState: 'redacted'` on ingest with `curator:` provenance.
5. DRY: V1 explicitly reuses the existing `batch_frame_root_cause`
   `synthesize groupBy` distribution rather than rebuilding a clusterer.
6. Single source of truth for relations: frontmatter `relations:` block is
   authoritative; `CaseGraph` edges are derived from it at ingest.
7. Report integration concretized to two named surfaces (conclusionContract
   case anchor OR `cite_case_in_report`), avoiding an AI Output Contract
   violation.
8. CLI scaffold concretized: `--cases` flag on existing `validate` command,
   not a new binary.
9. Test plan concretized with specific file paths matching the colocated
   `__tests__/` convention.
10. V1 cut-line redrawn to honor Plan 54's single-entry-path rule: V1 = ingest
    only; retrieval and report integration move to V1.1/V2.
11. Domain-pack versioning policy added: pack versions are immutable once
    published; breaking changes require a new version.
