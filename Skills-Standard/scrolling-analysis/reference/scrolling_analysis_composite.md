<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 滑动性能分析 (scrolling_analysis) - Composite Skill v2.0

基于 Perfetto FrameTimeline 的滑动分析，分层展示：概览 -> 区间 -> 帧详情。这是滑动分析的核心入口 skill。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名（不填则分析所有应用） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| enable_frame_details | boolean | 否 | - | 是否执行逐帧详情分析（L4） |
| max_frames_per_session | number | 否 | 200 | 每个滑动区间最多返回的掉帧帧数 |
| enable_expert_probes | boolean | 否 | true | 是否启用专家探针（帧方差等） |
| frame_variance_probe_min_janky_frames | number | 否 | 5 | 触发帧方差探针的最小掉帧数 |
| frame_variance_transition_threshold_ms | number | 否 | 8 | 帧间高抖动阈值(ms) |

## 前置条件

- 必需模块: `android.frames.timeline`, `android.binder`, `android.garbage_collection`, `android.monitor_contention`

## 步骤编排

### Step 0: init_cpu_topology (skill: cpu_topology_view)

初始化共享 CPU 拓扑视图 `_cpu_topology`，供后续四象限分析和大小核分布使用。可选步骤。

### Step 1: frame_timeline_check - L0 数据源检测

检测 `actual_frame_timeline_slice` 表是否存在。若不存在则后续所有步骤跳过。

### Step 2: vsync_config - L1 环境配置

检测 VSync 周期和刷新率。数据源优先级:
1. VSYNC-sf counter 中位数（SF 消费节奏）
2. expected_frame_timeline_slice 帧 dur 中位数（回退）
3. 默认 60Hz（16.67ms）

同时统计目标进程的总帧数。

### Step 3: performance_summary - L1 帧性能汇总

核心步骤。使用**双信号混合检测**策略:
- **非 Buffer Stuffing 帧**: `present_type IN ('Late Present', 'Dropped Frame')` 为权威信号
- **Buffer Stuffing 帧**: present_type 始终为 Late Present，需用 present_ts 间隔二次验证。间隔 > 1.5x VSync = 真实掉帧；否则 = 管线背压（非感知掉帧）

输出: 总帧数、感知掉帧数/率、Buffer Stuffing 帧数、App 侧掉帧、SF 侧掉帧、实际 FPS、刷新率、平均/P95 呈现间隔、评级。

评级基于感知掉帧率: 优秀(<1%) / 良好(<5%) / 一般(<15%) / 较差(>=15%)。

### Step 4: expert_analysis_window - L1 专家分析窗口

确定专家探针的时间窗口。用户显式传入 start_ts/end_ts 时尊重用户窗口；否则自动使用 FrameTimeline 边界。

### Step 5: frame_variance_probe (skill: frame_pipeline_variance)

帧方差探针。分析帧稳定性（标准差、帧间波动、高抖动转折点）。仅在掉帧数 >= 5 时启用。

### Step 6: jank_type_stats - L1 掉帧类型统计

展示 jank_type 与实际消费端掉帧的关系。识别假阳性（框架标记掉帧但用户无感知）和假阴性（框架标记正常但实际卡顿）。

### Step 7: scroll_sessions - L2 滑动区间列表

将连续帧序列切分为滑动区间（会话间隔 > 6x VSync 为新会话）。过滤条件: 帧数 >= 10 且持续时间 > 200ms。

### Step 8: session_stats_batch - L2 区间统计（批量）

每个区间的详细统计，一次扫描生成:
- 四象限分析 (MainThread + RenderThread): Q1 大核运行、Q2 小核运行、Q3 调度等待、Q4a IO 阻塞、Q4b 锁/等待
- CPU 频率分布（按核心类型）
- 大小核亲和性分布

### Step 9: session_jank - L2 区间掉帧统计

每个区间的掉帧数据: 感知掉帧数/率、App 掉帧、Buffer Stuffing、最大跳帧数、掉帧类型分布。使用双信号混合检测。

### Step 10: get_app_jank_frames - 内部步骤：获取掉帧帧列表

获取所有掉帧帧的详细信息，包括:
- 双信号混合检测（非 BS 帧用 present_type，BS 帧用间隔二次验证）
- Guilty frame 溯源（三缓冲下找到导致缓冲区枯竭的慢帧）
- 责任归属: APP / SF / BUFFER_STUFFING / HIDDEN / UNKNOWN
- 生产线程时间范围（动态检测，不依赖硬编码线程名）
- 掉帧原因说明（管线耗尽/隐形掉帧/App 超时/SF 合成延迟等）

### Step 11: batch_frame_root_cause - L3 批量帧根因分类

一次性分析所有掉帧帧的完整指标和根因分类:
- 四象限 (MainThread + RenderThread)
- CPU 频率
- Binder/GC 重叠检测
- Top Slice 定位
- 21 种根因分类 (reason_code)

根因决策树优先级: sf_composition > binder_blocking > gc_pressure > lock_contention > io_blocking > ... > workload_heavy (fallback)

### Step 12: frame_detail_iterator (可选) - L4 逐帧深度分析

仅在 enable_frame_details=true 时启用。对严重掉帧调用 `jank_frame_detail` skill 进行深度分析（CPU 频率时间线、详细 slice）。

## 参数流

```
inputs -> vsync_config -> performance_summary
                       -> scroll_sessions -> session_stats_batch
                                          -> session_jank
                       -> get_app_jank_frames -> batch_frame_root_cause
                                              -> frame_detail_iterator (optional)
```

## 条件逻辑

- 所有分析步骤依赖 `frame_timeline_check.has_frame_timeline === 1`
- performance_summary 额外依赖 `environment.has_data === 1`
- 专家探针依赖 `enable_expert_probes === true` 且存在掉帧
- get_app_jank_frames 依赖 `janky_frames > 0`
- frame_detail_iterator 依赖 `enable_frame_details === true`

## 触发关键词

- 中文: 滑动, 卡顿, 帧率, 掉帧, 丢帧, FPS, 流畅度, 列表滑动, fling
- 英文: scroll, jank, fps, frame, fling, stutter, smoothness, list