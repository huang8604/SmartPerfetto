<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 对比分析方法论与 SQL 模板

## 概述

对比分析用于：同一 App 在问题机和对比机上的性能差异归因。
工作流：Phase 1-3 独立分析 → Phase 4 对比分析。

## 1. 双 Trace 环境搭建

```bash
# 加载两个 trace 到不同端口
./scripts/load_dual_traces.sh test_device.pftrace ref_device.pftrace 9001 9002
```

对两个端口执行相同的 SQL 查询，分别获取指标后手动或程序化 diff。

## 2. 滑动对比核心 SQL

### 2.1 帧统计概览对比

对两个 trace 分别执行，获取基线帧指标后做 diff：

```sql
-- 帧统计概览（两个 trace 分别执行）
-- 前置: INCLUDE PERFETTO MODULE android.frames.timeline;
WITH vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
vsync_config AS (
  SELECT CASE
    WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333       -- 120 Hz
    WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111     --  90 Hz
    WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667    --  60 Hz
    ELSE raw_ns
  END AS vsync_period_ns
  FROM (
    SELECT CAST(COALESCE(
      (SELECT PERCENTILE(interval_ns, 0.5) FROM vsync_intervals
       WHERE interval_ns BETWEEN 5500000 AND 50000000),
      16666667
    ) AS INTEGER) AS raw_ns
  )
)
SELECT
  COUNT(*) as total_frames,
  SUM(CASE WHEN COALESCE(a.jank_type, 'None') NOT IN ('None', 'Buffer Stuffing') THEN 1 ELSE 0 END) as jank_frames,
  ROUND(100.0 * SUM(CASE WHEN COALESCE(a.jank_type, 'None') NOT IN ('None', 'Buffer Stuffing') THEN 1 ELSE 0 END) / COUNT(*), 1) as jank_rate_pct,
  ROUND(AVG(a.dur) / 1e6, 2) as avg_frame_ms,
  ROUND(MAX(a.dur) / 1e6, 2) as max_frame_ms,
  ROUND(1e9 * COUNT(*) / NULLIF(MAX(a.ts + a.dur) - MIN(a.ts), 0), 1) as estimated_fps,
  (SELECT ROUND(vsync_period_ns / 1e6, 2) FROM vsync_config) as vsync_budget_ms
FROM actual_frame_timeline_slice a
JOIN process p ON a.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
  AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR a.ts < <end_ts>)
```

**对比要点**：
- `jank_rate_pct` 差异 >5% 为显著
- `max_frame_ms` 反映最差帧体验，差异 >2x 为显著
- `estimated_fps` 用于验证两端是否运行在相同刷新率下

### 2.2 根因分布对比

如果 `batch_frame_root_cause` 步骤可用（即两个 trace 都已执行 `scrolling_analysis` composite skill），可直接对比根因分布：

```sql
-- 根因分布（两个 trace 分别执行，然后对比百分比差异）
-- 依赖: scrolling_analysis.batch_frame_root_cause 步骤已执行
SELECT
  reason_code,
  COUNT(*) as frame_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct
FROM batch_frame_root_cause
GROUP BY reason_code
ORDER BY frame_count DESC
```

如果 `batch_frame_root_cause` 不可用，可手动按 jank_type 做粗分类：

```sql
-- 粗粒度根因分类（通用方式，不依赖 composite skill）
SELECT
  a.jank_type,
  COUNT(*) as frame_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct,
  ROUND(AVG(a.dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(a.dur) / 1e6, 2) as max_dur_ms
FROM actual_frame_timeline_slice a
JOIN process p ON a.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND COALESCE(a.jank_type, 'None') != 'None'
  AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR a.ts < <end_ts>)
GROUP BY a.jank_type
ORDER BY frame_count DESC
```

**对比要点**：
- 某个 reason_code 在问题机占比显著高于对比机 → 该类根因是差异主因
- 注意 `workload_heavy` 是兜底分类，如果问题机该占比高，需进一步细查四象限和 CPU 频率

