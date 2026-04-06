<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# CPU Idle (cpuidle) C-State 分析

## 概述

CPU 在帧间 idle 时会进入低功耗 C-state。从深 C-state 唤醒有延迟，叠加 governor 升频延迟后，是帧起始时频率不足的重要原因。

## C-State 深度 vs 唤醒延迟

| C-State | 典型退出延迟 | 功耗节省 | 说明 |
|---------|------------|---------|------|
| C0 (Active) | 0 | 无 | CPU 运行中 |
| C1 (WFI) | ~1-5us | 低 | Wait-For-Interrupt |
| C2 (Retention) | ~50-200us | 中 | 保持状态但关闭时钟 |
| C3/PC (Power Collapse) | 500us-2ms | 高 | 完全断电，需要恢复状态 |

## cpuidle Counter Track 查询

```sql
-- 查询 CPU idle 状态变化
-- value: -1 = exiting idle, >=0 = entering C-state N
SELECT
  c.ts,
  cct.cpu,
  CAST(c.value AS INTEGER) as idle_state
FROM counter c
JOIN cpu_counter_track cct ON c.track_id = cct.id
WHERE cct.name = 'cpuidle'
ORDER BY c.ts
```

## 帧起始时 CPU Idle 状态检测

```sql
-- 对每个掉帧帧，检查帧开始前大核的 idle 状态
-- 如果帧开始时大核在深 idle (C2+)，升频总延迟 = C-state exit + governor ramp-up
WITH jank_frames AS (
  SELECT ts, dur FROM actual_frame_timeline_slice
  WHERE jank_type != 'None' AND dur > <vsync_period_ns> * 1.5
),
last_idle AS (
  SELECT f.ts as frame_ts,
    cct.cpu,
    CAST(c.value AS INTEGER) as idle_state,
    c.ts as idle_ts
  FROM jank_frames f
  JOIN counter c JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name = 'cpuidle'
    AND cct.cpu IN (<big_core_ids>)
    AND c.ts <= f.ts
    AND c.ts > f.ts - 10000000  -- 帧前 10ms 内
  ORDER BY c.ts DESC
  LIMIT 1
)
SELECT frame_ts, cpu, idle_state,
  CASE
    WHEN idle_state >= 2 THEN 'Deep idle (C2+) — 预期唤醒延迟 50-200us+'
    WHEN idle_state = 1 THEN 'Light idle (C1) — 唤醒延迟 <5us'
    WHEN idle_state = 0 THEN 'Active — 无 idle 开销'
    ELSE 'Exiting idle'
  END as assessment
FROM last_idle
```

## 与 governor ramp-up 的叠加

实际升频总延迟 = C-state exit latency + governor response time

- 如果帧前 CPU 在 C3/PC 状态：exit 500us + ramp-up 5ms = ~5.5ms
- 对 120Hz (8.33ms budget) 设备，5.5ms 已占帧预算 66%