<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Perfetto SQL 高级特性指南

## 1. INCLUDE PERFETTO MODULE（stdlib 预计算表）

stdlib 模块提供预计算的 view/table，避免重复手写 JOIN。

### 关键模块清单

| 模块 | 提供的表/视图 | 用途 |
|------|-------------|------|
| `slices.with_context` | `thread_slice` (slice + thread + process pre-joined) | 替代 slice JOIN thread_track JOIN thread JOIN process |
| `android.startup.startups` | `android_startups`, `android_startup_processes` | 启动事件预计算 |
| `android.frames.timeline` | `android_frames_overrun`, `android_frame_stats` | 帧统计预计算 |
| `android.binder` | `android_binder_txns` | Binder 事务预计算 |
| `android.monitor_contention` | 锁竞争事件 | Android 13+ |
| `android.garbage_collection` | GC 事件表 | GC 分析 |
| `android.memory.process` | 进程内存指标 | 内存压力检测 |

### 使用示例

```sql
-- 旧写法（手动 JOIN）
SELECT s.name, s.dur, t.name as thread, p.name as process
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '<package>*'

-- 新写法（用 slices.with_context）
INCLUDE PERFETTO MODULE slices.with_context;
SELECT name, dur, thread_name, process_name
FROM thread_slice
WHERE process_name GLOB '<package>*'
```

## 2. SPAN_JOIN（时间重叠检测）

SPAN_JOIN 专为时间区间重叠设计，替代手动 BETWEEN + 子查询。

### 使用场景
- Binder/GC 与帧的重叠时间计算
- 线程状态与 slice 的交叉分析

### 语法

```sql
-- 两个表必须有 ts 和 dur 列，且按 ts 排序
CREATE PERFETTO TABLE overlap AS
SELECT * FROM SPAN_JOIN(table_a, table_b);

-- 也支持 LEFT JOIN 和 OUTER JOIN
CREATE PERFETTO TABLE overlap AS
SELECT * FROM SPAN_LEFT_JOIN(table_a, table_b);
```

### 实际示例：Binder 与帧的重叠

```sql
-- 旧写法
SELECT frame_id, SUM(
  MIN(binder.ts + binder.dur, frame.ts + frame.dur) -
  MAX(binder.ts, frame.ts)
) as overlap_ns
FROM frames frame, binder_txns binder
WHERE binder.ts < frame.ts + frame.dur
  AND binder.ts + binder.dur > frame.ts

-- 新写法
CREATE PERFETTO TABLE frame_binder_overlap AS
SELECT * FROM SPAN_JOIN(
  (SELECT ts, dur, id as frame_id FROM actual_frame_timeline_slice),
  (SELECT ts, dur, id as binder_id FROM android_binder_txns)
);
SELECT frame_id, SUM(dur) as overlap_ns
FROM frame_binder_overlap GROUP BY frame_id;
```

## 3. CREATE PERFETTO TABLE / FUNCTION / MACRO

### CREATE PERFETTO TABLE（优化的分析表）

```sql
-- 比 VIEW 更快（物化存储，有索引优化）
CREATE PERFETTO TABLE hot_slices AS
SELECT * FROM slice WHERE dur > 1000000;
```

### CREATE PERFETTO FUNCTION（可复用函数）

```sql
-- 标量函数
CREATE PERFETTO FUNCTION is_big_core(cpu INT)
RETURNS BOOL AS
SELECT $cpu IN (SELECT cpu FROM _cpu_topology WHERE core_type IN ('big', 'prime'));

-- 表值函数
CREATE PERFETTO FUNCTION slices_in_range(start_ts LONG, end_ts LONG)
RETURNS TABLE(name STRING, dur LONG) AS
SELECT name, dur FROM slice
WHERE ts >= $start_ts AND ts < $end_ts;
```

### CREATE PERFETTO MACRO（编译时参数化）

```sql
CREATE PERFETTO MACRO frame_budget(hz INT)
RETURNS LONG AS 1000000000 / $hz;
```

## 4. ancestor_slice / descendant_slice（层级遍历）

```sql
-- 找到某个 slice 的所有祖先
SELECT * FROM ancestor_slice(12345);

-- 找到某个 slice 的所有后代（按调用栈）
SELECT * FROM descendant_slice_by_stack(12345);

-- 用途：计算 self_dur（替代手动减子 slice）
SELECT s.id, s.dur - COALESCE(
  (SELECT SUM(d.dur) FROM descendant_slice(s.id) d WHERE d.depth = s.depth + 1),
  0
) as self_dur
FROM slice s WHERE s.id = 12345;
```

## 5. EXTRACT_ARG（args 表快捷访问）

```sql
-- 旧写法
SELECT a.string_value FROM args a WHERE a.arg_set_id = s.arg_set_id AND a.key = 'debug.name'

-- 新写法
SELECT EXTRACT_ARG(s.arg_set_id, 'debug.name') as debug_name FROM slice s
```

## 6. FLOW 操作符（因果追踪）

```sql
-- 追踪 Binder 事务的因果链
SELECT * FROM FOLLOWING_FLOW(slice_id);   -- 从当前 slice 到后续 slice
SELECT * FROM PRECEDING_FLOW(slice_id);   -- 从当前 slice 到前序 slice

-- 用途：Binder 客户端 → 服务端的因果关联（比 waker_utid 更精确）
```