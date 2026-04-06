<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Scrolling Performance Analysis — SQL Pattern Catalog

> Comprehensive reference of all SQL patterns used in SmartPerfetto's scrolling/jank analysis skills.
> Target runtime: Perfetto `trace_processor_shell` (SQLite dialect with Perfetto extensions).
> All timestamps are in **nanoseconds**.

---

## Table of Contents

1. [VSync / 刷新率检测](#1-vsync--刷新率检测)
2. [帧生产分析](#2-帧生产分析)
3. [卡顿检测](#3-卡顿检测)
4. [滑动区间与会话](#4-滑动区间与会话)
5. [帧详情分析](#5-帧详情分析)
6. [缺帧检测](#6-缺帧检测)
7. [输入延迟](#7-输入延迟)
8. [GPU 分析](#8-gpu-分析)
9. [热控 / 温控分析](#9-热控--温控分析)
10. [Flutter 专用](#10-flutter-专用)
11. [批量帧根因分类](#11-批量帧根因分类)

---

## Common Prerequisites

Most patterns require these Perfetto stdlib modules to be loaded:

```sql
-- Load before running patterns that use expected_frame_timeline_slice / actual_frame_timeline_slice
INCLUDE PERFETTO MODULE android.frames.timeline;

-- Required for Binder analysis patterns
INCLUDE PERFETTO MODULE android.binder;

-- Required for GC analysis patterns
INCLUDE PERFETTO MODULE android.garbage_collection;

-- Required for lock contention patterns
INCLUDE PERFETTO MODULE android.monitor_contention;
```

### Common VSync Period Detection CTE

Nearly every pattern needs the VSync period. This is the canonical detection CTE reused throughout:

```sql
-- Canonical VSync period detection (copy into any query as a CTE)
-- Priority: 1) VSYNC-sf counter median  2) expected_frame_timeline_slice dur median  3) default 60Hz
-- Snaps raw median to nearest standard refresh rate (30/60/80/90/120/144/165 Hz)
vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
timing_config AS (
  SELECT CASE
    WHEN raw_ns BETWEEN 5500000 AND 6500000 THEN 6060606      -- 165 Hz
    WHEN raw_ns BETWEEN 6500001 AND 7500000 THEN 6944444      -- 144 Hz
    WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333      -- 120 Hz
    WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111    --  90 Hz
    WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667   --  60 Hz
    WHEN raw_ns BETWEEN 20000001 AND 35000000 THEN 33333333   --  30 Hz
    ELSE raw_ns
  END AS vsync_period_ns
  FROM (
    SELECT CAST(COALESCE(
      (SELECT PERCENTILE(interval_ns, 0.5)
       FROM vsync_intervals
       WHERE interval_ns > 5500000 AND interval_ns < 50000000),
      (SELECT CAST(PERCENTILE(dur, 0.5) AS INTEGER)
       FROM expected_frame_timeline_slice
       WHERE dur > 5000000 AND dur < 50000000
         AND (<start_ts> IS NULL OR ts >= <start_ts>)
         AND (<end_ts> IS NULL OR ts < <end_ts>)),
      16666667
    ) AS INTEGER) AS raw_ns
  )
)
```

---

## 内置 Metric 快捷方式

以下手写 SQL 有等效的 Perfetto 内置 metric。Metric 输出为 proto 格式，手写 SQL 更灵活，但 metric 更简洁。

| 分析维度 | 手写 SQL | 等效内置 Metric |
|---------|---------|---------------|
| 启动事件概览 | startup_events_in_range SQL | `RUN_METRIC('android_startup')` |
| 帧时间线统计 | scrolling performance_summary SQL | `RUN_METRIC('android_frame_timeline_metric')` |
| Jank 统计 | consumer_jank_detection SQL | `RUN_METRIC('android_jank')` |
| Binder 事务 | startup_binder SQL | `RUN_METRIC('android_binder')` |

**使用方法**：
```sql
-- 运行内置 metric
SELECT RUN_METRIC('android_startup');
-- 结果在 android_startup_output 表中（proto 格式）
SELECT * FROM android_startup_output;
```

> **何时用 metric vs 手写 SQL**：
> - metric 适合快速概览（一行调用得到全部结果）
> - 手写 SQL 适合自定义分析（按需过滤、关联其他表、计算自定义指标）
> - 本文档中的 SQL 模板提供了比 metric 更细粒度的控制

---

## 1. VSync / 刷新率检测

### 1.1 vsync_config — VSync 配置分析

- **Skill**: `vsync_config` (atomic)
- **Chinese name**: VSync 配置分析
- **Description**: Detects actual VSync period and refresh rate from trace data. Uses VSYNC-sf counter intervals (primary) or expected_frame_timeline_slice duration (fallback), defaulting to 60Hz.
- **Parameters**:
  - `<start_ts>` (timestamp, optional): Analysis start timestamp
  - `<end_ts>` (timestamp, optional): Analysis end timestamp
- **Output columns**: `vsync_period_ns`, `refresh_rate_hz`, `vsync_period_ms`, `vsync_source`, `detected_refresh_rate`

```sql
WITH
-- Method 1: expected_frame_timeline_slice (fallback source)
expected_frame_vsync AS (
  SELECT
    CAST(PERCENTILE(dur, 0.5) AS INTEGER) as vsync_period_ns,
    'expected_frame_dur' as source
  FROM expected_frame_timeline_slice
  WHERE dur > 5000000 AND dur < 50000000  -- 5ms-50ms covers 24Hz VRR
    AND (<start_ts> IS NULL OR ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ts < <end_ts>)
),
-- Method 2: VSYNC-sf counter (primary source)
sf_vsync_intervals AS (
  SELECT
    c.ts,
    c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
vsync_median AS (
  SELECT
    CASE
      WHEN raw_period BETWEEN 5500000 AND 6500000 THEN 6060606
      WHEN raw_period BETWEEN 6500001 AND 7500000 THEN 6944444
      WHEN raw_period BETWEEN 7500001 AND 9500000 THEN 8333333
      WHEN raw_period BETWEEN 9500001 AND 12500000 THEN 11111111
      WHEN raw_period BETWEEN 12500001 AND 20000000 THEN 16666667
      WHEN raw_period BETWEEN 20000001 AND 35000000 THEN 33333333
      ELSE raw_period
    END AS vsync_period_ns,
    source
  FROM (
    SELECT
      CAST(COALESCE(
        (SELECT PERCENTILE(interval_ns, 0.5)
         FROM sf_vsync_intervals
         WHERE interval_ns > 5500000 AND interval_ns < 50000000),
        (SELECT vsync_period_ns FROM expected_frame_vsync WHERE vsync_period_ns > 0),
        16666667
      ) AS INTEGER) as raw_period,
      CASE
        WHEN (SELECT COUNT(*) FROM sf_vsync_intervals WHERE interval_ns > 5500000 AND interval_ns < 50000000) > 0 THEN 'sf_vsync_counter'
        WHEN (SELECT vsync_period_ns FROM expected_frame_vsync WHERE vsync_period_ns > 0) IS NOT NULL THEN 'expected_frame_dur'
        ELSE 'default_60hz'
      END as source
  )
)
SELECT
  vsync_period_ns,
  refresh_rate_hz,
  ROUND(vsync_period_ns / 1e6, 2) as vsync_period_ms,
  source as vsync_source,
  refresh_rate_hz as detected_refresh_rate
FROM (
  SELECT
    vsync_period_ns,
    CAST(ROUND(1e9 / vsync_period_ns) AS INTEGER) as refresh_rate_hz,
    source
  FROM vsync_median
)
```

- **Usage notes**: Always run this first to establish the baseline VSync period. The snap-to-standard-Hz logic prevents VRR or measurement noise from producing odd periods.

---

### 1.2 vsync_period_detection — VSync 周期检测（带置信度）

- **Skill**: `vsync_period_detection` (atomic)
- **Chinese name**: VSync 周期检测
- **Description**: Detects VSync period with confidence scoring based on sample count. Useful when you need to know how reliable the detection is.
- **Parameters**:
  - `<start_ts>` (number, optional): Start timestamp (ns)
  - `<end_ts>` (number, optional): End timestamp (ns)
- **Output columns**: `vsync_period_ns`, `detected_refresh_rate_hz`, `measured_period_ns`, `detection_method`, `confidence`, `sample_count`, `theoretical_fps`

```sql
WITH params AS (
  SELECT
    COALESCE(<start_ts>, 0) AS start_ts,
    COALESCE(<end_ts>, (SELECT MAX(ts) FROM counter)) AS end_ts
),

-- Source 1: VSYNC-sf counter intervals
vsync_sf_raw AS (
  SELECT
    c.ts,
    c.ts - LAG(c.ts) OVER (ORDER BY c.ts) AS interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  CROSS JOIN params p
  WHERE t.name = 'VSYNC-sf'
    AND c.ts >= p.start_ts
    AND c.ts <= p.end_ts
),

vsync_sf_stats AS (
  SELECT
    CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER) AS median_period_ns,
    COUNT(*) AS sample_count
  FROM vsync_sf_raw
  WHERE interval_ns IS NOT NULL
    AND interval_ns > 5500000
    AND interval_ns < 50000000
),

-- Source 2: expected_frame_timeline_slice durations (fallback)
frame_timeline_stats AS (
  SELECT
    CAST(PERCENTILE(dur, 0.5) AS INTEGER) AS median_period_ns,
    COUNT(*) AS sample_count
  FROM expected_frame_timeline_slice e
  CROSS JOIN params p
  WHERE e.ts >= p.start_ts
    AND e.ts <= p.end_ts
    AND e.dur > 5000000
    AND e.dur < 50000000
),

-- Choose best source, then snap to standard Hz
detected_period AS (
  SELECT
    CASE
      WHEN raw_ns BETWEEN 5500000 AND 6500000 THEN 6060606
      WHEN raw_ns BETWEEN 6500001 AND 7500000 THEN 6944444
      WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333
      WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111
      WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667
      WHEN raw_ns BETWEEN 20000001 AND 35000000 THEN 33333333
      ELSE raw_ns
    END AS vsync_period_ns,
    detection_method,
    confidence,
    sample_count
  FROM (
    SELECT
      CASE
        WHEN (SELECT sample_count FROM vsync_sf_stats) >= 10
          THEN (SELECT median_period_ns FROM vsync_sf_stats)
        WHEN (SELECT sample_count FROM frame_timeline_stats) >= 10
          THEN (SELECT median_period_ns FROM frame_timeline_stats)
        ELSE 16666667
      END AS raw_ns,
      CASE
        WHEN (SELECT sample_count FROM vsync_sf_stats) >= 10 THEN 'vsync_sf'
        WHEN (SELECT sample_count FROM frame_timeline_stats) >= 10 THEN 'frame_timeline'
        ELSE 'default'
      END AS detection_method,
      CASE
        WHEN (SELECT sample_count FROM vsync_sf_stats) >= 100 THEN 0.95
        WHEN (SELECT sample_count FROM vsync_sf_stats) >= 10 THEN 0.85
        WHEN (SELECT sample_count FROM frame_timeline_stats) >= 100 THEN 0.80
        WHEN (SELECT sample_count FROM frame_timeline_stats) >= 10 THEN 0.70
        ELSE 0.50
      END AS confidence,
      COALESCE(
        (SELECT sample_count FROM vsync_sf_stats),
        (SELECT sample_count FROM frame_timeline_stats),
        0
      ) AS sample_count
  )
)

SELECT
  vsync_period_ns,
  CAST(ROUND(1e9 / vsync_period_ns) AS INTEGER) AS detected_refresh_rate_hz,
  vsync_period_ns AS measured_period_ns,
  detection_method,
  confidence,
  sample_count,
  ROUND(1000000000.0 / vsync_period_ns, 1) AS theoretical_fps
FROM detected_period
```

---

### 1.3 vsync_alignment_in_range — VSync 对齐分析

- **Skill**: `vsync_alignment_in_range` (atomic)
- **Chinese name**: VSync 对齐分析
- **Description**: Analyzes how a specific frame aligns with VSync signals. Reports whether the frame finished before or after the VSync deadline.
- **Parameters**:
  - `<start_ts>` (timestamp, **required**): Frame start timestamp (ns)
  - `<end_ts>` (timestamp, **required**): Frame end timestamp (ns)
- **Output columns**: `metric` (string), `value` (string) — key-value pairs

```sql
WITH vsync_ticks AS (
  SELECT c.ts, c.value,
    c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE (t.name LIKE '%VSYNC-sf%' OR t.name LIKE '%VSYNC-app%' OR t.name = 'VSYNC')
    AND c.ts >= <start_ts> - 100000000  -- look back 100ms
    AND c.ts < <end_ts> + 100000000
),
vsync_period AS (
  SELECT AVG(interval_ns) as period_ns
  FROM vsync_ticks
  WHERE interval_ns > 5000000 AND interval_ns < 50000000  -- 20Hz-200Hz
),
frame_timing AS (
  SELECT
    <start_ts> as frame_start,
    <end_ts> as frame_end,
    <end_ts> - <start_ts> as frame_dur,
    (SELECT MIN(ts) FROM vsync_ticks WHERE ts >= <start_ts>) as next_vsync_after_start,
    (SELECT MAX(ts) FROM vsync_ticks WHERE ts < <start_ts>) as prev_vsync_before_start,
    (SELECT MIN(ts) FROM vsync_ticks WHERE ts >= <end_ts>) as next_vsync_after_end,
    (SELECT period_ns FROM vsync_period) as vsync_period
)
SELECT 'VSync 周期' as metric,
  CASE
    WHEN vsync_period IS NULL THEN '无数据'
    ELSE ROUND(vsync_period / 1e6, 2) || 'ms (' || ROUND(1e9 / vsync_period, 0) || 'Hz)'
  END as value
FROM frame_timing
UNION ALL
SELECT '帧耗时' as metric,
  ROUND(frame_dur / 1e6, 2) || 'ms' as value
FROM frame_timing
UNION ALL
SELECT '相对 VSync 周期' as metric,
  CASE
    WHEN vsync_period IS NULL OR vsync_period = 0 THEN '无数据'
    ELSE ROUND(100.0 * frame_dur / vsync_period, 1) || '%'
  END as value
FROM frame_timing
UNION ALL
SELECT '帧起点偏移' as metric,
  CASE
    WHEN prev_vsync_before_start IS NULL THEN '无数据'
    ELSE ROUND((frame_start - prev_vsync_before_start) / 1e6, 2) || 'ms (距上次VSync)'
  END as value
FROM frame_timing
UNION ALL
SELECT '截止时间' as metric,
  CASE
    WHEN next_vsync_after_start IS NULL THEN '无数据'
    WHEN frame_end > next_vsync_after_start THEN
      '超时 ' || ROUND((frame_end - next_vsync_after_start) / 1e6, 2) || 'ms'
    ELSE
      '提前 ' || ROUND((next_vsync_after_start - frame_end) / 1e6, 2) || 'ms'
  END as value
FROM frame_timing
```

---

### 1.4 vsync_phase_alignment — VSync 相位对齐分析

- **Skill**: `vsync_phase_alignment` (atomic, 3 steps)
- **Chinese name**: VSync 相位对齐分析
- **Description**: Analyzes phase relationship between input events and VSYNC-app signals. Phase offset determines how long an input event must wait before being processed (key factor in touch-tracking latency).
- **Parameters**:
  - `<package>` (string, optional): Target process name (GLOB)
  - `<start_ts>` (timestamp, optional)
  - `<end_ts>` (timestamp, optional)

#### Step 1: VSync Timeline

- **Output columns**: `vsync_count`, `period_ms`, `refresh_hz`

```sql
WITH vsync_events AS (
  SELECT c.ts as vsync_ts
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-app'
  ORDER BY c.ts
),
intervals AS (
  SELECT vsync_ts - LAG(vsync_ts) OVER (ORDER BY vsync_ts) as interval_ns
  FROM vsync_events
)
SELECT
  (SELECT COUNT(*) FROM vsync_events) as vsync_count,
  ROUND(PERCENTILE(interval_ns, 0.5) / 1e6, 2) as period_ms,
  ROUND(1e9 / PERCENTILE(interval_ns, 0.5), 1) as refresh_hz
FROM intervals
WHERE interval_ns BETWEEN 5500000 AND 50000000
```

#### Step 2: Per-Event Phase Analysis

- **Output columns**: `input_ts`, `nearest_vsync_ts`, `phase_offset_ms`, `phase_ratio_pct`, `wait_ms`

```sql
WITH vsync_cfg AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(c.ts - LAG(c.ts) OVER (ORDER BY c.ts), 0.5) AS INTEGER)
     FROM counter c
     JOIN counter_track t ON c.track_id = t.id
     WHERE t.name = 'VSYNC-app'),
    16666667
  ) as period_ns
),
vsync_events AS (
  SELECT c.ts as vsync_ts
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-app'
  ORDER BY c.ts
),
input_events AS (
  SELECT ied.ts as input_ts
  FROM android_input_event_dispatch ied
  LEFT JOIN process p ON p.upid = ied.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND (ied.event_action = 'ACTION_MOVE' OR ied.event_action = '2')
    AND (<start_ts> IS NULL OR ied.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ied.ts <= <end_ts>)
),
input_with_vsync AS (
  SELECT
    ie.input_ts,
    (SELECT MAX(v.vsync_ts) FROM vsync_events v WHERE v.vsync_ts <= ie.input_ts) as prev_vsync,
    (SELECT MIN(v.vsync_ts) FROM vsync_events v WHERE v.vsync_ts > ie.input_ts) as next_vsync
  FROM input_events ie
)
SELECT
  printf('%d', input_ts) as input_ts,
  printf('%d', prev_vsync) as nearest_vsync_ts,
  ROUND((input_ts - prev_vsync) / 1e6, 2) as phase_offset_ms,
  ROUND((input_ts - prev_vsync) * 100.0 / (SELECT period_ns FROM vsync_cfg), 1) as phase_ratio_pct,
  ROUND((next_vsync - input_ts) / 1e6, 2) as wait_ms
FROM input_with_vsync
WHERE prev_vsync IS NOT NULL AND next_vsync IS NOT NULL
ORDER BY input_ts
```

#### Step 3: Phase Distribution Statistics

- **Output columns**: `metric`, `value` — includes P50/P90 phase offset, P50/P90 VSync wait, unfavorable phase %, sample count

```sql
WITH vsync_cfg AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(c.ts - LAG(c.ts) OVER (ORDER BY c.ts), 0.5) AS INTEGER)
     FROM counter c
     JOIN counter_track t ON c.track_id = t.id
     WHERE t.name = 'VSYNC-app'),
    16666667
  ) as period_ns
),
vsync_events AS (
  SELECT c.ts as vsync_ts
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-app'
),
input_events AS (
  SELECT ied.ts as input_ts
  FROM android_input_event_dispatch ied
  LEFT JOIN process p ON p.upid = ied.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND (ied.event_action = 'ACTION_MOVE' OR ied.event_action = '2')
    AND (<start_ts> IS NULL OR ied.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ied.ts <= <end_ts>)
),
phase_offsets AS (
  SELECT
    (ie.input_ts - (SELECT MAX(v.vsync_ts) FROM vsync_events v WHERE v.vsync_ts <= ie.input_ts)) as offset_ns,
    ((SELECT MIN(v.vsync_ts) FROM vsync_events v WHERE v.vsync_ts > ie.input_ts) - ie.input_ts) as wait_ns
  FROM input_events ie
),
valid AS (
  SELECT offset_ns, wait_ns FROM phase_offsets
  WHERE offset_ns IS NOT NULL AND wait_ns IS NOT NULL
    AND offset_ns >= 0 AND wait_ns >= 0
)
SELECT '相位偏移 P50(ms)' as metric, CAST(ROUND(PERCENTILE(offset_ns, 0.5) / 1e6, 2) AS TEXT) as value FROM valid
UNION ALL
SELECT '相位偏移 P90(ms)', CAST(ROUND(PERCENTILE(offset_ns, 0.9) / 1e6, 2) AS TEXT) FROM valid
UNION ALL
SELECT 'VSync等待 P50(ms)', CAST(ROUND(PERCENTILE(wait_ns, 0.5) / 1e6, 2) AS TEXT) FROM valid
UNION ALL
SELECT 'VSync等待 P90(ms)', CAST(ROUND(PERCENTILE(wait_ns, 0.9) / 1e6, 2) AS TEXT) FROM valid
UNION ALL
SELECT '偏移>75%周期(不利相位)', CAST(ROUND(
  100.0 * (SELECT COUNT(*) FROM valid WHERE offset_ns > (SELECT period_ns FROM vsync_cfg) * 0.75) /
  MAX((SELECT COUNT(*) FROM valid), 1), 1) AS TEXT) || '%' FROM valid LIMIT 1
UNION ALL
SELECT '样本数', CAST(COUNT(*) AS TEXT) FROM valid
```

---

## 2. 帧生产分析

### 2.1 app_frame_production — 应用帧生产统计

- **Skill**: `app_frame_production` (atomic)
- **Chinese name**: 应用帧生产分析
- **Description**: Analyzes app main thread frame production using `expected_frame_timeline_slice` and `actual_frame_timeline_slice` join on `display_frame_token`.
- **Parameters**:
  - `<package>` (string, optional): App package name (GLOB)
  - `<start_ts>` (timestamp, optional)
  - `<end_ts>` (timestamp, optional)
- **Output columns**: `total_produced_frames`, `duration_ms`, `on_time_frames`, `janky_frames`, `app_jank_rate`, `production_fps`, `expected_fps`, `avg_frame_dur_ms`, `max_frame_dur_ms`

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

---

### 2.2 sf_frame_consumption — SurfaceFlinger 帧消费统计

- **Skill**: `sf_frame_consumption` (atomic)
- **Chinese name**: SurfaceFlinger 帧消费分析
- **Description**: Analyzes how SurfaceFlinger consumes frames from the app's buffer queue. Measures actual display FPS from the consumer side.
- **Parameters**:
  - `<package>` (string, optional)
  - `<start_ts>` (timestamp, optional)
  - `<end_ts>` (timestamp, optional)
  - `<layer_name>` (string, optional)
- **Output columns**: `total_consumed_frames`, `duration_ms`, `duration_sec`, `on_time_frames`, `janky_frames`, `jank_rate`, `avg_fps`, `median_fps`, `actual_fps`, `avg_interval_ms`, `median_interval_ms`, `min_interval_ms`, `max_interval_ms`

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
    a.dur,
    a.layer_name,
    a.surface_frame_token,
    a.display_frame_token,
    a.jank_type,
    a.on_time_finish,
    a.present_type,
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
  SELECT
    present_ts - prev_ts as interval_ns,
    jank_type,
    on_time_finish,
    present_type
  FROM sf_frames
  WHERE prev_ts IS NOT NULL
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
  on_time_frames,
  janky_frames,
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

---

## 3. 卡顿检测

### 3.1 consumer_jank_detection — 消费端掉帧检测

- **Skill**: `consumer_jank_detection` (atomic, 4 steps)
- **Chinese name**: Consumer Jank 检测
- **Description**: Detects real user-perceived jank from SurfaceFlinger consumption side using `present_ts` interval analysis. Classifies severity as SMOOTH/MINOR_JANK/JANK/SEVERE_JANK/FROZEN. Includes `delay_source` decomposition (app_late / sf_late / buffer_stuffing).
- **Parameters**:
  - `<package>` (string, optional)
  - `<layer_name>` (string, optional)
  - `<start_ts>` (timestamp, optional)
  - `<end_ts>` (timestamp, optional)

#### Step 2: Consumer Jank Frame Detection (core SQL)

- **Output columns**: `frame_id`, `layer_name`, `ts_str`, `ts_sec`, `dur_ms`, `token_gap`, `vsync_missed`, `interval_ms`, `app_jank_type`, `present_type`, `jank_severity`, `is_consumer_jank`, `delay_source`

```sql
WITH
vsync_ticks AS (
  SELECT
    c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
vsync_period AS (
  SELECT CAST(COALESCE(
    (SELECT PERCENTILE(interval_ns, 0.5)
     FROM vsync_ticks
     WHERE interval_ns > 5500000 AND interval_ns < 50000000),
    (SELECT CAST(PERCENTILE(dur, 0.5) AS INTEGER)
     FROM expected_frame_timeline_slice
     WHERE dur > 5000000 AND dur < 50000000
       AND (<start_ts> IS NULL OR ts >= <start_ts>)
       AND (<end_ts> IS NULL OR ts < <end_ts>)),
    16666667
  ) AS INTEGER) as vsync_period_ns
),
raw_frames AS (
  SELECT
    COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
    a.display_frame_token,
    a.surface_frame_token,
    a.ts,
    a.dur,
    a.layer_name,
    a.jank_type,
    a.present_type,
    a.upid,
    ROW_NUMBER() OVER (
      PARTITION BY a.upid, COALESCE(a.display_frame_token, a.surface_frame_token)
      ORDER BY a.ts, a.layer_name
    ) as row_rank
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
    AND (
      a.layer_name LIKE 'TX - <package>%'
      OR a.layer_name = '<layer_name>'
      OR ('<package>' = '' AND '<layer_name>' = '')
    )
    AND ('<start_ts>' = '' OR a.ts >= CAST('<start_ts>' AS INTEGER))
    AND ('<end_ts>' = '' OR a.ts <= CAST('<end_ts>' AS INTEGER))
),
-- Deduplicate same display_frame_token across multiple layers
app_frames AS (
  SELECT
    frame_id, display_frame_token, surface_frame_token,
    ts, dur, layer_name, jank_type, present_type, upid,
    ts + CASE WHEN dur > 0 THEN dur ELSE 0 END as present_ts,
    LAG(ts + CASE WHEN dur > 0 THEN dur ELSE 0 END)
      OVER (PARTITION BY upid ORDER BY ts, frame_id) as prev_present_ts
  FROM raw_frames
  WHERE row_rank = 1
),
interval_analysis AS (
  SELECT
    frame_id, display_frame_token, surface_frame_token,
    ts, dur, layer_name,
    jank_type as app_jank_type, present_type,
    present_ts - prev_present_ts as interval_ns,
    CASE
      WHEN prev_present_ts IS NULL THEN 1
      WHEN present_ts - prev_present_ts > (SELECT vsync_period_ns * 6 FROM vsync_period) THEN 1
      ELSE 0
    END as is_session_break,
    MAX(CAST(ROUND((present_ts - prev_present_ts) * 1.0 / (SELECT vsync_period_ns FROM vsync_period) - 1, 0) AS INTEGER), 0) as vsync_missed,
    MAX(CAST(ROUND((present_ts - prev_present_ts) * 1.0 / (SELECT vsync_period_ns FROM vsync_period), 0) AS INTEGER), 1) as token_gap,
    CASE
      WHEN prev_present_ts IS NULL THEN 0
      WHEN present_ts - prev_present_ts > (SELECT vsync_period_ns * 6 FROM vsync_period) THEN 0
      WHEN present_ts - prev_present_ts > (SELECT vsync_period_ns FROM vsync_period) * 1.5 THEN 1
      ELSE 0
    END as is_consumer_jank,
    CASE
      WHEN MAX(CAST(ROUND((...) - 1, 0) AS INTEGER), 0) = 0 THEN 'SMOOTH'
      WHEN ... = 1 THEN 'MINOR_JANK'
      WHEN ... <= 3 THEN 'JANK'
      WHEN ... <= 7 THEN 'SEVERE_JANK'
      ELSE 'FROZEN'
    END as jank_severity
  FROM app_frames
  WHERE prev_present_ts IS NOT NULL
)
SELECT
  printf('%d', frame_id) as frame_id,
  layer_name,
  printf('%d', ts) as ts_str,
  ROUND(ts / 1e9, 3) as ts_sec,
  ROUND(CASE WHEN dur > 0 THEN dur ELSE 0 END / 1e6, 2) as dur_ms,
  token_gap, vsync_missed,
  ROUND(interval_ns / 1e6, 2) as interval_ms,
  app_jank_type, present_type, jank_severity, is_consumer_jank,
  -- delay_source decomposition
  CASE
    WHEN app_jank_type = 'None' THEN 'sf_late'
    WHEN app_jank_type GLOB '*SurfaceFlinger*' THEN 'sf_late'
    WHEN app_jank_type GLOB '*Buffer*' THEN 'buffer_stuffing'
    ELSE 'app_late'
  END as delay_source
FROM interval_analysis
WHERE is_session_break = 0 AND is_consumer_jank = 1
ORDER BY ts
```

- **Usage notes**: This is the canonical "ground truth" jank detection method. It uses `present_ts` intervals (not `token_gap`) to determine if frames were actually dropped from the user's perspective. Session breaks (>6x VSync gap) are filtered to avoid false positives from non-scrolling intervals.

---

### 3.2 Dual-Signal Jank Detection (from scrolling_analysis)

- **Source**: `scrolling_analysis.skill.yaml`, `performance_summary` step
- **Chinese name**: 双信号混合掉帧检测
- **Description**: The production jank detection used in scrolling_analysis. Uses a dual-signal hybrid strategy:
  - **Non-BS frames**: `present_type IN ('Late Present', 'Dropped Frame')` is the authoritative signal
  - **Buffer Stuffing frames**: `present_type` is always 'Late Present' for BS, so a secondary check using `present_ts` interval > 1.5x VSync distinguishes real jank from normal pipeline backpressure
- **Key concept**: "Perceived jank" excludes normal Buffer Stuffing (pipeline backpressure, not a real user-visible jank)

The dual-signal CTE pattern:

```sql
-- This CTE detects perceived jank using the dual-signal hybrid strategy
consumer_gap_stats AS (
  SELECT
    COUNT(*) as total_frames,
    -- Perceived jank: dual-signal hybrid detection
    SUM(CASE
      WHEN present_type IN ('Late Present', 'Dropped Frame')
        AND jank_type != 'Buffer Stuffing' THEN 1
      WHEN jank_type = 'Buffer Stuffing'
        AND prev_present_ts IS NOT NULL
        AND present_ts - prev_present_ts > (SELECT vsync_period_ns FROM timing_config) * 1.5
        AND present_ts - prev_present_ts <= (SELECT vsync_period_ns FROM timing_config) * 6 THEN 1
      ELSE 0
    END) as consumer_jank_frames,
    -- App-side jank (BS frames cannot be Self Jank/App Deadline Missed)
    SUM(CASE WHEN present_type IN ('Late Present', 'Dropped Frame')
      AND jank_type IN ('Self Jank', 'App Deadline Missed') THEN 1 ELSE 0 END) as app_jank_frames,
    -- Buffer Stuffing total
    SUM(CASE WHEN jank_type = 'Buffer Stuffing' THEN 1 ELSE 0 END) as buffer_stuffing_frames
  FROM consumer_layer_frames
)
```

---

### 3.3 Jank Severity Distribution

- **Source**: `consumer_jank_detection.skill.yaml`, `jank_severity_distribution` step
- **Chinese name**: 掉帧严重程度分布
- **Description**: Groups all frames by jank severity level
- **Output columns**: `severity`, `count`, `percentage`
- **Severity levels**:
  - `SMOOTH (gap=1)` — no jank
  - `MINOR_JANK (gap=2, 跳1帧)` — 1 frame missed
  - `JANK (gap=3-4, 跳2-3帧)` — 2-3 frames missed
  - `SEVERE_JANK (gap=5-8, 跳4-7帧)` — 4-7 frames missed
  - `FROZEN (gap>8, 跳8+帧)` — 8+ frames missed (freeze)

---

## 4. 滑动区间与会话

### 4.1 Scroll Session Segmentation (from scrolling_analysis)

- **Source**: `scrolling_analysis.skill.yaml`, `scroll_sessions` step
- **Chinese name**: 滑动区间列表
- **Description**: Segments continuous frame sequences into scroll sessions. A new session starts when the gap between consecutive frames exceeds 6x VSync period. Only sessions with >= 10 frames and > 200ms duration are retained.
- **Parameters**:
  - `<package>` (string, optional)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
- **Output columns**: `session_id`, `process_name`, `start_ts`, `end_ts`, `frame_count`, `duration_ms`, `duration`, `avg_dur`, `max_dur`, `session_fps`

```sql
WITH
-- VSync config (same canonical detection)
vsync_intervals AS ( /* ... standard VSync detection ... */ ),
vsync_config AS ( /* ... standard snap-to-Hz ... */ ),
frame_gaps AS (
  SELECT
    COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
    a.ts, a.dur, a.upid,
    p.name as process_name,
    LAG(a.ts + a.dur) OVER (PARTITION BY a.upid ORDER BY a.ts) as prev_end,
    a.ts - LAG(a.ts + a.dur) OVER (PARTITION BY a.upid ORDER BY a.ts) as gap_ns
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND p.name NOT LIKE '/system/%'
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
    AND a.dur > 0
    AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
),
session_markers AS (
  SELECT *,
    CASE WHEN gap_ns IS NULL OR gap_ns > (SELECT vsync_period_ns * 6 FROM vsync_config)
      THEN 1 ELSE 0 END as new_session
  FROM frame_gaps
),
sessions AS (
  SELECT *,
    SUM(new_session) OVER (PARTITION BY upid ORDER BY ts) as session_id
  FROM session_markers
)
SELECT
  session_id,
  process_name,
  printf('%d', MIN(ts)) as start_ts,
  printf('%d', MAX(ts + dur)) as end_ts,
  COUNT(*) as frame_count,
  ROUND((MAX(ts + dur) - MIN(ts)) / 1e6, 1) as duration_ms,
  printf('%d', MAX(ts + dur) - MIN(ts)) as duration,
  CAST(ROUND(AVG(dur)) AS INTEGER) as avg_dur,
  MAX(dur) as max_dur,
  ROUND(1e9 * COUNT(*) / NULLIF(MAX(ts + dur) - MIN(ts), 0), 1) as session_fps
FROM sessions
GROUP BY upid, session_id
HAVING COUNT(*) >= 10
  AND (MAX(ts + dur) - MIN(ts)) > 200000000
ORDER BY MIN(ts)
```

- **Usage notes**: The 6x VSync threshold for session boundaries is chosen to separate distinct scroll gestures while allowing for small gaps within a single scroll. Frames with `dur <= 0` are excluded as they represent dropped/invalid frames.

---

### 4.2 scroll_session_analysis — Per-Session Phase Analysis

- **Skill**: `scroll_session_analysis` (composite)
- **Chinese name**: 滑动会话分析
- **Description**: Analyzes a single scroll session, breaking it into touch-drag phase and fling phase. Uses `Choreographer#doFrame` / `DrawFrame` slices from main thread for frame timing.
- **Parameters**:
  - `<session_id>` (number, required)
  - `<start_ts>` / `<end_ts>` (timestamp, required)
  - `<touch_start_ts>` / `<touch_end_ts>` (timestamp, optional)
  - `<fling_start_ts>` / `<fling_end_ts>` (timestamp, optional)
  - `<has_fling>` (number, optional)
  - `<vsync_period_ns>` (context): VSync period from environment

#### Full Session Stats (doFrame-based)

```sql
WITH frames AS (
  SELECT
    s.ts, s.dur,
    s.dur / 1e6 AS dur_ms,
    CASE
      WHEN s.dur > <vsync_period_ns> * 1.5 THEN 1
      ELSE 0
    END AS is_janky
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN process p ON t.upid = p.upid
  WHERE (s.name GLOB '*doFrame*' OR s.name GLOB '*Choreographer#doFrame*')
    AND t.tid = p.pid  -- main thread only
    AND s.ts >= <start_ts>
    AND s.ts <= <end_ts>
)
SELECT
  <session_id> AS session_id,
  COUNT(*) AS total_frames,
  SUM(is_janky) AS janky_frames,
  ROUND(100.0 * SUM(is_janky) / NULLIF(COUNT(*), 0), 2) AS jank_rate,
  ROUND(AVG(dur_ms), 2) AS avg_frame_ms,
  ROUND(MAX(dur_ms), 2) AS max_frame_ms,
  ROUND(MIN(dur_ms), 2) AS min_frame_ms,
  ROUND(COUNT(*) * 1e9 / NULLIF(MAX(ts + dur) - MIN(ts), 0), 1) AS estimated_fps,
  ROUND((<end_ts> - <start_ts>) / 1e6, 1) AS duration_ms
FROM frames
```

---

## 5. 帧详情分析

### 5.1 render_thread_slices — RenderThread Slice 分析

- **Skill**: `render_thread_slices` (atomic)
- **Chinese name**: 渲染线程 Slice 分析
- **Description**: Finds the most time-consuming operations on RenderThread within a time range.
- **Parameters**:
  - `<start_ts>` (timestamp, required)
  - `<end_ts>` (timestamp, required)
  - `<package>` (string, optional)
- **Output columns**: `name`, `total_ms`, `count`, `max_ms`, `avg_ms`

```sql
WITH render_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND t.name = 'RenderThread'
)
SELECT
  s.name,
  ROUND(SUM(s.dur) / 1e6, 2) as total_ms,
  COUNT(*) as count,
  ROUND(MAX(s.dur) / 1e6, 2) as max_ms,
  ROUND(AVG(s.dur) / 1e6, 2) as avg_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
WHERE tt.utid IN (SELECT utid FROM render_thread)
  AND s.ts >= <start_ts>
  AND s.ts < <end_ts>
  AND s.dur >= 500000  -- > 0.5ms
GROUP BY s.name
HAVING total_ms > 0.5
ORDER BY total_ms DESC
LIMIT 10
```

---

### 5.2 render_pipeline_latency — 渲染流水线时延分析

- **Skill**: `render_pipeline_latency` (atomic)
- **Chinese name**: 渲染流水线时延
- **Description**: Decomposes frame rendering latency into main thread (UI construction), RenderThread (GPU commands), and handoff stages.
- **Parameters**:
  - `<start_ts>` / `<end_ts>` (timestamp, required)
  - `<main_start_ts>` / `<main_end_ts>` (timestamp, optional)
  - `<render_start_ts>` / `<render_end_ts>` (timestamp, optional)
- **Output columns**: `stage`, `dur_ms`, `pct`

```sql
WITH timing AS (
  SELECT
    <end_ts> - <start_ts> as total_dur,
    COALESCE(<main_end_ts>, <end_ts>) - COALESCE(<main_start_ts>, <start_ts>) as main_dur,
    COALESCE(<render_end_ts>, <end_ts>) - COALESCE(<render_start_ts>, <start_ts>) as render_dur,
    COALESCE(<main_start_ts>, <start_ts>) - <start_ts> as pre_main_dur,
    CASE
      WHEN <render_start_ts> IS NOT NULL AND <main_end_ts> IS NOT NULL
      THEN <render_start_ts> - <main_end_ts>
      ELSE 0
    END as handoff_dur
  WHERE <end_ts> > <start_ts>
)
SELECT '1. 帧总耗时' as stage,
  ROUND(total_dur / 1e6, 2) as dur_ms,
  100.0 as pct
FROM timing
UNION ALL
SELECT '2. 主线程 (UI 构建)' as stage,
  ROUND(main_dur / 1e6, 2) as dur_ms,
  ROUND(100.0 * main_dur / NULLIF(total_dur, 0), 1) as pct
FROM timing
UNION ALL
SELECT '3. RenderThread (GPU 指令)' as stage,
  ROUND(render_dur / 1e6, 2) as dur_ms,
  ROUND(100.0 * render_dur / NULLIF(total_dur, 0), 1) as pct
FROM timing
UNION ALL
SELECT '4. 主线程->RT 交接' as stage,
  ROUND(handoff_dur / 1e6, 2) as dur_ms,
  ROUND(100.0 * handoff_dur / NULLIF(total_dur, 0), 1) as pct
FROM timing
WHERE handoff_dur > 0
```

---

### 5.3 frame_blocking_calls — 帧阻塞调用分析

- **Skill**: `frame_blocking_calls` (atomic)
- **Chinese name**: 帧阻塞调用分析
- **Description**: Cross-matches `_android_critical_blocking_calls` (GC, Binder, lock contention, IO) with jank frames from `actual_frame_timeline_slice` to find which blocking calls overlapped with each dropped frame.
- **Prerequisites**: `android.frames.timeline`, `android.critical_blocking_calls`
- **Parameters**:
  - `<process_name>` (string, required)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
- **Output columns**: `frame_id`, `frame_ts`, `frame_dur_ms`, `jank_type`, `blocking_call`, `overlap_ms`, `call_dur_ms`, `call_count`

```sql
WITH jank_frames AS (
  SELECT
    a.display_frame_token as frame_id,
    a.ts as frame_ts,
    a.dur as frame_dur,
    a.ts + a.dur as frame_end,
    a.jank_type
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<process_name>*' OR '<process_name>' = '')
    AND COALESCE(a.jank_type, 'None') != 'None'
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
blocking AS (
  SELECT
    bc.name as blocking_call,
    bc.ts as call_ts,
    bc.dur as call_dur,
    bc.process_name as call_process,
    bc.utid
  FROM _android_critical_blocking_calls bc
  WHERE (bc.process_name GLOB '<process_name>*' OR '<process_name>' = '')
)
SELECT
  printf('%d', jf.frame_id) as frame_id,
  printf('%d', jf.frame_ts) as frame_ts,
  ROUND(jf.frame_dur / 1e6, 2) as frame_dur_ms,
  jf.jank_type,
  b.blocking_call,
  ROUND(
    (MIN(b.call_ts + b.call_dur, jf.frame_end) - MAX(b.call_ts, jf.frame_ts)) / 1e6,
    2
  ) as overlap_ms,
  ROUND(b.call_dur / 1e6, 2) as call_dur_ms,
  COUNT(*) as call_count
FROM jank_frames jf
JOIN blocking b
  ON b.call_ts < jf.frame_end
  AND b.call_ts + b.call_dur > jf.frame_ts
GROUP BY jf.frame_id, b.blocking_call
HAVING overlap_ms > 0.5
ORDER BY jf.frame_ts, overlap_ms DESC
LIMIT 100
```

---

### 5.4 frame_pipeline_variance — 帧管线方差分析

- **Skill**: `frame_pipeline_variance` (atomic)
- **Chinese name**: 帧管线方差分析
- **Description**: Measures frame-to-frame jitter and variance from FrameTimeline. Detects high-variance transitions (sudden frame time changes).
- **Parameters**:
  - `<package>` (string, optional)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
  - `<transition_threshold_ms>` (number, optional, default 8): High-jitter threshold
- **Output columns**: `total_frames`, `avg_frame_ms`, `stddev_ms`, `avg_delta_ms`, `high_variance_transitions`, `variance_level`

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
    ts, frame_ms,
    ABS(frame_ms - LAG(frame_ms) OVER (ORDER BY ts)) as delta_ms
  FROM frames
)
SELECT
  COUNT(*) as total_frames,
  ROUND(AVG(frame_ms), 2) as avg_frame_ms,
  ROUND(SQRT(MAX(AVG(frame_ms * frame_ms) - AVG(frame_ms) * AVG(frame_ms), 0)), 2) as stddev_ms,
  ROUND(AVG(COALESCE(delta_ms, 0)), 2) as avg_delta_ms,
  SUM(CASE WHEN COALESCE(delta_ms, 0) >= <transition_threshold_ms|8> THEN 1 ELSE 0 END) as high_variance_transitions,
  CASE
    WHEN AVG(COALESCE(delta_ms, 0)) >= <transition_threshold_ms|8> THEN 'high'
    WHEN AVG(COALESCE(delta_ms, 0)) >= <transition_threshold_ms|8> * 0.5 THEN 'medium'
    ELSE 'low'
  END as variance_level
FROM deltas
```

---

## 6. 缺帧检测

### 6.1 frame_production_gap — 帧生产 Gap 分析

- **Skill**: `frame_production_gap` (composite, 2 steps)
- **Chinese name**: 帧生产 Gap 分析
- **Description**: Detects frame production gaps (missing frames) where consecutive frame intervals exceed 1.5x VSync. Classifies gap type based on UI Thread and RenderThread activity during the gap:
  - `ui_no_frame` — UI Thread did not trigger doFrame (no render request)
  - `rt_no_drawframe` — doFrame ran but RenderThread did not execute DrawFrame
  - `sf_backpressure` — DrawFrame ran but SF did not consume (backpressure/discard)
- **Parameters**:
  - `<process_name>` (string, required)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
  - `<min_gap_vsync>` (number, optional, default 1.5): Minimum gap threshold in VSync multiples

#### Step 1: Gap Summary

- **Output columns**: `total_frames`, `total_gaps`, `ui_no_frame_count`, `rt_no_drawframe_count`, `sf_backpressure_count`, `max_gap_ms`, `vsync_period_ms`

```sql
WITH
vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
vsync_config AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER)
     FROM vsync_intervals
     WHERE interval_ns BETWEEN 4000000 AND 50000000),
    16666667
  ) as period_ns
),
frame_seq AS (
  SELECT
    a.display_frame_token as frame_id,
    a.ts as frame_start,
    a.ts + a.dur as frame_end,
    a.dur, a.upid, a.layer_name,
    LAG(a.ts + a.dur) OVER (PARTITION BY a.layer_name ORDER BY a.ts) as prev_frame_end,
    LAG(a.display_frame_token) OVER (PARTITION BY a.layer_name ORDER BY a.ts) as prev_frame_id
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<process_name>*')
    AND p.name NOT LIKE '/system/%'
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
    AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
),
gaps AS (
  SELECT
    fs.prev_frame_id as before_frame_id,
    fs.frame_id as after_frame_id,
    fs.prev_frame_end as gap_start,
    fs.frame_start as gap_end,
    fs.frame_start - fs.prev_frame_end as gap_ns,
    ROUND((fs.frame_start - fs.prev_frame_end) / 1e6, 2) as gap_ms,
    ROUND((fs.frame_start - fs.prev_frame_end) * 1.0 / vc.period_ns, 1) as gap_vsync_count,
    fs.upid
  FROM frame_seq fs
  CROSS JOIN vsync_config vc
  WHERE fs.prev_frame_end IS NOT NULL
    AND (fs.frame_start - fs.prev_frame_end) > vc.period_ns * COALESCE(<min_gap_vsync>, 1.5)
    AND (fs.frame_start - fs.prev_frame_end) < vc.period_ns * 30  -- exclude non-scroll gaps
),
relevant_threads AS (
  SELECT DISTINCT t.utid, t.tid,
    CASE WHEN t.tid = p.pid THEN 'main' ELSE 'render' END as role
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<process_name>*'
    AND p.name NOT LIKE '/system/%'
    AND (t.tid = p.pid OR t.name = 'RenderThread')
),
gap_ui_activity AS (
  SELECT
    g.gap_start, g.gap_end,
    COUNT(DISTINCT CASE WHEN s.name LIKE 'Choreographer#doFrame%' THEN s.id END) as doframe_count,
    COUNT(DISTINCT CASE WHEN s.name LIKE 'DrawFrame%' OR s.name LIKE 'draw:%' THEN s.id END) as drawframe_count
  FROM gaps g
  JOIN relevant_threads rt ON 1=1
  JOIN thread_track tt ON tt.utid = rt.utid
  JOIN slice s ON s.track_id = tt.id
    AND s.ts >= g.gap_start AND s.ts < g.gap_end
    AND s.dur > 100000
  GROUP BY g.gap_start, g.gap_end
),
classified_gaps AS (
  SELECT g.*,
    COALESCE(ua.doframe_count, 0) as doframe_count,
    COALESCE(ua.drawframe_count, 0) as drawframe_count,
    CASE
      WHEN COALESCE(ua.doframe_count, 0) = 0 THEN 'ui_no_frame'
      WHEN COALESCE(ua.drawframe_count, 0) = 0 THEN 'rt_no_drawframe'
      ELSE 'sf_backpressure'
    END as gap_type
  FROM gaps g
  LEFT JOIN gap_ui_activity ua ON ua.gap_start = g.gap_start AND ua.gap_end = g.gap_end
)
SELECT
  (SELECT COUNT(*) FROM frame_seq) as total_frames,
  COUNT(*) as total_gaps,
  SUM(CASE WHEN gap_type = 'ui_no_frame' THEN 1 ELSE 0 END) as ui_no_frame_count,
  SUM(CASE WHEN gap_type = 'rt_no_drawframe' THEN 1 ELSE 0 END) as rt_no_drawframe_count,
  SUM(CASE WHEN gap_type = 'sf_backpressure' THEN 1 ELSE 0 END) as sf_backpressure_count,
  MAX(gap_ms) as max_gap_ms,
  (SELECT ROUND(period_ns / 1e6, 2) FROM vsync_config) as vsync_period_ms
FROM classified_gaps
```

---

## 7. 输入延迟

### 7.1 input_to_frame_latency — 逐帧 Input-to-Display 延迟 (v2.0)

- **Skill**: `input_to_frame_latency` (atomic, 5 steps)
- **Chinese name**: 逐帧 Input-to-Display 延迟
- **Description**: Based on Perfetto stdlib `android_input_events` table. Measures per-frame input-to-display latency with 5-dimension breakdown (dispatch/handling/ack/total/e2e). Uses `frame_id` for precise frame association. Includes `is_speculative_frame` confidence marker.
- **Module**: `android.input` (auto-includes `android.frames.timeline`, `intervals.intersect`, `slices.with_context`)
- **Parameters**:
  - `<package>` (string, optional)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
  - `<event_action_filter>` (string, optional) — uses uppercase (MOVE, DOWN, UP)

#### Step 3: Per-Frame Latency (core)

- **Output columns**: `input_ts`, `process_name`, `event_action`, `input_to_display_ms`, `dispatch_latency_ms`, `handling_ms`, `ack_ms`, `frame_dur_ms`, `frame_to_present_ms`, `is_speculative`, `rating`

```sql
WITH vsync_cfg AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(c.ts - LAG(c.ts) OVER (ORDER BY c.ts), 0.5) AS INTEGER)
     FROM counter c
     JOIN counter_track t ON c.track_id = t.id
     WHERE t.name = 'VSYNC-app'),
    16666667
  ) as period_ns
),
input_with_frame AS (
  SELECT
    ie.dispatch_ts as input_ts,
    ie.event_action,
    ie.process_name,
    ie.dispatch_latency_dur,
    ie.handling_latency_dur,
    ie.ack_latency_dur,
    ie.end_to_end_latency_dur,
    ie.is_speculative_frame,
    f.ts as frame_ts,
    f.dur as frame_dur,
    f.ts + f.dur as frame_present_ts
  FROM android_input_events ie
  LEFT JOIN actual_frame_timeline_slice f
    ON ie.frame_id = f.display_frame_token
    AND ie.upid = f.upid
  WHERE (ie.process_name GLOB '<package>*' OR '<package>' = '')
    AND (UPPER(ie.event_action) = 'MOVE'
         OR ('<event_action_filter>' != '' AND UPPER(ie.event_action) = UPPER('<event_action_filter>')))
    AND (<start_ts> IS NULL OR ie.dispatch_ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ie.dispatch_ts <= <end_ts>)
)
SELECT
  printf('%d', input_ts) as input_ts,
  process_name,
  event_action,
  ROUND(COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) / 1e6, 2) as input_to_display_ms,
  ROUND(dispatch_latency_dur / 1e6, 2) as dispatch_latency_ms,
  ROUND(handling_latency_dur / 1e6, 2) as handling_ms,
  ROUND(ack_latency_dur / 1e6, 2) as ack_ms,
  ROUND(frame_dur / 1e6, 2) as frame_dur_ms,
  ROUND((frame_present_ts - frame_ts - COALESCE(frame_dur, 0)) / 1e6, 2) as frame_to_present_ms,
  is_speculative_frame as is_speculative,
  CASE
    WHEN COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) / 1e6
         < 2 * (SELECT period_ns FROM vsync_cfg) / 1e6 THEN '优秀'
    WHEN COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) / 1e6
         < 3 * (SELECT period_ns FROM vsync_cfg) / 1e6 THEN '良好'
    WHEN COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) / 1e6
         < 4 * (SELECT period_ns FROM vsync_cfg) / 1e6 THEN '需优化'
    ELSE '严重'
  END as rating
