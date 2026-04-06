<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动线程阻塞关系图 (startup_thread_blocking_graph)

利用 thread_state.waker_utid 构建线程间的 block/wakeup 关系图。回答核心问题："主线程被谁阻塞？唤醒者当时在做什么？" 让 Agent 可以构建因果链，例如：`MainThread[S: binder_wait] <- Binder:1234_5 <- system_server/PackageManager`。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名（支持 GLOB 前缀匹配） |
| start_ts | timestamp | 是 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动区间结束时间戳(ns) |
| min_block_ms | number | 否 | 1 | 最小阻塞时长阈值（ms） |
| top_k | number | 否 | 20 | 返回 Top K 条阻塞关系 |

## SQL 查询

```sql
WITH process_threads AS (
  SELECT t.utid, t.tid, t.name as thread_name, p.pid,
    CASE
      WHEN t.tid = p.pid THEN 'main'
      WHEN t.name = 'RenderThread' THEN 'render'
      WHEN t.name GLOB '*HeapTaskDaemon*' OR t.name GLOB '*FinalizerDaemon*' THEN 'gc'
      WHEN t.name GLOB 'Jit thread pool*' THEN 'jit'
      WHEN t.name GLOB 'Binder:*' THEN 'binder'
      ELSE 'other'
    END as role
  FROM thread t JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
),
-- 查找所有阻塞事件（S/D 状态 > min_block_ms）及其唤醒者
blocking_events AS (
  SELECT pt.thread_name as blocked_thread, pt.role as blocked_role,
    ts.state as blocked_state, ts.blocked_function,
    ts.waker_utid, ts.ts as block_ts, ts.dur as block_dur
  FROM thread_state ts JOIN process_threads pt ON ts.utid = pt.utid
  WHERE ts.state IN ('S', 'D') AND ts.waker_utid IS NOT NULL
    AND ts.ts >= <start_ts> AND ts.ts < <end_ts>
    AND ts.dur > <min_block_ms|1> * 1000000
),
-- 关联唤醒者线程和进程信息
with_waker_info AS (...),
-- 查找唤醒者在唤醒时刻正在执行的最内层 slice
with_waker_slice AS (
  SELECT wi.*,
    (SELECT s.name FROM slice s JOIN thread_track tt ON s.track_id = tt.id
     WHERE tt.utid = wi.waker_utid_resolved
       AND s.ts <= wi.block_ts + wi.block_dur
       AND s.ts + s.dur >= wi.block_ts + wi.block_dur
     ORDER BY s.dur ASC LIMIT 1) as waker_current_slice
  FROM with_waker_info wi
)
-- 聚合：按 blocked_thread x waker x blocked_function 分组
SELECT blocked_thread, blocked_role, blocked_state, blocked_function,
  waker_thread, waker_process, waker_current_slice,
  COUNT(*) as block_count,
  ROUND(SUM(block_dur) / 1e6, 2) as total_block_ms,
  ROUND(MAX(block_dur) / 1e6, 2) as max_block_ms,
  ROUND(AVG(block_dur) / 1e6, 2) as avg_block_ms
FROM with_waker_slice
GROUP BY blocked_thread, blocked_role, blocked_state, blocked_function,
         waker_thread, waker_process
ORDER BY CASE blocked_role WHEN 'main' THEN 0 WHEN 'render' THEN 1 ELSE 2 END,
  total_block_ms DESC
LIMIT <top_k|20>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| blocked_thread | string | 被阻塞线程名 |
| blocked_role | string | 被阻塞线程角色（main/render/gc/jit/binder/other） |
| blocked_state | string | 阻塞状态（S=睡眠/等待锁, D=IO 阻塞） |
| blocked_function | string | 阻塞内核函数（如 binder_wait_for_work, futex_wait_queue） |
| waker_thread | string | 唤醒者线程名 |
| waker_process | string | 唤醒者进程名 |
| waker_current_slice | string | 唤醒者在唤醒时刻正在执行的 slice 名 |
| block_count | number | 阻塞次数 |
| total_block_ms | duration | 总阻塞时间（ms） |
| max_block_ms | duration | 最大单次阻塞时间（ms） |
| avg_block_ms | duration | 平均阻塞时间（ms） |

## 使用说明

- **前置模块**: `sched`
- 依赖 `thread_state.waker_utid` 字段，需要 trace 中包含唤醒者信息
- `waker_current_slice` 通过子查询找到唤醒者在唤醒时刻的最内层 slice，帮助理解唤醒者当时在做什么
- 主线程阻塞排在最前，然后是 RenderThread
- 典型因果链：`MainThread[S: futex_wait] <- HeapTaskDaemon[Running: GC]` 表示主线程被 GC 阻塞
- 在 `startup_detail` 组合 Skill 中用于构建线程阻塞因果链