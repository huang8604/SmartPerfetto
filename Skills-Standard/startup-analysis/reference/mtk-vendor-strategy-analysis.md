<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# MTK 启动场景策略分析指南

## 概述

MTK 平台对启动场景有专用的性能策略：Launch Boost、频率地板、cpuset/schedtune 切换、task placement。与滑动策略不同，启动策略是**事件触发 + 定时持续**的模式，而非帧级反馈。

本文档指导如何在 trace 中识别和分析这些 MTK 启动策略行为。

## 1. MTK 启动策略栈

```
┌─────────────────────────────────────────────┐
│  场景识别层 (Activity Launch Detection)      │
│  AMS 通知启动事件 → 选择策略                 │
├─────────────────────────────────────────────┤
│  Boost 策略层 (Launch Boost)                 │
│  全核高频 / 定时持续 / uclamp 提升           │
├─────────────────────────────────────────────┤
│  进程管理层 (cpuset/schedtune/cgroup)        │
│  background → top-app 切换 / OOM_adj 调整    │
├─────────────────────────────────────────────┤
│  调度策略层 (EAS/Task Placement)             │
│  uclamp.min 地板 / 大核绑定 / 迁移成本       │
├─────────────────────────────────────────────┤
│  硬件层 (Governor/Thermal)                   │
│  sugov ramp-up / thermal 限制               │
└─────────────────────────────────────────────┘
```

## 2. Launch Boost

MTK 在 AMS 检测到 Activity Launch 时触发全核 Boost。

### 检测 Boost 是否触发

```sql
SELECT name, COUNT(*) as cnt, ROUND(SUM(dur)/1e6, 1) as total_ms,
  ROUND(MIN(dur)/1e6, 1) as min_ms, ROUND(MAX(dur)/1e6, 1) as max_ms
FROM slice
WHERE (
  name GLOB '*boost*' OR name GLOB '*launch*perf*' OR
  name GLOB '*PowerHal*' OR name GLOB '*PerfService*' OR
  name GLOB '*perf_idx*' OR name GLOB '*sched_boost*' OR
  name GLOB '*SchedTune*'
)
AND ts BETWEEN <start_ts> - 500000000 AND <end_ts>
GROUP BY name ORDER BY cnt DESC LIMIT 20
```

### Boost 效果验证

| 检查项 | 正常 | 异常 |
|--------|------|------|
| 启动前 100ms 内出现 Boost slice | 及时触发 | 无 Boost → 策略未生效 |
| Boost 持续 >= 关键路径时长 | 覆盖 bindApplication + activityStart | 提前过期 → 后半段无保障 |
| Boost 期间大核频率 > 峰值 80% | 充分保障 | 频率仍低 → Boost 力度不足或被 thermal 压制 |
| Boost 期间主线程 > 90% 大核 | 摆核正确 | 仍有小核 → cpuset 切换延迟 |

## 3. cpuset/schedtune 切换

启动时进程需要从 background cpuset 切换到 top-app。切换延迟会导致启动初期主线程被困在小核。

### 检测切换延迟

```sql
-- 启动前 50ms 的核心分布 vs 启动后 50ms
-- 如果前 50ms 全在小核，后 50ms 切到大核，说明有切换延迟
WITH startup AS (
  SELECT s.ts as start_ts FROM android_startups s LIMIT 1
),
early AS (
  SELECT ts2.cpu, SUM(ts2.dur) as dur
  FROM thread_state ts2
  JOIN thread t ON ts2.utid = t.utid
  JOIN process p ON t.upid = p.upid, startup su
  WHERE t.is_main_thread = 1 AND p.name GLOB '<package>*'
    AND ts2.state = 'Running'
    AND ts2.ts BETWEEN su.start_ts AND su.start_ts + 50000000
  GROUP BY ts2.cpu
)
SELECT cpu,
  ROUND(dur / 1e6, 2) as running_ms,
  ROUND(100.0 * dur / SUM(dur) OVER (), 1) as pct
FROM early ORDER BY dur DESC
```

信号：前 50ms 主线程 100% 小核，之后切到大核 → cpuset 切换有 ~50ms 延迟。

