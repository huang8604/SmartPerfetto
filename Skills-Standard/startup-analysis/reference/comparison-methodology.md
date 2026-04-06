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

## 2. 启动对比核心 SQL

### 2.1 启动基线指标提取

对两个 trace 分别执行：

```sql
-- 启动概览指标（在两个 trace 上分别执行）
SELECT
  s.startup_id,
  p.name as package,
  s.startup_type,
  s.dur / 1e6 as dur_ms,
  ttd.time_to_initial_display / 1e6 as ttid_ms,
  ttd.time_to_full_display / 1e6 as ttfd_ms
FROM android_startups s
JOIN android_startup_processes sp ON s.startup_id = sp.startup_id
JOIN process p ON sp.upid = p.upid
LEFT JOIN android_startup_time_to_display ttd ON s.startup_id = ttd.startup_id
WHERE p.name GLOB '<package>*'
ORDER BY s.ts
LIMIT 5
```

### 2.2 四象限分布对比

```sql
-- 主线程四象限（两个 trace 分别执行，然后对比百分比）
WITH startup AS (
  SELECT s.ts as start_ts, s.ts + s.dur as end_ts, s.dur
  FROM android_startups s
  JOIN android_startup_processes sp ON s.startup_id = sp.startup_id
  JOIN process p ON sp.upid = p.upid
  WHERE p.name GLOB '<package>*'
  LIMIT 1
),
main_states AS (
  SELECT
    ts.state,
    ts.cpu,
    SUM(MIN(ts.ts + ts.dur, su.end_ts) - MAX(ts.ts, su.start_ts)) as dur_ns
  FROM thread_state ts
  JOIN thread t ON ts.utid = t.utid
  JOIN process p ON t.upid = p.upid
  JOIN startup su
  WHERE t.is_main_thread = 1
    AND p.name GLOB '<package>*'
    AND ts.ts < su.end_ts
    AND ts.ts + ts.dur > su.start_ts
  GROUP BY ts.state, ts.cpu
)
-- 自动检测大核 CPU 列表（从 CPU 拓扑获取，见 Section 4.5 自动拓扑检测 SQL）
-- 优先使用 _cpu_topology（Perfetto stdlib），fallback 到频率分簇
big_cores AS (
  SELECT cpu_id as cpu FROM _cpu_topology WHERE core_type IN ('prime', 'big', 'medium')
  -- Fallback: 若 _cpu_topology 不可用，改用频率分簇（见 Section 4.5）
)
SELECT
  ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND cpu IN (SELECT cpu FROM big_cores) THEN dur_ns ELSE 0 END) / (SELECT dur FROM startup), 1) as q1_big_pct,
  ROUND(100.0 * SUM(CASE WHEN state = 'Running' AND cpu NOT IN (SELECT cpu FROM big_cores) THEN dur_ns ELSE 0 END) / (SELECT dur FROM startup), 1) as q2_little_pct,
  ROUND(100.0 * SUM(CASE WHEN state IN ('R', 'R+') THEN dur_ns ELSE 0 END) / (SELECT dur FROM startup), 1) as q3_runnable_pct,
  ROUND(100.0 * SUM(CASE WHEN state IN ('D', 'DK') THEN dur_ns ELSE 0 END) / (SELECT dur FROM startup), 1) as q4a_io_pct,
  ROUND(100.0 * SUM(CASE WHEN state IN ('S', 'I') THEN dur_ns ELSE 0 END) / (SELECT dur FROM startup), 1) as q4b_sleep_pct
FROM main_states
```

### 2.3 CPU 频率对比

```sql
-- 大核平均/峰值频率（两个 trace 分别执行）
WITH startup AS (
  SELECT s.ts as start_ts, s.ts + s.dur as end_ts
  FROM android_startups s
  JOIN android_startup_processes sp ON s.startup_id = sp.startup_id
  JOIN process p ON sp.upid = p.upid
  WHERE p.name GLOB '<package>*'
  LIMIT 1
)
SELECT
  cpu,
  ROUND(AVG(value) / 1000, 0) as avg_freq_mhz,
  ROUND(MAX(value) / 1000, 0) as max_freq_mhz
FROM counter c
JOIN counter_track ct ON c.track_id = ct.id
JOIN cpu_counter_track cct ON ct.id = cct.id
JOIN startup su
WHERE ct.name GLOB 'cpu*freq*'
  AND c.ts BETWEEN su.start_ts AND su.end_ts
  AND cct.cpu IN (SELECT cpu_id FROM _cpu_topology WHERE core_type IN ('prime', 'big', 'medium'))
  -- 注意：大核列表从 CPU 拓扑自动检测获取，见 Section 4.5 自动���扑检测 SQL
GROUP BY cpu
```

### 2.4 Binder 延迟对比

```sql
-- 同一服务的 Binder 延迟（两个 trace 分别执行，对比同名服务的延迟差异）
SELECT
  server_process,
  aidl_name,
  COUNT(*) as call_count,
  ROUND(SUM(client_dur) / 1e6, 1) as total_dur_ms,
  ROUND(AVG(client_dur) / 1e6, 1) as avg_dur_ms,
  ROUND(MAX(client_dur) / 1e6, 1) as max_dur_ms
FROM android_binder_txns bt
JOIN android_startups s ON bt.client_ts BETWEEN s.ts AND s.ts + s.dur
JOIN android_startup_processes sp ON s.startup_id = sp.startup_id
JOIN process p ON sp.upid = p.upid
WHERE p.name GLOB '<package>*'
    -- Schema 注意：is_main_thread 可能需改为 JOIN thread 判断
  AND bt.is_main_thread = 1
  AND bt.is_sync = 1
GROUP BY server_process, aidl_name
ORDER BY total_dur_ms DESC
LIMIT 15
```

