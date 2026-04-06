<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Binder 线程池分析 (startup_binder_pool_analysis)

分析启动期间 Binder 线程池的利用率和饱和度。如果所有 Binder 线程都在忙，新的 Binder reply 会排队等待。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名 |
| start_ts | timestamp | 是 | - | 启动起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动结束时间戳(ns) |

## SQL 查询

```sql
WITH binder_threads AS (
  SELECT t.utid, t.name as thread_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND t.name GLOB 'Binder:*'
),
pool_stats AS (
  SELECT
    COUNT(DISTINCT bt.utid) as pool_size,
    ROUND(SUM(CASE WHEN ts.state = 'Running' THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_running_ms,
    ROUND(SUM(CASE WHEN ts.state = 'S'
      AND (ts.blocked_function GLOB '*binder_wait_for_work*'
           OR ts.blocked_function GLOB '*binder_thread_read*') THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_idle_ms,
    ROUND(SUM(CASE WHEN ts.state = 'S'
      AND ts.blocked_function IS NOT NULL
      AND ts.blocked_function NOT GLOB '*binder_wait_for_work*'
      AND ts.blocked_function NOT GLOB '*binder_thread_read*' THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_blocked_ms
  FROM binder_threads bt
  JOIN thread_state ts ON ts.utid = bt.utid
  WHERE ts.ts < <end_ts> AND ts.ts + ts.dur > <start_ts>
)
SELECT '线程池大小' as metric, pool_size || ' 个 Binder 线程' as value, ... as assessment
FROM pool_stats
UNION ALL
SELECT '线程池利用率' as metric, ... as value, ... as assessment
FROM pool_stats
UNION ALL
SELECT 'Binder 线程被阻塞' as metric, ... as value, ... as assessment
FROM pool_stats
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| metric | string | 指标名称 |
| value | string | 指标值 |
| assessment | string | 评估结论 |

## 使用说明

- **前置模块**: `sched`
- 分析三个关键指标：
  1. **线程池大小**: 活跃 Binder 线程数
  2. **线程池利用率**: Running 时间 / (Running + Idle) 时间，>80% 表示可能排队
  3. **Binder 线程被阻塞**: 非 binder_wait 的 S 状态，说明 Binder 线程自身被锁/IO 阻塞
- 区分空闲等待（`binder_wait_for_work`/`binder_thread_read`）和真正的阻塞等待