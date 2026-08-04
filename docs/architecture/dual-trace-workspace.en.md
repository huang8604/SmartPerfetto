# Dual Trace Workspace Operation Model

[English](dual-trace-workspace.en.md) | [中文](dual-trace-workspace.md)

This document defines the Web UI operation model for Raw Trace Compare. It
extends the comparison-mode section in [Architecture Overview](overview.en.md)
and focuses on user operations, AI Panel context, frontend/backend coordination,
and edge cases. Analysis Result Compare still uses the workspace comparison API
and is out of scope here.

## Product Principles

- The default remains single-window. Opening a normal trace shows one Perfetto
  timeline and the AI Panel.
- The AI Panel header provides a direct `Open Dual View` button. It immediately
  opens a shell with the `current` trace in one pane and an empty pane waiting
  for a history trace; no separate picker step is required first.
- Both physical panes have a trace selector. The user decides which pane shows
  `current` and which shows the historical `reference`. Selecting history in
  the current pane atomically moves `current` to the other pane, with no
  duplicate-trace or no-current intermediate state.
- History options use `filename` as the primary label. Upload time and file size
  are secondary metadata; trace ids remain identity keys rather than the main
  user-facing label.
- The semantic pair is always the current page's `current` parent plus one
  workspace-history `reference`. Pane placement is flexible, but arbitrary
  history-versus-history pairs are not supported.
- Layout changes, maximize/minimize, and AI Panel hide/show only change visual
  state. They do not destroy or reload existing iframes.
- The dual workspace header owns a persistent `AI Assistant` button. It is the
  in-workspace control for collapsing or restoring the conversation panel while
  retaining the workspace controller, iframe identities, run, and SSE owner.
- While analysis is running or waiting for confirmed cancellation,
  `current + reference + agent session/run` is one locked execution identity.
  Selectors, new-pair creation, comparison exit, session/New Chat, provider,
  workspace, backend URL, and backend access-token changes cannot replace it.
  Layout, splitter, maximize/minimize, AI Panel hide/show, and reopening the
  visual workspace for the same pair remain available. Only explicit Stop
  enters the backend cancellation protocol.
- Collapsing the AI Panel is visual-only and retains the same Panel and SSE
  owner. Even before `/analyze` returns a session id, reopening still exposes
  Stop for that request. Pop Out/Dock operations that would change the Panel's
  mount owner are deferred until the run reaches a terminal state.
- Explicitly exiting the dual view, unloading the current trace, or switching
  workspace destroys the dual-view iframes. Exiting only the visual workspace
  may preserve its reference and AI comparison context; `Exit comparison`
  additionally clears the reference, context, and comparison agent session.
- Dual workspace iframes do not own new AI sessions and do not re-upload traces.
  They are complete Perfetto timeline views only.

## State Machine

| State | UI | Backend comparison capability | Entered by | Leaves by |
| --- | --- | --- | --- | --- |
| Single trace | One timeline + AI Panel | Single-trace tools | Normal trace open, exit comparison, workspace switch, new trace reset | Click `Open Dual View` |
| Dual workspace draft | Current timeline + one empty reference pane | Still single-trace tools | Click `Open Dual View` | Select history, explicitly exit, or switch trace/workspace |
| Dual workspace paired | Two complete timelines, each with a selector | `referenceTraceId` and comparison tools available, plus visual layout state | Select history in either selector | Explicitly exit dual view, exit comparison, or switch trace/workspace |
| Comparison context | One timeline + comparison bar | `referenceTraceId` and comparison tools remain available | Explicitly exit a paired dual view | Reopen dual view, exit comparison, or switch trace/workspace |
| Pane minimized | One live iframe + one minimized rail | Both traces remain analyzable; minimized pane is `context_only` | Pane minimize button | Restore rail, reset, maximize another pane, exit |
| Pane maximized | One iframe fills the workspace | Maximized pane is `live`; other pane is `context_only` | Pane maximize button | Restore, reset, exit |

## Loading Flow

### 1. Normal Trace Load

1. The user opens a trace in Perfetto UI.
2. The frontend uploads/registers it through `/api/traces/upload` or an existing
   HTTP RPC target.
3. Once `backendTraceId` is ready, the AI Panel becomes analyzable.
4. `referenceTraceId = null` and the dual workspace is not open yet.

If the current backend trace is not ready, the comparison entry should not open
a partial workspace.

### 2. Direct Dual Workspace Open

1. The user clicks `Open Dual View` in the AI Panel header.
2. The frontend requires only a ready current `backendTraceId`; a
   `referenceTraceId` is not required yet.
3. The trace-scoped workspace controller immediately opens
   `ai-trace-pair-workspace`. The first pane shows `current` by default, and the
   second pane shows a `Select a history trace` empty state.
4. The frontend concurrently loads the current workspace's trace catalog and
   excludes current by id.
5. Each history option uses `filename` as its label. Localized upload time and
   file size are appended only when same-name records need disambiguation.
   Records with the same filename remain distinct by id.