### 2.3 四象限分布对比

对掉帧帧的主线程 thread_state 做四象限分解，对比两个 trace 的资源消耗模式差异：

```sql
-- 掉帧帧四象限分布（两个 trace 分别执行，对比百分比差异）
-- 前置: INCLUDE PERFETTO MODULE android.frames.timeline;
WITH cpu_max AS (
  -- 自动检测大小核拓扑（不硬编码核心编号）
  SELECT cct.cpu, MAX(CAST(c.value AS INTEGER)) as max_freq_khz
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name GLOB 'cpu*freq*'
  GROUP BY cct.cpu
),
big_cores AS (
  SELECT cpu FROM cpu_max
  WHERE max_freq_khz >= (SELECT MAX(max_freq_khz) * 0.6 FROM cpu_max)
),
jank_frames AS (
  SELECT a.ts as frame_start, a.ts + a.dur as frame_end, a.upid, a.dur
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND COALESCE(a.jank_type, 'None') NOT IN ('None', 'Buffer Stuffing')
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
main_thread_states AS (
  SELECT
    jf.frame_start,
    ts.state,
    ts.cpu,
    MAX(MIN(ts.ts + ts.dur, jf.frame_end) - MAX(ts.ts, jf.frame_start), 0) as overlap_ns
  FROM jank_frames jf
  JOIN thread t ON t.upid = jf.upid AND t.is_main_thread = 1
  JOIN thread_state ts ON ts.utid = t.utid
    AND ts.ts < jf.frame_end
    AND ts.ts + ts.dur > jf.frame_start
)
SELECT
  COUNT(DISTINCT frame_start) as jank_frame_count,
  ROUND(AVG(q1_pct), 1) as avg_q1_big_run_pct,
  ROUND(AVG(q2_pct), 1) as avg_q2_little_run_pct,
  ROUND(AVG(q3_pct), 1) as avg_q3_runnable_pct,
  ROUND(AVG(q4a_pct), 1) as avg_q4a_io_pct,
  ROUND(AVG(q4b_pct), 1) as avg_q4b_sleep_pct
FROM (
  SELECT
    frame_start,
    ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND cpu IN (SELECT cpu FROM big_cores) AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q1_pct,
    ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND cpu NOT IN (SELECT cpu FROM big_cores) AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q2_pct,
    ROUND(100.0 * SUM(CASE WHEN state IN ('R', 'R+') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q3_pct,
    ROUND(100.0 * SUM(CASE WHEN state IN ('D', 'DK') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q4a_pct,
    ROUND(100.0 * SUM(CASE WHEN state IN ('S', 'I') AND overlap_ns > 0 THEN overlap_ns ELSE 0 END)
      / NULLIF(SUM(CASE WHEN overlap_ns > 0 THEN overlap_ns ELSE 0 END), 0), 1) as q4b_pct
  FROM main_thread_states
  GROUP BY frame_start
)
```

**对比要点**：
- Q1 (大核运行) 差异大 → 调度策略差异，检查 EAS/uclamp 配置
- Q2 (小核运行) 问题机高 → 可能被调度到小核上执行，检查 `small_core_placement` 根因
- Q3 (可运行未运行) 问题机高 → 调度延迟，CPU 可能被其他任务占据
- Q4a (IO 阻塞) 问题机高 → 存储速度差异或 IO 密集操作
- Q4b (Sleep/Lock) 问题机高 → Binder 等待或锁竞争

### 2.4 CPU 频率对比

对比掉帧帧期间大核的实际运行频率，判断是否存在限频/降频差异：

