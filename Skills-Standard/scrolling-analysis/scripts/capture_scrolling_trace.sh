#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# capture_scrolling_trace.sh — 使用 adb 抓取 Android 滑动性能 trace
#
# 使用方式:
#   ./capture_scrolling_trace.sh [package_name] [output_file] [duration_sec]
#
# 示例:
#   ./capture_scrolling_trace.sh com.example.app scrolling.pftrace 15
#
# 操作流程:
#   1. 脚本启动 trace 后，手动在设备上滑动操作
#   2. trace 自动在设定时长后停止并拉取
#
# 前置条件:
#   - adb 已连接设备
#   - Android 12+ (FrameTimeline 需要 API 31+)

set -euo pipefail

PACKAGE="${1:-}"
OUTPUT="${2:-scrolling_$(date +%Y%m%d_%H%M%S).pftrace}"
DURATION="${3:-15}"
MTK_ENHANCED="${4:-auto}"

# Auto-detect MTK platform
if [ "$MTK_ENHANCED" = "auto" ]; then
  PLATFORM=$(adb shell getprop ro.board.platform 2>/dev/null || echo "")
  if echo "$PLATFORM" | grep -qi "mt\|mediatek"; then
    MTK_ENHANCED="true"
    echo "MTK 平台检测到 ($PLATFORM)，自动启用增强 trace tags"
  else
    MTK_ENHANCED="false"
  fi
fi

# Perfetto trace 配置 — 滑动分析优化
# FrameTimeline + GPU + Input + CPU Freq
#
# 双 buffer 策略:
#   buffers[0] (64MB): ftrace 高频数据 (sched/binder/gpu_frequency 等)
#     - 滑动场景下 sched_switch 和 gfx 事件密集，需要大 buffer 防止被覆盖
#   buffers[1] (16MB): 低频采样数据 (process_stats, frametimeline)
#     - 采样频率低 (500ms/帧级)，独立 buffer 避免被 ftrace 洪流挤占
#   分离 buffer 确保:
#     1. 高频 ftrace 数据不会挤占低频数据的空间
#     2. 低频数据不会浪费高频 buffer 的宝贵容量
#     3. 两类数据各自按 RING_BUFFER 策略独立回收
TRACE_CONFIG=$(cat <<'PERFETTO_CONFIG'
buffers {
  size_kb: 65536
  fill_policy: RING_BUFFER
}
buffers {
  size_kb: 16384
  fill_policy: RING_BUFFER
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
      ftrace_events: "power/gpu_frequency"
      ftrace_events: "binder/binder_transaction"
      ftrace_events: "binder/binder_transaction_received"
      atrace_categories: "gfx"
      atrace_categories: "view"
      atrace_categories: "input"
      atrace_categories: "sched"
      atrace_categories: "freq"
      atrace_categories: "binder_driver"
      atrace_categories: "am"
      atrace_categories: "dalvik"
      # MTK vendor tags (ignored on non-MTK devices)
      atrace_categories: "fpsgo"
      atrace_categories: "ged"
      atrace_apps: "*"
      buffer_size_kb: 16384
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
      proc_stats_poll_ms: 500
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

echo "=== 滑动 Trace 抓取 ==="
[ -n "$PACKAGE" ] && echo "包名: $PACKAGE"
echo "时长: ${DURATION}s"
echo "输出: $OUTPUT"
echo ""

# 1. 推送 trace 配置
echo "[1/3] 推送 Perfetto 配置..."
echo "$TRACE_CONFIG" | adb shell "cat > /data/local/tmp/scroll_trace.cfg"

# 2. 启动 Perfetto trace
echo "[2/3] 启动 Perfetto trace (${DURATION}s)..."
adb shell "perfetto --config /data/local/tmp/scroll_trace.cfg \
  --out /data/local/tmp/scroll_trace.pftrace \
  --time ${DURATION}s \
  --background"

echo ""
echo ">>> 现在请在设备上执行滑动操作 <<<"
echo ">>> trace 将在 ${DURATION}s 后自动停止  <<<"
echo ""

# 3. 等待 trace 完成并拉取
sleep "$DURATION"
echo "[3/3] 拉取 trace 文件..."
sleep 2
adb pull /data/local/tmp/scroll_trace.pftrace "$OUTPUT"
adb shell rm /data/local/tmp/scroll_trace.pftrace /data/local/tmp/scroll_trace.cfg 2>/dev/null

echo ""
echo "=== 完成 ==="
echo "Trace 文件: $OUTPUT"
echo "文件大小: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "下一步: 使用 trace_processor 加载分析"
echo "  trace_processor_shell '$OUTPUT'"