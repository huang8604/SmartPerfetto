#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Update pre-built frontend after modifying the AI Assistant plugin.
#
# Run this after ./scripts/start-dev.sh has compiled the frontend and
# you have verified your changes in the browser.
#
# Usage:
#   ./scripts/update-frontend.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/perfetto/out/ui/ui/dist"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

# Find the versioned dist directory
VERSION_DIR=$(find "$DIST_DIR" -maxdepth 1 -type d -name 'v54.0-*' -print -quit 2>/dev/null || true)
if [ -z "$VERSION_DIR" ]; then
  echo "ERROR: No compiled frontend found at $DIST_DIR"
  echo "       Run ./scripts/start-dev.sh first to build the frontend."
  exit 1
fi

VERSION=$(basename "$VERSION_DIR")
echo "Found compiled frontend: $VERSION"

# Warn about stale version directories — rsync --delete only cleans inside the
# versioned dir, it does NOT remove old sibling dirs (e.g. v54.0-abc123/).
# Those must be removed manually with: git rm -r frontend/<old-version>/
STALE_DIRS=$(find "$FRONTEND_DIR" -maxdepth 1 -type d -name 'v*' ! -name "$VERSION" 2>/dev/null || true)
if [ -n "$STALE_DIRS" ]; then
  echo "⚠️  Stale version directories found (no longer referenced by index.html):"
  while IFS= read -r stale_dir; do
    printf '     %s\n' "$stale_dir"
  done <<< "$STALE_DIRS"
  echo "   Remove them with: git rm -r <dir>"
  echo ""
fi

echo "Updating frontend/ ..."

# Copy top-level files
cp "$DIST_DIR/index.html"          "$FRONTEND_DIR/index.html"
cp "$DIST_DIR/service_worker.js"   "$FRONTEND_DIR/service_worker.js" 2>/dev/null || true

# Sync versioned directory.
# Exclude source maps (repo size) and JS engine bundles — the --only-wasm-memory64
# build produces 38KB stubs for engine_bundle.js and traceconv_bundle.js instead
# of the real 244KB bundles, so we preserve those from git.
# WASM files ARE real products of the --only-wasm-memory64 build and must be copied.
rsync -a --delete \
  --exclude="*.map" \
  --exclude="engine_bundle.js" \
  --exclude="traceconv_bundle.js" \
  "$VERSION_DIR/" \
  "$FRONTEND_DIR/$VERSION/"

# Restore JS engine bundles if they are missing (e.g. first-time copy of a new
# version directory). The real bundles live in the previous versioned directory
# committed in git; stubs from --only-wasm-memory64 are ~38KB and must not be used.
for BUNDLE in engine_bundle.js traceconv_bundle.js; do
  TARGET="$FRONTEND_DIR/$VERSION/$BUNDLE"
  if [ ! -f "$TARGET" ] || [ "$(wc -c < "$TARGET")" -lt 100000 ]; then
    PREV=$(find "$FRONTEND_DIR" -maxdepth 2 -name "$BUNDLE" ! -path "$TARGET" 2>/dev/null | head -1)
    if [ -n "$PREV" ]; then
      echo "  Restoring $BUNDLE from previous build: $(basename "$(dirname "$PREV")")"
      cp "$PREV" "$TARGET"
    else
      echo "  ⚠️  $BUNDLE not found in any previous version — a full GN+ninja build may be required."
    fi
  fi
done

echo "✅ frontend/ updated to $VERSION"
echo ""
echo "Next steps:"
echo "  git add frontend/"
echo "  git commit -m 'chore(frontend): update prebuilt to $VERSION'"
echo ""
echo "Note: if you upgraded to a new Perfetto version, also remove the old"
echo "  versioned directory: git rm -r frontend/<old-version>/"
