<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 帧阻塞调用分析 (frame_blocking_calls)

将 `android.critical_blocking_calls` 模块识别的阻塞调用与 `android.frames.timeline` 的帧时间线做交叉匹配，找出每个掉帧帧期间发生的阻塞调用（GC、Binder、锁竞争、IO 等）。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |

## SQL 查询

```sql
WITH jank_frames AS (
  SELECT
    a.display_frame_token as frame_id,
    a.ts as frame_ts,
    a.dur as frame_dur,
    a.ts + a.dur as frame_end,
    a.jank_type
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<process_name>*' OR '<process_name>' = '')
    AND COALESCE(a.jank_type, 'None') != 'None'
    AND (<start_ts> IS NULL OR a.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR a.ts < <end_ts>)
),
-- _android_critical_blocking_calls 是 Perfetto stdlib 的内部表（underscore prefix）
blocking AS (
  SELECT
    bc.name as blocking_call,
    bc.ts as call_ts,
    bc.dur as call_dur,
    bc.process_name as call_process,
    bc.utid
  FROM _android_critical_blocking_calls bc
  WHERE (bc.process_name GLOB '<process_name>*' OR '<process_name>' = '')
)
SELECT
  printf('%d', jf.frame_id) as frame_id,
  printf('%d', jf.frame_ts) as frame_ts,
  ROUND(jf.frame_dur / 1e6, 2) as frame_dur_ms,
  jf.jank_type,
  b.blocking_call,
  ROUND(
    (MIN(b.call_ts + b.call_dur, jf.frame_end) - MAX(b.call_ts, jf.frame_ts)) / 1e6, 2
  ) as overlap_ms,
  ROUND(b.call_dur / 1e6, 2) as call_dur_ms,
  COUNT(*) as call_count
FROM jank_frames jf
JOIN blocking b
  ON b.call_ts < jf.frame_end
  AND b.call_ts + b.call_dur > jf.frame_ts
GROUP BY jf.frame_id, b.blocking_call
HAVING overlap_ms > 0.5
ORDER BY jf.frame_ts, overlap_ms DESC
LIMIT 100
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| frame_id | string | 帧 ID |
| frame_ts | timestamp | 帧时间（可点击导航） |
| frame_dur_ms | duration | 帧耗时(ms) |
| jank_type | string | Jank 类型 |
| blocking_call | string | 阻塞调用名称 |
| overlap_ms | duration | 重叠时间(ms) |
| call_dur_ms | duration | 调用耗时(ms) |
| call_count | number | 调用次数 |

## 使用说明

- 前置模块：`android.frames.timeline`、`android.critical_blocking_calls`
- 核心逻辑：对掉帧帧和阻塞调用做时间区间重叠 JOIN，计算重叠时长
- 仅分析 jank_type != 'None' 的帧（已被框架标记为掉帧）
- 阻塞调用类型包括：GC、Binder transaction、monitor contention、IO 等
- overlap_ms > 0.5 的门槛过滤微小重叠
- 限制最多返回 100 条记录