<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Logcat 集成分析 (logcat_analysis)

## 概述

Perfetto 的 `android.log` 数据源可以在 trace 中同步 Logcat，用于快速检查 ANR、GC 警告、Binder 超时等系统信号。

## Trace 配置

```protobuf
data_sources {
  config {
    name: "android.log"
    android_log_config {
      log_ids: LID_DEFAULT
      log_ids: LID_SYSTEM
      min_prio: PRIO_WARN  # 只记录 WARN 及以上
    }
  }
}
```

## 查询 SQL

```sql
-- 启动/滑动期间的关键系统警告
SELECT
  ts,
  prio,
  tag,
  msg
FROM android_logs
WHERE ts BETWEEN <start_ts> AND <end_ts>
  AND prio >= 5  -- WARN=5, ERROR=6, FATAL=7
  AND (
    tag GLOB '*ActivityManager*'  -- ANR, 启动超时
    OR tag GLOB '*art*'           -- GC 警告
    OR tag GLOB '*Binder*'        -- Binder 超时
    OR tag GLOB '*Choreographer*' -- 跳帧警告 "Skipped N frames"
    OR tag GLOB '*StrictMode*'    -- StrictMode 违规（磁盘/网络操作）
    OR tag GLOB '*SurfaceFlinger*'
    OR tag GLOB '*lowmemorykiller*'
  )
ORDER BY ts
LIMIT 50
```

## 关键 Log 模式

| Tag | 关键 msg 模式 | 含义 |
|-----|-------------|------|
| Choreographer | "Skipped N frames" | App 主线程阻塞导致跳帧 |
| ActivityManager | "ANR in" | ANR 发生 |
| art | "Clamp target GC heap" | GC 堆压力 |
| Binder | "Transaction failed" | Binder 超时 |
| StrictMode | "policy violation" | 主线程 IO/网络操作 |
| lowmemorykiller | "Kill" | LMK 杀进程 |