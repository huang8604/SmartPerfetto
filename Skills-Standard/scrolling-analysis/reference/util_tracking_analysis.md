<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# WALT/PELT Util 建模分析

## 概述

EAS 调度器依赖 task 的 util_avg 来决定 CPU 频率和核心放置。util_avg 的建模准确性直接影响调度质量。

## WALT vs PELT

| 维度 | PELT (AOSP upstream) | WALT (高通/MTK 定制) |
|------|---------------------|---------------------|
| 算法 | 指数加权移动平均 | 窗口内 MAX 取值 |
| 半衰期/窗口 | ~32ms (half-life) | ~20ms (window) |
| 从 0→90% 稳态 | ~100ms | ~20-40ms |
| 突发负载响应 | 慢（需要积累历史） | 快（一个窗口即响应） |
| 过度调度风险 | 低 | 高（MAX 容易高估） |
| 启动场景影响 | 前 100ms util_avg 严重不足 | 前 20ms 可能不足 |

## Trace 中的 util 数据

```sql
-- 搜索 eas_util / sugov_util 相关事件（需 MTK vendor trace tags）
SELECT name, COUNT(*) as cnt
FROM slice
WHERE name GLOB '*util*' OR name GLOB '*eas*' OR name GLOB '*sugov*'
GROUP BY name ORDER BY cnt DESC LIMIT 20
```

## util 建模延迟量化

```sql
-- 方法：对比 task 实际 CPU 使用率 vs governor 选择的频率
-- 如果任务一直在 Running 但频率很低，说明 util_avg 还没反映真实负载
WITH task_running AS (
  SELECT ts, dur, cpu
  FROM sched_slice
  WHERE utid = (SELECT utid FROM thread WHERE name = 'main' AND
    upid = (SELECT upid FROM process WHERE name GLOB '<package>*') LIMIT 1)
  AND ts BETWEEN <start_ts> AND <start_ts> + 100000000  -- 前 100ms
),
freq_at_time AS (
  SELECT c.ts, CAST(c.value AS INTEGER) as freq, cct.cpu
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name GLOB 'cpu*freq*'
    AND c.ts BETWEEN <start_ts> AND <start_ts> + 100000000
)
SELECT
  ROUND((tr.ts - <start_ts>) / 1e6, 1) as offset_ms,
  tr.cpu,
  ROUND(tr.dur / 1e6, 2) as running_ms,
  (SELECT freq FROM freq_at_time f WHERE f.cpu = tr.cpu AND f.ts <= tr.ts ORDER BY f.ts DESC LIMIT 1) / 1000 as freq_mhz
FROM task_running tr
ORDER BY tr.ts
LIMIT 20
```

## uclamp 覆盖 util 不足

uclamp.min 可以覆盖 util_avg 建模延迟：即使 util_avg = 0，有 uclamp.min >= 512 就能保证 EAS 选择大核 + 高频。这是启动场景和滑动场景的关键防线。