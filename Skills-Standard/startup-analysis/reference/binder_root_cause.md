<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Binder 根因归因 (binder_root_cause) — 组合 Skill

使用 Perfetto stdlib 的 `android_binder_client_server_breakdown` 表对慢 Binder 事务进行服务端/客户端阻塞原因归因。Breakdown 原因类型包括：GC、lock_contention、binder（嵌套）、monitor_contention、IO、CPU scheduling 等系统级根因分类。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 是 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 分析结束时间戳(ns) |
| min_dur_ms | number | 否 | 1 | 最小 Binder 事务时长阈值(ms) |

## 步骤编排

```
slow_binder_breakdown (慢 Binder 事务阻塞归因明细)
    │
    ▼
blame_summary (阻塞原因汇总)
```

### Step 1: slow_binder_breakdown — 慢 Binder 事务阻塞归因

从 `android_binder_txns` 中找到同步慢事务（Top 20），JOIN `android_binder_client_server_breakdown` 获取每个事务的阻塞原因明细。

| 输出列 | 类型 | 说明 |
|--------|------|------|
| interface | string | AIDL 接口名 |
| server_process | string | 服务端进程名 |
| client_dur_ms | duration | 客户端耗时(ms) |
| server_dur_ms | duration | 服务端耗时(ms) |
| reason | string | 阻塞原因描述 |
| reason_type | string | 原因类型（gc/lock_contention/io/memory_reclaim 等） |
| reason_dur_ms | duration | 原因耗时(ms) |
| reason_pct | percentage | 原因占事务总时间的百分比 |

### Step 2: blame_summary — 阻塞原因汇总

按 reason + reason_type 聚合所有慢事务的阻塞原因，统计影响的事务数和总耗时。

| 输出列 | 类型 | 说明 |
|--------|------|------|
| reason | string | 阻塞原因 |
| reason_type | string | 原因类型 |
| txn_count | number | 受影响事务数 |
| total_dur_ms | duration | 总耗时(ms) |

**自动洞察**：
- `reason_type = 'gc'` 且 total_dur_ms > 5 → "GC 导致 Binder 阻塞"
- `reason_type = 'lock_contention'` 且 total_dur_ms > 5 → "锁竞争导致 Binder 阻塞"

## 使用说明

- **前置模块**: `android.binder_breakdown`
- 使用 `android_binder_txns` 获取同步事务（`is_sync = 1`）
- 使用 `android_binder_client_server_breakdown` 获取服务端阻塞归因
- reason_type 常见值：gc、lock_contention、monitor_contention、io、memory_reclaim、art_lock_contention
- 在启动分析中配合 `startup_binder_in_range` 使用，先找到慢 Binder，再用本 Skill 归因