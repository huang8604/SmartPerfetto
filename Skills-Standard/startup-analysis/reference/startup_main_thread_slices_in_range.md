<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动主线程切片热点 (startup_main_thread_slices_in_range)

统计启动阶段主线程切片热点，含 wall time 和 self time（扣除子切片）。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| min_dur_ns | integer | 否 | 1000000 | 最小切片耗时阈值(ns)，默认 1ms |
| top_k | integer | 否 | 15 | 返回前 N 个热点 |

## SQL 查询

```sql
WITH raw AS (
  SELECT
    ts.slice_name, ts.thread_name, ts.slice_dur, ts.slice_id,
    s.dur as startup_dur, '<startup_type>' as startup_type, s.package
  FROM android_thread_slices_for_all_startups ts
  JOIN android_startups s ON ts.startup_id = s.startup_id
  WHERE ts.is_main_thread = 1
    AND (s.package GLOB '<package>*' OR '<package>' = '')
    AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
    AND ts.slice_dur > <min_dur_ns|1000000>
),
with_self AS (
  SELECT r.*,
    r.slice_dur - COALESCE((
      SELECT SUM(c.dur) FROM slice c WHERE c.parent_id = r.slice_id
    ), 0) as self_dur
  FROM raw r
)
SELECT
  slice_name, thread_name, COUNT(*) as count,
  SUM(slice_dur) / 1e6 as total_dur_ms,
  ROUND(SUM(self_dur) / 1e6, 2) as self_dur_ms,
  ROUND(AVG(slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(slice_dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(slice_dur) / startup_dur, 1) as percent_of_startup,
  ROUND(100.0 * SUM(self_dur) / startup_dur, 1) as self_percent
FROM with_self
GROUP BY slice_name
ORDER BY total_dur_ms DESC
LIMIT <top_k|15>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| slice_name | string | 操作名称 |
| thread_name | string | 线程名 |
| count | number | 出现次数 |
| total_dur_ms | duration | 总耗时(wall time) |
| self_dur_ms | duration | 自身耗时(扣除子切片) |
| avg_dur_ms | duration | 平均耗时 |
| max_dur_ms | duration | 最大耗时 |
| percent_of_startup | percentage | 启动占比(wall) |
| self_percent | percentage | 启动占比(self) |

## 使用说明

- **前置模块**: `android.startup.startups`
- self_dur 是关键指标：wall time 包含子切片时间，self_dur 才是该操作本身消耗的时间
- 典型热点：`bindApplication`、`inflate`、`contentProviderCreate`、`performCreate:*`、`activityResume`
- 结合 `startup_hot_slice_states` 可进一步分析每个热点 slice 内部的线程状态分布