At this point the dual-view shell is usable, but AI requests remain single-trace
until the user selects history: no `referenceTraceId` is sent and comparison
tools are not enabled.

### 3. Select a Trace in Either Pane

1. Both pane selectors list the current trace and every available history trace.
2. Selecting current in the other pane changes only its physical placement.
3. Selecting history in either pane makes that trace the sole `reference` and
   atomically moves current to the other pane.
4. The first reference selection stores `referenceTraceId/referenceTraceName`
   and enables raw trace comparison. Selecting different history changes only
   the reference identity.
5. The selectors cannot form `history A + history B`; the current parent always
   remains in the pair.

Moving current or swapping the same pair does not recreate either iframe.
Selecting a different historical reference changes the reference iframe URL,
so only that reference iframe loads a new trace; the current iframe is retained.

### 4. Iframe Loading

Once the workspace is open, each pane with a selected trace creates a
same-origin iframe with:

- `hideSidebar=true`
- `mode=embedded`
- `smartperfettoDualTrace=true`
- `smartperfettoPane=current|reference`
- `url=/api/workspaces/:workspaceId/traces/:traceId/file`

`load_trace.ts` sees `smartperfettoDualTrace=true` and skips AI backend upload.
Each iframe uses Perfetto UI's own WASM engine to load a complete timeline. The
empty reference pane has no iframe until the user selects history.

The main AI Panel remains the only conversation entry.

## Workspace Operations

| Operation | Entry | State change | AI context effect |
| --- | --- | --- | --- |
| Select a trace for a pane | Either pane selector | Current selection moves placement only; history becomes reference and atomically moves current to the other pane | `primarySide/referenceSide` follow physical placement; a new reference resets incompatible comparison session state |
| Horizontal/vertical layout | Workspace toolbar | `tracePairLayout = horizontal|vertical`, clears maximized, retains both iframe nodes | `primarySide/referenceSide` map to left/right or top/bottom |
| Drag splitter | Middle separator | Updates `tracePairSplitPercent`, clamped to 18-82 | `splitPercent` enters `tracePairContext` |
| Maximize pane | Pane toolbar | `tracePairMaximizedTraceSide = current|reference`, clears minimized, keeps iframe mounted | Maximized pane is `live`; the other is `context_only` |
| Minimize pane | Pane toolbar | `tracePairMinimizedTraceSides = {side}`, clears maximized, keeps iframe mounted | Minimized pane is `context_only`; the other is `live` |
| Restore minimized pane | Minimized rail | Removes side from minimized set and reuses the same iframe | Pane becomes `live` |
| Open pane in new tab | Pane toolbar | No current-state change | Auxiliary viewing only |
| Hide/show AI Panel | AI Panel entry | Toggles only the conversation surface; dual host, controller, and iframes remain | No change |
| Exit dual view | Workspace header | Closes the visual workspace, destroys its iframes, and clears max/min | Existing comparison context remains; workspaceOpen becomes false |
| Exit comparison | Comparison bar | With no active run, clears reference, agent session, and workspace state; disabled while running | Future requests become single-trace |

The dual host belongs to the current trace lifecycle and is a sibling of the AI
Panel's Right/Bottom/floating/hidden surface. Layout, maximize/minimize, and AI
Panel hide/show reuse the same semantic iframe nodes and `src` values. Only
explicit dual-view exit, current-trace unload, or workspace switch destroys
them; reopening creates them again. A new reference is an identity change and
loads only the reference side.

## AI Panel Context Contract

When `referenceTraceId` exists, the frontend sends `tracePairContext` with the
analysis request:

```json
{
  "traceId": "current-trace-id",
  "referenceTraceId": "reference-trace-id",
  "options": {
    "tracePairContext": {
      "schemaVersion": 1,
      "layout": "horizontal",
      "primarySide": "right",
      "referenceSide": "left",
      "activeSide": "left",
      "workspaceOpen": true,
      "splitPercent": 50,
      "panes": [
        {
          "side": "right",
          "traceSide": "current",
          "traceId": "current-trace-id",
          "traceName": "current.perfetto-trace",
          "active": false,
          "visualState": "live"
        },
        {
          "side": "left",
          "traceSide": "reference",
          "traceId": "reference-trace-id",
          "traceName": "reference.perfetto-trace",
          "active": true,
          "visualState": "live"
        }
      ],
      "aliases": {
        "left": "reference",
        "right": "current",
        "top": "reference",
        "bottom": "current",
        "current": "current",
        "reference": "reference"
      }
    }
  }
}
```

Rules:

- Top-level request `traceId` is always the originally opened current parent;
  `referenceTraceId` is always the sole historical reference selected in a pane.
- `current` and `reference` are semantic roles, not fixed positions. Current may
  be left/right or top/bottom. `primarySide/referenceSide`, `panes[].side`, and
  positional aliases must be derived from `currentPane`.
- Selecting history in the pane that holds current atomically updates
  `currentPane` and reference; it must never briefly construct two history
  traces or lose current.