### WALT/PELT util 建模滞后

EAS 调度器依赖 WALT 或 PELT 的 util_avg 来决定 task placement。启动初期 task 刚创建，util_avg = 0，即使 task 实际需要大核算力，调度器也会先放小核。

- **PELT**：util_avg 需要 ~32ms 半衰期才能反映真实负载
- **WALT**：基于窗口的 demand 估算，通常更快响应但也有首窗口延迟

这意味着启动前 30-50ms 的摆核行为可能不受 EAS 控制，而是由 initial util guess 决定。

**对策**：uclamp.min 可以覆盖 util_avg 不足的问题——即使 util_avg = 0，有 uclamp.min 就能保证不落小核。

## 4. 频率地板（启动场景）

```sql
-- 启动期间大核最低频率（是否有地板保障）
SELECT
  MIN(CAST(c.value AS INTEGER)) / 1000 as min_freq_mhz,
  ROUND(AVG(CAST(c.value AS INTEGER)) / 1000, 0) as avg_freq_mhz,
  MAX(CAST(c.value AS INTEGER)) / 1000 as max_freq_mhz,
  CASE
    WHEN MIN(CAST(c.value AS INTEGER)) > MAX(CAST(c.value AS INTEGER)) * 0.5
    THEN 'Floor active (min > 50% of max)'
    ELSE 'No floor detected'
  END as floor_status
FROM counter c
JOIN cpu_counter_track cct ON c.track_id = cct.id
WHERE cct.name GLOB 'cpu*freq*'
  AND cct.cpu IN (<big_core_ids>)
  AND c.ts BETWEEN <start_ts> AND <end_ts>
```

## 5. Binder 线程池冷态

启动时 App 进程的 Binder 线程池可能还没有 spawn 足够的线程。如果同时有多个 Binder 调用（如 ContentProvider + PackageManager + ActivityManager），线程池饱和会导致排队延迟。

```sql
-- 启动期间 Binder 线程活跃数和利用率
SELECT
  COUNT(DISTINCT t.name) as binder_threads,
  ROUND(SUM(CASE WHEN ts2.state = 'Running' THEN ts2.dur ELSE 0 END) / 1e6, 1) as running_ms,
  ROUND(SUM(CASE WHEN ts2.state IN ('S') AND ts2.blocked_function GLOB '*binder_wait*'
    THEN ts2.dur ELSE 0 END) / 1e6, 1) as idle_ms
FROM thread_state ts2
JOIN thread t ON ts2.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND t.name GLOB 'Binder:*'
  AND ts2.ts BETWEEN <start_ts> AND <end_ts>
```

## 6. 与滑动策略的区别

| 维度 | 启动策略 | 滑动策略 |
|------|---------|---------|
| 触发条件 | AMS Activity launch 事件 | FPSGO 检测到帧流 |
| 持续时间 | 固定时长或到首帧 | 跟随手势持续 |
| Boost 力度 | 通常更激进（全核高频） | 按需调节（帧级反馈） |
| 频率地板 | 固定值 | 动态（基于帧耗时反馈） |
| 急拉 | 无（不做帧级预判） | 有（预判掉帧急拉） |
| 场景识别 | AMS 直接通知 | FPSGO 自动检测帧流 + 架构分类 |

## 7. 策略对比框架

| 策略层 | 检查项 | 差异影响 |
|--------|--------|---------|
| 场景识别 | 是否识别为启动场景 | 未识别 → 无 Boost |
| Launch Boost | 触发时机/目标频率/持续时间 | Boost 不足 → 初期低频 |
| cpuset 切换 | 前 50ms 核心分布 | 延迟 → 困小核 |
| 频率地板 | 有/无、地板高度 | 无 → 帧间回落 |
| uclamp.min | 值、覆盖线程 | 低/无 → EAS 不保证大核 |
| WALT/PELT | util 建模速度 | 慢 → 前 30ms 错误摆核 |
| Binder pool | 线程数、冷态 | 少 → 并发 Binder 排队 |
| Thermal | Boost 前是否已限频 | 热机连续启动场景 |