<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 渲染线程 Slice 分析 (render_thread_slices)

分析渲染线程的时间片分布，找出 RenderThread 上的耗时操作。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 是 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 分析结束时间戳(ns) |
| package | string | 否 | - | 应用包名 |

## 前置条件

- 必需表: `slice`, `thread`

## SQL 查询

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
  AND s.dur >= 500000
GROUP BY s.name
HAVING total_ms > 0.5
ORDER BY total_ms DESC
LIMIT 10
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| name | string | Slice 操作名称 |
| total_ms | duration | 所有同名操作的总耗时(ms) |
| count | number | 操作出现次数 |
| max_ms | duration | 单次最大耗时(ms) |
| avg_ms | duration | 平均耗时(ms) |

## 使用说明

- 仅分析 RenderThread 上 dur >= 0.5ms 的 slice，避免噪声
- 按 total_ms 降序排列，返回 Top 10 耗时操作
- 常见高耗时操作: DrawFrame, eglSwapBuffers, dequeueBuffer, queueBuffer, syncFrameState
- 结合 render_pipeline_latency 一起使用，可定位 RT 侧瓶颈的具体操作