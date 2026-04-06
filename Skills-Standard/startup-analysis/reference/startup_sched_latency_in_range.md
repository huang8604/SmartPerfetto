<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动调度延迟 (startup_sched_latency_in_range)

统计启动阶段主线程 Runnable (R/R+) 等待时延，反映 CPU 资源争抢程度。

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
  COUNT(*) as count,
  SUM(ts.dur) / 1e6 as total_wait_ms,
  ROUND(AVG(ts.dur) / 1e6, 2) as avg_wait_ms,
  ROUND(MAX(ts.dur) / 1e6, 2) as max_wait_ms,
  SUM(CASE WHEN ts.dur / 1e6 > 8 THEN 1 ELSE 0 END) as severe_delays
FROM thread_state ts
JOIN android_startup_threads st ON ts.utid = st.utid
JOIN android_startups s ON st.startup_id = s.startup_id
WHERE st.is_main_thread = 1
  AND ts.state IN ('R', 'R+')
  AND ts.ts >= s.ts
  AND ts.ts <= s.ts + s.dur
GROUP BY ts.state
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| state | string | 状态（R = Runnable, R+ = Runnable Preempted） |
| count | number | 出现次数 |
| total_wait_ms | duration | 总等待时间 |
| avg_wait_ms | duration | 平均等待时间 |
| max_wait_ms | duration | 最大单次等待时间 |
| severe_delays | number | 严重延迟次数（>8ms） |

## 使用说明

- **前置模块**: `android.startup.startups`, `sched`
- 对应四象限 Q3（Runnable = 等待调度）
- 严重延迟阈值设为 8ms（约半帧），>15% 的 Runnable 时间 = CPU 调度瓶颈
- 高调度延迟通常指向根因 B9（后台进程干扰）或 B12（并发启动）
- R+ (Runnable Preempted) 表示线程被更高优先级的线程抢占