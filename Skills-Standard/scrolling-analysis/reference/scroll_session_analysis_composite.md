<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 滑动会话分析 (scroll_session_analysis) - Composite Skill v1.0

分析单个完整滑动区间的性能。一次完整滑动 = 按压滑动阶段(Touch) + Fling 阶段，分别统计两个阶段的 FPS 和掉帧情况。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| session_id | number | 是 | - | 区间编号 |
| start_ts | timestamp | 是 | - | 区间起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 区间结束时间戳(ns) |
| duration_ms | number | 否 | - | 持续时间(ms) |
| frame_count | number | 否 | - | 帧数 |
| touch_start_ts | timestamp | 否 | - | 按压滑动阶段起始 |
| touch_end_ts | timestamp | 否 | - | 按压滑动阶段结束 |
| touch_duration_ms | number | 否 | - | 按压阶段持续时间 |
| fling_start_ts | timestamp | 否 | - | Fling 阶段起始 |
| fling_end_ts | timestamp | 否 | - | Fling 阶段结束 |
| fling_duration_ms | number | 否 | - | Fling 阶段持续时间 |
| has_fling | number | 否 | - | 是否有 Fling 阶段 |

## 前置条件

- 必需表: `android_input_event`
- 上下文变量: `package`, `vsync_period_ns`, `refresh_rate_hz`

## 步骤编排

### Step 1: full_session_stats - 完整区间统计

统计整个区间的帧性能: 总帧数、掉帧数/率、平均/最大/最小帧耗时、估算 FPS。

掉帧判定: `dur > vsync_period_ns * 1.5`。

### Step 2: touch_phase_stats - 按压滑动阶段统计

**条件**: `touch_start_ts != null`

统计 Touch 阶段的帧数、掉帧数/率、平均/最大帧耗时、FPS。

### Step 3: fling_phase_stats - Fling 阶段统计

**条件**: `has_fling == 1`

统计 Fling 阶段的帧数、掉帧数/率、平均/最大帧耗时、FPS。

### Step 4: identify_janky_frames - 识别掉帧

列出掉帧帧列表，按帧耗时降序排列。包含帧号、阶段(touch/fling)、开始时间、帧耗时、卡顿等级(normal/jank/bad/severe)、丢帧数。最多返回 20 帧。

卡顿等级:
- severe: dur > 3x VSync
- bad: dur > 2x VSync
- jank: dur > 1.5x VSync

### Step 5: analyze_janky_frames - 掉帧原因分析 (Iterator)

对严重掉帧 (jank_level = severe 或 bad) 调用 `jank_frame_detail` skill，最多分析 10 帧。传入 start_ts/end_ts/dur_ms 参数。

### Step 6: session_diagnosis - 区间诊断

基于规则引擎的诊断:
- `jank_rate > 15%`: 掉帧率过高 (critical)
- `jank_rate > 5%`: 存在掉帧 (warning)
- `max_frame_ms > 100ms`: 存在严重卡顿帧 (critical)
- Touch 阶段掉帧率 > Fling 2 倍: 按压阶段更严重 (warning)
- Fling 阶段掉帧率 > Touch 2 倍: Fling 阶段更严重 (warning)
- `estimated_fps < 50`: 帧率偏低 (warning)

## 参数流

```
inputs -> full_session_stats
       -> touch_phase_stats (conditional: touch_start_ts)
       -> fling_phase_stats (conditional: has_fling)
       -> identify_janky_frames -> analyze_janky_frames (iterator)
       -> session_diagnosis (uses all above)
```

## 使用说明

- 通常由 scrolling_analysis 的区间列表驱动调用
- Touch vs Fling 阶段的掉帧特征不同: Touch 阶段受输入处理链路影响，Fling 阶段受动画计算和列表回收影响
- 帧检测基于 Choreographer#doFrame/DrawFrame slice，通过主线程 tid = pid 过滤