<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 渲染流水线时延 (render_pipeline_latency)

分解帧渲染全链路各阶段耗时，分析从 App 画图到屏幕显示的全链路耗时，分解主线程和 RenderThread 各阶段占比。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 是 | - | 帧开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 帧结束时间戳(ns) |
| main_start_ts | timestamp | 否 | - | 主线程开始时间戳(ns) |
| main_end_ts | timestamp | 否 | - | 主线程结束时间戳(ns) |
| render_start_ts | timestamp | 否 | - | RenderThread 开始时间戳(ns) |
| render_end_ts | timestamp | 否 | - | RenderThread 结束时间戳(ns) |

## SQL 查询

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

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| stage | string | 阶段名称 |
| dur_ms | duration | 该阶段耗时(ms) |
| pct | percentage | 该阶段占总耗时的百分比 |

## 使用说明

- 用于单帧的渲染流水线深度分析，通常在 jank_frame_detail 下游调用
- 将帧总耗时拆分为 4 个阶段：总耗时、主线程 UI 构建、RenderThread GPU 指令、主线程到 RenderThread 的交接
- 当 main_start_ts/main_end_ts/render_start_ts/render_end_ts 未提供时，使用 start_ts/end_ts 作为回退
- 交接耗时（handoff_dur）仅在 render_start_ts 和 main_end_ts 都存在时计算
- display.level = key, display.layer = deep