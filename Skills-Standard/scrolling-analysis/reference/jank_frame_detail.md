<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 掉帧详情分析 (jank_frame_detail)

分析特定掉帧帧的详细原因，包括四象限分析（大核运行/小核运行/等待调度/IO阻塞/休眠等待）、Binder 调用、CPU 频率、主线程耗时操作、RenderThread 操作、锁竞争、GC 影响等。

**类型**: composite  
**路径**: `backend/skills/composite/jank_frame_detail.skill.yaml`

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 否 | - | 帧开始时间戳(ns)，优先使用 |
| end_ts | timestamp | 否 | - | 帧结束时间戳(ns) |
| frame_ts | timestamp | 否 | - | 兼容旧接口，等同于 start_ts |
| frame_dur | duration | 否 | - | 兼容旧接口，用于计算 end_ts |
| main_start_ts | timestamp | 否 | - | 主线程开始时间戳 |
| main_end_ts | timestamp | 否 | - | 主线程结束时间戳 |
| render_start_ts | timestamp | 否 | - | RenderThread 开始时间戳 |
| render_end_ts | timestamp | 否 | - | RenderThread 结束时间戳 |
| package | string | 否 | - | 应用包名 |
| pid | integer | 否 | - | 进程 ID |
| frame_id | integer | 否 | - | 帧 ID |
| jank_type | string | 否 | - | 掉帧类型 |
| dur_ms | number | 否 | - | 帧耗时(ms) |
| session_id | integer | 否 | - | 滑动区间 ID |
| layer_name | string | 否 | - | Layer 名称 |
| token_gap | integer | 否 | - | display_frame_token 跳跃值 |
| vsync_missed | integer | 否 | - | 跳过的 VSync 数量 |
| jank_responsibility | string | 否 | - | 掉帧责任归属 |
| jank_cause | string | 否 | - | 掉帧原因说明 |

## 步骤编排

### 数据源检测 (前置)

1. **init_cpu_topology** - 初始化共享 CPU 拓扑视图 (_cpu_topology VIEW)
2. **monitor_contention_check** - Monitor Contention 表可用性
3. **gc_table_check** - GC 表可用性
4. **gpu_table_check** - GPU 数据可用性
5. **binder_table_check** - Binder 详细数据可用性

### 核心分析步骤

6. **quadrant_analysis** - 四象限分析
   - Q1_大核运行：Running on prime/big cores
   - Q2_小核运行：Running on medium/little cores
   - Q3_等待调度：Runnable state
   - Q4a_IO阻塞：D/DK state
   - Q4b_休眠等待：S/I state

7. **binder_calls** - Binder 调用分析（按服务端进程汇总）

8. **cpu_freq_analysis** - CPU 频率分析（按核心类型汇总）

9. **main_thread_slices** - 主线程耗时操作 Top 10

10. **render_thread_slices** - RenderThread 耗时操作 Top 10

11. **cpu_freq_timeline** - CPU 频率变化时间线

12. **lock_contention** - 锁竞争分析（依赖 android_monitor_contention 表）

13. **gc_in_frame** - GC 与帧重叠分析

14. **io_blocking** - IO 阻塞分析（D/DK 状态）

## 使用说明

- 前置模块：android.binder, android.slices, android.monitor_contention, android.garbage_collection, android.gpu.frequency
- 由 `scroll_session_analysis` 的 iterator 步骤调用，对每个严重掉帧进行逐帧深度分析
- 也可独立调用，需提供精确的帧起止时间戳
- 使用共享 `_cpu_topology` VIEW 避免重复计算
- 各分析步骤均设为 `optional: true`，数据不可用时优雅降级