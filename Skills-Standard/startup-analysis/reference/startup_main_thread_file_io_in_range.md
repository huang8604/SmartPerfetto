<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动主线程文件 IO (startup_main_thread_file_io_in_range)

统计启动阶段主线程文件 IO 相关切片，通过 GLOB 模式匹配 IO 操作名。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| min_dur_ns | integer | 否 | 500000 | 最小切片耗时阈值(ns)，默认 0.5ms |
| top_k | integer | 否 | 15 | 返回前 N 个 IO 操作 |

## SQL 查询

```sql
SELECT
  ts.slice_name as io_slice,
  ts.thread_name,
  COUNT(*) as count,
  SUM(ts.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(ts.slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(ts.slice_dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(ts.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_thread_slices_for_all_startups ts
JOIN android_startups s ON ts.startup_id = s.startup_id
WHERE ts.is_main_thread = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND ts.slice_dur > <min_dur_ns|500000>
  AND (
    lower(ts.slice_name) GLOB '*open*'
    OR lower(ts.slice_name) GLOB '*read*'
    OR lower(ts.slice_name) GLOB '*write*'
    OR lower(ts.slice_name) GLOB '*fsync*'
    OR lower(ts.slice_name) GLOB '*sqlite*'
    OR lower(ts.slice_name) GLOB '*database*'
    OR lower(ts.slice_name) GLOB '*file*'
    OR lower(ts.slice_name) GLOB '*disk*'
  )
GROUP BY ts.slice_name, s.startup_id
ORDER BY total_dur_ms DESC
LIMIT <top_k|15>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| io_slice | string | IO 操作名称 |
| thread_name | string | 线程名 |
| count | number | 出现次数 |
| total_dur_ms | duration | 总耗时 |
| avg_dur_ms | duration | 平均耗时 |
| max_dur_ms | duration | 最大耗时 |
| percent_of_startup | percentage | 启动占比 |

## 使用说明

- **前置模块**: `android.startup.startups`
- 匹配模式包括：open/read/write/fsync/sqlite/database/file/disk
- 主线程文件 IO 是启动性能的常见瓶颈，对应根因 A2（主线程磁盘 IO）和 A8（数据库初始化）
- 与 `startup_main_thread_states_in_range` 的 D 状态互为印证