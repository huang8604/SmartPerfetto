<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# GPU 频率/利用率分析 (gpu_frequency_analysis)

GPU 性能分析不能只看 slice 名称匹配（Fence Wait 等），还需要关联 GPU 频率和利用率。

## GPU 频率查询

```sql
-- GPU frequency counter tracks
-- 注意：不同 GPU 厂商的 counter track 名称不同
SELECT
  ct.name as counter_name,
  c.ts,
  CAST(c.value AS INTEGER) as freq_mhz
FROM counter c
JOIN counter_track ct ON c.track_id = ct.id
WHERE ct.name GLOB '*gpu*freq*'
  OR ct.name GLOB '*mali*freq*'
  OR ct.name GLOB '*adreno*freq*'
  OR ct.name GLOB '*img*freq*'
ORDER BY c.ts
```

## GPU 频率 vs 帧耗时关联

```sql
-- 对每个掉帧帧，查询帧窗口内的 GPU 频率
WITH jank_frames AS (
  SELECT ts, dur FROM actual_frame_timeline_slice
  WHERE jank_type != 'None' AND jank_type != 'Buffer Stuffing'
),
gpu_freq AS (
  SELECT c.ts, CAST(c.value AS INTEGER) as freq
  FROM counter c
  JOIN counter_track ct ON c.track_id = ct.id
  WHERE ct.name GLOB '*gpu*freq*'
)
SELECT
  f.ts,
  ROUND(f.dur / 1e6, 2) as frame_ms,
  ROUND(AVG(g.freq), 0) as avg_gpu_freq,
  MAX(g.freq) as max_gpu_freq
FROM jank_frames f
LEFT JOIN gpu_freq g ON g.ts BETWEEN f.ts AND f.ts + f.dur
GROUP BY f.ts
ORDER BY f.dur DESC
LIMIT 20
```

## GPU Thermal Throttling 检测

```sql
-- GPU 频率天花板 vs trace 全局最高频
WITH gpu_max AS (
  SELECT MAX(CAST(c.value AS INTEGER)) as peak_freq
  FROM counter c JOIN counter_track ct ON c.track_id = ct.id
  WHERE ct.name GLOB '*gpu*freq*'
),
gpu_recent AS (
  SELECT MAX(CAST(c.value AS INTEGER)) as recent_max
  FROM counter c JOIN counter_track ct ON c.track_id = ct.id
  WHERE ct.name GLOB '*gpu*freq*'
    AND c.ts > (SELECT MAX(ts) - 5000000000 FROM counter)  -- 最后 5s
)
SELECT
  (SELECT peak_freq FROM gpu_max) as trace_peak_mhz,
  (SELECT recent_max FROM gpu_recent) as recent_max_mhz,
  CASE WHEN (SELECT recent_max FROM gpu_recent) < (SELECT peak_freq FROM gpu_max) * 0.7
    THEN 'GPU Thermal Throttling Detected'
    ELSE 'GPU freq normal' END as assessment
```

## HWC vs GPU 合成区分

SurfaceFlinger 合成有两种模式：
- **HWC 合成**：硬件合成器直接合成 Layer，效率高
- **GPU 合成（Client Composition）**：SF 回退到 GPU 渲染，较慢

从 SF composition slice 推断：如果 SF 帧窗口内有大量 GPU draw 操作，可能是 HWC 回退。