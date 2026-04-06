<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# MTK 调度深钻分析指南

## 概述

作为芯片厂商，我们对 CPU 调度行为有完整的控制权和可观测性。标准 AOSP trace 能提供基础的 sched_switch/cpu_frequency 数据，但 MTK 平台有更丰富的 trace points 可以做更深入的分析。

本文档指导如何利用 MTK 特有能力做深入的调度/频率分析。

## 1. 帧级频率分析（Per-Frame DVFS）

### 为什么均频不够

标准分析用"帧窗口内大核平均频率"做判断，但这掩盖了关键信息：
- 帧开始时 governor 可能还没升频（ramp-up delay）
- 帧中间可能因 idle 被降频再升频
- thermal throttling 可能在帧执行过程中触发

### 帧内频率变化曲线

```sql
-- 查询单帧窗口内的 CPU 频率变化时间线
-- <frame_start_ts> 和 <frame_end_ts> 从掉帧帧的 start_ts/end_ts 获取
SELECT
  c.ts,
  printf('%d', c.ts - <frame_start_ts>) as offset_ns,
  ROUND((c.ts - <frame_start_ts>) / 1e6, 2) as offset_ms,
  cct.cpu,
  CAST(c.value AS INTEGER) as freq_khz,
  ROUND(c.value / 1000, 0) as freq_mhz
FROM counter c
JOIN cpu_counter_track cct ON c.track_id = cct.id
WHERE cct.name = 'cpufreq'
  AND c.ts BETWEEN <frame_start_ts> AND <frame_end_ts>
  AND cct.cpu IN (<big_core_ids>)
ORDER BY c.ts
```

**分析要点**：
- 帧开始时频率 vs 帧结束时频率：如果差距大，说明 governor 升频延迟
- 频率跳变次数：>3 次跳变说明 governor 在频繁调整，可能参数不稳定
- 频率天花板：如果从未达到 `scaling_max_freq`，检查 thermal 限制

### governor 响应时间测量

```sql
-- 测量从帧开始（负载上升）到频率达到目标的延迟
-- 前提：帧开始前 CPU 处于低频状态
WITH frame AS (
  SELECT <frame_start_ts> as start_ts, <frame_end_ts> as end_ts
),
freq_events AS (
  SELECT c.ts, CAST(c.value AS INTEGER) as freq_khz, cct.cpu
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name = 'cpufreq'
    AND cct.cpu IN (<big_core_ids>)
    AND c.ts BETWEEN (SELECT start_ts - 5000000 FROM frame) -- 5ms before
                 AND (SELECT end_ts FROM frame)
  ORDER BY c.ts
),
max_freq AS (
  SELECT MAX(freq_khz) as peak FROM freq_events
  WHERE ts BETWEEN (SELECT start_ts FROM frame) AND (SELECT end_ts FROM frame)
)
SELECT
  (SELECT freq_khz FROM freq_events WHERE ts <= (SELECT start_ts FROM frame) ORDER BY ts DESC LIMIT 1) as freq_before_frame_khz,
  (SELECT peak FROM max_freq) as peak_during_frame_khz,
  (SELECT MIN(ts) FROM freq_events
   WHERE freq_khz >= (SELECT peak * 0.9 FROM max_freq)
     AND ts >= (SELECT start_ts FROM frame)
  ) - (SELECT start_ts FROM frame) as rampup_latency_ns
```

## 2. 摆核精细分析

### 核迁移事件追踪

```sql
-- 主线程在帧窗口内的核迁移事件（精确到每次迁移）
WITH migrations AS (
  SELECT
    ts.ts,
    ts.cpu as to_cpu,
    LAG(ts.cpu) OVER (ORDER BY ts.ts) as from_cpu,
    ts.dur
  FROM thread_state ts
  JOIN thread t ON ts.utid = t.utid
  JOIN process p ON t.upid = p.upid
  WHERE t.is_main_thread = 1
    AND p.name GLOB '<package>*'
    AND ts.state = 'Running'
    AND ts.ts BETWEEN <frame_start_ts> AND <frame_end_ts>
)
SELECT
  printf('%d', ts - <frame_start_ts>) as offset_ns,
  ROUND((ts - <frame_start_ts>) / 1e6, 2) as offset_ms,
  from_cpu,
  to_cpu,
  CASE
    WHEN from_cpu IN (<big_core_ids>) AND to_cpu IN (<little_core_ids>) THEN 'BIG→LITTLE ⚠️'
    WHEN from_cpu IN (<little_core_ids>) AND to_cpu IN (<big_core_ids>) THEN 'LITTLE→BIG'
    WHEN from_cpu != to_cpu THEN 'SAME_CLUSTER'
    ELSE 'NO_MIGRATION'
  END as migration_type,
  ROUND(dur / 1e6, 2) as running_ms_after
FROM migrations
WHERE from_cpu IS NOT NULL AND from_cpu != to_cpu
ORDER BY ts
```