```sql
-- 掉帧帧期间大核频率（两个 trace 分别执行）
WITH cpu_max AS (
  SELECT cct.cpu, MAX(CAST(c.value AS INTEGER)) as max_freq_khz
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name GLOB 'cpu*freq*'
  GROUP BY cct.cpu
),
big_cores AS (
  SELECT cpu, max_freq_khz FROM cpu_max
  WHERE max_freq_khz >= (SELECT MAX(max_freq_khz) * 0.6 FROM cpu_max)
),
device_peak AS (
  SELECT MAX(max_freq_khz) as peak_khz FROM big_cores
),
jank_frames AS (
  SELECT a.ts as frame_start, a.ts + a.dur as frame_end
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND COALESCE(a.jank_type, 'None') NOT IN ('None', 'Buffer Stuffing')
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
jank_freq AS (
  SELECT
    c.value / 1000.0 as freq_mhz,
    cct.cpu
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  JOIN jank_frames jf
    ON c.ts >= jf.frame_start AND c.ts < jf.frame_end
  WHERE cct.name GLOB 'cpu*freq*'
    AND cct.cpu IN (SELECT cpu FROM big_cores)
)
SELECT
  ROUND(AVG(freq_mhz), 0) as avg_big_freq_mhz,
  ROUND(MAX(freq_mhz), 0) as max_big_freq_mhz,
  ROUND(MIN(freq_mhz), 0) as min_big_freq_mhz,
  ROUND((SELECT peak_khz FROM device_peak) / 1000.0, 0) as device_peak_mhz,
  ROUND(100.0 * AVG(freq_mhz) / NULLIF((SELECT peak_khz FROM device_peak) / 1000.0, 0), 1) as avg_freq_pct_of_peak,
  (SELECT COUNT(*) FROM jank_frames) as jank_frame_count
FROM jank_freq
```

**对比要点**：
- `avg_freq_pct_of_peak` 差异 >15% 为显著 → Thermal 限频或调频策略差异
- 问题机 `max_big_freq_mhz` 远低于 `device_peak_mhz` → Thermal throttling 信号
- 跨厂商对比时必须使用 `avg_freq_pct_of_peak`（归一化指标），不可直接比绝对频率

### 2.5 VSync/刷新率对比

确认两个 trace 是否运行在相同刷新率下。刷新率不同会直接影响帧耗时和 jank 判定阈值：

```sql
-- VSync 周期检测（两个 trace 分别执行）
WITH vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR c.ts < <end_ts>)
),
stats AS (
  SELECT
    COUNT(*) as sample_count,
    CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER) as median_ns
  FROM vsync_intervals
  WHERE interval_ns BETWEEN 5500000 AND 50000000
)
SELECT
  sample_count,
  ROUND(median_ns / 1e6, 3) as raw_median_ms,
  CASE
    WHEN median_ns BETWEEN 5500000 AND 6500000 THEN 165
    WHEN median_ns BETWEEN 6500001 AND 7500000 THEN 144
    WHEN median_ns BETWEEN 7500001 AND 9500000 THEN 120
    WHEN median_ns BETWEEN 9500001 AND 12500000 THEN 90
    WHEN median_ns BETWEEN 12500001 AND 20000000 THEN 60
    WHEN median_ns BETWEEN 20000001 AND 35000000 THEN 30
    ELSE CAST(ROUND(1e9 / median_ns) AS INTEGER)
  END as refresh_rate_hz,
  CASE
    WHEN median_ns BETWEEN 7500001 AND 9500000 THEN 8.33
    WHEN median_ns BETWEEN 9500001 AND 12500000 THEN 11.11
    WHEN median_ns BETWEEN 12500001 AND 20000000 THEN 16.67
    ELSE ROUND(median_ns / 1e6, 2)
  END as budget_ms
FROM stats
```

**对比要点**：
- 两端刷新率不同（如 120Hz vs 60Hz），帧预算不同（8.33ms vs 16.67ms），jank 阈值不同
- 如果刷新率不同，应以"超预算倍数"（frame_ms / budget_ms）作为归一化对比维度
- VSync sample_count 过低（<20）可能表示 trace 采集时间过短或 VSYNC-sf counter 未启用

## 3. 滑动对比辅助 SQL

