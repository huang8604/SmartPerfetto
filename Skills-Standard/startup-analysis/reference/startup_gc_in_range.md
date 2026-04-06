<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动 GC 分析 (startup_gc_in_range)

统计启动阶段 GC 相关切片及主线程占比。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| top_k | integer | 否 | 10 | 返回前 N 个 GC 事件 |

## SQL 查询

```sql
SELECT
  ts.slice_name as gc_type,
  ts.thread_name,
  ts.is_main_thread,
  COUNT(*) as count,
  SUM(ts.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(ts.slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(100.0 * SUM(ts.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_thread_slices_for_all_startups ts
JOIN android_startups s ON ts.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (ts.slice_name GLOB '*GC*' OR ts.slice_name GLOB '*gc*')
GROUP BY ts.slice_name, ts.is_main_thread
ORDER BY total_dur_ms DESC
LIMIT <top_k|10>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| gc_type | string | GC 类型名称 |
| thread_name | string | 发生 GC 的线程 |
| is_main_thread | boolean | 是否在主线程上 |
| count | number | GC 次数 |
| total_dur_ms | duration | GC 总耗时 |
| avg_dur_ms | duration | 平均单次 GC 耗时 |
| percent_of_startup | percentage | 启动占比 |

## 使用说明

- **前置模块**: `android.startup.startups`
- 对应根因 A6（GC 压力）
- 主线程 GC 直接阻塞启动；后台线程 GC 间接竞争 CPU
- 阈值：GC 总时间/启动 >5% = critical，>8 次 GC = critical
- 常见 GC 类型：`concurrent copying GC`、`young concurrent copying GC`