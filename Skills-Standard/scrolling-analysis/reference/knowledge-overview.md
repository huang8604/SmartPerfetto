<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 滑动分析知识参考

本文档为滑动/卡顿性能分析提供系统性知识参考，涵盖渲染管线机制、卡顿根因分类、以及相关子系统（Binder、GC、CPU 调度、温控、锁竞争）对帧渲染的影响。

---

## 1. 渲染管线机制

### 管线流程

每一帧经过多阶段管线，由 VSync 信号驱动：

1. **VSync-app** 触发，唤醒 App 进程
2. **Choreographer#doFrame** 在主线程执行：输入处理、动画、measure、layout、draw（记录 display list）
3. **syncFrameState** 将 display list 传递给 RenderThread
4. **RenderThread DrawFrame**：从 BufferQueue dequeueBuffer，发出 GPU 命令（OpenGL/Vulkan），queueBuffer 回 BufferQueue
5. **SurfaceFlinger** 在 VSync-sf 时接收 buffer，通过 HWC 合成所有可见 Layer
6. **HWC**（Hardware Composer）将最终帧发送到显示器

帧预算为一个 VSync 周期：60Hz = 16.67ms，90Hz = 11.11ms，120Hz = 8.33ms。任何阶段超出其份额都会将帧推迟到 deadline 之后。

### 为什么卡顿延迟 2-3 帧出现

Android 使用三缓冲（triple-buffering）。当一帧渲染时间过长，其 buffer 迟到达 SurfaceFlinger。SF 没有新 buffer 可显示，因此重复显示旧 buffer，造成可见卡顿。由于管线深度，可见卡顿出现在实际慢帧之后 2-3 个 VSync 周期。这称为 **buffer stuffing** — 管线积压，用户在下游看到效果。

### 关键 Trace 标记

| Slice / Counter | 位置 | 含义 |
|----------------|------|------|
| `Choreographer#doFrame` | 主线程 | App 侧帧工作（UI 线程部分） |
| `DrawFrame` | RenderThread | GPU 命令录制 + buffer 提交 |
| `dequeueBuffer` | RenderThread | 等待 BufferQueue 中的空闲 buffer |
| `queueBuffer` | RenderThread | 向 SurfaceFlinger 提交完成的 buffer |
| `onMessageInvalidate` | SurfaceFlinger | SF 侧合成触发 |
| `HW_VSYNC` counter | Display | 硬件 VSync 脉冲 |

### 诊断方法

- 比较 `Choreographer#doFrame` 时长与 VSync 周期。如果超预算，瓶颈在主线程（measure/layout/draw）。
- 如果主线程快但 `DrawFrame` 慢，瓶颈在 GPU 侧（复杂 shader、过度绘制、大纹理）。
- 长 `dequeueBuffer` 意味着所有 buffer 都在使用中 — 管线积压，通常来自之前的慢帧。
- 检查 `FrameMissed` 或 `StalledByBackpressure` 计数器确认掉帧。

### 典型优化方向

- 减少 View 层级深度（减少 measure/layout 遍历）
- 将重活从主线程移走（使用协程、HandlerThread）
- 减少 GPU 过度绘制（扁平化布局，避免不必要的背景）
- 使用 RenderThread 提示：避免 `canvas.saveLayer()`，最小化路径裁剪
- 对复杂静态 View 启用硬件 Layer

---

## 2. 卡顿根因分类（21 reason codes）

### 分类优先级顺序

reason_code 采用 **优先级驱动的 CASE 树**，按从高到低的优先级依次匹配，第一个满足条件的规则胜出。共 21 个 reason_code，分为管线短路、直接阻塞、CPU/调度、GPU、频率/温控、四象限/IO、兜底分类七大类。

#### P0 — 管线短路（非 App 问题，跳过线程分析）

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P0 | `buffer_stuffing` | `jank_responsibility = 'BUFFER_STUFFING'` | Buffer Stuffing 管线背压。App 未错过 deadline，但 BufferQueue 积压导致 dequeueBuffer 背压。主线程 S 状态来自 syncFrameState 等待，非锁/Binder 问题 |
| P0.5 | `sf_composition_slow` | `jank_responsibility = 'SF'` | SurfaceFlinger 合成超时。Perfetto FrameTimeline 判定 SF 为掉帧责任方，跳过 App 侧分析 |

