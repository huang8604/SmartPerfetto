<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动归因分解 (startup_breakdown_in_range)

统计启动阶段各归因原因耗时占比，基于 Perfetto stdlib 的 `android_startup_opinionated_breakdown` 表。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| top_k | integer | 否 | 15 | 返回前 N 个原因 |

## SQL 查询

```sql
SELECT
  b.reason,
  COUNT(*) as count,
  SUM(b.dur) / 1e6 as total_dur_ms,
  ROUND(AVG(b.dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(b.dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(b.dur) / (
    SELECT SUM(dur) FROM android_startup_opinionated_breakdown
    WHERE startup_id IN (
      SELECT startup_id FROM android_startups
      WHERE (package GLOB '<package>*' OR '<package>' = '')
        AND (<startup_id> IS NULL OR startup_id = <startup_id>)
        AND (<start_ts> IS NULL OR ts >= <start_ts>)
        AND (<end_ts> IS NULL OR ts + dur <= <end_ts>)
    )
  ), 1) as percent,
  CASE
    WHEN b.reason GLOB '*binder*' THEN 'IPC'
    WHEN b.reason GLOB '*io*' OR b.reason GLOB '*dlopen*' THEN 'IO'
    WHEN b.reason GLOB '*gc*' OR b.reason GLOB '*memory*' THEN 'Memory'
    WHEN b.reason GLOB '*lock*' OR b.reason GLOB '*contention*' THEN 'Lock'
    WHEN b.reason GLOB '*inflate*' THEN 'Layout'
    WHEN b.reason GLOB '*verify*' OR b.reason GLOB '*dex*' THEN 'ClassLoading'
    ELSE 'Other'
  END as category
FROM android_startup_opinionated_breakdown b
JOIN android_startups s ON b.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
GROUP BY b.reason
ORDER BY total_dur_ms DESC
LIMIT <top_k|15>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| reason | string | 延迟归因原因 |
| count | number | 出现次数 |
| total_dur_ms | duration | 总耗时（毫秒） |
| avg_dur_ms | duration | 平均耗时 |
| max_dur_ms | duration | 最大单次耗时 |
| percent | percentage | 占启动总延迟的比例 |
| category | string | 类别（IPC/IO/Memory/Lock/Layout/ClassLoading/Other） |

## 使用说明

- **前置模块**: `android.startup.startups`, `android.startup.startup_breakdowns`
- 基于 Perfetto 官方的 opinionated breakdown 分析，将启动耗时归因到不同原因类别
- 归因分类涵盖：Binder IPC、文件 IO、GC/内存、锁竞争、布局膨胀、类加载等
- 与 `startup_main_thread_slices_in_range` 互补：breakdown 是官方归因视角，slices 是按操作名排序视角