### 3.1 Binder/GC 重叠对比

对比掉帧帧期间 Binder 和 GC 事件对帧耗时的占用（overlap duration）：

```sql
-- Binder + GC 重叠统计（两个 trace 分别执行）
-- 前置: INCLUDE PERFETTO MODULE android.critical_blocking_calls;
-- 前置: INCLUDE PERFETTO MODULE android.frames.timeline;
WITH jank_frames AS (
  SELECT
    a.display_frame_token as frame_id,
    a.ts as frame_start,
    a.ts + a.dur as frame_end,
    a.dur as frame_dur
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND COALESCE(a.jank_type, 'None') NOT IN ('None', 'Buffer Stuffing')
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
blocking AS (
  SELECT
    bc.name as call_type,
    bc.ts as call_ts,
    bc.dur as call_dur
  FROM _android_critical_blocking_calls bc
  WHERE bc.process_name GLOB '<package>*'
),
overlaps AS (
  SELECT
    jf.frame_id,
    jf.frame_dur,
    b.call_type,
    MAX(MIN(b.call_ts + b.call_dur, jf.frame_end) - MAX(b.call_ts, jf.frame_start), 0) as overlap_ns
  FROM jank_frames jf
  JOIN blocking b
    ON b.call_ts < jf.frame_end
    AND b.call_ts + b.call_dur > jf.frame_start
)
SELECT
  CASE
    WHEN call_type GLOB '*binder*' THEN 'Binder'
    WHEN call_type GLOB '*GC*' OR call_type GLOB '*garbage*' THEN 'GC'
    WHEN call_type GLOB '*monitor*' OR call_type GLOB '*lock*' THEN 'Lock'
    ELSE 'Other'
  END as blocking_category,
  COUNT(DISTINCT frame_id) as affected_frame_count,
  ROUND(AVG(overlap_ns) / 1e6, 2) as avg_overlap_ms,
  ROUND(MAX(overlap_ns) / 1e6, 2) as max_overlap_ms,
  ROUND(SUM(overlap_ns) / 1e6, 2) as total_overlap_ms,
  ROUND(100.0 * AVG(overlap_ns) / NULLIF(AVG(frame_dur), 0), 1) as avg_overlap_pct_of_frame
FROM overlaps
WHERE overlap_ns > 0
GROUP BY blocking_category
ORDER BY total_overlap_ms DESC
```

**对比要点**：
- 同一 blocking category 的 `avg_overlap_ms` 在问题机显著更高 → 该类阻塞是差异来源
- `affected_frame_count` 差异大 → 问题机触发该类阻塞的频率更高
- GC overlap 问题机高 → 内存压力大，检查后台进程数量和 LMK 配置

### 3.2 帧生产 Gap 对比

帧生产 Gap 表示连续帧之间超过 1.5x VSync 的空隙。Gap 类型反映不同的丢帧原因：

```sql
-- 帧生产 Gap 概览（两个 trace 分别执行）
WITH vsync_config AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(c.ts - LAG(c.ts) OVER (ORDER BY c.ts), 0.5) AS INTEGER)
     FROM counter c
     JOIN counter_track t ON c.track_id = t.id
     WHERE t.name = 'VSYNC-sf'
       AND (<start_ts> IS NULL OR c.ts >= <start_ts>)
       AND (<end_ts> IS NULL OR c.ts < <end_ts>)),
    16666667
  ) as period_ns
),
frame_seq AS (
  SELECT
    a.ts as frame_start,
    a.ts + a.dur as frame_end,
    a.dur,
    LAG(a.ts + a.dur) OVER (PARTITION BY a.upid ORDER BY a.ts) as prev_frame_end
  FROM actual_frame_timeline_slice a
  JOIN process p ON a.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
gaps AS (
  SELECT
    frame_start - prev_frame_end as gap_ns,
    ROUND((frame_start - prev_frame_end) / 1e6, 2) as gap_ms,
    ROUND((frame_start - prev_frame_end) * 1.0 / vc.period_ns, 1) as gap_vsync_count
  FROM frame_seq
  CROSS JOIN vsync_config vc
  WHERE prev_frame_end IS NOT NULL
    AND (frame_start - prev_frame_end) > vc.period_ns * 1.5
    AND (frame_start - prev_frame_end) < vc.period_ns * 30  -- 排除非滑动大 gap
)
SELECT
  COUNT(*) as total_gaps,
  ROUND(AVG(gap_ms), 2) as avg_gap_ms,
  ROUND(MAX(gap_ms), 2) as max_gap_ms,
  ROUND(AVG(gap_vsync_count), 1) as avg_gap_vsync,
  SUM(CASE WHEN gap_vsync_count >= 5 THEN 1 ELSE 0 END) as severe_gaps,
  (SELECT ROUND(period_ns / 1e6, 2) FROM vsync_config) as vsync_budget_ms
FROM gaps
```

