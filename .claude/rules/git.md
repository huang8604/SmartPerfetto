# Git and Submodule Rules

## Repository Remotes

Root repository:

- `origin`: `git@github.com:Gracker/SmartPerfetto.git`

Perfetto submodule:

- Path: `perfetto/`
- This is a fork of Google's official Perfetto repository.
- `origin` inside the submodule is upstream Google Perfetto.
- `fork` inside the submodule is Gracker's fork.

Never push SmartPerfetto submodule changes to upstream `origin`.

## Root Workflow

1. Inspect `git status --short --branch` before editing.
2. Preserve unrelated local changes; assume they belong to the user.
3. Run the verification tier that matches the change.
4. Stage only the files that belong to the requested change.
5. Commit with a descriptive message.
6. Push the active branch when the task asks for push/ship.

## Portable Release Workflow

Portable releases are published from the root repository, not from the
`perfetto/` submodule. The default release uploads Windows x64, macOS arm64,
and Linux x64 assets to the same GitHub Release.

Normal public release flow:

1. Start from an up-to-date clean `main`.
2. Run `npm run version:set -- <version>`.
3. Commit `package.json`, `package-lock.json`, `backend/package.json`, and
   `backend/package-lock.json`.
4. Push `main`.
5. Run `npm run package:portable`.
6. Run `npm run release:portable -- <version> --skip-build --no-draft`.

Release invariants:

- Asset names and top-level directories must be versioned:
  `smartperfetto-v<version>-windows-x64.zip`,
  `smartperfetto-v<version>-macos-arm64.zip`, and
  `smartperfetto-v<version>-linux-x64.tar.gz`.
- Do not publish the old unversioned `smartperfetto-windows-x64.zip` asset
  name.
- Do not use `--allow-dirty` for public releases. It is only acceptable for
  draft/test uploads where a dirty package is intentional.
- `--skip-build` is safe only when the existing zip was freshly built for the
  exact version and commit being released.
- The release script must verify the package manifest, commit, dirty state,
  remote release target, and uploaded asset before reporting success.
- `dist/portable/` and `dist/windows-exe/` are generated output; never stage or
  commit them.

## Submodule Landing Order

When a task changes `perfetto/`:

1. Enter `perfetto/`.
2. Commit the submodule change.
3. Push that commit to the submodule `fork` remote.
4. Return to the root repository.
5. If the change affects the AI Assistant plugin UI or generated Perfetto UI
   output, run `./scripts/update-frontend.sh` and stage the resulting
   `frontend/` changes.
6. Stage the root gitlink (`perfetto`) plus required root artifacts.
7. Commit and push the root repository only after the submodule commit is
   reachable from `fork`.

Do not push a root commit that points to a local-only submodule commit. Docker
Hub and user installs consume the root `frontend/` prebuild and the root
gitlink; both must point to committed, pushed artifacts.

## Generated and Ignored Files

Expected ignored local state includes:

- `.claude/settings.local.json`
- `.claude/worktrees/`
- `backend/logs/`
- `logs/`
- `backend/test-output/`
- `perfetto/out/`
- `node_modules/`

Do not add ignored runtime data unless the task explicitly changes ignore
policy.
