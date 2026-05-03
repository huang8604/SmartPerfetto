<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: game
priority: 4
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - gpu
  - thermal_throttling
  - surfaceflinger
  - gpu_work_period
  - power_rails
  - cpu_freq_idle
keywords:
  - 游戏
  - game
  - 帧率
  - 游戏卡顿
  - 游戏掉帧
  - unity
  - unreal
  - 游戏性能
  - game fps
  - game performance
  - godot
  - cocos
compound_patterns:
  - "游戏.*卡"
  - "游戏.*帧"
  - "game.*jank"
  - "game.*fps"

plan_template:
  mandatory_aspects:
    - id: fps_and_gpu
      match_keywords: ['game', 'fps', '游戏', 'gpu', 'frame', '帧率']
      suggestion: '游戏场景建议包含帧率分析和 GPU 状态检查阶段'
---

#### 游戏性能分析（用户提到 游戏、game、帧率、游戏卡顿）

游戏渲染管线与标准 Android View 不同：没有 FrameTimeline，不使用 Choreographer/RenderThread 流程。
需要使用 `game_fps_analysis`（非 `scrolling_analysis`）作为入口。

#### 游戏场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_gpu_frequency`、`cpu_utilization_per_second`、`cpu_frequency_counters`、`android_dvfs_counters`、`android_screen_state`

**Phase 1 — 游戏帧率分析（1 次调用）：**
```
invoke_skill("game_fps_analysis", { process_name: "<游戏进程名>" })
```
返回：帧率统计、帧间隔分布、卡顿帧列表。

**Phase 2 — GPU 深度分析（推荐）：**

游戏通常是 GPU-bound。调用 GPU 相关分析：
```
invoke_skill("gpu_analysis")
```
检查 GPU 频率/利用率、Fence 等待时间。

如果 Trace 数据完整度显示 `gpu_work_period` 可用，再补充：
```
invoke_skill("android_gpu_work_period_track")
invoke_skill("mali_gpu_power_state")
```
用于判断 GPU active region 是否连续、Mali power state 是否异常。无 `gpu_work_period` 时只能做 GPU 频率/帧间隔定性分析。

**Phase 3 — 系统级交叉分析：**

| 信号 | 检查工具 | 说明 |
|------|---------|------|
| CPU 频率下降 | `invoke_skill("thermal_throttling")` | 游戏长时间运行容易触发热节流 |
| 内存压力 | `invoke_skill("memory_analysis")` | 游戏内存占用大，可能触发 LMK |
| CPU 调度 | `invoke_skill("cpu_analysis")` | 游戏线程调度到小核会造成帧率波动 |
| 线程/进程 CPU 利用率 | `invoke_skill("cpu_thread_utilization_period")` / `invoke_skill("cpu_process_utilization_period")` | 判断 UnityMain/GameThread/RenderThread 是否 CPU-bound |
| 功耗归因 | `invoke_skill("wattson_thread_power_attribution")` | 仅在 power_rails + cpu_freq_idle 可用时做线程能耗归因 |

**Phase 4 — 引擎特定分析：**

| 引擎 | 关键线程 | 关键 Slice |
|------|---------|-----------|
| Unity | UnityMain, UnityGfx | `PlayerLoop`, `Gfx.WaitForPresent`, `Camera.Render` |
| Unreal | GameThread, RHIThread, RenderThread | `FrameGameThread`, `RHIThread`, `RenderingThread` |
| Godot | GodotMain | `Main::iteration`, `physics_process` |

**输出结构：**

1. **帧率概览**：平均/P50/P90/P99 帧间隔、稳定性评级
2. **卡顿帧分析**：卡顿帧时间分布、帧间隔直方图
3. **GPU 状态**：频率、利用率、Fence 等待
4. **热节流影响**：CPU/GPU 频率是否被限制
5. **优化建议**：按 GPU-bound / CPU-bound / Thermal 分类