**对比要点**：
- `total_gaps` 差异大 → 问题机丢帧频率更高
- `severe_gaps` (>= 5 VSync) 差异大 → 问题机有明显的冻帧/卡顿
- `max_gap_ms` 反映最严重的单次卡顿事件

### 3.3 RenderThread 对比

对比两端 RenderThread 上耗时最大的 slice，定位 GPU 侧差异：

```sql
-- RenderThread Top Slices（两个 trace 分别执行，对比同名 slice 的耗时差异）
WITH render_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
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
  AND s.dur >= 500000  -- > 0.5ms
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts < <end_ts>)
GROUP BY s.name
HAVING total_ms > 0.5
ORDER BY total_ms DESC
LIMIT 15
```

**对比要点**：
- 同名 slice 的 `avg_ms` 差异 >2x → 该渲染阶段是性能瓶颈
- 问题机出现对比机没有的 slice（如 `ShaderCompilation`, `Fence Wait`）→ GPU 侧问题
- `DrawFrame` 的 `avg_ms` 差异直接反映 GPU 渲染效率差距

## 4. Delta 分析方法

### 指标对齐

将两个 trace 的指标放入对比表：

```
| 指标 | 问题机 | 对比机 | Delta | Delta% | 显著? |
|------|--------|--------|-------|--------|-------|
| dur_ms | 1500 | 800 | +700 | +87.5% | YES (>20%) |
| Q1_pct | 40% | 65% | -25% | - | YES |
| big_avg_freq | 1200 | 2100 | -900 | -43% | YES (>15%) |
```

### 贡献度估算

对于 CPU 频率差异的贡献度：
```
freq_ratio = test_freq / ref_freq
estimated_contribution = (1 - freq_ratio) * test_q1_time_ms
```

对于四象限差异的贡献度：
```
q4_delta_ms = (test_q4_pct - ref_q4_pct) / 100 * test_dur_ms
```

## 4.5 跨厂商对比（MTK vs 高通 / 其他厂商）

当对比机是**非 MTK 平台**（如高通 Snapdragon）时，存在以下不对称性：

### 数据可用性差异

| 数据维度 | MTK 设备 | 高通/其他设备 | 处理方式 |
|---------|---------|-------------|---------|
| **标准 AOSP trace** | 有 | 有 | 可直接对比 |
| **FPSGO/急拉/频率地板** | 有（vendor slice） | 无（高通有自己的但不同） | MTK 侧单独报告策略状态，不做 diff |
| **CPU 拓扑** | MTK 簇配置 | 高通簇配置（可能不同） | 必须分别识别拓扑，不能假设相同 |
| **频率范围** | MTK 频率表 | 高通频率表（不同） | 用"占峰值百分比"归一化 |
| **thermal zone** | MTK 传感器 | 高通传感器（名称不同） | 都用 cpufreq 天花板推断 |
| **GPU** | Mali/IMG | Adreno | GPU 频率 counter 名称可能不同 |

### CPU 拓扑自动识别

