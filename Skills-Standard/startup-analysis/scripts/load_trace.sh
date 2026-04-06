#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# load_trace.sh — 加载 Perfetto trace 到 trace_processor 并预加载 stdlib 模块
#
# 使用方式:
#   ./load_trace.sh <trace_file> [port]
#
# 示例:
#   ./load_trace.sh startup.pftrace 9001
#
# 前置条件:
#   - trace_processor_shell 已安装（可从 Perfetto release 下载）

set -euo pipefail

TRACE_FILE="${1:?Usage: $0 <trace_file> [port]}"
PORT="${2:-9001}"

if [ ! -f "$TRACE_FILE" ]; then
  echo "Error: Trace file not found: $TRACE_FILE"
  exit 1
fi

# 查找 trace_processor_shell（优先使用同目录下的内置版本）
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
  echo "Download from: https://github.com/nicedavid98/trace_processor/releases"
  echo "Or: pip install perfetto"
  exit 1
fi

echo "=== 加载 Trace ==="
echo "文件: $TRACE_FILE ($(du -h "$TRACE_FILE" | cut -f1))"
echo "端口: $PORT"
echo "trace_processor: $TP_SHELL"
echo ""

# 预加载启动分析所需的 stdlib 模块
PRELOAD_SQL=$(cat <<'SQL'
-- 启动分析关键 stdlib 模块
INCLUDE PERFETTO MODULE android.startup.startups;
INCLUDE PERFETTO MODULE android.startup.time_to_display;
INCLUDE PERFETTO MODULE android.startup.startup_breakdowns;
INCLUDE PERFETTO MODULE android.binder;
INCLUDE PERFETTO MODULE android.garbage_collection;
INCLUDE PERFETTO MODULE android.monitor_contention;
INCLUDE PERFETTO MODULE android.frames.timeline;
INCLUDE PERFETTO MODULE android.input;
INCLUDE PERFETTO MODULE linux.cpu.utilization.process;
INCLUDE PERFETTO MODULE linux.cpu.utilization.thread;

-- 验证加载
SELECT 'stdlib loaded' as status,
  (SELECT COUNT(*) FROM android_startups) as startup_count,
  (SELECT COUNT(*) FROM actual_frame_timeline_slice) as frame_count;
SQL
)

echo "启动 trace_processor (HTTP RPC on :$PORT)..."
echo "$PRELOAD_SQL" | "$TP_SHELL" --httpd -p "$PORT" "$TRACE_FILE"