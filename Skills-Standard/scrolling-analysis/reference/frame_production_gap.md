<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 帧生产 Gap 分析 (frame_production_gap)

检测帧生产间隙（缺帧）：连续帧之间的 gap 超过 1.5x VSync 周期。分析 gap 期间 UI Thread 和 RenderThread 的活动状态，区分缺帧类型。

**类型**: composite

缺帧类型：
- **ui_no_frame**: UI Thread 未触发 doFrame（无渲染请求）
- **rt_no_drawframe**: 有 doFrame 但 RenderThread 未执行 DrawFrame
- **sf_backpressure**: 有 DrawFrame 但 SF 端未消费（背压或丢弃）

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| min_gap_vsync | number | 否 | 1.5 | 最小 gap 阈值（VSync 倍数） |

## 步骤编排

### Step 1: gap_summary - 帧 Gap 概览

```sql
-- 帧序列（按 present_ts 排序），检测前后帧间隔
-- Gap 检测：帧间隔 > min_gap_vsync x VSync，且 < 30x VSync（排除非滑动 gap）
-- Gap 期间 UI Thread 活动检测：查找 Choreographer#doFrame 和 DrawFrame slice
-- Gap 分类：
--   doframe_count = 0 → ui_no_frame
--   drawframe_count = 0 → rt_no_drawframe
--   else → sf_backpressure

SELECT
  (SELECT COUNT(*) FROM frame_seq) as total_frames,
  COUNT(*) as total_gaps,
  SUM(CASE WHEN gap_type = 'ui_no_frame' THEN 1 ELSE 0 END) as ui_no_frame_count,
  SUM(CASE WHEN gap_type = 'rt_no_drawframe' THEN 1 ELSE 0 END) as rt_no_drawframe_count,
  SUM(CASE WHEN gap_type = 'sf_backpressure' THEN 1 ELSE 0 END) as sf_backpressure_count,
  MAX(gap_ms) as max_gap_ms,
  ... as vsync_period_ms
FROM classified_gaps
```

### Step 2: gap_list - 帧 Gap 列表

按严重程度排序的 gap 明细列表，包含 gap 起始时间、时长、跳过 VSync 数、类型、doFrame/DrawFrame 计数、前后帧 ID。

## 输出列（Gap 列表）

| 列名 | 类型 | 说明 |
|------|------|------|
| gap_start | timestamp | Gap 起始（可点击导航范围） |
| gap_ms | duration | Gap 时长(ms) |
| gap_vsync_count | number | 跳过 VSync 数 |
| gap_type | string | Gap 类型 (ui_no_frame/rt_no_drawframe/sf_backpressure) |
| doframe_count | number | Gap 期间 doFrame 数 |
| drawframe_count | number | Gap 期间 DrawFrame 数 |
| before_frame_id | string | 前帧 ID |
| after_frame_id | string | 后帧 ID |

## 使用说明

- 前置依赖：`actual_frame_timeline_slice`、`slice`、`thread`、`process`
- 典型使用场景：
  - 滑动中出现"跳帧"但 batch_frame_root_cause 无对应 jank 帧
  - SurfaceTexture 单 buffer 场景下的帧吞噬检测
  - 滑动到边界时的帧率自然下降确认
- Gap 上限 30x VSync 过滤非滑动长间隙
- 最多返回 50 条 gap 记录