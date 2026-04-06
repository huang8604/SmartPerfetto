<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 热点 Slice 线程状态分布 (startup_hot_slice_states)

分析启动区间内 Top N 热点 Slice 各自的线程状态分布（Running/S/D/R）及 blocked_functions。用于定位每个耗时切片的具体瓶颈是 CPU 运行、IO 阻塞还是锁等待。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名（支持 GLOB 前缀匹配） |
| start_ts | timestamp | 是 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动区间结束时间戳(ns) |
| top_n | number | 否 | 10 | 返回 Top N 个热点 Slice |

## SQL 查询

```sql
WITH main_thread AS (
  SELECT t.utid, p.pid
  FROM thread t JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*' AND t.tid = p.pid
),
-- 取主线程上 >= 5ms 的最耗时切片
hot_slices AS (
  SELECT s.name as slice_name, s.ts as slice_ts,
    s.ts + s.dur as slice_end, s.dur / 1e6 as slice_dur_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  WHERE s.ts >= <start_ts> AND s.ts + s.dur <= <end_ts>
    AND s.dur >= 5000000
  ORDER BY s.dur DESC LIMIT <top_n|10>
)
-- 对每个热点 Slice 关联 thread_state，计算状态分布
SELECT
  hs.slice_name, ROUND(hs.slice_dur_ms, 1) as slice_dur_ms,
  printf('%d', hs.slice_ts) as slice_ts,
  tstate.state,
  ROUND(SUM(overlap_dur) / 1e6, 2) as state_dur_ms,
  ROUND(100.0 * SUM(overlap_dur) / (hs.slice_dur_ms * 1e6), 1) as state_pct,
  GROUP_CONCAT(DISTINCT tstate.blocked_function) as blocked_functions
FROM hot_slices hs
JOIN main_thread mt
JOIN thread_state tstate ON tstate.utid = mt.utid
  AND tstate.ts < hs.slice_end AND tstate.ts + tstate.dur > hs.slice_ts
GROUP BY hs.slice_name, hs.slice_ts, tstate.state
ORDER BY hs.slice_dur_ms DESC, state_dur_ms DESC
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| slice_name | string | 切片名 |
| slice_dur_ms | duration | 切片总耗时（ms） |
| slice_ts | timestamp | 切片开始时间戳 |
| state | string | 线程状态（Running/S/D/R/R+ 等） |
| state_dur_ms | duration | 该状态在切片内的持续时间（ms） |
| state_pct | percentage | 该状态占切片总时间的百分比 |
| blocked_functions | string | 阻塞函数列表（去重） |

## 使用说明

- **前置模块**: `sched`
- 仅分析主线程上的切片（tid = pid）
- 过滤条件：切片时长 >= 5ms，避免噪声
- 每个切片会展开多行，每行对应一个线程状态
- 如果 `state = 'S'` 且 `blocked_functions` 含 `binder_wait`，说明该 Slice 被 Binder 阻塞
- 如果 `state = 'D'`，说明该 Slice 正在等待 IO
- 在 `startup_detail` 组合 Skill 中作为精细化根因定位步骤使用