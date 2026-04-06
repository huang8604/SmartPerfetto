<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动 Binder 总览 (startup_binder_in_range)

统计启动阶段所有 Binder 调用分布（不限于主线程），包含主线程调用次数统计。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| top_k | integer | 否 | 15 | 返回前 N 个调用 |

## SQL 查询

```sql
SELECT
  bt.server_process,
  bt.aidl_name,
  COUNT(*) as call_count,
  SUM(bt.client_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(bt.client_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(bt.client_dur) / 1e6, 2) as max_dur_ms,
  SUM(CASE WHEN bt.is_main_thread THEN 1 ELSE 0 END) as main_thread_calls,
  ROUND(100.0 * SUM(bt.client_dur) / s.dur, 1) as percent_of_startup
FROM android_binder_txns bt
JOIN android_startups s ON (
  bt.client_ts >= s.ts AND bt.client_ts <= s.ts + s.dur
  AND bt.client_process GLOB s.package || '*'
)
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
GROUP BY bt.server_process, bt.aidl_name, s.startup_id
ORDER BY total_dur_ms DESC
LIMIT <top_k|15>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| server_process | string | 服务端进程名 |
| aidl_name | string | AIDL 方法名 |
| call_count | number | 总调用次数 |
| total_dur_ms | duration | 总耗时 |
| avg_dur_ms | duration | 平均耗时 |
| max_dur_ms | duration | 最大单次耗时 |
| main_thread_calls | number | 主线程上的调用次数 |
| percent_of_startup | percentage | 启动占比 |

## 使用说明

> **Schema 兼容性注意**：SQL 中的 `bt.is_main_thread` 在某些 Perfetto stdlib 版本中不存在。如果报错，改为 `JOIN thread t ON bt.client_utid = t.utid WHERE t.is_main_thread = 1` 来判断主线程。

- **前置模块**: `android.startup.startups`, `android.binder`
- 包含所有线程的 Binder 调用（不仅主线程），提供全局视角
- `main_thread_calls` 列标记哪些调用发生在主线程上（直接影响启动时间）
- 与 `startup_main_thread_sync_binder_in_range` 互补：后者只看主线程同步调用