#### P1 — 直接阻塞（Binder / GC）

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P1 | `binder_sync_blocking` | `top_slice_ms > slice_critical_ms AND binder_overlap_ms >= binder_overlap_critical_ms` | 同步 Binder 阻塞。关键 slice 内有大量同步 Binder 重叠 |
| P1.5 | `gc_jank` | `gc_overlap_ms > 1.0` | GC 暂停。帧窗口内 GC 重叠 > 1ms |
| P1.6 | `gc_pressure_cascade` | `gc_count >= 3 AND gc_overlap_ms > 0.5` | GC 压力级联。帧窗口内多次 GC（>=3 次），即使单次重叠 <1ms，密集 GC 累积也显著影响帧耗时 |

#### P2-P3 — CPU 核心调度与 Slice 内延迟

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P2 | `small_core_placement` | `top_slice_ms > slice_critical_ms AND little_run_pct >= 45` | 小核调度。关键 slice 多数时间在小核（little core）执行 |
| P3 | `sched_delay_in_slice` | `top_slice_ms > slice_critical_ms AND runnable_pct >= 15` | 调度延迟。关键 slice 中 Runnable 等待占比高 |

#### P3.5-P3.7 — GPU 与 RenderThread

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P3.5 | `shader_compile` | `shader_count > 0 AND total_shader_dur_ns > vsync_period_ns * 0.3` | Shader 编译。RenderThread 有 shader compile 且耗时 > 30% 帧预算 |
| P3.6 | `gpu_fence_wait` | `max_fence_dur_ns > vsync_period_ns * 0.5` | GPU Fence 等待。RenderThread 长时间等待 GPU fence > 50% 帧预算 |
| P3.7 | `render_thread_heavy` | `(render_q1_pct + render_q2_pct) > 70 AND render_q4b_pct < 20` | RenderThread 负载过重。RT 主动运行占比高（>70%），非 GPU/Shader 等待（此处 Shader/GPU fence 已排除） |

#### P4-P6 — 频率 / 温控 / 工作负载

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P4 | `workload_heavy` | `top_slice_ms > frame_budget_ms * 2.0` | 重度业务负载。关键操作 > 2x 帧预算，即使满频也会超时 |
| P4.5 | `thermal_throttling` | `big_max_freq_mhz < device_peak_freq_mhz * 0.60 AND top_slice_ms > slice_critical_ms` | 温控降频。帧内大核最高频率显著低于设备峰值（<60%）。放在 workload_heavy 之后：如果帧有明确 App 侧直接原因，优先归因到直接原因；温控是供给侧约束，仅在无更强直接原因时作为主因 |
| P4.6 | `cpu_max_limited` | `big_max_freq_mhz < device_peak_freq_mhz * 0.75 AND top_slice_ms > slice_critical_ms` | CPU 最大频率被限。中等程度限频（60%-75%） |
| P5 | `big_core_low_freq` | `top_slice_ms > slice_critical_ms AND big_run_pct >= 40 AND big_avg_freq_mhz < big_max_freq_mhz * 0.55` | 大核低频。边际情况：slice 在 1x-2x 帧预算区间 |
| P6 | `freq_ramp_slow` | `top_slice_ms > slice_critical_ms AND ramp_to_high_ms > freq_ramp_critical_ms AND top_slice_offset_ms <= ramp_to_high_ms` | 频率爬升慢。边际情况：slice 在 1x-2x 帧预算区间 |

