<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Changelog

All notable changes to SmartPerfetto are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commit prefixes follow [Conventional Commits](https://www.conventionalcommits.org/).
Detailed commit-level history is available via `git log`.

## [Unreleased]

### Added
- Fast / Full / Auto three-tier analysis mode routing via `options.analysisMode`
  (env-configurable per-turn timeouts, classifier fast-path via keyword rules).
- Scene reconstruction pipeline with independent `sceneStoryService`
  (JobRunner concurrency=3, Haiku-summarized `SceneReport`).
- State Timeline V1: four swim-lane track overlays (device/input/app/system).
- Trace comparison prototype: three conditional MCP tools, orthogonal
  comparison mode.
- Perfetto stdlib integration: 22 critical-preload tables, `list_stdlib_modules`
  MCP tool, `lookup_knowledge` for on-demand background knowledge.
- Deep root-cause analysis skills: `blocking_chain_analysis`,
  `binder_root_cause`, `startup_slow_reasons`, `frame_blocking_calls`.
- Android version diff analysis (system-behavior vs app-adaptation root causes).
- Scrolling jank taxonomy: 21 reason codes, 2 new skills.
- Trace data completeness: capability registry + session-init probing.

### Changed
- agentv3 is now the primary runtime (Claude Agent SDK orchestrator, 20 MCP tools).
- Six shell scripts under `scripts/`; typecheck + test:core covered by `/health`
  dashboard.

### Fixed
- `claudeRuntime.ts` SDK `query()` close-handle convention to prevent zombie
  trace_processor_shell subprocesses.
- Verifier tightened around shallow root causes (critical-severity findings
  must include a quantitative claim and ≥ 2 causal chains).

## [0.1.0] - 2025-12-14

### Added
- Initial public repository structure.
- Perfetto fork submodule (`perfetto/`) with custom UI plugin
  `com.smartperfetto.AIAssistant`.
- Backend Express service with SSE streaming, in-memory session management,
  and trace_processor_shell integration.
- YAML skill system (`backend/skills/`) with L1–L4 layered results and
  `DataEnvelope` v2.0 contract.
- Scene classifier (12 scenes: scrolling / startup / anr / pipeline / memory /
  game / teaching / interaction / touch-tracking / overview / scroll-response /
  general) driven by strategy front-matter.
- Strategy + template system under `backend/strategies/` (`*.strategy.md`,
  `*.template.md`) with hot reload in dev mode.
- HTML report generation and CSV / JSON export.
- AGPL v3.0 licensing throughout.

[Unreleased]: https://github.com/Gracker/SmartPerfetto/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Gracker/SmartPerfetto/releases/tag/v0.1.0