FROM input_with_frame
WHERE (end_to_end_latency_dur IS NOT NULL OR frame_present_ts IS NOT NULL)
  AND COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) > 0
  AND COALESCE(end_to_end_latency_dur, frame_present_ts - input_ts) < 500000000
ORDER BY input_ts
```

#### Step 4: Latency Statistics

- **Output columns**: `metric`, `value_ms`

```sql
-- Uses android_input_events.end_to_end_latency_dur directly
WITH valid AS (
  SELECT end_to_end_latency_dur as latency_ns
  FROM android_input_events
  WHERE UPPER(event_action) = 'MOVE'
    AND end_to_end_latency_dur IS NOT NULL
    AND end_to_end_latency_dur > 0
    AND end_to_end_latency_dur < 500000000
)
SELECT 'P50' as metric, ROUND(PERCENTILE(latency_ns, 0.5) / 1e6, 2) as value_ms FROM valid
UNION ALL
SELECT 'P90', ROUND(PERCENTILE(latency_ns, 0.9) / 1e6, 2) FROM valid
UNION ALL
SELECT 'P99', ROUND(PERCENTILE(latency_ns, 0.99) / 1e6, 2) FROM valid
UNION ALL
SELECT '均值', ROUND(AVG(latency_ns) / 1e6, 2) FROM valid
UNION ALL
SELECT '标准差', ROUND(SQRT(AVG(latency_ns * latency_ns) - AVG(latency_ns) * AVG(latency_ns)) / 1e6, 2) FROM valid
UNION ALL
SELECT '样本数', CAST(COUNT(*) AS REAL) FROM valid
```

---

### 7.2 scroll_response_latency — 滚动响应延迟

- **Skill**: `scroll_response_latency` (atomic)
- **Chinese name**: 滚动响应延迟 (区间)
- **Description**: Measures latency from first scroll gesture input to first frame rendered. Detects gesture starts by looking for ACTION_MOVE events with > 500ms gap from previous move.
- **Parameters**:
  - `<package>` (string, optional)
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
- **Output columns**: `gesture_ts`, `process_name`, `first_frame_ts`, `response_latency_ms`, `first_frame_dur_ms`, `rating`
- **Rating**: < 50ms = 优秀, < 100ms = 良好, < 200ms = 需优化, >= 200ms = 严重

```sql
WITH input_events AS (
  SELECT
    ied.ts as input_ts,
    ied.event_type, ied.event_action,
    ied.window_id, ied.event_seq,
    p.name as process_name, p.upid
  FROM android_input_event_dispatch ied
  LEFT JOIN process p ON p.upid = ied.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND (<start_ts> IS NULL OR ied.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ied.ts <= <end_ts>)
),
move_events AS (
  SELECT
    input_ts, process_name, upid,
    ROW_NUMBER() OVER (PARTITION BY upid ORDER BY input_ts) as move_idx
  FROM input_events
  WHERE event_action = 'ACTION_MOVE' OR event_action = '2'
),
gesture_starts AS (
  SELECT m1.input_ts as gesture_ts, m1.process_name, m1.upid
  FROM move_events m1
  LEFT JOIN move_events m2 ON m1.upid = m2.upid AND m2.move_idx = m1.move_idx - 1
  WHERE m2.input_ts IS NULL OR (m1.input_ts - m2.input_ts) > 500000000
),
first_frames AS (
  SELECT
    g.gesture_ts, g.process_name,
    MIN(f.ts) as frame_ts,
    (SELECT f2.ts + f2.dur FROM actual_frame_timeline_slice f2
     WHERE f2.upid = g.upid AND f2.ts >= g.gesture_ts
     ORDER BY f2.ts LIMIT 1) as frame_end_ts,
    (SELECT f2.dur FROM actual_frame_timeline_slice f2
     WHERE f2.upid = g.upid AND f2.ts >= g.gesture_ts
     ORDER BY f2.ts LIMIT 1) as frame_dur
  FROM gesture_starts g
  LEFT JOIN actual_frame_timeline_slice f ON f.upid = g.upid AND f.ts >= g.gesture_ts
  GROUP BY g.gesture_ts, g.process_name
)
SELECT
  printf('%d', gesture_ts) as gesture_ts,
  process_name,
  printf('%d', frame_ts) as first_frame_ts,
  ROUND((frame_ts - gesture_ts) / 1e6, 2) as response_latency_ms,
  ROUND(frame_dur / 1e6, 2) as first_frame_dur_ms,
  CASE
    WHEN (frame_ts - gesture_ts) / 1e6 < 50 THEN '优秀'
    WHEN (frame_ts - gesture_ts) / 1e6 < 100 THEN '良好'
    WHEN (frame_ts - gesture_ts) / 1e6 < 200 THEN '需优化'
    ELSE '严重'
  END as rating
