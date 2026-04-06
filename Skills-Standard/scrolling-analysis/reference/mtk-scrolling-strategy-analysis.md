<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# MTK 滑动策略分析指南

## 概述

MTK 平台对滑动场景有全栈控制：从上层场景识别、插帧、急拉策略，到 Framework Choreographer/RenderThread 行为，到底层 EAS task placement、频率地板。不同架构（标准 HWUI / Flutter / WebView）有独立的滑动策略配置。

本文档指导如何在 trace 中识别和分析这些 MTK 特有的策略行为。

## 1. MTK 滑动策略栈

```
┌─────────────────────────────────────────────┐
│  场景识别层 (Scene Detection)                │
│  识别当前滑动架构 + 负载级别 → 选择策略      │
├─────────────────────────────────────────────┤
│  软件策略层 (Software Policy)                │
│  插帧 / 急拉 / Boost                        │
├─────────────────────────────────────────────┤
│  Framework 层                                │
│  Choreographer / ViewRootImpl / RenderThread │
├─────────────────────────────────────────────┤
│  调度策略层 (Scheduler Policy)               │
│  Task placement / uclamp / 频率地板          │
├─────────────────────────────────────────────┤
│  硬件层 (EAS / Governor / Thermal)           │
│  sugov / cpu_idle / thermal_governor          │
└─────────────────────────────────────────────┘
```

## 2. 场景识别与策略分支

MTK 场景识别非常细粒度，不同场景触发不同的滑动策略：

| 场景 | 识别方法 | 策略特点 |
|------|---------|---------|
| **标准 HWUI (LSP 出图)** | RenderThread + Choreographer#doFrame | 标准策略：按负载动态调频 |
| **Flutter TextureView** | 1.ui + RenderThread updateTexImage | 双出图管线：需要给 1.ui 和 RT 都保障算力 |
| **Flutter SurfaceView** | 1.ui + 1.raster（无 RT 参与） | 单出图：重点保障 1.ui 和 1.raster |
| **WebView** | CrRendererMain + SurfaceTexture | 单 buffer：更激进的频率策略 |
| **高负载滑动** | 帧耗时持续 > 0.8x budget | 提升频率地板 + 更激进的摆核 |
| **轻负载滑动** | 帧耗时 < 0.5x budget | 降低频率允许省电 |

### 在 trace 中检测场景识别是否生效

```sql
-- 搜索 MTK 场景识别相关 slice（名称因 MTK 版本而异）
-- 常见模式：*perf_*, *boost*, *scene*, *fpsgo*, *ged*
SELECT name, COUNT(*) as cnt, ROUND(SUM(dur)/1e6, 1) as total_ms
FROM slice s
WHERE (
  name GLOB '*fpsgo*' OR
  name GLOB '*ged_*' OR
  name GLOB '*perf_idx*' OR
  name GLOB '*boost*' OR
  name GLOB '*scene*' OR
  name GLOB '*PowerHal*' OR
  name GLOB '*PerfService*' OR
  name GLOB '*FSTB*'
)
AND s.ts BETWEEN <start_ts> AND <end_ts>
GROUP BY name
ORDER BY cnt DESC
LIMIT 30
```

**FPSGO（FPS Go）** 是 MTK 的帧感知调度框架：
- `fpsgo` 相关 slice 出现 = FPSGO 活跃
- `ged_` 前缀 = GPU Energy-aware Driver
- `FSTB` = Frame Stable，MTK 的帧稳定模块

## 3. 急拉（Jank Prediction Boost）

急拉是 MTK 的预判掉帧机制：当检测到帧可能超时时，主动拉高 CPU 频率。

### 检测急拉是否触发

```sql
-- 搜索急拉相关事件
-- 急拉通常表现为：帧开始后很短时间内出现频率跳变到高值
SELECT name, COUNT(*) as cnt,
  ROUND(SUM(dur)/1e6, 1) as total_ms,
  ROUND(AVG(dur)/1e6, 2) as avg_ms
FROM slice
WHERE (
  name GLOB '*boost*' OR
  name GLOB '*rescue*' OR
  name GLOB '*jank*predict*' OR
  name GLOB '*emergency*freq*' OR
  name GLOB '*sched_boost*'
)
AND ts BETWEEN <start_ts> AND <end_ts>
GROUP BY name
ORDER BY cnt DESC
```

### 急拉效果验证

```sql
-- 对比急拉帧 vs 非急拉帧的频率和帧耗时
-- 如果急拉帧的帧耗时仍然超时，说明急拉力度不够或时机太晚
-- 如果急拉帧的帧耗时明显低于非急拉帧但仍掉帧，可能是急拉阈值设置问题
```

### 对比分析中的急拉差异

| 信号 | 含义 | 建议 |
|------|------|------|
| 问题机无急拉 slice、对比机有 | 急拉策略未生效 | 检查场景识别是否正确识别了滑动场景 |
| 两台都有急拉但问题机频率低 | 急拉目标频率不足 | 提高急拉的目标频率或 uclamp.min |
| 急拉触发太晚（帧已超时才拉） | 预测模型滞后 | 调整预判窗口或提前触发 |

## 4. 插帧（Frame Interpolation）

MTK 的插帧在 SurfaceFlinger 层合成额外帧，但会干扰标准帧率/掉帧率统计。

### 在 trace 中识别插帧

