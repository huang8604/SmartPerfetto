<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 帧管线方差分析 (frame_pipeline_variance)

检测帧时长抖动与高方差区间，测量帧间 jitter。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名(可选) |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| transition_threshold_ms | number | 否 | 8 | 高抖动阈值(ms) |

## SQL 查询

```sql
WITH frames AS (
  SELECT
    a.ts,
    a.dur / 1e6 as frame_ms
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND p.name NOT LIKE '/system/%'
    AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
deltas AS (
  SELECT
    ts,
    frame_ms,
    ABS(frame_ms - LAG(frame_ms) OVER (ORDER BY ts)) as delta_ms
  FROM frames
)
SELECT
  COUNT(*) as total_frames,
  ROUND(AVG(frame_ms), 2) as avg_frame_ms,
  ROUND(SQRT(MAX(AVG(frame_ms * frame_ms) - AVG(frame_ms) * AVG(frame_ms), 0)), 2) as stddev_ms,
  ROUND(AVG(COALESCE(delta_ms, 0)), 2) as avg_delta_ms,
  SUM(CASE WHEN COALESCE(delta_ms, 0) >= <transition_threshold_ms> THEN 1 ELSE 0 END) as high_variance_transitions,
  CASE
    WHEN AVG(COALESCE(delta_ms, 0)) >= <transition_threshold_ms> THEN 'high'
    WHEN AVG(COALESCE(delta_ms, 0)) >= <transition_threshold_ms> * 0.5 THEN 'medium'
    ELSE 'low'
  END as variance_level
FROM deltas
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| total_frames | number | 总帧数 |
| avg_frame_ms | duration | 平均帧耗时(ms) |
| stddev_ms | duration | 标准差(ms) |
| avg_delta_ms | duration | 帧间波动(ms) |
| high_variance_transitions | number | 高抖动转折次数 |
| variance_level | string | 抖动等级 (high/medium/low) |

## 使用说明

- 前置依赖：`actual_frame_timeline_slice` 表，`android.frames.timeline` 模块
- 作为 `scrolling_analysis` 的专家探针，仅在确认存在掉帧时触发
- 默认高抖动阈值 8ms，可通过参数调整
- variance_level 分级：avg_delta >= threshold = high, >= 0.5x threshold = medium, else low
- 高 variance 通常指示帧时长不稳定，可能由 GC、Binder、热降频等引起