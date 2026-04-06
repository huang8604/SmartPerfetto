#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# load_dual_traces.sh — 同时加载问题机和对比机 trace 到两个 trace_processor 实例
#
# 使用方式:
#   ./load_dual_traces.sh <test_trace> <ref_trace> [test_port] [ref_port]
#
# 示例:
#   ./load_dual_traces.sh buggy_device.pftrace good_device.pftrace 9001 9002
#
# 加载后可通过不同端口对两个 trace 执行相同的 SQL 查询进行对比

set -euo pipefail

TEST_TRACE="${1:?Usage: $0 <test_trace> <ref_trace> [test_port] [ref_port]}"
REF_TRACE="${2:?Usage: $0 <test_trace> <ref_trace> [test_port] [ref_port]}"
TEST_PORT="${3:-9001}"
REF_PORT="${4:-9002}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TP_SHELL=""
for candidate in \
  "$SCRIPT_DIR/trace_processor_shell" \
  "trace_processor_shell" \
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

for f in "$TEST_TRACE" "$REF_TRACE"; do
  if [ ! -f "$f" ]; then
    echo "Error: File not found: $f"
    exit 1
  fi
done

PRELOAD_SQL=$(cat <<'SQL'
INCLUDE PERFETTO MODULE android.startup.startups;
INCLUDE PERFETTO MODULE android.startup.time_to_display;
INCLUDE PERFETTO MODULE android.startup.startup_breakdowns;
INCLUDE PERFETTO MODULE android.binder;
INCLUDE PERFETTO MODULE android.garbage_collection;
INCLUDE PERFETTO MODULE android.monitor_contention;
INCLUDE PERFETTO MODULE android.frames.timeline;
INCLUDE PERFETTO MODULE linux.cpu.utilization.process;
INCLUDE PERFETTO MODULE linux.cpu.utilization.thread;
SELECT 'ready' as status;
SQL
)

echo "============================================="
echo "  双 Trace 对比模式"
echo "============================================="
echo ""
echo "问题机 trace: $TEST_TRACE ($(du -h "$TEST_TRACE" | cut -f1))"
echo "  → port $TEST_PORT"
echo ""
echo "对比机 trace: $REF_TRACE ($(du -h "$REF_TRACE" | cut -f1))"
echo "  → port $REF_PORT"
echo ""

# 启动问题机 trace_processor（后台）
echo "[1/2] 加载问题机 trace (port $TEST_PORT)..."
echo "$PRELOAD_SQL" | "$TP_SHELL" --httpd -p "$TEST_PORT" "$TEST_TRACE" &
TEST_PID=$!
sleep 2

# 启动对比机 trace_processor（后台）
echo "[2/2] 加载对比机 trace (port $REF_PORT)..."
echo "$PRELOAD_SQL" | "$TP_SHELL" --httpd -p "$REF_PORT" "$REF_TRACE" &
REF_PID=$!
sleep 2

echo ""
echo "============================================="
echo "  两个 trace_processor 实例已启动"
echo "============================================="
echo ""
echo "问题机: http://localhost:$TEST_PORT  (PID: $TEST_PID)"
echo "对比机: http://localhost:$REF_PORT  (PID: $REF_PID)"
echo ""
echo "对比分析时，对两个端口执行相同的 SQL 查询，然后 diff 结果。"
echo ""
echo "停止: kill $TEST_PID $REF_PID"
echo ""

# 等待两个进程
wait $TEST_PID $REF_PID 2>/dev/null