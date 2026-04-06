<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# VSync 相位对齐分析 (vsync_phase_alignment)

分析输入事件与 VSync 信号的相位关系，定位跟手延迟中的 VSync 等待瓶颈。相位差决定了输入事件需要等待多久才能被处理（跟手度的关键因素）。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 目标进程名（支持 GLOB） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |

## 步骤编排

### Step 1: vsync_timeline - VSync 时间线

获取 VSYNC-app counter 统计，输出 VSync 数量、周期、刷新率。

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

### Step 2: phase_analysis - 逐事件相位分析

将每个 ACTION_MOVE 输入事件与最近的 VSYNC-app 信号对齐，计算相位偏移和 VSync 等待时间。

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

### Step 3: phase_distribution - 相位分布统计

汇总统计：P50/P90 相位偏移、P50/P90 VSync 等待、不利相位占比、样本数。

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| input_ts | timestamp | 输入事件时间 |
| nearest_vsync_ts | timestamp | 最近 VSync 时间 |
| phase_offset_ms | number | 相位偏移(ms) |
| phase_ratio_pct | percentage | 相位比(%) |
| wait_ms | duration | 等待下个 VSync(ms) |

## 使用说明

- 依赖 `android_input_event_dispatch` 表和 `VSYNC-app` counter（部分 trace 不含输入事件数据）
- 仅分析 ACTION_MOVE 事件（滑动过程中的跟手度核心）
- 相位偏移 > 75% VSync 周期 = 不利相位（输入事件在 VSync 末尾到达，需要等待几乎整个周期）
- 用于跟手度/touch-tracking 场景分析