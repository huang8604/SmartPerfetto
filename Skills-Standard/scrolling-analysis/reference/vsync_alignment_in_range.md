<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# VSync 对齐分析 (vsync_alignment_in_range)

分析帧与 VSync 信号的对齐情况，检测帧是否在 VSync 周期内完成。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 是 | - | 帧开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 帧结束时间戳(ns) |

## SQL 查询

```sql
WITH vsync_ticks AS (
  SELECT c.ts, c.value,
    c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE (t.name LIKE '%VSYNC-sf%' OR t.name LIKE '%VSYNC-app%' OR t.name = 'VSYNC')
    AND c.ts >= <start_ts> - 100000000  -- 往前看 100ms
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
SELECT 'VSync 周期' as metric, ... as value
FROM frame_timing
UNION ALL
SELECT '帧耗时' as metric, ROUND(frame_dur / 1e6, 2) || 'ms' as value
FROM frame_timing
UNION ALL
SELECT '相对 VSync 周期' as metric, ROUND(100.0 * frame_dur / vsync_period, 1) || '%' as value
FROM frame_timing
UNION ALL
SELECT '帧起点偏移' as metric, ... as value
FROM frame_timing
UNION ALL
SELECT '截止时间' as metric, ... as value  -- 超时/提前 Xms
FROM frame_timing
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| metric | string | 指标名称 |
| value | string | 指标值（带单位） |

输出为 key-value 对形式，包括：
- VSync 周期
- 帧耗时
- 相对 VSync 周期（百分比）
- 帧起点偏移（距上次 VSync）
- 截止时间（超时/提前 ms）

## 使用说明

- 用于单帧深度分析，需要精确的帧起止时间戳
- 适合从 `jank_frame_detail` 中获取帧时间后调用
- 查找 VSYNC-sf / VSYNC-app / VSYNC 三种 counter track
- 分析窗口会向前后各扩展 100ms 以找到相邻 VSync 信号