#### P7-P9.5 — 四象限 / IO / Binder 信号（不依赖 top_slice_ms 阈值）

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P7 | `cpu_saturation` | `main_q3_pct > 15 AND render_q3_pct > 15` | CPU 全核饱和。主线程和 RenderThread 同时调度等待高 |
| P7.5 | `scheduling_delay` | `main_q3_pct > 20` | 调度延迟。仅主线程 Runnable 高 |
| P8 | `main_thread_file_io` | `file_io_overlap_ms > 1.0` | 主线程文件 IO。SharedPreferences/SQLite/fsync 等具体 IO slice |
| P8.5 | `blocking_io` | `main_q4a_pct > 20` | IO 阻塞。D/DK 状态，无具体 IO slice 匹配 |
| P9 | `binder_timeout` | `binder_overlap_ms > 500` | Binder 超时。帧窗口内 Binder 累计 > 500ms |
| P9.5 | `lock_binder_wait` | `main_q4b_pct > 30` | 锁/Binder 等待。S/I 状态 |

#### P10-P11 — 兜底分类

| 优先级 | reason_code | 条件 | 含义 |
|--------|-------------|------|------|
| P10 | `small_core_placement` | `main_q2_pct > 50` | 小核调度（按四象限判断） |
| P11 | `workload_heavy` | `top_slice_ms > slice_critical_ms` | 工作负载超时兜底。top_slice > critical 但无特定供给侧/四象限因素 |
| — | `unknown` | 以上均不匹配 | 未分类 |

### workload_heavy 子分类表

当 `reason_code = workload_heavy` 时，根据 `top_slice_name` 字段进行子分类（字符串包含匹配）：

| top_slice_name 包含 | 子分类 | 优化方向 |
|--------------------|--------|---------|
| `Choreographer` / `doFrame` / `doCallbacks` | doFrame 回调总时间过长 | [App层] 检查 measure/layout/draw 各阶段，减少过度绘制 |
| `layout` / `measure` / `onLayout` / `onMeasure` | 布局计算密集 | [App层] 减少嵌套层级，使用 ConstraintLayout，避免 requestLayout 连锁 |
| `obtainView` / `inflate` / `createViewFromTag` / `RecyclerView` / `prefetch` | View 创建/Inflate/预取过长 | [App层] 启用 RecyclerView 预创建、异步 inflate、ViewStub 延迟加载 |
| `animation` / `Animator` / `ValueAnimator` | 动画回调过长 | [App层] 检查是否有多个动画叠加，或动画回调中执行了耗时操作 |
| `input` / `dispatchTouchEvent` / `onTouch` / `onScrollChanged` | 输入处理阻塞 | [App层] 避免在 onTouchEvent/onScrollChanged 中执行耗时操作 |
| `decodeBitmap` / `BitmapFactory` / `decodeResource` / `decode` | 主线程图片解码 | [App层] 使用 Glide/Coil 异步加载，避免主线程 decode |
| `SharedPreferences` / `sqlite` / `QueuedWork` / `waitToFinish` | 主线程 IO | [App层] 迁移到 DataStore/Room 异步 API，避免 apply() 后 waitToFinish |
| `traversal` / `performTraversal` / `relayoutWindow` | ViewRootImpl traversal 过长 | [App层] 减少 View 树深度，检查是否有不必要的 invalidate |
| `Recomposition` / `compose:` | Compose 重组过长 | [App层] 使用 derivedStateOf/remember 减少不必要的重组 |
| 其他 / 无法匹配 | 通用负载过重 | 需要 jank_frame_detail 查看 main_slices_json 获取更多上下文 |

### workload_heavy 频率复核规则

对每个 `workload_heavy` 帧，读取 `big_avg_freq_mhz` 和 `device_peak_freq_mhz` 字段，计算频率占比：

- **big_avg_freq_mhz < device_peak_freq_mhz * 0.70**：根因标注为 **"负载过重 + 频率不足"**（trigger=workload, supply=frequency_insufficient）。在满频下相同操作可能不超时，优化建议应同时包含 [App层] 降低负载 + [系统层] 提升调度频率
- **big_avg_freq_mhz >= device_peak_freq_mhz * 0.70**：确认为纯负载问题，优化方向纯 [App层]
- 在结论的代表帧分析中必须报告：`大核均频 XXMHz / 设备峰值 YYMHz (ZZ%)`

---

## 3. Binder IPC 对帧渲染的影响

### 机制

