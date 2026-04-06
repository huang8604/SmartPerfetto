<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 逐帧 Input-to-Display 延迟 (input_to_frame_latency) v2.0

基于 Perfetto stdlib `android_input_events` 表的 5 维延迟分解，测量每个 MotionEvent 到对应帧 present 的延迟，用于跟手度分析。

与 `scroll_response_latency` 的区别: 本 skill 用于逐帧跟手度分析（每个 MOVE 事件到帧的延迟），而非首帧响应速度。

## v2.0 变更

- 从 `android_input_event_dispatch` (proto 数据源) 迁移到 `android_input_events` (slice-based)
- 帧关联从时间窗口子查询改为 `frame_id` 精确 JOIN
- 新增 dispatch/handling/ack 管线分解
- 新增 `is_speculative_frame` 帧关联置信度标记
- event_action 使用大写格式（如 MOVE, DOWN, UP）

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 目标进程名（支持 GLOB） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| event_action_filter | string | 否 | - | 事件动作过滤（默认 MOVE） |

## 前置条件

- 必需模块: `android.input`（内部自动 INCLUDE `android.frames.timeline`, `intervals.intersect`, `slices.with_context`）
- 数据源依赖: trace 需包含 input atrace category（`sendMessage(*)`/`receiveMessage(*)` slices）

## 步骤编排

### Step 1: vsync_period - VSync 周期检测

从 VSYNC-app counter track 获取 VSync 周期，使用中位数 + 标准吸附。

### Step 2: input_sampling_rate - 输入采样率检测

从 `android_input_events` 表计算 MOVE 事件间隔中位数，推算采样率(Hz)。

### Step 3: per_frame_latency - 逐帧延迟

核心步骤。使用 `android_input_events` 的 `frame_id` 精确 JOIN `actual_frame_timeline_slice`：
- input_to_display_ms: `end_to_end_latency_dur`（read_time → frame present，最完整的端到端度量）
- dispatch_latency_ms: `dispatch_latency_dur`（OS → App 分发延迟）
- handling_ms: `handling_latency_dur`（App 处理延迟）
- ack_ms: `ack_latency_dur`（ACK 往返延迟）
- frame_dur_ms: 帧渲染耗时（来自 `actual_frame_timeline_slice`）
- frame_to_present_ms: 帧完成到 present 的延迟
- is_speculative: 帧关联是否为推测匹配（非精确 VSync 对齐）

评级标准（基于 VSync 周期 T）:
- 优秀: < 2T
- 良好: < 3T
- 需优化: < 4T
- 严重: >= 4T

### Step 4: latency_statistics - 延迟统计

基于 `end_to_end_latency_dur` 聚合统计: P50/P90/P99、均值、标准差、样本数、VSync 周期。

### Step 5: latency_spikes - 延迟飙升检测

检测延迟突然飙升的时刻: 当前帧延迟 > 前帧延迟 × 2 且绝对值 > 30ms。返回 Top 20 飙升点，按 spike_ratio 降序。包含 `is_speculative` 标记。

## 输出列（per_frame_latency 主步骤）

| 列名 | 类型 | 说明 |
|------|------|------|
| input_ts | timestamp | 输入事件时间(ns)，可点击跳转 |
| process_name | string | 进程名 |
| event_action | string | 事件动作（如 MOVE, DOWN, UP） |
| input_to_display_ms | duration | Input→Display 总延迟(ms)（end_to_end_latency_dur） |
| dispatch_latency_ms | duration | 系统分发延迟(ms) |
| handling_ms | duration | 应用处理延迟(ms) |
| ack_ms | duration | ACK 往返延迟(ms) |
| frame_dur_ms | duration | 帧渲染耗时(ms) |
| frame_to_present_ms | duration | Frame→Present 延迟(ms) |
| is_speculative | boolean | 帧关联是否为推测匹配 |
| rating | string | 评级（优秀/良好/需优化/严重） |

## 使用说明

- 需要 trace 包含 input atrace category（`sendMessage(*)`/`receiveMessage(*)` slices）
- `end_to_end_latency_dur` 为 NULL 时表示输入事件无关联帧，这些事件会被过滤
- `is_speculative_frame` 为 true 时表示帧关联基于时间推测而非精确 ID 匹配，分析时应降低置信度
- 过滤条件: 延迟 > 0 且 < 500ms，避免异常值
- 延迟拆解: dispatch + handling + ack + 帧渲染 + 合成提交，可精确定位瓶颈阶段
- 飙升检测可发现偶发性卡顿（如 GC、Binder 阻塞导致的延迟尖峰）