- Moving the same pair does not change `traceId/referenceTraceId` or reset its
  comparison session. A reference identity change must drop incompatible prior
  comparison session state.
- `activeSide` comes from the latest hovered/focused pane. When the workspace is
  closed, current is active by default.
- `visualState=live` means the pane is visible. `context_only` means the trace
  is still analyzable but not currently visible.
- Backend normalization drops illegal sides/layouts, duplicate minimized sides,
  and clamps split to 18-82.

## Frontend/Backend Coordination

| Layer | Responsibility |
| --- | --- |
| Perfetto UI main page | Opens current trace and owns the workspace controller/host for the trace lifecycle, independently of whether the AI Panel is mounted |
| AI Panel | Provides the direct dual-view entry, loads history catalog, builds `tracePairContext`, and sends `referenceTraceId` |
| Pane selectors | Display current/history by filename and maintain current placement plus the sole reference identity |
| Dual workspace iframe | Loads a full Perfetto timeline from a workspace trace file URL; visual-only changes keep its node and `src`, and it never owns a comparison session |
| `load_trace.ts` | Detects `smartperfettoDualTrace=true` and skips backend AI upload |
| Backend analyze route | Normalizes `tracePairContext` and passes `referenceTraceId` to the runtime |
| MCP registry | Exposes comparison tools only when `referenceTraceId` exists |
| Agent runtime | Uses shared comparison methodology and resolves current/reference or left/right/top/bottom references |
| Report/snapshot | Keeps the raw trace comparison evidence/report/session snapshot contract aligned with CLI `smp compare` |

## Edge Cases

- Current trace not ready: do not open comparison or dual workspace until
  `backendTraceId` is ready.
- No reference trace: still open the dual shell with current available and a
  `Select a history trace` empty pane; ask the user to upload another trace.
- Reference trace file cannot be read: the affected iframe shows the Perfetto
  load failure; backend SQL/Skill calls report the actual trace-service error.
- User opens a new trace: destroy dual-view iframes, reset to Single trace,
  clear reference/workspace state, and create or restore the new trace's session.
- Workspace switch: destroy dual-view iframes and clear catalog, reference,
  workspace state, and agent session; URLs must use the new workspace path.
- Dual view exited: its iframes are destroyed, but `referenceTraceId` remains,
  so future questions are still dual-trace comparison with
  `workspaceOpen=false`. Reopening recreates the iframes for the same pair.
- Comparison exited: `referenceTraceId` is cleared; future requests no longer
  register comparison tools or send `tracePairContext`.
- Pane minimized/maximized or layout changed: hidden panes are still analyzable
  and should be described as context-only, not missing. These visual changes
  preserve both iframe DOM nodes and `src` values.
- AI Panel hidden/shown or repositioned: Right/Bottom/floating/hidden AI Panel
  state neither unmounts the dual view nor reloads its iframes, and does not
  change current/reference semantics.
- Pane selector changes: moving current reuses both iframes; selecting a new
  history trace changes the reference identity and loads only its iframe. The
  product never permits arbitrary `history A versus history B` pairs.
- Multi-turn sessions: entering comparison drops incompatible single-trace agent
  state; exiting comparison drops comparison agent state. Provider/runtime
  pinning still follows normal session rules.

## Completion Criteria

Dual Trace Workspace changes are complete only when current evidence proves:

- Normal trace open defaults to a single timeline.
- Clicking `Open Dual View` in the AI Panel header immediately displays the
  current-plus-empty-reference shell without a prior history selection.
- Both pane selectors work; selecting history in the current pane atomically
  moves current to the other pane.
- History options lead with filename and use time/size as secondary metadata;
  distinct ids with the same filename remain separately selectable.
- Selecting a reference displays two complete timelines while the pair remains
  current parent plus one historical reference.
- Horizontal/vertical layout, dragging, minimize/maximize, and AI Panel
  hide/show do not replace or reload existing iframes.
- During analysis, selectors and every session-identity mutation stay locked,
  while layout operations, AI Panel hide/show, and visual reopening of the same
  pair neither stop nor replace the active run.
- Settings, workspace, backend URL/access token, and Provider writes stay
  locked during a run. Pre-session hide/show retains the same Stop owner, and
  collapsing an established SSE does not reconnect it.
- Explicit dual-view exit, trace unload, and workspace switch destroy the
  iframes; exit comparison additionally clears reference and comparison session.
- Dual workspace iframes do not create extra backend trace uploads.
- Dual workspace iframes retain only the timeline and parent redraw bridge; they
  do not register an AI Panel, status entry, or independent session owner.
- Stop carries the exact `runId` from the current receipt. A replacement run in
  the same session waits until the cancelled runtime has fully settled, so
  late cleanup from the old run cannot terminate or contaminate the new run.
- `tracePairContext` remains correct with current in either physical pane, dual
  view open/exited, vertical/horizontal, and max/min states.
- Backend normalization and system prompt handling are stable for invalid or
  missing fields.
- The committed `frontend/` prebuild has been refreshed for `./start.sh`.