FROM first_frames
WHERE frame_ts IS NOT NULL
ORDER BY response_latency_ms DESC
```

---

## 8. GPU 分析

### 8.1 gpu_render_in_range — GPU 渲染分析

- **Skill**: `gpu_render_in_range` (atomic)
- **Chinese name**: GPU 渲染分析
- **Description**: Analyzes GPU-side workload within a time range. Detects GPU rendering, fence waits, buffer operations. Categorizes slices into: Draw Frame, Fence Signal, Fence Wait, EGL SwapBuffers, GPU Flush, Queue Buffer, Dequeue Buffer, GPU Other, RenderThread.
- **Parameters**:
  - `<start_ts>` / `<end_ts>` (timestamp, optional)
  - `<package>` (string, optional)
- **Output columns**: `operation`, `count`, `total_ms`, `max_ms`, `avg_ms`

```sql
WITH gpu_slices AS (
  SELECT
    s.name, s.dur,
    CASE
      WHEN s.name GLOB '*DrawFrame*' OR s.name GLOB '*doFrame*' THEN 'Draw Frame'
      WHEN s.name GLOB '*fence*signal*' OR s.name GLOB '*Fence*signal*' THEN 'Fence Signal'
      WHEN s.name GLOB '*fence*wait*' OR s.name GLOB '*waitForFence*' THEN 'Fence Wait'
      WHEN s.name GLOB '*eglSwap*' THEN 'EGL SwapBuffers'
      WHEN s.name GLOB '*flush*' OR s.name GLOB '*Flush*' THEN 'GPU Flush'
      WHEN s.name GLOB '*queueBuffer*' THEN 'Queue Buffer'
      WHEN s.name GLOB '*dequeueBuffer*' THEN 'Dequeue Buffer'
      WHEN s.name GLOB '*GPU*' THEN 'GPU Other'
      WHEN s.name GLOB '*RenderThread*' THEN 'RenderThread'
      ELSE NULL
    END as operation
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN process p ON t.upid = p.upid
  WHERE (<start_ts> IS NULL OR s.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR s.ts < <end_ts>)
    AND (p.name GLOB '<package>*' OR '<package>' = '' OR p.name = 'surfaceflinger')
    AND s.dur > 10000  -- > 10us
)
SELECT
  operation,
  COUNT(*) as count,
  ROUND(SUM(dur) / 1e6, 2) as total_ms,
  ROUND(MAX(dur) / 1e6, 2) as max_ms,
  ROUND(AVG(dur) / 1e6, 2) as avg_ms
