<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 阻塞链分析 (blocking_chain_analysis) — 组合 Skill

分析指定时间范围内主线程的阻塞链：线程状态分布、唤醒链、阻塞函数分布。与 anr_main_thread_blocking 不同，此技能不依赖 ANR 时间戳，可用于任意时间范围的阻塞根因分析。典型使用场景：滚动卡顿、启动慢某阶段、任意用户选定时间范围的诊断。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 是 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 分析结束时间戳(ns) |

## 步骤编排

```
thread_state_distribution (主线程状态分布)
    │
    ▼
waker_chain (唤醒链分析)
    │
    ▼
blocked_function_summary (阻塞函数汇总)
```

### Step 1: thread_state_distribution — 主线程状态分布

查询主线程在指定时间范围内各状态（Running/R/S/D/T/X）的时间分布和占比，并找到每个状态下最常见的 blocked_function。

| 输出列 | 类型 | 说明 |
|--------|------|------|
| state | string | 线程状态 |
| state_display | string | 状态中文说明 |
| total_dur_ms | duration | 总时间(ms) |
| count | number | 次数 |
| pct | percentage | 占比(%) |
| blocked_function | string | 主要阻塞函数 |

**自动洞察**：
- S 状态 > 50% → "主线程可能在等待锁或 Binder"
- D 状态 > 20% → "可能存在 IO 阻塞"
- R 状态 > 80% → "CPU 争抢或繁忙"

### Step 2: waker_chain — 唤醒链分析

查询"谁唤醒了主线程"：按唤醒者线程 x 唤醒者进程 x 阻塞函数分组聚合。

| 输出列 | 类型 | 说明 |
|--------|------|------|
| ts | timestamp | 首次唤醒时间 |
| waker_thread_name | string | 唤醒者线程名 |
| waker_process_name | string | 唤醒者进程名 |
| blocked_function | string | 阻塞函数 |
| total_sleep_dur_ms | duration | 总 Sleep 时长(ms) |
| max_sleep_dur_ms | duration | 最大 Sleep 时长(ms) |
| wakeup_count | number | 唤醒次数 |

### Step 3: blocked_function_summary — 阻塞函数汇总

统计主线程所有 S/D 状态下的阻塞函数分布 Top 10。

| 输出列 | 类型 | 说明 |
|--------|------|------|
| blocked_function | string | 阻塞函数名 |
| total_dur_ms | duration | 总阻塞时间(ms) |
| count | number | 次数 |
| pct | percentage | 占比(%) |

## 使用说明

- **前置表**: `thread_state`, `thread`, `process`
- 主线程定位使用 `is_main_thread = 1 OR tid = pid`
- 唤醒链通过 `thread_state.waker_utid` 关联，需要 trace 包含 waker 信息
- 阻塞函数汇总中 `binder_wait_for_work` 表示 Binder 等待、`futex_wait_queue` 表示锁竞争
- 在启动分析中用于定位特定阶段的阻塞根因