Binder 是 Android 主要的进程间通信机制。同步 Binder 调用流程：

1. **Client 线程**发起 `binder transaction` 并 **睡眠**（阻塞在内核中）
2. **内核**将调用数据传输到目标（Server）进程
3. **Server 线程**唤醒，执行请求方法，产生结果
4. **内核**将结果复制回 Client
5. **Client 线程**唤醒继续执行

整个往返期间，Client 线程无法做任何事。当发生在主线程时：
- Choreographer 回调无法触发（帧 deadline 错过）
- 输入事件排队（触摸延迟增加）
- 动画冻结

阻塞时长完全取决于 Server 侧 — Client 无法控制 Server 响应时间。

### 常见慢 Server

| Server 进程 | 服务 | 慢的原因 |
|-------------|------|---------|
| system_server | ActivityManagerService (AMS) | 锁竞争、进程查找 |
| system_server | PackageManagerService (PMS) | 包解析、权限检查 |
| system_server | WindowManagerService (WMS) | 窗口状态转换 |
| surfaceflinger | SurfaceComposer | Buffer 管理、Layer 更新 |
| mediaserver | MediaCodec/AudioFlinger | 编解码器分配、音频路由 |

### Trace 标记

| 查找内容 | 含义 |
|---------|------|
| `binder transaction` slice（Client 线程） | Client 侧阻塞时长 |
| `binder reply` slice（Server 线程） | Server 侧执行时间 |
| blocked_function = `binder_wait_for_work` | 线程空闲等待 Binder 工作 |
| `android_binder_client_server_breakdown` | 详细的 Server 侧归因分解 |

Server 侧归因：
- **monitor_contention** — Server 线程等待 Java monitor 锁
- **io** — Server 在处理调用时执行磁盘或网络 IO
- **memory_reclaim** — 内核在调用期间回收内存
- **art_lock_contention** — ART 运行时内部锁竞争

### 帧渲染场景下的优化方向

- 切换到异步 Binder（`oneway`），在不需要立即结果时使用
- 批量合并多个 IPC 调用为单次事务
- 将非关键 IPC 推迟到后台线程
- 缓存频繁查询结果（如 PackageManager 信息）
- 空闲时预取数据，而非帧渲染期间按需获取

---

## 4. GC 对帧渲染的影响

### GC 类型与影响

| GC 类型 | 触发条件 | 典型时长 | 影响 |
|---------|---------|---------|------|
| **Young（minor）** | Young generation 满 | 1-5ms | 低 — 仅扫描年轻对象 |
| **Full（major）** | Old generation 压力 | 50-200ms | 高 — 扫描整个堆 |
| **Explicit** | `System.gc()` 调用 | 50-200ms | 可避免 — 开发者触发 |
| **Alloc** | 分配失败（无空闲空间） | 可变 | 关键 — 分配阻塞直到 GC 完成 |

### 并发 vs Stop-the-World

大部分 GC 工作在后台线程并发运行。但**最终标记阶段**需要短暂的 stop-the-world 暂停，所有应用线程被挂起：
- 无 UI 线程工作
- 无 RenderThread 绘制
- 所有线程冻结直到标记完成

### 对帧渲染的影响

当主线程遇到 `GC: Wait For Completion`，它被阻塞等待 GC 周期完成，直接占用帧预算时间。高堆压力产生恶性循环：更多分配触发更多 GC，每次偷走 CPU 时间并造成线程暂停。

**分配率**是关键指标。高分配率（如 RecyclerView 滑动期间）触发频繁 young GC，增加累积 CPU 开销和暂停频率。

### Trace 标记

| 查找内容 | 含义 |
|---------|------|
| `android_garbage_collection_events` 表 | GC 事件，含 gc_type、duration、reclaimed_mb |
| `GC: Wait For Completion` slice（主线程） | 主线程被 GC 阻塞 |
| `gc_running_dur` vs `gc_wall_dur` | 并发时间 vs 总挂钟时间 |
| gc_type = `young` 且高频率 | 分配压力 |
| gc_type = `full` 或 `explicit` | 重大收集 — 显著暂停风险 |
| 大 `reclaimed_mb` | 高分配率（快速分配和丢弃） |