```sql
-- 插帧的帧通常 frame_id = -1 或有特殊标记
-- 在 actual_frame_timeline_slice 中检查异常帧
SELECT
  display_frame_token,
  COUNT(*) as layer_count,
  GROUP_CONCAT(DISTINCT jank_type) as jank_types
FROM actual_frame_timeline_slice a
WHERE a.ts BETWEEN <start_ts> AND <end_ts>
GROUP BY display_frame_token
HAVING layer_count > (SELECT COUNT(DISTINCT layer_name)
  FROM actual_frame_timeline_slice
  WHERE ts BETWEEN <start_ts> AND <end_ts>)
ORDER BY a.ts
LIMIT 20
```

### 插帧对分析的影响

- **帧率统计失真**：插帧使得 `estimated_fps` 偏高（实际 App 产出 60fps 但显示 120fps）
- **掉帧率失真**：插帧帧不掉帧，稀释了掉帧率
- **处理方法**：在 `scrolling_analysis` 的 `global_context_flags` 中 `interpolation_active = 1` 时，需在结论中标注统计受插帧影响

## 5. 频率地板（Frequency Floor）

"垫地板"是给关键线程设最低频率保障，防止 governor 在帧间 idle 时降频太深。

### 检测频率地板是否生效

```sql
-- 检查滑动期间大核是否有最低频率保障
-- 如果有频率地板，大核频率不应低于某个阈值
WITH frame_freqs AS (
  SELECT
    c.ts,
    CAST(c.value AS INTEGER) as freq_khz,
    cct.cpu
  FROM counter c
  JOIN cpu_counter_track cct ON c.track_id = cct.id
  WHERE cct.name = 'cpufreq'
    AND cct.cpu IN (<big_core_ids>)
    AND c.ts BETWEEN <scroll_start_ts> AND <scroll_end_ts>
)
SELECT
  MIN(freq_khz) as min_freq_khz,
  ROUND(AVG(freq_khz), 0) as avg_freq_khz,
  MAX(freq_khz) as max_freq_khz,
  -- 如果 min 和 avg 接近，说明有地板
  CASE WHEN MIN(freq_khz) > MAX(freq_khz) * 0.5 THEN 'Floor likely active'
       ELSE 'No floor detected' END as floor_status,
  COUNT(*) as sample_count
FROM frame_freqs
```

### 地板不足的信号

| 信号 | 含义 | 建议 |
|------|------|------|
| 帧间 idle 时频率降到最低频 | 无频率地板 | 设置 `uclamp.min` 或 FPSGO floor |
| 帧开始时频率从低频爬升 | 地板太低或无地板 | 提高地板频率 |
| 不同架构(Flutter vs HWUI)的地板不同 | 策略区分 | 检查场景识别是否正确匹配策略 |

## 6. Per-Architecture 策略对比

对比分析时，如果两台设备对同一架构应用了不同策略，需要逐层分析：

### 策略对比框架

```
对每一层，在两个 trace 上检查：

1. 场景识别结果 → 是否识别为相同场景？
   - 一台识别为 "Flutter"，另一台识别为 "Standard" → 策略完全不同

2. 急拉/Boost 行为 → 是否触发？触发时机？目标频率？
   - 一台有急拉另一台没有 → 帧保障能力不同

3. 频率地板 → 是否有地板？地板高度？
   - 一台地板 1.5GHz 另一台无地板 → 帧间回落深度不同

4. Task placement → 关键线程是否在大核？
   - 一台主线程 100% 大核，另一台 70% 大核 → 摆核策略差异

5. Governor 参数 → 升频延迟？降频速度？
   - 一台 ramp-up 5ms 另一台 20ms → 频率响应差异
```

### 对比结论模板

```
### MTK 策略差异分析

| 策略层 | 问题机 | 对比机 | 差异影响 |
|--------|--------|--------|---------|
| 场景识别 | Flutter (正确) | Flutter (正确) | 无差异 |
| 急拉 | 未触发 ⚠️ | 已触发 | 问题机缺少帧保障 |
| 频率地板 | 无 ⚠️ | 1.5GHz | 问题机帧间频率回落严重 |
| 摆核 | 大核 70% ⚠️ | 大核 95% | 问题机主线程频繁落小核 |
| Governor | ramp-up 18ms | ramp-up 6ms | 问题机升频响应慢 |

**根因**：问题机的 Flutter 滑动策略配置不完整（急拉未触发 + 无频率地板），
导致帧间频率回落后无法及时升频，叠加主线程小核调度，
最终每帧有效算力不足 → workload_heavy 帧占比高。

**建议**：
1. 检查 FPSGO 是否正确识别 Flutter 场景并激活对应策略
2. 为 Flutter 1.ui 线程设置 uclamp.min >= 600
3. 配置急拉阈值：当帧耗时 > 0.7x budget 时触发 boost
```

## 7. 需要但可能缺失的 Trace Tags

| 分析需求 | 需要的 trace tag | 检测是否存在 |
|---------|-----------------|------------|
| FPSGO 策略决策 | `fpsgo`, `FSTB` | 搜索 `*fpsgo*` slice |
| 急拉触发事件 | vendor boost events | 搜索 `*boost*` / `*rescue*` slice |
| 场景识别结果 | scene detection logs | 搜索 `*scene*` / `*perf_idx*` slice |
| per-task uclamp 值 | `sched:sched_util_est_task` | 搜索 ftrace 中 `sched_util` 事件 |
| GPU 频率决策 | `ged`, `mtk_gpufreq` | 搜索 `*ged_*` slice |
| Power 预算分配 | `thermal_power_allocator` | 搜索 thermal counter tracks |

如果以上数据缺失且分析需要，建议 QA 使用增强 trace 配置重抓。