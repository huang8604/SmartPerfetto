#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export SMARTPERFETTO_PORTABLE_OUT_DIR="${SMARTPERFETTO_WINDOWS_OUT_DIR:-$PROJECT_ROOT/dist/windows-exe}"
exec "$PROJECT_ROOT/scripts/release-portable.sh" "$@" --targets windows-x64
