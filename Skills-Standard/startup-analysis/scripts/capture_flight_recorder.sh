#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# capture_flight_recorder.sh — Flight-recorder 模式：持续录制 + 事件触发停止
#
# 使用方式:
#   ./capture_flight_recorder.sh [output_file] [timeout_sec]
#
# 操作流程:
#   1. 脚本启动后持续录制（RING_BUFFER 循环覆盖）
#   2. 当观察到卡顿时，在另一个终端执行: adb shell perfetto --trigger jank_detected
#   3. trace 会在触发后 2s 停止并拉取（保留触发前的历史数据）
#   4. 如果无触发，timeout 后自动停止

set -euo pipefail

OUTPUT="${1:-flight_recorder_$(date +%Y%m%d_%H%M%S).pftrace}"
TIMEOUT="${2:-60}"

TRACE_CONFIG=$(cat <<'PERFETTO_CONFIG'
buffers {
  size_kb: 131072
  fill_policy: RING_BUFFER
}
buffers {
  size_kb: 16384
  fill_policy: RING_BUFFER
}
trigger_config {
  trigger_mode: STOP_TRACING
  triggers {
    name: "jank_detected"
    stop_delay_ms: 2000
    producer_name_regex: ".*"
  }
  trigger_timeout_ms: TIMEOUT_PLACEHOLDER
}
data_sources {
  config {
    name: "linux.ftrace"
    target_buffer: 0
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "sched/sched_wakeup"
      ftrace_events: "sched/sched_blocked_reason"
      ftrace_events: "power/cpu_frequency"
      ftrace_events: "power/cpu_idle"
      ftrace_events: "binder/binder_transaction"
      ftrace_events: "binder/binder_transaction_received"
      atrace_categories: "gfx"
      atrace_categories: "view"
      atrace_categories: "input"
      atrace_categories: "sched"
      atrace_categories: "freq"
      atrace_categories: "am"
      atrace_categories: "dalvik"
      atrace_categories: "binder_driver"
      atrace_apps: "*"
      buffer_size_kb: 32768
      drain_period_ms: 250
    }
  }
}
data_sources {
  config {
    name: "linux.process_stats"
    target_buffer: 1
    process_stats_config {
      scan_all_processes_on_start: true
      proc_stats_poll_ms: 1000
    }
  }
}
data_sources {
  config {
    name: "android.surfaceflinger.frametimeline"
    target_buffer: 1
  }
}
PERFETTO_CONFIG
)

# Replace timeout placeholder
TIMEOUT_MS=$((TIMEOUT * 1000))
TRACE_CONFIG=$(echo "$TRACE_CONFIG" | sed "s/TIMEOUT_PLACEHOLDER/$TIMEOUT_MS/")

echo "============================================="
echo "  Flight-Recorder 模式"
echo "============================================="
echo "持续录制中... (timeout: ${TIMEOUT}s)"
echo "触发停止: adb shell perfetto --trigger jank_detected"
echo ""

echo "$TRACE_CONFIG" | adb shell "cat > /data/local/tmp/flight_recorder.cfg"
adb shell "perfetto --config /data/local/tmp/flight_recorder.cfg \
  --out /data/local/tmp/flight_recorder.pftrace"

echo "Trace 已停止，拉取中..."
adb pull /data/local/tmp/flight_recorder.pftrace "$OUTPUT"
adb shell rm /data/local/tmp/flight_recorder.pftrace /data/local/tmp/flight_recorder.cfg 2>/dev/null

echo "完成: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"