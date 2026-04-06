<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# GPU 渲染分析 (gpu_render_in_range)

分析指定时间范围内 GPU 侧的工作负载，检测 GPU 渲染、Fence 等待等是否是性能瓶颈。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns，可选) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns，可选) |
| package | string | 否 | - | 目标进程名（支持 GLOB 匹配） |

## SQL 查询

```sql
WITH gpu_slices AS (
  SELECT
    s.name,
    s.dur,
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

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| operation | string | GPU 操作类型分类 |
| count | number | 操作次数 |
| total_ms | duration | 总耗时(ms) |
| max_ms | duration | 单次最大耗时(ms) |
| avg_ms | duration | 平均耗时(ms) |

## 使用说明

- 操作分类覆盖 9 种 GPU 相关操作: Draw Frame, Fence Signal/Wait, EGL SwapBuffers, GPU Flush, Queue/Dequeue Buffer, GPU Other, RenderThread
- 同时匹配目标进程和 surfaceflinger 进程的 GPU slice
- 过滤 dur > 10us 的 slice，避免微小事件干扰
- Fence Wait 时间长通常表示 GPU 管线积压或前帧未完成
- display.level = detail, display.layer = deep