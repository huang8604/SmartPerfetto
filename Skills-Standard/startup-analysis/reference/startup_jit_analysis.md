<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动 JIT 影响分析 (startup_jit_analysis)

分析 JIT 编译线程对启动速度的影响：CPU 竞争、Code Cache GC、Baseline Profile 缺失信号。

JIT 影响启动的三个机制：
1. JIT 编译与主线程争抢 CPU（特别是大核）
2. JIT Code Cache 接近上限时触发 GarbageCollectCache
3. 缺少 Baseline Profile 时，冷启动前期代码走解释器，性能差 5-10x

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名 |
| start_ts | timestamp | 是 | - | 启动起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动结束时间戳(ns) |

## SQL 查询

```sql
WITH jit_threads AS (
  SELECT t.utid, t.name as thread_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND (t.name GLOB 'Jit thread pool*' OR t.name GLOB 'Profile Saver*')
),
jit_cpu AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    SUM(MIN(ss.ts + ss.dur, <end_ts>) - MAX(ss.ts, <start_ts>)) / 1e6 as running_ms
  FROM sched_slice ss
  JOIN jit_threads jt ON ss.utid = jt.utid
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.ts < <end_ts> AND ss.ts + ss.dur > <start_ts>
  GROUP BY core_type
),
jit_slices AS (
  SELECT
    CASE
      WHEN s.name GLOB 'JIT compiling*' THEN 'jit_compile'
      WHEN s.name GLOB '*GarbageCollectCache*' THEN 'code_cache_gc'
      WHEN s.name GLOB '*ScopedCodeCacheWrite*' THEN 'code_cache_write'
      WHEN s.name GLOB 'JitProfileTask*' THEN 'profile_task'
      ELSE 'other_jit'
    END as jit_activity,
    COUNT(*) as event_count,
    SUM(s.dur) / 1e6 as total_ms,
    MAX(s.dur) / 1e6 as max_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN jit_threads jt ON tt.utid = jt.utid
  WHERE s.ts >= <start_ts> AND s.ts < <end_ts> AND s.dur > 0
  GROUP BY jit_activity
),
summary AS (
  SELECT
    ROUND(COALESCE((SELECT SUM(running_ms) FROM jit_cpu), 0), 1) as jit_total_cpu_ms,
    ROUND(COALESCE((SELECT SUM(running_ms) FROM jit_cpu WHERE core_type IN ('prime','big','medium')), 0), 1) as jit_big_core_ms,
    COALESCE((SELECT event_count FROM jit_slices WHERE jit_activity = 'jit_compile'), 0) as compile_count,
    COALESCE((SELECT event_count FROM jit_slices WHERE jit_activity = 'code_cache_gc'), 0) as code_cache_gc_count,
    ...
)
-- Returns metric/value/assessment rows for:
-- JIT 总 CPU 时间, JIT 大核 CPU 时间, JIT 编译次数, Code Cache GC
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| metric | string | 指标名称 |
| value | string | 指标值 |
| assessment | string | 评估结论 |

## 使用说明

- **前置模块**: `sched`
- 对应根因 A12（JIT 编译开销）和 A5（Baseline Profile 缺失）
- 关键判断指标：
  - JIT 总 CPU >50ms = 偏高
  - JIT 大核 CPU >30ms = 与主线程争抢大核
  - JIT 编译次数 >50 = Baseline Profile 覆盖不足
  - Code Cache GC >0 = 可能影响启动性能
- 官方阈值：JIT >100ms、JIT compiled methods >65 为告警