### 帧渲染场景下的优化方向

- **减少热路径中的分配**：RecyclerView.onBindViewHolder、动画 tick、onDraw — 避免每帧创建对象
- **使用对象池**：复用 Message、Rect、Paint 对象
- **避免自动装箱**：使用 SparseIntArray 代替 HashMap<Integer, Integer>
- **移除显式 GC 调用**：`System.gc()` 强制 full collection
- **避免热路径中的 Finalizer 和弱引用**
- **使用分配追踪**进行 Profiling：定位 top 分配调用点

---

## 5. CPU 调度与帧时序

### EAS 调度机制

Android 使用 **EAS（Energy Aware Scheduling）**，将任务放置在能满足性能需求的最节能 CPU 核心上。

现代 Android SoC 使用异构 CPU 集群：

| 集群 | 核心数 | 特征 |
|------|--------|------|
| **Little**（效率核） | 4 | 低频、低功耗、高能效 |
| **Medium**（均衡核） | 2-3 | 中等频率、中等功耗 |
| **Big**（性能核） | 1-2 | 高频、高功耗 |
| **Prime**（峰值核） | 1 | 最高频率、最高功耗 |

### 小核调度为何影响帧渲染

当延迟敏感任务（主线程、RenderThread）运行在 little core 上，以较低频率执行。在 big core 上 8ms 的工作在 little core 上可能需要 20ms，直接超过帧 deadline。调度器可能因为任务负载均值看起来低而初始放置到 little core。

### 频率 Governor 延迟

CPU 频率 Governor 根据负载调整核心频率，但有 **10-30ms 升频延迟**。突发工作（如 Choreographer#doFrame 启动）在前几毫秒以之前的低频率运行，Governor 还未来得及升频。这个初始慢周期可能将帧推过预算。

### uclamp（Utilization Clamping）

Android 使用 `uclamp.min` 提示调度器某些线程需要最低性能保证。RenderThread 和主线程通常获得高 uclamp 值，请求放置到更快核心。当 uclamp 配置错误或系统处于热约束下，这些提示可能被忽略。

### 调度延迟阈值

- < 2ms：正常
- 2-5ms：偏高（负载下可接受）
- 5-15ms：值得关注 — CPU 竞争或优先级问题
- \> 15ms：严重 — 严重 CPU 饥饿，可能温控降频或失控进程

### Trace 标记

| 查找内容 | 含义 |
|---------|------|
| `sched_slice` 表 | 每个线程在哪个 CPU 核心运行及时长 |
| `cpu_frequency_counters` | 实际 CPU 频率随时间变化 |
| CPU ID 在 Q1/Q2 范围（通常 0-3 为 little） | 任务运行在效率核 |
| 调度延迟（Runnable 时长） | Runnable 和 Running 状态之间的时间 |

### 帧渲染场景下的优化方向

- 设置合适的线程优先级：对关键渲染线程使用 `SCHED_FIFO` 或高 nice 值
- 减少后台线程数以避免 CPU 竞争
- 检查温控状态：降频强制任务到更慢核心的更低频率
- 审计性能关键操作期间的后台服务和 Job
- 通过 `thread_state` 表验证 RenderThread 和主线程的 uclamp 设置

---

## 6. 温控与持续滑动

### 降频机制

Android 设备包含多个热传感器监控 SoC 结温、电池温度和皮肤温度。当任何传感器超过定义的阈值，**thermal governor** 介入，降低 CPU 和 GPU 频率上限，限制系统可用的最大性能。

降频链路：
```
持续负载 → 热量产生 → 热区超过阈值
    → governor 降低频率上限 → CPU/GPU 运行更慢
    → 帧渲染时间更长 → 帧错过 VSync deadline → 卡顿
```

### 迟滞效应