### 为什么被调度到小核

当主线程被调度到小核（Q2 高）时，需要定位原因：

```sql
-- 检查小核运行期间，大核在做什么（谁占了大核）
WITH main_on_little AS (
  SELECT ts.ts, ts.dur, ts.cpu
  FROM thread_state ts
  JOIN thread t ON ts.utid = t.utid
  JOIN process p ON t.upid = p.upid
  WHERE t.is_main_thread = 1
    AND p.name GLOB '<package>*'
    AND ts.state = 'Running'
    AND ts.cpu IN (<little_core_ids>)
    AND ts.ts BETWEEN <start_ts> AND <end_ts>
    AND ts.dur > 1000000  -- > 1ms
  ORDER BY ts.dur DESC
  LIMIT 5
)
SELECT
  m.cpu as main_on_cpu,
  ROUND(m.dur / 1e6, 2) as main_dur_ms,
  ts2.cpu as big_core,
  t2.name as occupant_thread,
  p2.name as occupant_process,
  ROUND(ts2.dur / 1e6, 2) as occupant_dur_ms
FROM main_on_little m
JOIN thread_state ts2 ON ts2.state = 'Running'
  AND ts2.cpu IN (<big_core_ids>)
  AND ts2.ts < m.ts + m.dur
  AND ts2.ts + ts2.dur > m.ts
JOIN thread t2 ON ts2.utid = t2.utid
JOIN process p2 ON t2.upid = p2.upid
ORDER BY m.dur DESC, ts2.dur DESC
```

## 3. MTK Vendor Trace Tags

以下 MTK 特有 trace points 可以提供更深入的数据。如果当前 trace 中没有，可以要求 QA 重新抓取时开启。

### 调度相关

| Trace Tag / Event | 提供的信息 | 使用场景 |
|-------------------|-----------|---------|
| `mtk_sched` | MTK scheduler extension events | EAS 决策追踪 |
| `eas_util` / `sugov_util` | Per-CPU utilization used by governor | 频率决策输入 |
| `capacity_margin` | Capacity margin for task placement | 摆核决策依据 |
| `thermal_power_allocator` | Power budget allocation | Thermal 如何分配功耗预算 |
| `ppmu` / `dvfsrc` | DRAM frequency and bandwidth | 内存带宽瓶颈 |

### 频率相关

| Trace Tag / Event | 提供的信息 | 使用场景 |
|-------------------|-----------|---------|
| `cpufreq_transition` | 频率切换事件（含 target freq） | 精确的升降频时机 |
| `cpu_idle` | C-state 进入/退出 | idle 对升频延迟的影响 |
| `mtk_gpufreq` | GPU frequency transitions | GPU 负载与频率关联 |
| `thermal_zone` | 各温度传感器读数 | Thermal 限频的温度证据 |

### 抓取建议

如果分析中发现以下情况，建议要求 QA 用增强配置重新抓取：

| 发现 | 缺失数据 | 建议增加的 trace config |
|------|---------|----------------------|
| Q2 高但不知道为什么 | 大核占用者信息不足 | `sched` + `freq` + 更大 buffer |
| 频率升不上去 | governor 决策过程 | `power` + `thermal` + MTK `eas_util` |
| 帧内频率抖动 | 抖动原因 | `cpufreq_transition` + `cpu_idle` |
| Thermal 限频但不确定来源 | 温度数据 | `thermal_zone` counters |
| 内存带宽瓶颈疑似 | DRAM 频率 | `ppmu` / `dvfsrc` |

## 4. 调度优化方向映射

作为 MTK，对比分析中发现的系统层差异可以直接转化为调优行动：

| 差异信号 | 可调参数 | 典型调优 |
|---------|---------|---------|
| 主线程频繁落小核 | `uclamp.min` / `sched_boost` | 提高前台启动场景的 uclamp.min |
| Governor 升频慢 | `sugov` rate_limit, up_rate_limit | 缩短升频响应时间 |
| Thermal 过早限频 | thermal governor 阈值 | 调整温度阈值或 power budget |
| 核迁移过多 | `sched_nr_migrate`, `sched_migration_cost` | 增加迁移成本避免抖动 |
| 大核被后台抢占 | `cgroup` 配置, `oom_adj` | 加强后台进程 CPU 隔离 |
| 帧内频率回落 | `schedutil` iowait_boost, idle 策略 | 优化 idle 预测避免不必要降频 |