FROM gpu_slices
WHERE operation IS NOT NULL
GROUP BY operation
HAVING total_ms > 0.1
ORDER BY total_ms DESC
```

---

## 9. 热控 / 温控分析

### 9.1 thermal_predictor — 热控风险预测

- **Skill**: `thermal_predictor` (atomic)
- **Chinese name**: 热控风险预测
- **Description**: Predicts thermal throttling risk by comparing CPU frequency trend between the start (first 20%) and end (last 20%) of a time range. Also checks what fraction of cores show significant frequency drops.
- **Parameters**:
  - `<start_ts>` / `<end_ts>` (timestamp, required)
  - `<high_drop_threshold_pct>` (number, optional, default 30)
  - `<medium_drop_threshold_pct>` (number, optional, default 15)
  - `<high_core_ratio_threshold_pct>` (number, optional, default 50)
  - `<medium_core_ratio_threshold_pct>` (number, optional, default 25)
  - `<core_drop_threshold_pct>` (number, optional, default 30)
- **Output columns**: `avg_start_freq_mhz`, `avg_end_freq_mhz`, `avg_drop_pct`, `throttled_core_ratio_pct`, `thermal_risk` (high/medium/low), `prediction`

```sql
WITH freq_samples AS (
  SELECT
    t.cpu, c.ts,
    c.value / 1000.0 as freq_mhz
  FROM counter c
  JOIN cpu_counter_track t ON c.track_id = t.id
  WHERE t.name = 'cpufreq'
    AND c.ts >= <start_ts>
    AND c.ts < <end_ts>
),
ordered AS (
  SELECT *,
    PERCENT_RANK() OVER (PARTITION BY cpu ORDER BY ts) as ts_rank
  FROM freq_samples
),
per_cpu AS (
  SELECT
    cpu,
    AVG(CASE WHEN ts_rank <= 0.2 THEN freq_mhz END) as start_freq_mhz,
    AVG(CASE WHEN ts_rank >= 0.8 THEN freq_mhz END) as end_freq_mhz,
    MAX(freq_mhz) as max_freq_mhz,
    MIN(freq_mhz) as min_freq_mhz
  FROM ordered
  GROUP BY cpu
),
scored AS (
  SELECT
    cpu, start_freq_mhz, end_freq_mhz, max_freq_mhz, min_freq_mhz,
    CASE
      WHEN start_freq_mhz IS NULL OR start_freq_mhz <= 0 THEN NULL
      ELSE 100.0 * (start_freq_mhz - end_freq_mhz) / start_freq_mhz
    END as drop_pct,
    CASE
      WHEN min_freq_mhz < max_freq_mhz * (1 - <core_drop_threshold_pct|30> / 100.0) THEN 1 ELSE 0
    END as likely_throttled
  FROM per_cpu
)
SELECT
  ROUND(AVG(CASE WHEN start_freq_mhz IS NOT NULL AND start_freq_mhz > 0 THEN start_freq_mhz END), 0) as avg_start_freq_mhz,
  ROUND(AVG(CASE WHEN start_freq_mhz IS NOT NULL AND start_freq_mhz > 0 THEN end_freq_mhz END), 0) as avg_end_freq_mhz,
  ROUND(AVG(drop_pct), 1) as avg_drop_pct,
  ROUND(
    100.0 * SUM(CASE WHEN start_freq_mhz IS NOT NULL AND start_freq_mhz > 0 THEN likely_throttled ELSE 0 END)
    / NULLIF(SUM(CASE WHEN start_freq_mhz IS NOT NULL AND start_freq_mhz > 0 THEN 1 ELSE 0 END), 0),
    1
  ) as throttled_core_ratio_pct,
  CASE
    WHEN AVG(drop_pct) >= <high_drop_threshold_pct|30>
         OR throttled_core_ratio >= <high_core_ratio_threshold_pct|50>
      THEN 'high'
    WHEN AVG(drop_pct) >= <medium_drop_threshold_pct|15>
         OR throttled_core_ratio >= <medium_core_ratio_threshold_pct|25>
      THEN 'medium'
    ELSE 'low'
  END as thermal_risk,
  -- prediction text omitted for brevity
