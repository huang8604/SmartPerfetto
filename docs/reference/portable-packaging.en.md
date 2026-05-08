<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Portable Packaging

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

SmartPerfetto portable packages are not single-file binaries. The launcher starts
the bundled Node.js 24 runtime, backend, pre-built Perfetto UI, and pinned
`trace_processor_shell`.

Current release assets:

- `smartperfetto-v<version>-windows-x64.zip`
- `smartperfetto-v<version>-macos-arm64.zip`
- `smartperfetto-v<version>-linux-x64.tar.gz`

## Build

```bash
npm run package:portable
```

Single target:

```bash
npm run package:windows-exe
npm run package:macos-app
npm run package:linux
```

Outputs:

```text
dist/portable/smartperfetto-v<version>-windows-x64.zip
dist/portable/smartperfetto-v<version>-macos-arm64.zip
dist/portable/smartperfetto-v<version>-linux-x64.tar.gz
```

The legacy-compatible Windows command still writes:

```text
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

## Release

Normal public release:

```bash
npm run version:set -- 1.0.3
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v1.0.3"
git push origin main
npm run release:portable -- 1.0.3 --no-draft
```

`release:portable` rebuilds packages, verifies manifests, uploads every target
asset, and verifies the GitHub Release target commit plus asset names. It creates
a draft release by default; pass `--no-draft` to publish immediately.

Single-target release:

```bash
npm run release:portable -- 1.0.3 --targets macos-arm64
npm run release:windows-exe -- 1.0.3
```

Do not use `--allow-dirty` for public releases. Use `--skip-build` only when the
existing asset was freshly built for the exact version and commit.

## macOS Signing and Notarization

Without signing variables, the script creates an unsigned app for local testing.
For public macOS releases, configure:

```bash
export SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
export SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
npm run release:portable -- 1.0.3 --targets macos-arm64
```

When a signing identity is set, the script runs `codesign --options runtime` and
strict verification. When a notary profile is set, it submits with
`xcrun notarytool submit --wait`, staples the `.app`, and recreates the zip.

## User Data Directories

- Windows: package-local `data/` and `logs/`.
- macOS: `~/Library/Application Support/SmartPerfetto` and `~/Library/Logs/SmartPerfetto`.
- Linux: `${XDG_DATA_HOME:-~/.local/share}/smartperfetto` and
  `${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs`.

AI analysis should normally use Provider profiles configured in the UI. For env
credentials, create an `env` file in the platform user data directory and
restart the launcher.

## Verification

The scripts verify package structure, version, manifest, Node runtime, target
native dependencies, and the `trace_processor_shell` pin. Before a public
release, still run a target-platform smoke test:

1. Start the bundled launcher.
2. Open [http://localhost:10000](http://localhost:10000).
3. Check [http://localhost:3000/health](http://localhost:3000/health).
4. Upload a small trace and confirm the platform `trace_processor_shell` starts
   in backend logs.
