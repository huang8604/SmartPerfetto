<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: power
priority: 4
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - power_rails
  - battery_counters
  - cpu_freq_idle
  - gpu_work_period
  - thermal_throttling
  - device_state
keywords:
  - 功耗
  - 耗电
  - 电池
  - 掉电
  - 发热
  - wattson
  - power
  - battery
  - drain
  - energy
  - thermal
compound_patterns:
  - "电池.*掉"
  - "耗电.*原因"
  - "功耗.*分析"
  - "battery.*drain"
  - "power.*analysis"

phase_hints:
  - id: power_data_gate
    keywords: ['power', 'battery', 'wattson', '功耗', '耗电', '电池', '数据', '采集']
    constraints: '先检查 Trace 数据完整度中的 power_rails、battery_counters、cpu_freq_idle、gpu_work_period。缺失时必须输出数据采集建议，禁止把空表解释为“没有功耗问题”。'
    critical_tools: ['lookup_knowledge']
    critical: true
  - id: wattson_attribution
    keywords: ['wattson', 'rail', 'thread', '归因', '能耗', 'energy', 'power_rails']
    constraints: '只有 power_rails/cpu_freq_idle 数据可用时才用 Wattson 归因。优先调用 wattson_rails_power_breakdown，再调用 wattson_thread_power_attribution；启动窗口问题再加 wattson_app_startup_power。'
    critical_tools: ['wattson_rails_power_breakdown', 'wattson_thread_power_attribution', 'wattson_app_startup_power']
    critical: false
  - id: fallback_state_power
    keywords: ['wakelock', 'doze', 'battery', 'dvfs', 'thermal', '唤醒', '待机', '降频']
    constraints: '如果 Wattson 前置数据缺失，退化为状态/事件链分析：battery_charge_timeline、battery_doze_state_timeline、android_kernel_wakelock_summary、android_dvfs_counter_stats、suspend_wakeup_analysis。结论必须标注这是定性分析，不是 rail 级能耗归因。'
    critical_tools: ['battery_charge_timeline', 'battery_doze_state_timeline', 'android_kernel_wakelock_summary', 'android_dvfs_counter_stats', 'suspend_wakeup_analysis']
    critical: false

plan_template:
  mandatory_aspects:
    - id: power_data_availability
      match_keywords: ['power', 'battery', 'wattson', '功耗', '耗电', '电池', '数据完整度', '采集']
      suggestion: '功耗场景必须先确认 power_rails/battery_counters/cpu_freq_idle/gpu_work_period 是否可用'
    - id: power_attribution_or_fallback
      match_keywords: ['wattson', 'rail', 'thread', 'wakelock', 'doze', '归因', '唤醒', '降频']
      suggestion: '功耗场景需要包含 Wattson 归因或状态事件 fallback 分析阶段'
---

#### 功耗 / 电池 / Wattson 分析（用户提到 功耗、耗电、电池、掉电、wattson）

功耗分析的第一原则：**先判数据能不能支撑结论**。Wattson/rail 级归因依赖 `android.power`、power rails、CPU freq/idle、GPU work period 等采集源。缺失这些数据时，不能把空结果解释为“没有耗电”；只能输出采集建议，或退化为状态/事件链分析。

#### 功耗场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`wattson_rails_aggregation`、`wattson_threads_aggregation`、`wattson_window_app_startup`、`android_battery_charge`、`android_deep_idle_state`、`android_kernel_wakelocks`、`android_dvfs_counter_stats`、`android_gpu_work_period_track`、`cpu_idle_counters`

**Phase 0 — 数据完整度门禁：**

先读取系统提示中的 Trace 数据完整度结果：

| capability | 缺失时含义 | 处理 |
|---|---|---|
| `power_rails` | 无 rail 级能耗估算 | 不调用 Wattson rail/thread 能耗结论；输出 `collect_power_rails` 采集建议 |
| `battery_counters` | 无电量/电流采样 | 不计算掉电速率；输出 `battery_poll_ms` 采集建议 |
| `cpu_freq_idle` | 无 CPU idle/freq 完整状态 | 不做 Wattson CPU 能耗归因；可退化为 CPU 频率/DVFS 定性分析 |
| `gpu_work_period` | 无 GPU active region | 不做 GPU work period/能耗归因；可退化为 GPU 频率或 Mali power state 分析 |

如果用户明确问“怎么采集”，优先调用：
```
lookup_knowledge("data-sources")
```

**Phase 1 — Wattson rail/thread 归因（数据可用时）：**

```
invoke_skill("wattson_rails_power_breakdown")
invoke_skill("wattson_thread_power_attribution", { process_name: "<包名>" })
```

分析顺序：
1. 看 rail 总能耗排序：CPU/GPU/DDR/Modem 哪个是主耗能源
2. 看线程级归因：是否是目标 App 线程、system_server、RenderThread、Binder 线程池或后台进程消耗
3. 如果能耗集中在某一时间窗口，结合 `cpu_thread_utilization_period` / `cpu_process_utilization_period` 做 CPU 利用率交叉验证

**Phase 2 — 启动期功耗（用户提到启动耗电时）：**

```
invoke_skill("wattson_app_startup_power", { package: "<包名>" })
invoke_skill("app_process_starts_summary")
```

把启动窗口能耗与启动类型、进程创建、CPU/DVFS 状态关联。不能只给总能耗，必须说明能耗集中在哪个阶段或线程。

**Phase 3 — 电池/Doze/Wakelock fallback（Wattson 数据缺失或用户问待机耗电时）：**

```
invoke_skill("battery_charge_timeline")
invoke_skill("battery_doze_state_timeline")
invoke_skill("android_kernel_wakelock_summary")
invoke_skill("suspend_wakeup_analysis")
```

输出要明确标注：这是状态/事件链证据，能说明“是否频繁唤醒、是否无法进入 Doze、是否有 wakelock”，但不是 rail 级功耗量化。

**Phase 4 — GPU/温控/频率交叉验证（按需）：**

| 信号 | 调用 |
|---|---|
| GPU work period 可用 | `invoke_skill("android_gpu_work_period_track")` |
| Mali power state 可用 | `invoke_skill("mali_gpu_power_state")` |
| DVFS 频率异常 | `invoke_skill("android_dvfs_counter_stats")` |
| 热降频/发热 | `invoke_skill("thermal_throttling")` |
| CPU idle residency | `invoke_skill("cpu_idle_state_residency")` |

**输出结构：**

1. **数据完整度判定**：power_rails / battery_counters / cpu_freq_idle / gpu_work_period 哪些可用，哪些缺失
2. **主耗能源或 fallback 事件链**：rail/thread 归因，或 wakelock/doze/battery 状态链
3. **时间窗口关联**：耗电/唤醒/降频发生在什么阶段，是否与启动、滑动、后台任务重叠
4. **结论可信度**：量化归因 / 定性事件链 / 数据不足三选一
5. **采集建议**：缺哪些数据就给具体 Perfetto 配置方向，不泛泛而谈
