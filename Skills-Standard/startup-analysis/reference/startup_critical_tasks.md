<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动关键任务发现 (startup_critical_tasks)

自动识别启动区间内所有活跃线程，按 CPU 时间排序，为每个线程提供四象限分析 + 摆核 + 核迁移统计。打破"主线程隧道视野"：不预定义哪些线程是关键的，而是从数据出发，自动发现启动区间内 CPU 占用最高的 Top N 线程。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名（支持 GLOB 前缀匹配） |
| start_ts | timestamp | 是 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动区间结束时间戳(ns) |
| top_k | number | 否 | 15 | 返回 Top K 个线程 |

## SQL 查询

```sql
-- Step 1: 识别目标进程的所有线程并自动分配角色
-- 线程角色自动识别（GLOB 匹配）：
--   main — 主线程（tid = pid）
--   render — RenderThread（首帧渲染 GPU 指令提交）
--   gc — HeapTaskDaemon / FinalizerDaemon（GC 相关）
--   jit — Jit thread pool（JIT 编译）
--   binder — Binder:PID_N（IPC 线程池）
--   worker — AsyncTask / Coroutine / ThreadPool
--   flutter_ui / flutter_raster — Flutter 线程
--   webview — CrRendererMain（WebView 渲染）
--   system — Signal Catcher
--   other — 其他
WITH process_threads AS (
  SELECT t.utid, t.tid, t.name as thread_name, p.pid,
    CASE
      WHEN t.tid = p.pid THEN 'main'
      WHEN t.name = 'RenderThread' THEN 'render'
      WHEN t.name GLOB '*HeapTaskDaemon*' THEN 'gc'
      -- ... 完整角色映射
      ELSE 'other'
    END as role
  FROM thread t JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
),
-- Step 2: 计算每个线程的四象限分布
-- Q1: 大核运行（prime/big/medium）
-- Q2: 小核运行（little）
-- Q3: Runnable 等待（R/R+）
-- Q4a: IO 阻塞（D/DK）
-- Q4b: 睡眠等待（S/I）
thread_quadrants AS (
  -- 从 thread_state + _cpu_topology 聚合
  -- HAVING total_cpu_ms > 0.5 过滤噪声线程
),
-- Step 3: 计算核迁移
-- 使用 sched_slice + LAG() 窗口函数检测 CPU 变化和跨 cluster 迁移
thread_migrations AS (...)
-- Final: 合并四象限 + 摆核数据
SELECT thread_name, tid, role, total_cpu_ms,
  q1_big_running_ms, q2_little_running_ms, q3_runnable_ms,
  q4a_io_blocked_ms, q4b_sleeping_ms, total_ms,
  running_pct, big_core_pct, migrations, cross_cluster_migrations
FROM thread_quadrants tq
LEFT JOIN thread_migrations tm ON tq.utid = tm.utid
ORDER BY CASE role WHEN 'main' THEN 0 ELSE 1 END, total_cpu_ms DESC
LIMIT <top_k|15>
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| thread_name | string | 线程名 |
| tid | number | 线程 ID |
| role | string | 自动识别的线程角色（main/render/gc/jit/binder/worker/flutter_ui/flutter_raster/webview/system/other） |
| total_cpu_ms | duration | CPU 时间（Running 状态总和，ms） |
| q1_big_running_ms | duration | Q1 大核运行时间（ms） |
| q2_little_running_ms | duration | Q2 小核运行时间（ms） |
| q3_runnable_ms | duration | Q3 等待调度时间（Runnable，ms） |
| q4a_io_blocked_ms | duration | Q4a IO 阻塞时间（D/DK 状态，ms） |
| q4b_sleeping_ms | duration | Q4b 睡眠等待时间（S/I 状态，ms） |
| total_ms | duration | 总状态时间（各象限之和，ms） |
| running_pct | percentage | 运行占比（Running / total） |
| big_core_pct | percentage | 大核占比（Q1 / CPU 时间） |
| migrations | number | 核迁移次数（CPU 变化） |
| cross_cluster_migrations | number | 跨 cluster 迁移次数（大核↔小核切换） |

## 使用说明

- **前置模块**: `sched`, `linux.cpu.frequency`
- 使用 `_cpu_topology` 视图判断核类型，medium 核归入性能核侧
- 角色自动识别基于 GLOB 匹配，覆盖 Android/Flutter/WebView 线程
- 主线程（tid = pid）始终排在最前，其余按 CPU 时间降序
- 核迁移使用 `LAG()` 窗口函数在 sched_slice 上计算，可检测频繁跨 cluster 迁移导致的 L2 Cache 失效
- 在 `startup_detail` 组合 Skill 中作为关键任务发现步骤使用