FROM scored
```

---

## 10. Flutter 专用

### 10.1 flutter_scrolling_analysis — Flutter 滑动分析

- **Skill**: `flutter_scrolling_analysis` (composite, 5+ steps)
- **Chinese name**: Flutter 滑动分析
- **Description**: Flutter-specific frame analysis using `actual_frame_timeline_slice` and Flutter's thread model (`1.ui` / `1.raster` / `1.io`). Handles both SurfaceView (single pipeline: 1.ui -> 1.raster -> BufferQueue -> SurfaceFlinger) and TextureView (dual pipeline: 1.ui -> texture -> RenderThread updateTexImage -> composite).

#### Step 1: Flutter Frame Overview

- **Output columns**: `total_frames`, `avg_frame_ms`, `max_frame_ms`, `min_frame_ms`, `jank_frames`, `reported_jank_frames`, `jank_rate_pct`, `estimated_fps`

```sql
WITH flutter_frames AS (
  SELECT
    a.ts, a.dur,
    a.dur / 1e6 AS dur_ms,
    a.jank_type, a.jank_tag, a.on_time_finish
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (
    '<package>' = '' OR p.name LIKE '%<package>%'
  )
  AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR a.ts <= <end_ts>)
)
SELECT
  COUNT(*) AS total_frames,
  ROUND(AVG(dur_ms), 2) AS avg_frame_ms,
  ROUND(MAX(dur_ms), 2) AS max_frame_ms,
  ROUND(MIN(dur_ms), 2) AS min_frame_ms,
  SUM(CASE WHEN dur > <vsync_period_ns|16666667> * 1.5 THEN 1 ELSE 0 END) AS jank_frames,
  SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) AS reported_jank_frames,
  ROUND(
    100.0 * SUM(CASE WHEN dur > <vsync_period_ns|16666667> * 1.5 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1),
    1
  ) AS jank_rate_pct,
  CASE
    WHEN COUNT(*) > 0 AND MAX(ts + dur) > MIN(ts) THEN
      ROUND(COUNT(*) * 1e9 / NULLIF(MAX(ts + dur) - MIN(ts), 0), 1)
    ELSE 0
  END AS estimated_fps
