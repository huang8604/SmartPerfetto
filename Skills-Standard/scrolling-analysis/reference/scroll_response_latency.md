<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 滚动响应延迟 (scroll_response_latency) v2.0

基于 Perfetto stdlib `android_input_events` 测量滚动手势从输入到首帧渲染的响应延迟。

与 `input_to_frame_latency` 的区别: 本 skill 测量手势起始到首帧的响应速度，而非逐帧跟手度。

## v2.0 变更

- 从 `android_input_event_dispatch` (proto 数据源) 迁移到 `android_input_events` (slice-based)
- event_action 使用大写格式（MOVE, DOWN, UP）
- 时间戳基准统一为 `dispatch_ts`

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 目标进程名（支持 GLOB） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |

## 前置条件

- 必需模块: `android.input`（内部自动 INCLUDE `android.frames.timeline`）
- 数据源依赖: trace 需包含 input atrace category（`sendMessage(*)`/`receiveMessage(*)` slices）

## SQL 查询

```sql
WITH move_events AS (
  SELECT
    dispatch_ts as input_ts,
    process_name,
    upid,
    ROW_NUMBER() OVER (PARTITION BY upid ORDER BY dispatch_ts) as move_idx
  FROM android_input_events
  WHERE (process_name GLOB '<package>*' OR '<package>' = '')
    AND event_action = 'MOVE'
    AND (<start_ts> IS NULL OR dispatch_ts >= <start_ts>)
    AND (<end_ts> IS NULL OR dispatch_ts <= <end_ts>)
),
gesture_starts AS (
  -- 手势起始检测: 与前一个 MOVE 间隔 > 500ms 视为新手势
  SELECT m1.input_ts as gesture_ts, m1.process_name, m1.upid
  FROM move_events m1
  LEFT JOIN move_events m2 ON m1.upid = m2.upid AND m2.move_idx = m1.move_idx - 1
  WHERE m2.input_ts IS NULL OR (m1.input_ts - m2.input_ts) > 500000000
),
first_frames AS (
  SELECT
    g.gesture_ts, g.process_name,
    MIN(f.ts) as frame_ts,
    (SELECT f2.dur FROM actual_frame_timeline_slice f2
     WHERE f2.upid = g.upid AND f2.ts >= g.gesture_ts
     ORDER BY f2.ts LIMIT 1) as frame_dur
  FROM gesture_starts g
  LEFT JOIN actual_frame_timeline_slice f ON f.upid = g.upid AND f.ts >= g.gesture_ts
  GROUP BY g.gesture_ts, g.process_name
)
SELECT
  printf('%d', gesture_ts) as gesture_ts,
  process_name,
  ROUND((frame_ts - gesture_ts) / 1e6, 2) as response_latency_ms,
  ROUND(frame_dur / 1e6, 2) as first_frame_dur_ms,
  CASE
    WHEN (frame_ts - gesture_ts) / 1e6 < 50 THEN '优秀'
    WHEN (frame_ts - gesture_ts) / 1e6 < 100 THEN '良好'
    WHEN (frame_ts - gesture_ts) / 1e6 < 200 THEN '需优化'
    ELSE '严重'
  END as rating
FROM first_frames
WHERE frame_ts IS NOT NULL
ORDER BY response_latency_ms DESC
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| gesture_ts | timestamp | 手势起始时间(ns)，可点击跳转 |
| process_name | string | 进程名 |
| response_latency_ms | duration | 响应延迟(ms) |
| first_frame_dur_ms | duration | 首帧渲染耗时(ms) |
| rating | string | 评级 |

## 评级标准

| 评级 | 响应延迟阈值 |
|------|-------------|
| 优秀 | < 50ms |
| 良好 | < 100ms |
| 需优化 | 100-200ms |
| 严重 | >= 200ms |

## 使用说明

- 手势起始检测: 两次 MOVE 事件间隔 > 500ms 视为新手势
- 首帧匹配: 从手势起始时间开始，找 `actual_frame_timeline_slice` 中最近的后续帧
- 响应延迟 = 首帧 ts - 手势起始 ts（不含帧渲染时间）
- 按 response_latency_ms 降序排列，最慢响应优先展示
- `android_input_events` 仅包含完成完整 IPC 周期的事件