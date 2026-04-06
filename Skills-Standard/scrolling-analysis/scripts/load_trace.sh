#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# load_trace.sh — 加载 Perfetto trace 到 trace_processor 并预加载滑动分析 stdlib 模块
#
# 使用方式:
#   ./load_trace.sh <trace_file> [port]

set -euo pipefail

TRACE_FILE="${1:?Usage: $0 <trace_file> [port]}"
PORT="${2:-9001}"

if [ ! -f "$TRACE_FILE" ]; then
  echo "Error: Trace file not found: $TRACE_FILE"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TP_SHELL=""
for candidate in \
  "$SCRIPT_DIR/trace_processor_shell" \
  "trace_processor_shell" \
  "./trace_processor_shell" \
  "$HOME/perfetto/trace_processor_shell" \
  "/usr/local/bin/trace_processor_shell"; do
  if [ -x "$candidate" ]; then
    TP_SHELL="$candidate"
    break
  elif command -v "$candidate" &>/dev/null; then
    TP_SHELL="$candidate"
    break
  fi
done

if [ -z "$TP_SHELL" ]; then
  echo "Error: trace_processor_shell not found"
  exit 1
fi

echo "=== 加载 Trace (滑动分析) ==="
echo "文件: $TRACE_FILE ($(du -h "$TRACE_FILE" | cut -f1))"

PRELOAD_SQL=$(cat <<'SQL'
-- 滑动分析关键 stdlib 模块
INCLUDE PERFETTO MODULE android.frames.timeline;
INCLUDE PERFETTO MODULE android.binder;
INCLUDE PERFETTO MODULE android.garbage_collection;
INCLUDE PERFETTO MODULE android.monitor_contention;
INCLUDE PERFETTO MODULE android.input;
INCLUDE PERFETTO MODULE linux.cpu.utilization.process;
INCLUDE PERFETTO MODULE linux.cpu.utilization.thread;

SELECT 'stdlib loaded' as status,
  (SELECT COUNT(*) FROM actual_frame_timeline_slice) as frame_count;
SQL
)

echo "$PRELOAD_SQL" | "$TP_SHELL" --httpd -p "$PORT" "$TRACE_FILE"