FROM flutter_frames
```

#### Step 2: Flutter Thread Analysis (with TextureView detection)

- **Output columns**: `role`, `slice_count`, `avg_ms`, `max_ms`, `total_ms`, `over_budget_count`

```sql
WITH
-- Detect TextureView mode
textureview_check AS (
  SELECT
    (SELECT COUNT(DISTINCT t.utid) FROM thread t
     JOIN process p ON t.upid = p.upid
     WHERE t.name GLOB '*1.ui*'
       AND ('<package>' = '' OR p.name LIKE '%<package>%')
    ) as flutter_ui_threads,
    (SELECT COUNT(*) FROM slice s
     JOIN thread_track tt ON s.track_id = tt.id
     JOIN thread t ON tt.utid = t.utid
     WHERE (s.name GLOB '*updateTexImage*' OR s.name GLOB '*SurfaceTexture*')
       AND s.dur > 0
    ) as texture_view_slices
),
is_textureview AS (
  SELECT (flutter_ui_threads > 0 AND texture_view_slices > 5) as flag
  FROM textureview_check
),
-- Standard Flutter threads
flutter_threads AS (
  SELECT
    CASE
      WHEN t.name GLOB '*1.ui*' THEN 'UI (Dart)'
      WHEN t.name GLOB '*1.raster*' THEN 'Raster (GPU)'
      WHEN t.name GLOB '*1.io*' THEN 'IO (Decode)'
    END AS role,
    s.dur / 1e6 AS dur_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN process p ON t.upid = p.upid
  WHERE ('<package>' = '' OR p.name LIKE '%<package>%')
    AND (t.name GLOB '*1.ui*' OR t.name GLOB '*1.raster*' OR t.name GLOB '*1.io*')
    AND s.dur > 0
    AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR s.ts <= <end_ts>)
),
-- TextureView mode: RenderThread composition
textureview_threads AS (
  SELECT
    'RenderThread (TextureView)' AS role,
    s.dur / 1e6 AS dur_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  WHERE t.name = 'RenderThread'
    AND (s.name GLOB '*updateTexImage*' OR s.name GLOB '*DrawFrame*' OR s.name GLOB '*queueBuffer*')
    AND s.dur > 0
    AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR s.ts <= <end_ts>)
    AND (SELECT flag FROM is_textureview) = 1
),
all_threads AS (
  SELECT role, dur_ms FROM flutter_threads
  UNION ALL
  SELECT role, dur_ms FROM textureview_threads
)
SELECT
  role,
  COUNT(*) AS slice_count,
  ROUND(AVG(dur_ms), 2) AS avg_ms,
  ROUND(MAX(dur_ms), 2) AS max_ms,
  ROUND(SUM(dur_ms), 1) AS total_ms,
  SUM(CASE WHEN dur_ms > (<vsync_period_ns|16666667> / 1e6 * 1.5) THEN 1 ELSE 0 END) AS over_budget_count
