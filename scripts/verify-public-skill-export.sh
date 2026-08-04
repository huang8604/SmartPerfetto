#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMARTPERFETTO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PERFETTO_SKILLS_DIR="${PERFETTO_SKILLS_DIR:-$(cd "$SMARTPERFETTO_DIR/.." && pwd)/Perfetto-Skills}"

if [[ ! -d "$PERFETTO_SKILLS_DIR/.git" && ! -f "$PERFETTO_SKILLS_DIR/.git" ]]; then
  echo "Perfetto-Skills checkout not found at: $PERFETTO_SKILLS_DIR" >&2
  echo "Clone Gracker/Perfetto-Skills beside SmartPerfetto or set PERFETTO_SKILLS_DIR." >&2
  exit 2
fi

SYNC_CHECKER="$PERFETTO_SKILLS_DIR/tools/sync_smartperfetto.py"
VALIDATOR="$PERFETTO_SKILLS_DIR/tools/validate_catalog.py"
LOCK_FILE="$PERFETTO_SKILLS_DIR/upstreams/smartperfetto.lock.json"
if [[ ! -f "$SYNC_CHECKER" || ! -f "$VALIDATOR" ]]; then
  echo "Perfetto-Skills checkout is missing export verification tools: $PERFETTO_SKILLS_DIR" >&2
  exit 2
fi

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "Perfetto-Skills checkout is missing its SmartPerfetto lock: $LOCK_FILE" >&2
  exit 2
fi

resolve_python_bin() {
  local candidate resolved
  local -a candidates=()
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    candidates+=("$PYTHON_BIN")
  fi
  candidates+=("/usr/bin/python3" "python3")

  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" == */* ]]; then
      resolved="$candidate"
    else
      resolved="$(command -v "$candidate" 2>/dev/null || true)"
    fi
    [[ -x "$resolved" ]] || continue
    if "$resolved" -c 'import json,sys,yaml' >/dev/null 2>&1; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

if ! PYTHON_BIN="$(resolve_python_bin)"; then
  echo "No executable Python 3 runtime with PyYAML is available for public Skill verification." >&2
  exit 2
fi

PINNED_COMMIT="$("$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["commit"])' "$LOCK_FILE")"
if ! git -C "$SMARTPERFETTO_DIR" cat-file -e "${PINNED_COMMIT}^{commit}" 2>/dev/null; then
  echo "Pinned SmartPerfetto commit is not available locally: $PINNED_COMMIT" >&2
  exit 2
fi

# The public checkout intentionally pins an older immutable SmartPerfetto
# commit. Verify that snapshot from an isolated clean worktree instead of
# requiring the active development checkout to remain at the pinned HEAD.
VERIFY_SOURCE="$SMARTPERFETTO_DIR"
TEMP_WORKTREE=""
cleanup() {
  if [[ -n "$TEMP_WORKTREE" ]]; then
    git -C "$SMARTPERFETTO_DIR" worktree remove --force "$TEMP_WORKTREE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

CURRENT_HEAD="$(git -C "$SMARTPERFETTO_DIR" rev-parse HEAD)"
if [[ "$CURRENT_HEAD" != "$PINNED_COMMIT" ]] || [[ -n "$(git -C "$SMARTPERFETTO_DIR" status --porcelain)" ]]; then
  TEMP_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/smartperfetto-public-verify.XXXXXX")"
  rmdir "$TEMP_WORKTREE"
  git -C "$SMARTPERFETTO_DIR" worktree add --detach "$TEMP_WORKTREE" "$PINNED_COMMIT" >/dev/null
  git \
    -c protocol.file.allow=always \
    -c "submodule.perfetto.url=$SMARTPERFETTO_DIR/perfetto" \
    -C "$TEMP_WORKTREE" submodule update --init --recursive perfetto >/dev/null
  VERIFY_SOURCE="$TEMP_WORKTREE"
fi

"$PYTHON_BIN" "$SYNC_CHECKER" \
  --source "$VERIFY_SOURCE" \
  --commit "$PINNED_COMMIT" \
  --report-dir "$PERFETTO_SKILLS_DIR/test-output/verify-smartperfetto" \
  --check
"$PYTHON_BIN" "$VALIDATOR" \
  --catalog "$PERFETTO_SKILLS_DIR/catalog/smartperfetto-export.json" \
  --skill-root "$PERFETTO_SKILLS_DIR/skills/perfetto-performance-analysis"