不能硬编码 CPU 核心分类。两个 trace 需要**分别识别**大小核拓扑：

```sql
-- 自动检测 CPU 拓扑（对每个 trace 独立执行）
-- 原理：按 CPU 的最高频率分簇
WITH cpu_max AS (
  SELECT cct.cpu, MAX(CAST(c.value AS INTEGER)) as max_freq_khz
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name GLOB 'cpu*freq*'
  GROUP BY cct.cpu
),
clusters AS (
  SELECT cpu, max_freq_khz,
    CASE
      WHEN max_freq_khz >= (SELECT MAX(max_freq_khz) * 0.9 FROM cpu_max) THEN 'prime'
      WHEN max_freq_khz >= (SELECT MAX(max_freq_khz) * 0.6 FROM cpu_max) THEN 'big'
      WHEN max_freq_khz >= (SELECT MAX(max_freq_khz) * 0.35 FROM cpu_max) THEN 'medium'
      ELSE 'little'
    END as core_type
  FROM cpu_max
)
SELECT core_type, GROUP_CONCAT(cpu) as cpus,
  COUNT(*) as core_count,
  MAX(max_freq_khz) / 1000 as max_freq_mhz
FROM clusters
GROUP BY core_type
ORDER BY max_freq_mhz DESC
```

### 归一化原则

跨厂商对比时，**绝对值不可比**，必须用相对指标：

| 指标 | 错误做法 | 正确做法 |
|------|---------|---------|
| CPU 频率 | MTK 2.85GHz vs 高通 3.2GHz（直接比） | 占各自峰值的百分比（88% vs 92%） |
| 帧耗时 | 12ms vs 10ms（直接比） | 超预算倍数（1.4x vs 1.2x budget） |
| 大核占比 | 80% vs 90%（直接比） | 可以直接比（都是百分比） |
| 调度延迟 | 5ms vs 3ms | 可以直接比（都是绝对时间） |
| Binder 延迟 | 同服务的延迟可直接比 | 直接比（服务端实现相同） |

### 跨厂商对比的归因逻辑

1. **先排除 SoC 能力差异**：如果高通旗舰 vs MTK 中端，性能差异可能就是硬件代差，不是策略问题
2. **聚焦"相对效率"**：同等频率百分比下的帧耗时差异才有意义
3. **MTK 策略信息单独报告**：对比机无 FPSGO 数据时，仍然报告 MTK 侧的策略审计结果（策略是否生效），但不做 diff
4. **Binder/system_server 可直接对比**：这是 AOSP 代码，两个平台行为应相似。差异大说明 Framework 定制不同

### 跨厂商对比报告补充段

```
### 平台差异说明
- 问题机: MTK Dimensity XXXX (X+X+X 核心配置, 最高 X.XGHz)
- 对比机: Qualcomm Snapdragon XXX (X+X+X 核心配置, 最高 X.XGHz)
- ⚠️ 不同 SoC，绝对性能指标不可直接对比。以下分析基于归一化指标。
- ⚠️ 对比机无 MTK vendor trace data，FPSGO/急拉/频率地板状态仅在问题机侧报告。
```

## 5. 归因优先级（同 App 不同设备）

| 优先级 | 差异类型 | 典型信号 | 建议方向 |
|--------|---------|---------|---------|
| P0 | Thermal 限频 | max_freq 差距 >30% | 散热设计、thermal governor |
| P1 | CPU 调度差异 | Q2/Q3 差距大 | EAS 参数、uclamp、SCHED_UTIL |
| P2 | 内存压力差异 | 一方有 kswapd/LMK | RAM 配置、后台进程管理 |
| P3 | 存储速度差异 | D 状态差距 >2x | UFS vs eMMC、IO 调度 |
| P4 | SF/GPU 差异 | SF jank 占比不同 | HWC 能力、GPU 性能 |
| P5 | Binder 服务差异 | 同服务延迟 >2x | system_server 优化 |