FROM all_threads
GROUP BY role
ORDER BY total_ms DESC
```

#### Step 4: UI Thread (1.ui) Long Slices

```sql
SELECT
  s.name AS slice_name,
  printf('%d', s.ts) AS ts,
  ROUND(s.dur / 1e6, 2) AS dur_ms,
  CASE
    WHEN s.name LIKE '%BeginFrame%' THEN 'frame_build'
    WHEN s.name LIKE '%Build%' THEN 'widget_build'
    WHEN s.name LIKE '%Layout%' THEN 'layout'
    WHEN s.name LIKE '%Paint%' THEN 'paint'
    WHEN s.name LIKE '%Semantics%' THEN 'semantics'
    ELSE 'other'
  END AS category
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE ('<package>' = '' OR p.name LIKE '%<package>%')
  AND t.name GLOB '*1.ui*'
  AND s.dur > <vsync_period_ns>
  AND s.depth = 0
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts <= <end_ts>)
ORDER BY s.dur DESC
LIMIT 20
```

#### Step 5: Raster Thread (1.raster) Long Slices

```sql
SELECT
  s.name AS slice_name,
  printf('%d', s.ts) AS ts,
  ROUND(s.dur / 1e6, 2) AS dur_ms,
  CASE
    WHEN s.name LIKE '%DrawToSurface%' THEN 'draw_to_surface'
    WHEN s.name LIKE '%EntityPass%' THEN 'impeller_render'
    WHEN s.name LIKE '%SkGpu%' THEN 'skia_render'
    WHEN s.name LIKE '%Compositor%' THEN 'compositor'
    ELSE 'other'
  END AS category
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE ('<package>' = '' OR p.name LIKE '%<package>%')
  AND t.name GLOB '*1.raster*'
  AND s.dur > <vsync_period_ns>
  AND s.depth = 0
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts <= <end_ts>)
ORDER BY s.dur DESC
LIMIT 20
```

---

## 11. 批量帧根因分类

### 11.1 batch_frame_root_cause (from scrolling_analysis)

- **Source**: `scrolling_analysis.skill.yaml`, `batch_frame_root_cause` step
- **Chinese name**: 掉帧列表（含根因分类）
- **Description**: The largest and most complex SQL pattern. Performs a single-pass root cause classification for ALL jank frames using a priority-ordered decision tree. Collects per-frame: thread quadrant analysis (MainThread + RenderThread), CPU frequency, Binder/GC overlap, GPU fence wait, shader compilation, file IO, and lock contention.

#### Root Cause Decision Tree (21 reason codes, priority order)

| Priority | reason_code | Description | Condition |
|----------|-------------|-------------|-----------|
| P0 | `buffer_stuffing` | Buffer Stuffing pipeline backpressure | `jank_responsibility = 'BUFFER_STUFFING'` |
| P0.5 | `sf_composition_slow` | SurfaceFlinger composition timeout | `jank_responsibility = 'SF'` |
| P1 | `binder_sync_blocking` | Synchronous Binder blocking in top slice | `top_slice_ms > critical AND binder_overlap_ms >= binder_critical` |
| P1.5 | `gc_jank` | GC pause overlapping frame window | `gc_overlap_ms > 1.0` |
| P1.6 | `gc_pressure_cascade` | Multiple GC events (memory pressure) | `gc_count >= 3 AND gc_overlap_ms > 0.5` |
| P2 | `small_core_placement` | Top slice mostly on small cores | `top_slice_ms > critical AND little_run_pct >= 45` |
| P3 | `sched_delay_in_slice` | Scheduling delay within critical slice | `top_slice_ms > critical AND runnable_pct >= 15` |
| P3.5 | `shader_compile` | Shader compilation on RenderThread | `shader_count > 0 AND shader_dur > 30% budget` |
| P3.6 | `gpu_fence_wait` | GPU fence wait exceeds 50% of budget | `max_fence_dur > 50% vsync_period` |
| P3.7 | `render_thread_heavy` | RenderThread compute-heavy | `(RT_q1+RT_q2) > 70% AND RT_q4b < 20%` |
| P4 | `workload_heavy` | Heavy workload (>2x budget) | `top_slice_ms > budget * 2.0` |
| P4.5 | `thermal_throttling` | Thermal throttling detected | `big_max_freq < device_peak * 60%` |
| P4.6 | `cpu_max_limited` | Moderate frequency capping | `big_max_freq < device_peak * 75%` |
| P5 | `big_core_low_freq` | Big core running at low frequency | `big_avg < big_max * 55%` |
| P6 | `freq_ramp_slow` | Slow frequency ramp-up | `ramp_ms > freq_ramp_critical` |
| P7 | `cpu_saturation` | Both threads scheduling-delayed | `main_q3 > 15% AND render_q3 > 15%` |
| P7.5 | `scheduling_delay` | Main thread scheduling delay | `main_q3 > 20%` |
| P8 | `main_thread_file_io` | File IO on main thread | `file_io_overlap > 1.0ms` |
| P8.5 | `blocking_io` | IO blocking (D/DK state) | `main_q4a > 20%` |
| P9 | `binder_timeout` | Binder cumulative >500ms | `binder_overlap > 500ms` |
| P9.5 | `lock_binder_wait` | Lock/Binder wait (S/I state) | `main_q4b > 30%` |
| P10 | `small_core_placement` | Small core (quadrant-based) | `main_q2 > 50%` |
| P11 | `workload_heavy` | Fallback: workload timeout | `top_slice_ms > critical` |

#### Dynamic Thresholds (VSync-relative)

```
frame_budget_ms      = vsync_period_ns / 1e6
slice_critical_ms    = frame_budget_ms * 0.50
freq_ramp_critical_ms = MAX(frame_budget_ms * 0.35, 2.0)
binder_overlap_critical_ms = MAX(frame_budget_ms * 0.18, 1.5)
```

#### Per-Frame Data Collected (JSON columns for drill-down)

- `cpu_freq_clusters_json` — Per-cluster (prime/big/little) avg/max/min frequency
- `freq_timeline_json` — CPU frequency change events with relative timestamps
- `main_slices_json` — Top 8 main thread slices by total duration
- `render_slices_json` — Top 8 RenderThread slices by total duration
- `binder_calls_json` — Top 5 Binder call targets by duration
- `gc_events_json` — GC events by type with overlap duration
- `lock_contention_json` — Top 5 lock contentions with blocking method and wait time

#### Key CTEs Used in the Root Cause SQL

**Thread role identification** (supports both standard Android and Flutter):

```sql
per_frame_thread_roles AS (
  SELECT
    fl.frame_start,
    t.utid, t.tid, t.name as thread_name,
    CASE
      WHEN t.tid = p.pid THEN 'main'
      WHEN t.name GLOB '[0-9]*.ui' THEN 'main'        -- Flutter UI thread
      WHEN t.name = 'RenderThread' THEN 'render'
      WHEN t.name GLOB '[0-9]*.raster' THEN 'render'   -- Flutter raster thread
    END as role
  FROM jank_frame_list fl
  JOIN process p ON fl.upid = p.upid
  JOIN thread t ON t.upid = fl.upid
  WHERE t.tid = p.pid
    OR t.name = 'RenderThread'
    OR t.name GLOB '[0-9]*.ui'
    OR t.name GLOB '[0-9]*.raster'
)
```

**Four-quadrant thread state analysis** (main thread):

```sql
per_frame_quadrants AS (
  SELECT
    frame_start,
    ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND core_type IN ('prime', 'big') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q1_pct,   -- Q1: Running on big cores
    ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND core_type IN ('medium', 'little') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q2_pct,   -- Q2: Running on small cores
    ROUND(100.0 * SUM(CASE WHEN state = 'R' AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q3_pct,   -- Q3: Runnable (scheduling delay)
    ROUND(100.0 * SUM(CASE WHEN state IN ('D', 'DK') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q4a_pct,  -- Q4a: IO blocking
    ROUND(100.0 * SUM(CASE WHEN state IN ('S', 'I') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q4b_pct   -- Q4b: Lock/Binder sleep
  FROM frame_thread_states
  GROUP BY frame_start
)
```

**Device peak frequency** (for thermal/throttling detection):

```sql
device_peak_freq AS (
  SELECT COALESCE(ROUND(MAX(c.value) / 1000, 0), 0) as device_peak_freq_mhz
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id AND cct.name = 'cpufreq'
  LEFT JOIN _cpu_topology ct ON cct.cpu = ct.cpu_id
  WHERE ct.core_type IN ('prime', 'big')
  -- Note: No start_ts/end_ts filter — measures hardware ceiling across entire trace
)
```

**File IO detection** (SharedPreferences/SQLite/fsync):

```sql
per_frame_file_io AS (
  SELECT fl.frame_start,
    ROUND(SUM(
      MAX(MIN(s.ts + s.dur, fl.frame_end) - MAX(s.ts, fl.frame_start), 0)
    ) / 1e6, 2) as file_io_overlap_ms
  FROM jank_frame_list fl
  JOIN per_frame_thread_roles ptr ON ptr.frame_start = fl.frame_start AND ptr.role = 'main'
  JOIN thread_track tt ON tt.utid = ptr.utid
  JOIN slice s ON s.track_id = tt.id
    AND s.ts < fl.frame_end AND s.ts + s.dur > fl.frame_start
    AND s.dur > 500000
  WHERE s.name GLOB '*SharedPreferences*'
    OR s.name GLOB '*getSharedPreferences*'
    OR s.name GLOB '*commit*SharedPref*'
    OR s.name GLOB '*QueuedWork*'
    OR s.name GLOB '*waitToFinish*'
    OR s.name GLOB '*sqlite*'
    OR s.name GLOB '*SQLiteDatabase*'
    OR s.name GLOB '*openFile*'
    OR s.name GLOB '*fsync*'
  GROUP BY fl.frame_start
)
```

---

## Appendix: Key Tables Reference

| Table | Module | Description |
|-------|--------|-------------|
| `actual_frame_timeline_slice` | `android.frames.timeline` | Actual frame timeline with `jank_type`, `present_type`, `display_frame_token` |
| `expected_frame_timeline_slice` | `android.frames.timeline` | Expected frame timeline (VSync-based deadlines) |
| `counter` + `counter_track` | (built-in) | Counter tracks including `VSYNC-sf`, `VSYNC-app`, `cpufreq` |
| `cpu_counter_track` | (built-in) | CPU-specific counter tracks |
| `_cpu_topology` | (internal view) | CPU core type mapping (`prime`/`big`/`medium`/`little`) |
| `slice` + `thread_track` | (built-in) | Thread slices (doFrame, DrawFrame, etc.) |
| `thread` + `process` | (built-in) | Thread/process metadata |
| `thread_state` | (built-in) | Thread scheduling states (`Running`, `R`, `S`, `D`, `DK`, `I`) |
| `android_input_event_dispatch` | (built-in) | Input event dispatch records |
| `android_binder_txns` | `android.binder` | Binder transaction records |
| `android_garbage_collection_events` | `android.garbage_collection` | GC event records |
| `android_monitor_contention` | `android.monitor_contention` | Java lock contention records |
| `_android_critical_blocking_calls` | `android.critical_blocking_calls` | Critical blocking calls (internal stdlib table) |

### Thread State Reference

| State | Meaning |
|-------|---------|
| `Running` | Thread is executing on a CPU |
| `R` | Runnable — ready to run but waiting for CPU (scheduling delay) |
| `S` | Sleeping — voluntarily waiting (lock, Binder, futex) |
| `D` | Uninterruptible sleep — IO blocking |
| `DK` | Uninterruptible sleep (killable) — IO blocking variant |
| `I` | Idle — interruptible sleep |

### Core Type Reference

| Core Type | Description |
|-----------|-------------|
| `prime` | Highest-performance core (Cortex-X series) |
| `big` | High-performance core (Cortex-A7x series) |
| `medium` | Medium core (some SoCs have 3-cluster designs) |
| `little` | Efficiency core (Cortex-A5x series) |