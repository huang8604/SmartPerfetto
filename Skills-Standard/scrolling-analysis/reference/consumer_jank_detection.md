<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Consumer Jank 检测 (consumer_jank_detection)

从 SurfaceFlinger 消费端角度检测真正的掉帧。使用同 layer 的"实际呈现时间间隔"判断是否错过 VSync，而非仅依赖 jank_type 标记。

核心原理：
- display_frame_token 仅作为帧标识，不再直接用 token gap 判定卡顿
- 通过动态 VSync 周期 + 会话断点过滤，避免长空窗/跨会话误判
- 与传统 jank_type 的区别：jank_type 反映框架标记，不一定等同用户可见掉帧

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| layer_name | string | 否 | - | Layer 名称（可选，用于精确匹配） |
| start_ts | timestamp | 否 | - | 分析起始时间 |
| end_ts | timestamp | 否 | - | 分析结束时间 |

## 步骤编排

### Step 1: vsync_config - VSync 配置

检测 VSync 周期，使用 VSYNC-sf 中位数 + 标准吸附。

### Step 2: consumer_jank_frames - 消费端掉帧检测

基于 present_ts 间隔检测真正的掉帧帧列表。核心逻辑：
- 同一 display frame token 在多 layer 去重（row_rank = 1）
- 会话断点：间隔 > 6x VSync 视为会话中断，不算掉帧
- 消费端掉帧：间隔 > 1.5x VSync 且非会话中断
- 严重程度：SMOOTH / MINOR_JANK / JANK / SEVERE_JANK / FROZEN
- 延迟来源：app_late / sf_late / buffer_stuffing

```sql
-- 核心分类逻辑
CASE
  WHEN app_jank_type = 'None' THEN 'sf_late'
  WHEN app_jank_type GLOB '*SurfaceFlinger*' THEN 'sf_late'
  WHEN app_jank_type GLOB '*Buffer*' THEN 'buffer_stuffing'
  ELSE 'app_late'
END as delay_source
```

### Step 3: consumer_jank_summary - 消费端掉帧汇总

统计总帧数、掉帧数/率、最大跳帧数、评级。

评级标准：
- 掉帧率 < 1%: 优秀
- 掉帧率 < 5%: 良好
- 掉帧率 < 15%: 一般
- 掉帧率 >= 15%: 较差

### Step 4: jank_severity_distribution - 掉帧严重程度分布

统计各严重程度的帧数和占比。

## 输出列（掉帧帧列表）

| 列名 | 类型 | 说明 |
|------|------|------|
| frame_id | string | 帧 ID |
| layer_name | string | 图层名 |
| ts_str | timestamp | 时间（可点击导航） |
| dur_ms | duration | 帧耗时(ms) |
| token_gap | number | Token 跳跃 |
| vsync_missed | number | 跳帧数 |
| interval_ms | duration | 呈现间隔(ms) |
| app_jank_type | string | App 标记 |
| jank_severity | string | 严重程度 |
| delay_source | string | 延迟来源（app_late/sf_late/buffer_stuffing） |

## 使用说明

- 前置依赖：`actual_frame_timeline_slice` 表，`android.frames.timeline` 模块
- 这是滑动分析中最关键的掉帧检测技能，从用户可感知的角度判定掉帧
- 使用 present_ts 间隔而非 token_gap 作为主要判定依据
- 会话断点过滤（> 6x VSync）避免跨滑动区间误判
- delay_source 字段帮助快速定位掉帧责任方

## FrameTimeline 高级字段

### is_buffer
区分 buffer 帧（App 提交了新 buffer）和 animation 帧（仅动画/位移变化）。用于帧生产 gap 分析：
- is_buffer = 1：App 确实提交了新的 surface buffer
- is_buffer = 0：帧只是动画/位移更新，无新 buffer

### prediction_type
FrameTimeline 的预测精度：
- Valid Prediction：预测的 present time 与实际接近
- Expired Prediction：预测已过期（通常意味着调度延迟），可能导致帧被错误分类

### 多 Layer 分析
一个 DisplayFrame 可以消费多个 Layer 的 SurfaceFrame。当 SF composition 慢时，需要检查是哪些 Layer 贡献了延迟：
```sql
SELECT
  display_frame_token,
  layer_name,
  jank_type,
  present_type,
  dur / 1e6 as dur_ms
FROM actual_frame_timeline_slice
WHERE display_frame_token = <target_token>
ORDER BY layer_name
```