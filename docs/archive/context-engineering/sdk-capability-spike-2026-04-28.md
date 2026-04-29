# Claude Agent SDK Capability Spike

> **Date**: 2026-04-28
> **Phase**: v2.1 Phase 1.0 (hard gate)
> **SDK version**: `@anthropic-ai/claude-agent-sdk` (whatever is in `backend/package-lock.json`)

This spike answers two questions that gate Phase 1 (prompt-cache aware
prompting) and Phase 3 (active compact + bounded recovery) of the v2.1
context-engineering refactor:

1. Can `systemPrompt` carry a `cache_control` block / explicit 1h TTL?
2. Can a running `query()` stream accept a mid-stream system message
   so a compact-boundary handler can push a recovery note immediately
   instead of deferring to the next `resume`?

Both are **No** under the current SDK surface. The findings below
collapse Phase 1.1 / Phase 3.1 to their respective fallback designs.

## Methodology

Pure type-signature inspection on `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
No live API calls; the d.ts file is authoritative for whether a feature
is reachable from user code.

## Finding 1 — `systemPrompt` does not accept `cache_control`

```ts
// sdk.d.ts:1052
systemPrompt?: string | {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
};
```

The type union admits exactly two shapes: a plain string (`"You are
..."`) or a Claude Code preset with optional appended instructions.
There is no path to attach `cache_control: { type: 'ephemeral', ttl:
'1h' }` because the SDK never accepts a `BetaTextBlockParam[]`.

**Implication**

- **Phase 1.1 (explicit cache_control TTL)** — not viable without
  bypassing the SDK and calling the Messages API directly. Skip this
  task or rewrite it as "negotiate longer caching by upgrading the
  SDK" once Anthropic exposes the option.
- **Phase 1.2 (stable prefix layout)** still pays off: the SDK
  internally caches whatever string we hand it. Identical prefix
  bytes across turns mean we get the SDK's *default* cache hit (5
  min TTL by default in current Anthropic builds), instead of cache
  thrash. So the work to refactor `claudeSystemPrompt.ts` into
  `{stablePrefix, cacheBoundary, volatileSuffix}` is still valuable —
  just for the implicit cache, not an explicit 1h breakpoint.
- **Phase 1.3 metrics** — `usage.cache_read_input_tokens` is already
  surfaced via `BetaUsage`; the existing `AgentMetricsCollector`
  consumes it. No SDK gap there.

## Finding 2 — no mid-stream message-push API

```ts
// sdk.d.ts (Query handle methods)
interrupt(): Promise<void>;
setPermissionMode(mode: PermissionMode): Promise<void>;
// no pushMessage / sendMessage / appendMessage / injectMessage
```

The Query handle exposes `interrupt()` and `setPermissionMode()` only.
There is no `pushMessage(role, content)` or equivalent way to inject a
user/system message into a live stream.

**Implication**

- **Phase 3.1 (compact_boundary handler "push recovery now")** — not
  viable in-stream. Codex F.5 was right.
- The fallback path **is** still viable: when the token meter trips
  the pre-rot threshold (Phase 3.2 budget), call `query.interrupt()`,
  let the current `query()` settle, then start a new
  `query({ resume: sdkSessionId })` whose `prompt` carries a
  recovery preamble (the existing `sdkQueryWithRetry` already takes
  this shape — see `claudeRuntime.ts:943-979`).
- Trade-off: the recovery note arrives one turn later than the ideal
  in-stream injection, but the cost is one extra round-trip rather
  than total failure to recover.

## Phase 0 — what to do with this report

| Phase | Original plan | Adjusted plan |
|-------|---------------|---------------|
| 1.1   | Configure `cache_control: { ttl: '1h' }` | **Drop**. Document the SDK constraint; revisit when SDK adds the option. |
| 1.2   | Stable prefix, cache breakpoint, volatile suffix | **Keep**, but the "cache breakpoint" becomes a bookkeeping comment in the assembler — not an SDK-visible boundary. |
| 1.3   | Reuse `AgentMetrics` cache fields | **Keep** as-is; SDK already emits `cache_read_input_tokens`. |
| 1.4   | Cache stability test asserting byte-equal prefix | **Keep** — the test is even more important now because the SDK's implicit cache is our only lever. |
| 3.1   | Mid-stream push of recovery on `compact_boundary` | **Drop / replace** with: interrupt + resume + recovery preamble (Codex F.5 fallback). |
| 3.2   | Token meter at 60% of context | **Keep**. |
| 3.3   | Recovery note keeps last N raw tool origins | **Keep** — the recovery preamble in the resume call carries it. |

## Recommendation

Land the type-driven findings as a doc-only commit. Do not gate the
remaining v2.1 work on a runtime spike: the SDK will not silently
loosen its public types, and any new capability will surface as a new
union member in a future SDK release that we can then opt into.