热管理使用迟滞（hysteresis）防止快速振荡。一旦在阈值 T1（如 85C）激活降频，不会在温度降至更低阈值 T2（如 80C）以下前解除。这意味着：
- 降频起始可能在实际高负载之后延迟数秒
- 恢复比预期更久 — 温度必须大幅下降才能恢复完整性能
- 即使高负载结束后，用户仍会经历持续卡顿

### 持续 vs 突发负载

- **突发**（< 2s）：短暂峰值很少触发降频。SoC 的热质量可以吸收短暂突发。
- **持续**（> 5-10s）：连续高负载累积热量直到达到降频阈值。
- 游戏、视频录制、benchmark、滑动浏览大列表都是常见的持续负载触发场景。

### 检测方法

比较 trace 前 5 秒的 CPU 频率（热累积之前）与卡顿期间的频率。显著下降（如 big core 从 2.8GHz 降到 1.8GHz）确认温控降频为贡献因素。

### Trace 标记

| 查找内容 | 含义 |
|---------|------|
| `android_dvfs_counters` | thermal governor 施加的频率上限 |
| `cpu_frequency_counters` | 实际运行频率 — 与最大值比较检测限频 |
| `thermal_zone` counters | SoC 传感器的原始温度读数 |
| 实际频率 << 最大支持频率 | 活跃的温控降频 |
| 频率在 trace 中途下降 | 降频起始 — 与卡顿增加关联 |
| GPU 频率 counters | GPU 降频（影响 DrawFrame 时长） |

### 帧渲染场景下的优化方向

- **减少持续 CPU/GPU 负载**：优化 shader，减少过度绘制，简化动画
- **实现帧节奏**：每帧交付一致的工作而非突发模式。不一致的帧时间导致更高的峰值温度
- **将绘制工作移至 RenderThread**：分散热量到多个核心
- **避免忙等模式**：自旋循环产生最大热量但无有用工作
- **性能关键路径期间减少后台工作**：滑动或动画期间暂停非必要 Job
- **考虑负载分散**：将计算分布到多个核心而非饱和单个核心

---

## 7. 锁竞争

### 机制

当多个线程竞争同一把锁时，除持有者外的所有线程必须等待。Android 上锁竞争遵循升级路径：

1. **Thin lock（快速路径）**：ART 使用 CAS（compare-and-swap）操作。无竞争时，获取成本约 1 条指令。无内核参与。
2. **Fat lock（竞争态）**：当 thin lock 被竞争，ART 将其膨胀为 fat lock，底层由 **futex**（Fast Userspace muTEX）支持。等待线程通过 `futex_wait` 进入内核睡眠。
3. **Kernel wait**：被阻塞线程完全从 CPU 运行队列移除。在锁持有者释放并内核唤醒之前，它无法做任何工作。

当锁竞争发生在主线程上，直接占用帧预算时间。主线程在等待锁时无法处理输入、运行动画或绘制。

### Monitor Contention（Java 锁）

Java `synchronized` 块使用 ART monitor 锁。竞争时：
- 被阻塞线程出现 `monitor contention with <owner>` slice
- `android_monitor_contention` 表提供结构化数据：blocking_method、blocked_method、waiter_count、blocking_thread_name
- 高 waiter_count 表示热点锁有多个线程竞争

### Futex Contention（Native/内核层）

Native 锁（pthread_mutex、std::mutex）和膨胀的 Java monitor 底层都使用 futex：
- `thread_state` 中 blocked_function = `futex_wait_queue` 表示内核级锁等待
- 更长的 futex 等待暗示锁持有者在持有锁期间执行大量工作

### 常见来源

| 来源 | 竞争原因 |
|------|---------|
| ContentProvider.onCreate() | 初始化期间持有全局锁；其他线程的查询被阻塞 |
| synchronized 数据库访问 | SQLite 单写者锁；UI 线程查询被后台写入阻塞 |
| SharedPreferences commit() | 磁盘 IO 期间持有锁；其他读写阻塞 |
| Room 数据库事务 | 写事务持有排他锁；并发读取等待 |
| 自定义 singleton synchronized | 任何由单锁保护的共享状态 |

### Trace 标记

