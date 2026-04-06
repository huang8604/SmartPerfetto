<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Binder 根因归因 (binder_root_cause) - Composite Skill v1.0

分析慢 Binder 事务的服务端/客户端阻塞原因（GC/锁/IO/内存回收）。使用 Perfetto stdlib 的 `android_binder_client_server_breakdown` 表对慢 Binder 事务进行服务端/客户端阻塞原因归因。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 是 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 分析结束时间戳(ns) |
| min_dur_ms | number | 否 | 1 | 最小 Binder 事务时长阈值(ms) |

## 前置条件

- 必需模块: `android.binder_breakdown`

## Breakdown 原因类型

`android_binder_client_server_breakdown` 表提供的原因类型:
- **GC**: 垃圾回收导致服务端暂停
- **lock_contention**: 锁竞争
- **binder**: 嵌套 Binder 调用（服务端处理中又发起 Binder）
- **monitor_contention**: Java monitor 等待
- **IO**: 磁盘 IO
- **CPU scheduling**: 调度延迟
- 其他系统级根因分类

## 步骤编排

### Step 1: slow_binder_breakdown - 慢 Binder 事务阻塞归因（可选）

获取 Top 20 慢 Binder 事务（按 client_dur 降序），每个事务关联其 breakdown 原因:
- interface: AIDL 接口名
- server_process: 服务端进程
- client_dur_ms: 客户端侧总耗时
- server_dur_ms: 服务端侧执行耗时
- reason: 阻塞原因文本
- reason_type: 原因类型分类
- reason_dur_ms: 该原因的耗时
- reason_pct: 该原因占客户端耗时的百分比

### Step 2: blame_summary - 阻塞原因汇总（可选）

按 reason/reason_type 聚合所有慢 Binder 事务的阻塞时间:
- reason: 阻塞原因
- reason_type: 原因类型
- txn_count: 受影响事务数
- total_dur_ms: 总阻塞时间(ms)

按 total_dur_ms 降序排列。

**自动生成 insights**:
- GC 导致阻塞 > 5ms: "GC 导致 Binder 阻塞 Xms，影响 N 个事务"
- 锁竞争导致阻塞 > 5ms: "锁竞争导致 Binder 阻塞 Xms，需检查同步代码"

## SQL 查询（Step 1 核心查询）

```sql
WITH slow_txns AS (
  SELECT binder_txn_id, binder_reply_id, client_ts, client_dur, server_dur,
         aidl_name, client_process, server_process
  FROM android_binder_txns
  WHERE is_sync = 1
    AND (client_process GLOB '<process_name>*' OR '<process_name>' = '')
    AND client_dur > <min_dur_ms|1> * 1000000
    AND (<start_ts> IS NULL OR client_ts >= <start_ts>)
    AND (<end_ts> IS NULL OR client_ts < <end_ts>)
  ORDER BY client_dur DESC
  LIMIT 20
)
SELECT
  COALESCE(st.aidl_name, 'unknown') as interface,
  st.server_process,
  ROUND(st.client_dur / 1e6, 2) as client_dur_ms,
  ROUND(st.server_dur / 1e6, 2) as server_dur_ms,
  bd.reason,
  bd.reason_type,
  ROUND(SUM(bd.dur) / 1e6, 2) as reason_dur_ms,
  ROUND(100.0 * SUM(bd.dur) / st.client_dur, 1) as reason_pct
FROM slow_txns st
JOIN android_binder_client_server_breakdown bd
  ON st.binder_txn_id = bd.binder_txn_id
  AND st.binder_reply_id = bd.binder_reply_id
GROUP BY st.binder_txn_id, bd.reason, bd.reason_type
ORDER BY st.client_dur DESC, reason_dur_ms DESC
```

## 使用说明

- 仅分析同步 Binder 事务（is_sync = 1），异步事务不阻塞客户端
- min_dur_ms 默认 1ms，可调高以减少噪声
- 结合 blocking_chain_analysis 使用: 先定位主线程阻塞在 Binder，再用本 skill 深入服务端原因
- 常见高耗时接口: AMS (startActivity), PMS (getPackageInfo), WMS (relayoutWindow)