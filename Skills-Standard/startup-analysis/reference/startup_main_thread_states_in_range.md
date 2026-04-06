<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动主线程状态分布 (startup_main_thread_states_in_range)

统计启动阶段主线程 Running/Runnable/Blocked 状态占比，是四象限分析的基础。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |

## SQL 查询

```sql
SELECT
  ts.state,
  CASE ts.state
    WHEN 'Running' THEN 'Running (CPU执行)'
    WHEN 'R' THEN 'Runnable (等待调度)'
    WHEN 'R+' THEN 'Runnable+ (抢占等待)'
    WHEN 'S' THEN 'Sleeping (主动睡眠)'
    WHEN 'D' THEN 'Disk Sleep (IO等待)'
    ELSE ts.state
  END as state_desc,
  SUM(ts.dur) / 1e6 as total_dur_ms,
  ROUND(100.0 * SUM(ts.dur) / s.dur, 1) as percent,
  COUNT(*) as count,
  GROUP_CONCAT(DISTINCT ts.blocked_function) as blocked_functions
FROM thread_state ts
JOIN android_startup_threads st ON ts.utid = st.utid
JOIN android_startups s ON st.startup_id = s.startup_id
WHERE st.is_main_thread = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND ts.ts >= s.ts
  AND ts.ts <= s.ts + s.dur
GROUP BY ts.state, s.startup_id
ORDER BY total_dur_ms DESC
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| state | string | 线程状态（Running/R/R+/S/D） |
| state_desc | string | 状态中文说明 |
| total_dur_ms | duration | 该状态总耗时 |
| percent | percentage | 占启动总时长的比例 |
| count | number | 该状态出现次数 |
| blocked_functions | string | 阻塞函数（去重） |

## 使用说明

- **前置模块**: `android.startup.startups`, `sched`
- 主线程状态分布是启动分析的核心指标，直接映射到四象限模型：
  - Running = Q1/Q2（CPU 执行，看大核/小核分布）
  - R/R+ = Q3（Runnable，等待调度 = CPU 资源争抢）
  - S = Q4b（Sleeping，等待锁/Binder/信号量）
  - D = Q4a（IO 阻塞）
- blocked_functions 列提供阻塞原因的内核函数，用于根因定位