| 查找内容 | 含义 |
|---------|------|
| `monitor contention with <owner>` slice | Java monitor 锁被阻塞，显示持有者 |
| `android_monitor_contention` 表 | 结构化竞争数据（方法名和线程名） |
| `android_monitor_contention_chain` | 多跳阻塞链（A blocks B blocks C） |
| blocked_function = `futex_wait_queue` | 内核级锁等待 |
| Thread state = `S` + futex blocked_function | 线程在竞争的锁上睡眠 |

### 帧渲染场景下的优化方向

- **缩小 synchronized 范围**：持有锁的时间最短。将 IO 和计算移到锁外。
- **使用并发数据结构**：ConcurrentHashMap 替代 synchronized HashMap，CopyOnWriteArrayList 替代 synchronized List（读多场景）。
- **将 IO 移出锁区域**：持有锁时绝不执行磁盘读取、网络调用或 Binder IPC。
- **使用 ReadWriteLock**：读多场景使用 ReentrantReadWriteLock 允许并发读。
- **避免嵌套锁**：所有线程以一致顺序获取锁以防死锁。
- **使用异步模式**：用协程 + Mutex 或 Channel 替代 synchronized 访问。

---

## 8. 数据采集要求

### 帧渲染与滑动分析

**依赖表**: `actual_frame_timeline_slice`, `expected_frame_timeline_slice`
**架构适用**: STANDARD, COMPOSE, MIXED
**最低版本**: Android 12 (API 31) — Frame Timeline API

**必要 atrace category:**
- `gfx` — 图形渲染管线事件
- `view` — View 系统（measure/layout/draw）

**增强 atrace category:**
- `input` — 关联输入延迟与帧超时
- `sched/sched_switch` ftrace event — 分析渲染线程被抢占

**Perfetto 配置片段:**
```
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      atrace_categories: "gfx"
      atrace_categories: "view"
      atrace_categories: "input"
      ftrace_events: "sched/sched_switch"
    }
  }
}
```

**常见缺失原因:**
- 未开启 `gfx` atrace category（最常见）
- Android 11 及以下版本不支持 Frame Timeline API — 降级为 Choreographer slice 分析
- Flutter/WebView 架构不走 Android Frame Timeline — 使用各自专用管线分析

### CPU 调度分析

**依赖表**: `sched_slice`, `thread_state`

**必要 ftrace event:**
- `sched/sched_switch` — CPU 调度切换
- `sched/sched_wakeup` — 线程唤醒

**增强 ftrace event:**
- `sched/sched_blocked_reason` — 阻塞原因（需 CONFIG_SCHEDSTATS）
- `power/cpu_frequency` — CPU 频率变化
- `power/cpu_idle` — CPU idle 状态

### Binder/IPC 分析

**依赖表**: `android_binder_txns`, `android_sync_binder_thread_state_by_txn`

**必要配置:**
- atrace category: `binder_driver` — Binder 驱动事件
- ftrace event: `binder/binder_transaction` — 事务开始/结束

### 锁竞争分析

**依赖表**: `android_monitor_contention`, `android_monitor_contention_chain`
**最低版本**: Android 13 (API 33) — ART monitor contention tracing

**必要配置:**
- atrace category: `dalvik` — ART 事件
- atrace_apps: `"*"` — 开启应用级 tracing

> **注意**: Monitor contention 事件需要 Android 13+ 的 ART 支持。Android 12 及以下版本不会产出 `android_monitor_contention` 数据。

### GC/内存分析

**依赖表**: `android_garbage_collection_events`

**必要配置:**
- atrace category: `dalvik` — ART GC 事件

### 热降频分析

**依赖表**: `counter`（thermal_zone counters）, `android_dvfs_counters`

**必要配置:**
- ftrace event: `power/cpu_frequency` — CPU 频率变化

**增强配置:**
- ftrace event: `thermal/thermal_temperature` — 热区温度
- ftrace event: `thermal/cdev_update` — 冷却设备更新

> **注意**: `thermal/*` ftrace 事件依赖设备/内核支持，非所有设备都暴露。即使无 thermal ftrace，可通过 CPU 频率钳位间接诊断降频。