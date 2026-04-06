<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动详情分析 (startup_detail) — 组合 Skill

深入分析单个启动过程的性能瓶颈。由 startup_analysis 的 iterator 步骤逐个调用，包含大小核分析、频率分析、四象限分析、摆核时序、主线程 Slice、文件 IO、Binder、调度延迟、状态分布、关键任务发现、线程阻塞关系图、JIT 分析、热点 Slice 状态分布和诊断规则。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| startup_id | integer | 是 | - | 启动事件 ID |
| start_ts | timestamp | 是 | - | 启动开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动结束时间戳(ns) |
| dur_ms | number | 是 | - | 启动耗时(ms) |
| package | string | 是 | - | 应用包名 |
| startup_type | string | 是 | - | 启动类型（cold/warm/hot，已经过校验） |
| original_type | string | 否 | - | Perfetto 原始启动类型（校验前） |
| ttid_ms | number | 否 | - | TTID(ms) |
| ttfd_ms | number | 否 | - | TTFD(ms) |
| perfetto_start | timestamp | 否 | - | Perfetto 跳转开始时间 |
| perfetto_end | timestamp | 否 | - | Perfetto 跳转结束时间 |

## 步骤编排

```
init_cpu_topology (CPU 拓扑初始化, optional)
    │
    ▼
startup_info (启动基本信息 + 评级)
    │
    ▼
┌──────────────────────────────────────────────────┐
│ 并行分析步骤                                      │
├──────────────────────────────────────────────────┤
│ cpu_core_analysis      → 大小核占比               │
│ cpu_freq_analysis      → CPU 频率分析             │
│ freq_rampup            → CPU 频率爬升分析          │
│ quadrant_analysis      → 四大象限分析              │
│ cpu_placement_timeline → 主线程摆核时序            │
│ main_thread_slices     → 主线程耗时操作 Top10      │
│ actionable_main_thread_slices → 可操作热点 Top5    │
│ main_thread_file_io    → 主线程文件 IO Top10       │
│ binder_analysis        → Binder 调用分析          │
│ main_thread_sync_binder → 主线程同步 Binder        │
│ binder_pool            → Binder 线程池分析         │
│ sched_latency          → 调度延迟分析             │
│ main_thread_state      → 主线程状态分布            │
│ critical_tasks         → 关键任务发现（全线程四象限）│
│ thread_blocking_graph  → 线程阻塞关系图            │
│ jit_analysis           → JIT 影响分析（仅冷启动）   │
│ hot_slice_states       → 热点 Slice 线程状态分布   │
└──────────────────────────────────────────────────┘
    │
    ▼
startup_diagnosis (诊断规则引擎)
```

### 步骤详情

| Step ID | 类型 | 调用 Skill | 用途 |
|---------|------|-----------|------|
| init_cpu_topology | skill | cpu_topology_view | 初始化 CPU 拓扑视图 |
| startup_info | atomic | (内联 SQL) | 启动基本信息 + 评级 |
| cpu_core_analysis | atomic | (内联 SQL) | 主线程大小核占比 |
| cpu_freq_analysis | atomic | (内联 SQL) | CPU 频率统计 |
| freq_rampup | skill | startup_freq_rampup | CPU 频率爬升检测 |
| quadrant_analysis | atomic | (内联 SQL) | 四大象限分析（Q1大核/Q2小核/Q3等待调度/Q4a IO/Q4b睡眠） |
| cpu_placement_timeline | skill | startup_cpu_placement_timeline | 主线程摆核时序（50ms 桶） |
| main_thread_slices | skill | main_thread_slices_in_range | 主线程耗时操作 |
| actionable_main_thread_slices | atomic | (内联 SQL) | 可操作热点（剔除框架包裹，含 exclusive time） |
| main_thread_file_io | skill | main_thread_file_io_in_range | 主线程文件 IO |
| binder_analysis | skill | binder_in_range | Binder 调用 |
| main_thread_sync_binder | skill | binder_blocking_in_range | 主线程同步 Binder 阻塞 |
| binder_pool | skill | startup_binder_pool_analysis | Binder 线程池利用率 |
| sched_latency | skill | main_thread_sched_latency_in_range | 调度延迟 |
| main_thread_state | skill | startup_main_thread_states_in_range | 主线程状态分布 |
| critical_tasks | skill | startup_critical_tasks | 全线程四象限 + 核迁移 |
| thread_blocking_graph | skill | startup_thread_blocking_graph | 线程 block/wakeup 关系图 |
| jit_analysis | skill | startup_jit_analysis | JIT 编译影响（仅 cold） |
| hot_slice_states | skill | startup_hot_slice_states | 热点 Slice 线程状态分布 |
| startup_diagnosis | diagnostic | - | 诊断规则引擎 |

### 评级标准

| 启动类型 | 优秀 | 良好 | 需优化 | 严重 |
|---------|------|------|--------|------|
| cold | <500ms | <1000ms | <2000ms | >2000ms |
| warm | <200ms | <500ms | <1000ms | >1000ms |
| hot | <100ms | <200ms | <500ms | >500ms |

### 诊断规则（关键规则摘要）

| 条件 | 严重度 | 诊断 |
|------|--------|------|
| 大核占比 < 20% + Runnable > 50ms | warning | 调度供给不足 |
| Runnable > 50ms + >8ms 延迟 > 3次 | warning | 调度延迟 |
| Q4a IO > 15% + 文件 IO/D 状态证据 | warning | IO 阻塞瓶颈 |
| Q4b 睡眠 > 30% + Binder 阻塞证据 | warning | 锁/Binder 等待 |
| JIT 线程 CPU > 20ms + 大核占比 > 50% | warning | JIT 与主线程争抢大核 |
| RenderThread 大核占比 < 30% | info | 首帧渲染可能因小核不足变慢 |
| 主线程跨 cluster 迁移 > 10 次 | warning | L2 Cache 反复失效 |
| 主线程被 system_server 阻塞 > 30ms | warning | system_server 处理延迟 |
| 主线程被 GC 阻塞 > 10ms | warning | GC 阻塞 |
| 启动初期大核频率爬升 > 50% | warning | 升频延迟 |

## 使用说明

- **前置模块**: `android.startup.startups`, `android.binder`, `sched`, `linux.cpu.frequency`
- 大小核判定优先使用 `_cpu_topology` 视图（基于频率排名），fallback 到 capacity，最后才用 CPU 编号
- actionable_main_thread_slices 通过 parent_id 计算 exclusive time，剔除框架包裹切片（如 clientTransactionExecuted、activityStart）
- JIT 分析仅在冷启动时执行（`condition: startup_type = 'cold'`）
- 诊断规则全部采用双证据模式：主指标 + 佐证指标同时满足才触发