### 2.5 内存压力对比

```sql
-- 内存压力信号（两个 trace 分别执行）
WITH startup AS (
  SELECT s.ts as start_ts, s.ts + s.dur as end_ts
  FROM android_startups s LIMIT 1
)
SELECT
  (SELECT COUNT(*) FROM slice s2 JOIN thread_track tt ON s2.track_id = tt.id
   JOIN thread t ON tt.utid = t.utid
   WHERE t.name = 'kswapd0'
     AND s2.ts BETWEEN su.start_ts AND su.end_ts) as kswapd_events,
  (SELECT COUNT(*) FROM slice s3
   WHERE s3.name GLOB '*direct_reclaim*'
     AND s3.ts BETWEEN su.start_ts AND su.end_ts) as direct_reclaim_events
FROM startup su
```

## 3. Delta 分析方法

### 指标对齐

将两个 trace 的指标放入对比表：

```
| 指标 | 问题机 | 对比机 | Delta | Delta% | 显著? |
|------|--------|--------|-------|--------|-------|
| dur_ms | 1500 | 800 | +700 | +87.5% | YES (>20%) |
| Q1_pct | 40% | 65% | -25% | - | YES |
| big_avg_freq | 1200 | 2100 | -900 | -43% | YES (>15%) |
```

### 贡献度估算（粗略上界，非精确归因）

以下公式假设线性关系，实际受锁竞争、cache miss、内存带宽等非线性因素影响。**只能作为粗略上界估算**，不能作为严格归因。结论中应标注"估算"。

对于 CPU 频率差异的贡献度上界：
```
freq_ratio = test_freq / ref_freq
estimated_upper_bound = (1 - freq_ratio) * test_q1_time_ms
```
注意：这假设 CPU-bound 部分与频率线性反比，实际可能低于此值（IPC、cache 效应）。

对于四象限差异的贡献度上界：
```
q4_delta_ms = (test_q4_pct - ref_q4_pct) / 100 * test_dur_ms
```

**更可靠的判断方式**：
- 以 Q1/Q2/Q3/Q4 分布差异为主要依据，频率比仅做辅证
- 区分 CPU-bound（Q1 主导）、sched-bound（Q3 主导）、supply-bound（Q4 + 频率不足）三类再做归因

## 3.5 跨厂商对比（MTK vs 高通 / 其他厂商）

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

## 4. 归因优先级（同 App 不同设备）

| 优先级 | 差异类型 | 典型信号 | 建议方向 |
|--------|---------|---------|---------|
| P0 | Thermal 限频 | max_freq 差距 >30% | 散热设计、thermal governor |
| P1 | CPU 调度差异 | Q2/Q3 差距大 | EAS 参数、uclamp、SCHED_UTIL |
| P2 | 内存压力差异 | 一方有 kswapd/LMK | RAM 配置、后台进程管理 |
| P3 | 存储速度差异 | D 状态差距 >2x | UFS vs eMMC、IO 调度 |
| P4 | SF/GPU 差异 | SF jank 占比不同 | HWC 能力、GPU 性能 |
| P5 | Binder 服务差异 | 同服务延迟 >2x | system_server 优化 |

## 4.5 Android 大版本升级差异分析

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

## 5. 对比报告模板

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

## 6. 调度策略参数 Diff

对比两台设备的调度策略配置差异。以下 SQL 在两个 trace 上分别执行，然后对比结果。

### 6.1 uclamp 参数提取

```sql
-- 搜索 uclamp 相关事件
SELECT name, COUNT(*) as cnt, 
  ROUND(AVG(dur)/1e6, 2) as avg_ms
FROM slice
WHERE name GLOB '*uclamp*' OR name GLOB '*sched_util*'
GROUP BY name
```

### 6.2 cpuset/cgroup 配置推断

```sql
-- 从主线程的核心分布推断 cpuset 配置
-- 如果主线程从不出现在某些核上 → 被 cpuset 限制
SELECT DISTINCT cpu, COUNT(*) as running_count
FROM sched_slice
WHERE utid = (SELECT utid FROM thread WHERE name = 'main' AND
  upid = (SELECT upid FROM process WHERE name GLOB '<package>*') LIMIT 1)
GROUP BY cpu ORDER BY cpu
```

### 6.3 Governor 参数推断

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

### 6.4 策略 Diff 输出模板

```
| 策略维度 | 问题机 | 对比机 | 差异 |
|---------|--------|--------|------|
| 主线程可用核 | CPU 4-7 (4 核) | CPU 0-7 (8 核) | cpuset 限制 |
| 频率变化步数 | 45 次 (avg 200MHz/step) | 12 次 (avg 800MHz/step) | governor 参数不同 |
| uclamp 事件 | 有 (N 次) | 无 | 频率地板策略 |
| 升频次数 | 30 | 8 | governor 响应模式 |
```