<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# VSync 配置分析 (vsync_config)

从 trace 中解析实际的 Vsync 周期和刷新率设置。

数据来源（按优先级）：
1. VSYNC-sf counter track 间隔的中位数（PERCENTILE 0.5，直接反映显示侧消费节奏）
2. expected_frame_timeline_slice 的帧 duration 中位数（作为回退）
3. 默认 60Hz（16.67ms）

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 否 | - | 分析起始时间（可选） |
| end_ts | timestamp | 否 | - | 分析结束时间（可选） |

## SQL 查询

```sql
WITH
-- 方法1: 从 expected_frame_timeline_slice 获取 vsync 周期（回退来源）
-- 当提供 start_ts/end_ts 时，只看该区间内的帧（避免 VRR 省电时段干扰）
expected_frame_vsync AS (
  SELECT
    CAST(PERCENTILE(dur, 0.5) AS INTEGER) as vsync_period_ns,
    'expected_frame_dur' as source
  FROM expected_frame_timeline_slice
  WHERE dur > 5000000 AND dur < 50000000  -- 5ms-50ms 覆盖 24Hz VRR
    AND (<start_ts> IS NULL OR ts >= <start_ts>)
    AND (<end_ts> IS NULL OR ts < <end_ts>)
),
-- 方法2: 从 VSYNC-sf counter track 推算周期 (优先来源)
-- counter 值在 0/1 间交替，每次变化代表一个 vsync tick
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
-- 合并结果，sf_vsync 优先，expected_frame 回退
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
        WHEN (...) > 0 THEN 'sf_vsync_counter'
        WHEN (...) IS NOT NULL THEN 'expected_frame_dur'
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

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| vsync_period_ns | integer | Vsync 周期（纳秒） |
| refresh_rate_hz | number | 刷新率（Hz） |
| vsync_period_ms | number | Vsync 周期（毫秒） |
| vsync_source | string | 数据来源（sf_vsync_counter / expected_frame_dur / default_60hz） |
| detected_refresh_rate | integer | 检测到的刷新率 |

## 使用说明

- 前置依赖：`expected_frame_timeline_slice` 表，`android.frames.timeline` 模块
- 标准刷新率吸附范围：30Hz / 60Hz / 90Hz / 120Hz / 144Hz / 165Hz
- 提供 start_ts/end_ts 时只分析指定区间，避免 VRR 省电时段干扰
- 被 `scrolling_analysis`、`consumer_jank_detection` 等多个 composite skill 内部引用