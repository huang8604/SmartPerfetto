#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# capture_startup_trace.sh — 使用 adb 抓取 Android 启动性能 trace
#
# 使用方式:
#   ./capture_startup_trace.sh <package_name> [output_file] [duration_sec]
#
# 示例:
#   ./capture_startup_trace.sh com.example.app startup.pftrace 10
#
# 前置条件:
#   - adb 已连接设备
#   - 设备为 userdebug/eng build 或已开启开发者选项
#   - Android 12+ (FrameTimeline 数据需要 API 31+)

set -euo pipefail

PACKAGE="${1:?Usage: $0 <package_name> [output_file] [duration_sec]}"
OUTPUT="${2:-startup_$(date +%Y%m%d_%H%M%S).pftrace}"
DURATION="${3:-10}"
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

# Perfetto trace 配置 — 启动分析优化
# 包含: am/dalvik/wm/sched/binder_driver/disk/freq/gfx/view
#
# 双 buffer 策略:
#   buffers[0] (64MB): ftrace 高频数据 (sched/binder/block/vmscan 等)
#     - 这些事件每秒产生数千条，需要大 buffer 防止被覆盖
#   buffers[1] (16MB): 低频采样数据 (process_stats, frametimeline)
#     - 采样频率低 (1s/帧级)，独立 buffer 避免被 ftrace 洪流挤占
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
      ftrace_events: "sched/sched_wakeup_new"
      ftrace_events: "sched/sched_blocked_reason"
      ftrace_events: "power/cpu_frequency"
      ftrace_events: "power/cpu_idle"
      ftrace_events: "power/suspend_resume"
      ftrace_events: "binder/binder_transaction"
      ftrace_events: "binder/binder_transaction_received"
      ftrace_events: "binder/binder_lock"
      ftrace_events: "binder/binder_locked"
      ftrace_events: "binder/binder_unlock"
      ftrace_events: "block/block_bio_queue"
      ftrace_events: "block/block_bio_complete"
      ftrace_events: "filemap/mm_filemap_add_to_page_cache"
      ftrace_events: "filemap/mm_filemap_delete_from_page_cache"
      ftrace_events: "vmscan/mm_vmscan_direct_reclaim_begin"
      ftrace_events: "vmscan/mm_vmscan_direct_reclaim_end"
      ftrace_events: "vmscan/mm_vmscan_kswapd_wake"
      ftrace_events: "lowmemorykiller/lowmemory_kill"
      ftrace_events: "oom/oom_score_adj_update"
      atrace_categories: "am"
      atrace_categories: "dalvik"
      atrace_categories: "wm"
      atrace_categories: "sched"
      atrace_categories: "gfx"
      atrace_categories: "view"
      atrace_categories: "binder_driver"
      atrace_categories: "disk"
      atrace_categories: "freq"
      atrace_categories: "input"
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

echo "=== 启动 Trace 抓取 ==="
echo "包名: $PACKAGE"
echo "时长: ${DURATION}s"
echo "输出: $OUTPUT"
echo ""

# 1. 强制停止目标应用
echo "[1/5] 停止应用..."
adb shell am force-stop "$PACKAGE" 2>/dev/null || true
sleep 1

# 2. 推送 trace 配置
echo "[2/5] 推送 Perfetto 配置..."
echo "$TRACE_CONFIG" | adb shell "cat > /data/local/tmp/startup_trace.cfg"

# 3. 启动 Perfetto trace
echo "[3/5] 启动 Perfetto trace (${DURATION}s)..."
adb shell "perfetto --config /data/local/tmp/startup_trace.cfg \
  --out /data/local/tmp/startup_trace.pftrace \
  --time ${DURATION}s \
  --background"
sleep 1

# 4. 启动应用
echo "[4/5] 启动应用: $PACKAGE"
adb shell am start -W -S "$PACKAGE" 2>&1 | grep -E "TotalTime|WaitTime|Status"

# 5. 等待 trace 完成并拉取
echo "[5/5] 等待 trace 完成..."
sleep "$DURATION"
sleep 2  # 额外等待 flush

adb pull /data/local/tmp/startup_trace.pftrace "$OUTPUT"
adb shell rm /data/local/tmp/startup_trace.pftrace /data/local/tmp/startup_trace.cfg 2>/dev/null

echo ""
echo "=== 完成 ==="
echo "Trace 文件: $OUTPUT"
echo "文件大小: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "下一步: 使用 trace_processor 加载分析"
echo "  trace_processor_shell --run-metrics android_startup '$OUTPUT'"