## 5.5 Android 大版本升级差异分析

当对比的两个 trace 来自**不同 Android 版本**（如 Android 15 vs 16）时，需要额外考虑**系统行为变化**和 **App 适配问题**两个维度。大版本升级是性能 Bug 的重要来源。

### 场景识别

先确认两个 trace 的 Android 版本。从 trace metadata 提取：
```sql
-- 获取 Android 版本信息
SELECT name, str_value FROM metadata
WHERE name IN ('android_build_fingerprint', 'android_sdk_version', 'android_build_type')
```

如果 `android_sdk_version` 不同（如 35 vs 36），激活版本差异分析。

### 差异类型 A — 系统行为变化

Android 大版本升级可能改变以下系统内部行为，导致 trace 中可见的负载模式差异：

| 变化维度 | 典型信号 | 检测方法 |
|---------|---------|---------|
| **HWUI/RenderThread 流程变更** | 新增/消失的 RT slice，帧管线阶段耗时分布偏移 | 对比两个 trace 的 `RenderThread` top slices 名称和耗时分布 |
| **SurfaceFlinger 合成策略** | SF 侧 jank 比例变化，合成耗时变化 | 对比 SF composition 相关 slice |
| **调度策略变更** | Q2/Q3 分布变化，大小核调度行为差异 | 对比主线程四象限分布和 CPU topology 使用模式 |
| **Binder/IPC 行为** | 相同服务的延迟模式变化 | 对比同名 Binder 服务的 latency 分布 |
| **GC 策略调整** | GC 频率/类型/暂停时间变化 | 对比 GC 事件分布 |
| **线程模型变化** | 新增线程/线程重命名/线程职责转移 | 对比两个 trace 的活跃线程列表 |

**关键检测 SQL — Slice 名称差异**：
```sql
-- 在两个 trace 上分别执行，然后 diff 结果
-- 找出只在一侧出现的 slice 名称（系统行为变化的直接证据）
SELECT name, COUNT(*) as cnt, ROUND(SUM(dur)/1e6, 1) as total_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND s.dur > 1000000  -- > 1ms
  AND s.ts BETWEEN <start_ts> AND <end_ts>
GROUP BY name
ORDER BY total_ms DESC
LIMIT 30
```

两个 trace 的结果取 diff：只在新版本出现的 slice = 新增行为；只在旧版本出现的 slice = 废弃/重命名行为。

**关键检测 SQL — 线程列表差异**：
```sql
-- 对比两个 trace 中目标进程的活跃线程
SELECT t.name as thread_name,
  COUNT(DISTINCT s.name) as unique_slices,
  ROUND(SUM(s.dur)/1e6, 1) as total_cpu_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND s.ts BETWEEN <start_ts> AND <end_ts>
GROUP BY t.name
HAVING total_cpu_ms > 5
ORDER BY total_cpu_ms DESC
```

### 差异类型 B — App 适配缺失

App 未适配新版本 Android 时的典型信号：

| 适配问题 | Trace 中的表现 | 检测方法 |
|---------|--------------|---------|
| **废弃 API 兼容层** | 额外的 wrapper/compat slice（如 `CompatChange`），耗时增加 | 检查新版本 trace 中是否有 compat 相关 slice |
| **权限模型变更** | 新增 Binder 调用（权限检查），S 状态增加 | 对比 Binder 调用列表，找新增的权限相关调用 |
| **后台限制加强** | App 进程被冻结/限制，出现异常 gap | 检查 `oom_adj` 变化、进程状态转换 |
| **渲染管线变更** | 帧管线耗时分布偏移，新 slice 出现 | 对比 doFrame/DrawFrame 内部阶段耗时 |
| **targetSdkVersion 不匹配** | 系统为旧 targetSdk 应用启用兼容模式 | 检查是否有 compat mode 相关 slice |

### 对比分析输出补充

当检测到 Android 版本差异时，在对比报告中增加以下部分：

