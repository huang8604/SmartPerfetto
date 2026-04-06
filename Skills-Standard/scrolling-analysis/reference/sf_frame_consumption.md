<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# SurfaceFlinger 帧消费分析 (sf_frame_consumption)

分析 SurfaceFlinger 消费帧的情况，从显示侧统计实际 FPS、掉帧率和帧间隔分布。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| start_ts | timestamp | 否 | - | 分析起始时间 |
| end_ts | timestamp | 否 | - | 分析结束时间 |
| layer_name | string | 否 | - | Layer 名称（可选，用于精确匹配） |

## SQL 查询

```sql
WITH
time_bounds AS (
  SELECT
    COALESCE(<start_ts>, MIN(ts)) as start_ts,
    COALESCE(<end_ts>, MAX(ts + dur)) as end_ts
  FROM actual_frame_timeline_slice
),
sf_frames AS (
  SELECT
    a.ts as present_ts,
    a.dur, a.layer_name, a.surface_frame_token,
    a.display_frame_token, a.jank_type, a.on_time_finish, a.present_type,
    ROW_NUMBER() OVER (ORDER BY a.ts) as frame_num,
    LAG(a.ts) OVER (ORDER BY a.ts) as prev_ts
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE a.surface_frame_token IS NOT NULL
    AND (p.name GLOB '<package>*' OR '<package>' = '' OR a.layer_name GLOB '*<package>*')
    AND a.ts >= (SELECT start_ts FROM time_bounds)
    AND a.ts <= (SELECT end_ts FROM time_bounds)
),
frame_intervals AS (
  SELECT present_ts - prev_ts as interval_ns, jank_type, on_time_finish, present_type
  FROM sf_frames WHERE prev_ts IS NOT NULL
),
consumption_stats AS (
  SELECT
    COUNT(*) as total_consumed_frames,
    (SELECT end_ts - start_ts FROM time_bounds) as total_duration_ns,
    COUNT(CASE WHEN jank_type = 'None' THEN 1 END) as on_time_frames,
    COUNT(CASE WHEN jank_type != 'None' THEN 1 END) as janky_frames,
    AVG(interval_ns) as avg_interval_ns,
    PERCENTILE(interval_ns, 0.5) as median_interval_ns,
    MIN(interval_ns) as min_interval_ns,
    MAX(interval_ns) as max_interval_ns
  FROM frame_intervals
)
SELECT
  total_consumed_frames,
  ROUND(total_duration_ns / 1e6, 1) as duration_ms,
  ROUND(total_duration_ns / 1e9, 2) as duration_sec,
  on_time_frames, janky_frames,
  ROUND(100.0 * janky_frames / NULLIF(total_consumed_frames, 0), 2) as jank_rate,
  ROUND(1e9 / NULLIF(avg_interval_ns, 0), 1) as avg_fps,
  ROUND(1e9 / NULLIF(median_interval_ns, 0), 1) as median_fps,
  ROUND(1e9 * total_consumed_frames / NULLIF(total_duration_ns, 0), 1) as actual_fps,
  ROUND(avg_interval_ns / 1e6, 2) as avg_interval_ms,
  ROUND(median_interval_ns / 1e6, 2) as median_interval_ms,
  ROUND(min_interval_ns / 1e6, 2) as min_interval_ms,
  ROUND(max_interval_ns / 1e6, 2) as max_interval_ms
FROM consumption_stats
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| total_consumed_frames | integer | SF 消费的总帧数 |
| actual_fps | number | 实际 FPS（基于消费端） |
| median_fps | number | 中位数 FPS |
| jank_rate | number | 掉帧率(%) |
| avg_interval_ms | number | 平均帧间隔(ms) |
| median_interval_ms | number | 中位帧间隔(ms) |
| max_interval_ms | number | 最大帧间隔(ms) |

## 使用说明

- 前置依赖：`actual_frame_timeline_slice` 表，`android.frames.timeline` 模块
- 从 SurfaceFlinger 消费端视角统计，反映用户实际看到的帧率
- 支持按 package 或 layer_name 过滤
- 与 `app_frame_production` 配合使用，对比生产/消费两端差异