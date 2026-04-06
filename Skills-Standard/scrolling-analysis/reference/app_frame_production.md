<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 应用帧生产分析 (app_frame_production)

分析应用主线程的帧生产情况，统计生产侧的帧率、掉帧率和帧耗时分布。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| start_ts | timestamp | 否 | - | 分析起始时间 |
| end_ts | timestamp | 否 | - | 分析结束时间 |

## SQL 查询

```sql
WITH
time_bounds AS (
  SELECT
    COALESCE(<start_ts>, MIN(ts)) as start_ts,
    COALESCE(<end_ts>, MAX(ts + dur)) as end_ts
  FROM actual_frame_timeline_slice
),
app_frames AS (
  SELECT
    e.ts as expected_ts,
    e.dur as expected_dur,
    a.ts as actual_ts,
    a.dur as actual_dur,
    a.jank_type,
    p.name as process_name,
    LAG(e.ts) OVER (PARTITION BY a.upid ORDER BY e.ts) as prev_expected_ts,
    LAG(a.ts) OVER (PARTITION BY a.upid ORDER BY a.ts) as prev_actual_ts
  FROM expected_frame_timeline_slice e
  JOIN actual_frame_timeline_slice a
    ON e.display_frame_token = a.display_frame_token
    AND e.upid = a.upid
  JOIN process p ON e.upid = p.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND e.ts >= (SELECT start_ts FROM time_bounds)
    AND e.ts <= (SELECT end_ts FROM time_bounds)
),
production_intervals AS (
  SELECT
    expected_ts - prev_expected_ts as expected_interval_ns,
    actual_ts - prev_actual_ts as actual_interval_ns,
    actual_dur,
    jank_type
  FROM app_frames
  WHERE prev_expected_ts IS NOT NULL
),
production_stats AS (
  SELECT
    COUNT(*) + 1 as total_produced_frames,
    (SELECT end_ts - start_ts FROM time_bounds) as total_duration_ns,
    COUNT(CASE WHEN jank_type = 'None' THEN 1 END) as on_time_frames,
    COUNT(CASE WHEN jank_type != 'None' THEN 1 END) as janky_frames,
    AVG(expected_interval_ns) as avg_expected_interval_ns,
    AVG(actual_dur) as avg_actual_dur_ns,
    MAX(actual_dur) as max_actual_dur_ns
  FROM production_intervals
)
SELECT
  total_produced_frames,
  ROUND(total_duration_ns / 1e6, 1) as duration_ms,
  on_time_frames,
  janky_frames,
  ROUND(100.0 * janky_frames / NULLIF(total_produced_frames, 0), 2) as app_jank_rate,
  ROUND(1e9 * total_produced_frames / NULLIF(total_duration_ns, 0), 1) as production_fps,
  ROUND(1e9 / NULLIF(avg_expected_interval_ns, 0), 1) as expected_fps,
  ROUND(avg_actual_dur_ns / 1e6, 2) as avg_frame_dur_ms,
  ROUND(max_actual_dur_ns / 1e6, 2) as max_frame_dur_ms,
  'app_production' as metric_source
FROM production_stats
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| total_produced_frames | number | 总帧数 |
| duration_ms | duration | 持续时间(ms) |
| on_time_frames | number | 按时帧数 |
| janky_frames | number | 掉帧数 |
| app_jank_rate | percentage | 掉帧率(%) |
| production_fps | number | 生产 FPS |
| expected_fps | number | 期望 FPS |
| avg_frame_dur_ms | duration | 平均帧耗时(ms) |
| max_frame_dur_ms | duration | 最大帧耗时(ms) |

## 使用说明

- 前置依赖：`actual_frame_timeline_slice` 表，`android.frames.timeline` 模块
- 通过 JOIN expected/actual frame timeline 获取生产侧视角
- jank_type = 'None' 为按时帧，其余为掉帧
- 仅反映 App 生产端的帧情况，不等同于用户可感知的掉帧（需结合消费端数据）