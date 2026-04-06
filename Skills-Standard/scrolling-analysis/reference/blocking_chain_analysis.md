<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 阻塞链分析 (blocking_chain_analysis) - Composite Skill v1.0

分析指定时间范围内主线程的阻塞链：谁阻塞了主线程？唤醒者是谁？唤醒者在做什么？

与 `anr_main_thread_blocking` 不同，此 skill 不依赖 ANR 时间戳，可用于任意时间范围的阻塞根因分析。

## 典型使用场景

- 滚动卡顿期间的主线程阻塞根因
- 启动慢时某阶段的阻塞分析
- 任意用户选定时间范围的诊断

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| process_name | string | 是 | - | 目标进程名 |
| start_ts | timestamp | 是 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 是 | - | 分析结束时间戳(ns) |

## 前置条件

- 必需表: `thread_state`, `thread`, `process`

## 步骤编排

### Step 1: thread_state_distribution - 主线程状态分布

统计主线程在指定时间范围内各状态的时间占比:
- Running (运行中)
- R / Runnable (可运行，等待 CPU)
- R+ / Runnable (Preempted)
- S / Sleeping (睡眠/等待锁/Binder)
- D / Uninterruptible Sleep (不可中断睡眠/IO)
- T / Stopped
- X / Dead

每个状态包含: 总时间(ms)、次数、占比(%)、主要阻塞函数（该状态下 SUM(dur) 最大的 blocked_function）。

**自动生成 insights**:
- S > 50%: 主线程可能在等待锁或 Binder
- D > 20%: 可能存在 IO 阻塞
- R > 80%: CPU 争抢或繁忙

### Step 2: waker_chain - 唤醒链分析（可选）

分析谁唤醒了主线程（从 S/D 状态）。按唤醒者线程+进程+阻塞函数分组:
- 唤醒时间(ts)
- 唤醒者线程名/进程名
- 阻塞函数
- 总 Sleep 时长(ms)
- 最大 Sleep 时长(ms)
- 唤醒次数

按 SUM(sleep_dur) 降序排列，最多 15 条。

### Step 3: blocked_function_summary - 阻塞函数汇总（可选）

统计 S/D 状态下各 blocked_function 的总阻塞时间和次数。Top 10 阻塞函数。

常见阻塞函数含义:
- `binder_wait_for_work`: Binder 线程空闲等待
- `futex_wait_queue`: 锁竞争（Java monitor / native mutex）
- `do_epoll_wait`: Looper 消息循环等待
- `SyS_read` / `vfs_read`: 文件 IO
- `pipe_wait`: 管道通信等待

## 使用说明

- 主线程通过 `t.is_main_thread = 1 OR t.tid = p.pid` 识别
- 时间重叠处理: `MIN(ts + dur, end_ts) - MAX(ts, start_ts)` 确保只计算范围内的时间
- 唤醒链分析依赖 `waker_utid`，部分 trace 可能缺少此字段（需 sched_wakeup ftrace 事件）
- 结合 binder_root_cause 使用可进一步定位 Binder 阻塞的服务端原因