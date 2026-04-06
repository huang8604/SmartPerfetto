<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动类加载分析 (startup_class_loading_in_range)

统计启动阶段类加载切片耗时，使用 stdlib 的 `android_class_loading_for_startup` 表。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| top_k | integer | 否 | 10 | 返回前 N 个类 |

## SQL 查询

```sql
SELECT
  cl.slice_name,
  cl.thread_name,
  COUNT(*) as count,
  SUM(cl.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(cl.slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(100.0 * SUM(cl.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_class_loading_for_startup cl
JOIN android_startups s ON cl.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
GROUP BY cl.slice_name
ORDER BY total_dur_ms DESC
LIMIT <top_k|10>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| slice_name | string | 类名 |
| thread_name | string | 加载线程名 |
| count | number | 加载次数 |
| total_dur_ms | duration | 总耗时 |
| avg_dur_ms | duration | 平均耗时 |
| percent_of_startup | percentage | 启动占比 |

## 使用说明

- **前置模块**: `android.startup.startups`
- 对应根因 A5（类加载/DEX 优化/Baseline Profile）
- 类加载包括 `OpenDexFilesFromOat`、`VerifyClass` 等阶段
- 官方阈值：OpenDexFilesFromOat >20% = 需优化，VerifyClass >15% = 需优化
- 大量类加载是缺少 Baseline Profile 的信号