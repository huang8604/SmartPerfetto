<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动主线程 Binder 阻塞 (startup_main_thread_binder_blocking_in_range)

分析启动阶段主线程同步 Binder 阻塞明细，关联 thread_state 提供阻塞状态和阻塞函数信息。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名 |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤 |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |
| min_dur_ns | integer | 否 | 5000000 | 最小阻塞耗时(ns)，默认 5ms |
| top_k | integer | 否 | 20 | 返回前 N 个阻塞事件 |

## SQL 查询

```sql
SELECT DISTINCT
  bt.server_process,
  bt.aidl_name,
  bt.client_dur / 1e6 as dur_ms,
  ts.state,
  ts.blocked_function,
  printf('%d', bt.client_ts) as ts_str,
  printf('%d', bt.client_dur) as dur_str,
  CASE
    WHEN bt.client_dur / 1e6 > 50 THEN 'critical'
    WHEN bt.client_dur / 1e6 > 16 THEN 'warning'
    ELSE 'normal'
  END as severity
FROM android_binder_txns bt
JOIN android_startups s ON (
  bt.client_ts >= s.ts AND bt.client_ts <= s.ts + s.dur
  AND bt.client_process GLOB s.package || '*'
)
LEFT JOIN thread_state ts ON (
  ts.utid = bt.client_utid
  AND ts.ts >= bt.client_ts
  AND ts.ts < bt.client_ts + bt.client_dur
)
WHERE bt.is_main_thread = 1
  AND bt.is_sync = 1
  AND bt.client_dur > <min_dur_ns|5000000>
ORDER BY bt.client_dur DESC
LIMIT <top_k|20>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| server_process | string | 服务端进程名 |
| aidl_name | string | AIDL 方法名 |
| dur_ms | duration | 客户端阻塞耗时（毫秒） |
| state | string | 阻塞期间的线程状态 |
| blocked_function | string | 内核阻塞函数 |
| ts_str | timestamp | 时间戳（可点击导航） |
| severity | enum | 严重程度（critical >50ms / warning >16ms / normal） |

## 使用说明

> **Schema 兼容性注意**：SQL 中的 `bt.is_main_thread` 在某些 Perfetto stdlib 版本中不存在。如果报错，改为 `JOIN thread t ON bt.client_utid = t.utid WHERE t.is_main_thread = 1` 来判断主线程。

- **前置模块**: `android.startup.startups`, `android.binder`
- 相比 `startup_main_thread_sync_binder_in_range` 的聚合视图，此 Skill 提供逐条明细
- LEFT JOIN thread_state 可看到 Binder 阻塞期间主线程的具体内核状态
- severity 阈值：>50ms 为 critical（超过 3 帧），>16ms 为 warning（超过 1 帧）