```
### Android 版本差异分析
- 问题机: Android XX (SDK YY)
- 对比机: Android XX (SDK YY)

#### 系统行为变化
- [新增 slice]: RenderThread 中出现 `XXX` (新版本新增)，平均耗时 YYms
- [消失 slice]: 旧版本的 `XXX` 在新版本中不再出现
- [耗时偏移]: `DrawFrame` 平均耗时从 XXms 变为 YYms (+ZZ%)

#### App 适配建议
- [建议 1]: 检查 targetSdkVersion 是否已更新到 Android XX
- [建议 2]: 检查 [具体 API] 在新版本中的行为变化
```

## 6. 对比报告模板

```markdown
## 对比分析报告

### 1. 测试环境
| | 问题机 | 对比机 |
|---|---|---|
| 设备型号 | [从 trace metadata 提取] | ... |
| App 版本 | ... | ... |
| 操作场景 | ... | ... |

### 2. 性能指标对比
[指标对齐表]

### 3. 关键差异（按贡献度排序）
[每个差异：现象 → 数据 → 归因 → 建议]

### 4. 可排除因素
[差异不显著的维度]

### 5. 结论
[一句话总结根因 + 系统层建议]
```

## 7. 调度策略参数 Diff

对比两台设备的调度策略配置差异。以下 SQL 在两个 trace 上分别执行，然后对比结果。

### 7.1 uclamp 参数提取

```sql
-- 搜索 uclamp 相关事件
SELECT name, COUNT(*) as cnt, 
  ROUND(AVG(dur)/1e6, 2) as avg_ms
FROM slice
WHERE name GLOB '*uclamp*' OR name GLOB '*sched_util*'
GROUP BY name
```

### 7.2 cpuset/cgroup 配置推断

```sql
-- 从主线程的核心分布推断 cpuset 配置
-- 如果主线程从不出现在某些核上 → 被 cpuset 限制
SELECT DISTINCT cpu, COUNT(*) as running_count
FROM sched_slice
WHERE utid = (SELECT utid FROM thread WHERE name = 'main' AND
  upid = (SELECT upid FROM process WHERE name GLOB '<package>*') LIMIT 1)
GROUP BY cpu ORDER BY cpu
```

### 7.3 Governor 参数推断

```sql
-- 从频率变化模式推断 governor 参数
-- 频繁小步升频 → conservative/schedutil with high rate_limit
-- 直接跳到最高频 → interactive/performance or boost active
WITH freq_changes AS (
  SELECT c.ts,
    CAST(c.value AS INTEGER) as freq,
    LAG(CAST(c.value AS INTEGER)) OVER (PARTITION BY cct.cpu ORDER BY c.ts) as prev_freq,
    cct.cpu
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name GLOB 'cpu*freq*'
    AND cct.cpu IN (<big_core_ids>)
    AND c.ts BETWEEN <start_ts> AND <end_ts>
)
SELECT
  COUNT(*) as total_freq_changes,
  SUM(CASE WHEN freq > prev_freq THEN 1 ELSE 0 END) as ramp_up_count,
  SUM(CASE WHEN freq < prev_freq THEN 1 ELSE 0 END) as ramp_down_count,
  ROUND(AVG(ABS(freq - prev_freq)) / 1000, 0) as avg_step_mhz
FROM freq_changes
WHERE prev_freq IS NOT NULL AND freq != prev_freq
```

### 7.4 策略 Diff 输出模板

```
| 策略维度 | 问题机 | 对比机 | 差异 |
|---------|--------|--------|------|
| 主线程可用核 | CPU 4-7 (4 核) | CPU 0-7 (8 核) | cpuset 限制 |
| 频率变化步数 | 45 次 (avg 200MHz/step) | 12 次 (avg 800MHz/step) | governor 参数不同 |
| uclamp 事件 | 有 (N 次) | 无 | 频率地板策略 |
| 升频次数 | 30 | 8 | governor 响应模式 |
```