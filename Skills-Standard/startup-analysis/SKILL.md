<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
name: startup-analysis
description: Android 应用启动性能分析（冷启动/温启动/热启动）。基于 Perfetto trace 数据，通过多阶段 SQL 查询和诊断决策树，定位启动瓶颈根因（CPU/IO/Binder/GC/锁/调度/内存压力等），输出完整结构化分析报告。覆盖 TTID/TTFD、四象限分析、根因推理链、平台策略审计（Boost/频率地板/摆核）、App层+平台调度层双视角优化建议。触发词：启动、冷启动、热启动、launch、startup、TTID、TTFD、app start。
---

# Android 启动性能分析

当用户提到启动、冷启动、热启动、温启动、launch、startup、TTID、TTFD、app start 等关键词时，使用此 Skill 进行分析。

## 前置依赖

- Perfetto trace 文件已加载到 trace_processor
- 可通过 `execute_sql()` 或等效工具执行 SQL 查询
- trace 需包含以下 atrace 分类：`am`、`dalvik`、`wm`、`sched`（最低要求）
- 推荐额外开启：`binder_driver`、`disk`、`freq`（获取更完整的根因数据）
- **MTK 平台增强 trace**（可要求 QA 开启以获取更深入的调度数据）：
  - `fpsgo` / `FSTB`：FPSGO 帧感知调度决策
  - `eas_util` / `sugov_util`：per-CPU 负载利用率（governor 决策输入）
  - `thermal_zone`：温度传感器读数（thermal 限频直接证据）
  - vendor `perf_idx` / `PowerHal` / `PerfService`：平台 Boost 事件

## Android 版本要求

| 分析能力 | 最低版本 | 依赖 | Fallback |
|---------|---------|------|---------|
| **FrameTimeline** (actual/expected_frame_timeline_slice) | Android 12 (API 31) | SurfaceFlinger atrace | 无 FrameTimeline 时无法做帧级分析，仅能做 slice 级分析 |
| **blocked_functions** (thread_state 列) | 任意版本 | 内核 `CONFIG_SCHEDSTATS=y` + `sched_blocked_reason` ftrace | 高通量产内核常关闭。为空时退回间接推断（S/D 比例 + Binder/GC 交叉分析） |
| **monitor_contention** (锁竞争 slice) | Android 13 (API 33) | `android.monitor_contention` stdlib | 无 contention slice 时只能从 blocked_function=futex_wait 推断锁问题 |
| **input events** (android_input_event_dispatch) | Android 14 (API 34) | InputFlinger atrace | 无法做输入延迟关联分析 |
| **android_startups** (启动事件表) | Android 10 (API 29) | `android.startup.startups` stdlib | 低于 Android 10 需手动从 ActivityManager slice 提取 |
| **CC GC** (concurrent copying GC slice) | Android 10 (API 29) | ART Runtime | 旧版本 GC slice 名称不同（CMS 风格） |
| **Perfetto token 语义** | Android 14 变更 | FrameTimeline token 分配逻辑变化 | Android 14+ token 不再严格连续递增，token_gap 检测可能需要调整 |

**版本检测 SQL**：
```sql
SELECT name, str_value FROM metadata
WHERE name IN ('android_build_fingerprint', 'android_sdk_version')
```

## 核心原则

1. **不能只报告"某 slice 耗时 XXms"——必须解释 WHY（为什么慢）**
2. **每个热点 slice 必须交叉分析**：结合四象限、线程状态（含 blocked_functions）、CPU 频率、Binder/IO/GC 数据，构建因果链
3. **四象限 + 线程状态是定位根因的核心工具**，不是独立罗列的数据
4. **使用 self_ms（exclusive time）做归因**：slice 数据包含 total_ms（wall time，含子 slice）和 self_ms（exclusive time）。根因归因必须基于 self_ms，避免父子重叠导致百分比超过 100%
5. **平台策略审计**：不只分析"发生了什么"，还要检查"平台策略是否生效"。启动 Boost、频率地板（uclamp.min）、场景识别是否正确触发——**策略未生效或配置不当本身就是根因**

## 启动类型判定规则

启动类型决定分析策略和性能基线，必须在分析初期验证。

| 类型 | 判定信号 | Android 框架路径 |
|------|---------|-----------------|
| 冷启动 (cold) | `bindApplication` slice 存在 | Zygote fork -> handleBindApplication() |
| 温启动 (warm) | `performCreate:*` 存在且**无** `bindApplication` | handleLaunchActivity() -> Activity.onCreate() |
| 热启动 (hot) | 两者均不存在 | Activity.onRestart() -> onResume() |

**LMK 边界场景**：进程被 LMK 回收后重启时，Perfetto 可能报告 `warm`，但 `bindApplication` 存在说明实为冷启动。**必须以 bindApplication 信号为准**。

## 分析阶段

### Phase 1 — 启动概览

获取启动事件基础数据。详细 SQL 模板见 `reference-sql-patterns.md` 中的对应章节。

**Step 1.1 — 获取启动事件列表**

使用 `startup_events_in_range` SQL 模板查询 `android_startups` 表，获取：
- startup_id, package, startup_type, dur_ms, start_ts, end_ts
- TTID/TTFD 指标（来自 `android_startup_time_to_display`）
- 启动类型重分类（基于 bindApplication/performCreate 信号）

**Step 1.2 — 启动延迟归因分解**

使用 `startup_breakdown_in_range` SQL 模板查询 `android_startup_opinionated_breakdown` 表：
- 按 reason 分组，计算 count, total_dur_ms, percent
- 分类：IPC, IO, Memory, Lock, Layout, ClassLoading, Other

**Step 1.3 — 主线程热点 Slice**

使用 `startup_main_thread_slices_in_range` SQL 模板查询主线程 slice：
- 包含 total_ms 和 self_dur_ms（关键：根因归因用 self_ms）
- 按 total_dur_ms 降序排列

**Step 1.4 — 主线程状态分布**

使用 `startup_main_thread_states_in_range` SQL 模板查询 `thread_state` 表：
- 按 state (Running/S/D/R) 分组
- **关键**：`blocked_functions` 列是定位阻塞根因的核心数据

**Step 1.5 — 辅助数据采集**（并行执行）

- **文件 IO**：`startup_main_thread_file_io_in_range` — 主线程 IO 操作
- **Binder 总览**：`startup_binder_in_range` — 全进程 Binder 调用分布
- **主线程同步 Binder**：`startup_main_thread_sync_binder_in_range` — 主线程被 Binder 阻塞的时间
- **GC 分析**：`startup_gc_in_range` — GC 在主线程/后台线程的影响
- **类加载**：`startup_class_loading_in_range` — DEX/类验证耗时
- **调度延迟**：`startup_sched_latency_in_range` — Runnable 等待时延

### Phase 2 — 启动详情深钻

基于 Phase 1 提取的 startup_id, start_ts, end_ts, package 参数执行。

**Step 2.1 — 四象限分析**

查询主线程在启动窗口内的线程状态分布，按 CPU 拓扑分类：
- **Q1**：大核运行（prime/big/medium 核 Running 状态）
- **Q2**：小核运行（little 核 Running 状态）
- **Q3**：Runnable（R/R+ 状态，调度等待）
- **Q4a**：IO 阻塞（D/**DK** 状态）— 注意 kernel 5.x+ 很多之前报 D 的场景改报 DK（D+killable）
- **Q4b**：Sleep/等待（S/I 状态，锁/Binder/sleep）

**特殊状态**：
- `R+` (Preempted)：被更高优先级任务抢占，归入 Q3 但说明"非调度队列等待，是被抢占"
- `T` (Stopped/Traced)：进程被 strace/ptrace 附加。如果 T > 5%，检查是否有调试工具
- `W` (Waking)：跨 CPU 唤醒过程中，归入 Q3

**Step 2.2 — 热点 Slice 线程状态（per-slice 根因定位）**

使用 `startup_hot_slice_states` SQL 模板：对 Top N 热点 slice，查询每个 slice 执行期间的线程状态分布（Running/S/D/R + blocked_functions）。**这是判断某个 slice 为什么慢的最直接证据**。

**Step 2.3 — 关键任务分析**

使用 `startup_critical_tasks` SQL 模板：识别所有活跃线程，按 CPU 时间排序，提供每线程四象限 + 摆核分析。用于诊断：
- CPU 争抢（所有线程总 CPU 时间 / 墙钟时间 > 2x）
- JIT 线程大核竞争
- RenderThread 是否被困小核
- 核迁移频率

**Step 2.4 — 线程阻塞关系图**

使用 `startup_thread_blocking_graph` SQL 模板：分析线程间 block/wakeup 关系。当 Q4 > 25% 时**必须执行**。
- 输出：blocked_thread, blocked_function, waker_thread, waker_process, waker_current_slice
- 构建因果链：主线程[S:binder_wait] <- Binder 线程 <- system_server/PackageManager

**Step 2.5 — CPU 频率 + 平台策略分析**

- `startup_freq_rampup`：冷启动初期频率爬升速度
- `startup_cpu_placement_timeline`：主线程在启动各时段的大/小核分布
- **平台策略检查**（MTK 视角）：
  - 检查是否有启动 Boost slice（搜索 `*boost*`、`*perf*`、`*PowerHal*` 相关 slice）
  - 检查频率地板：启动期间大核最低频率是否有保障（min_freq > peak * 0.5 说明有地板）
  - 帧内频率时间线：对热点 slice 窗口内的频率变化做逐事件追踪，检查 governor ramp-up delay
  - 详细 SQL 见 `reference/mtk-scheduling-deep-dive.md` 和 `reference/mtk-vendor-strategy-analysis.md`

**Step 2.6 — 启动慢原因检测（冷启动必须执行）**

使用 `startup_slow_reasons` SQL 模板，检测 20 种已知启动慢原因（SR01-SR20）：

| 分类 | SR Codes | 检测内容 |
|------|----------|---------|
| App 层基础 | SR01-SR08 | JIT/DEX2OAT/GC/锁/IO/Binder/广播/类验证 |
| App 层扩展 | SR09-SR15 | ContentProvider 过多/SP 阻塞/显式 sleep/SDK 初始化/Native 库/.so/WebView/Inflate |
| 系统层 | SR16-SR20 | 热节流/后台干扰/system_server 锁/并发启动/数据库 fsync |

### Phase 2.56 — 内存压力检测（条件触发）

**触发条件**（满足任一即执行）：
- D 状态占启动时长 >10%
- 存在 kswapd 线程活动

使用 `memory_pressure_in_range` SQL 模板，检测：
- pressure_level (none/low/moderate/high/critical)
- kswapd_events, direct_reclaim_events, lmk_events
- page_cache_add/delete_events

**诊断逻辑**：
- high/critical：内存压力是 D 状态异常的重要因素，Page Cache 被回收导致 IO 放大
- moderate：作为贡献因素注明
- none/low 但有 direct_reclaim/LMK：异常信号，不能直接排除

### Phase 2.7 — 阻塞链深钻（Q4 > 25% 时必须执行）

对 `hot_slice_states` 中 S(Sleeping) > 40% 的热点 slice，使用 `blocking_chain_analysis` SQL 模板追踪阻塞链。如果 blocked_function 含 binder，进一步使用 `binder_root_cause` 模板定位服务端原因。

### Phase 2.75 — 首帧后可交互性检查（TTFD 存在或 dur > 2s 时执行）

首帧显示（TTID）后，App 可能仍在执行异步数据加载、首屏动画、权限检查等操作，导致"看到了但用不了"。

```sql
-- 查询首帧后 500ms 内主线程和 RenderThread 的活动
SELECT name, ROUND(dur/1e6, 1) as dur_ms, t.name as thread
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE p.name GLOB '<package>*'
  AND (t.is_main_thread = 1 OR t.name = 'RenderThread')
  AND s.ts BETWEEN <end_ts> AND <end_ts> + 500000000
  AND s.dur > 5000000
ORDER BY s.dur DESC LIMIT 15
```

关注：网络请求回调、数据库查询、图片异步加载完成后的 UI 刷新、权限弹窗阻塞。

### Phase 2.8-2.10 — 架构特定分析（可选）

- **Phase 2.8 Compose**：检查 `Recomposition*`/`Compose:*` slice 占比
- **Phase 2.9 Flutter**：检查 1.ui/1.raster 线程、FlutterEngine 初始化
- **Phase 2.10 WebView**：检查 WebViewChromium.init、CrRendererMain 线程

## Phase 3 — 综合结论

**结论是用户看到的最终输出，必须是完整的结构化报告。严禁用简短摘要代替。**

### 预检查：识别测试/基准应用

检查热点 slice 名称是否包含 `Benchmark`、`StressTest`、`TestRunner`、`Mock`、`Synthetic` 等关键词。如检测到，在概览中标注。

### Slice 嵌套感知

- **根因归因用 self_ms**，不用 total_ms
- 嵌套 slice 必须体现父子关系：`activityStart -> performCreate -> inflate`
- 收益估算基于 self_ms，不能简单相加父子 wall time

### 根因诊断决策树

**第一步：看四象限分布**

| 四象限 | 阈值 | 含义 | 下一步 |
|--------|------|------|--------|
| Q1 大核运行 | >50% | CPU-bound | 分析热点 slice 计算密集度 |
| Q2 小核运行 | >15% | 被调度到性能不足的小核 | 检查进程优先级、EAS/uclamp |
| Q3 Runnable | >5% | CPU 资源争抢 | 看调度延迟、核迁移、后台负载 |
| Q4 Sleeping | >25% | 主线程被阻塞 | **必须看 blocked_functions** |

**第二步：Q4 高时，用 blocked_functions 定位阻塞根因**

| blocked_functions 特征 | 根因类型 | 典型场景 |
|----------------------|---------|---------|
| `futex_wait_queue` / `futex_wait` | 锁等待 | monitor 竞争、synchronized |
| `binder_ioctl` / `binder_ioctl_write_read` | **同步 Binder 阻塞** | 客户端发起 IPC 等待服务端响应 |
| `binder_wait_for_work` | Binder 线程池空闲（正常） | Binder 服务端线程等待新请求，非阻塞问题。**注意**：如果在主线程看到此函数，说明主线程异常充当了 Binder 服务端 |
| `do_epoll_wait` / `ep_poll` | Looper 空闲 | 正常（非问题） |
| `SyS_nanosleep` / `hrtimer_nanosleep` | 主动 sleep | Thread.sleep() |
| `io_schedule` / `blkdev_issue_flush` | 磁盘 IO | 文件读写、数据库 |
| `SyS_fsync` / `do_fsync` | fsync 刷盘 | SQLite、SharedPreferences |
| `filemap_fault` / `do_page_fault` | 页缺失 | DEX 加载、mmap 首次访问 |

**CONFIG_SCHEDSTATS 依赖**：`blocked_functions` 列的填充依赖 `sched_blocked_reason` ftrace 事件，需要内核编译 `CONFIG_SCHEDSTATS=y`。高通量产内核常关闭此选项。如果 blocked_functions 全部为空，整个第二步诊断需要退回到间接推断（见 hot_slice_states 的 Running/S/D 比例交叉分析）。

**第三步：用 hot_slice_states 做 per-slice 根因定位**

每个热点 slice 内部的 Running/S/D/R 分解是最直接的证据。

**第四步：检查 CPU 频率**
- 大核均频 vs 最高频：均频远低于最高频 -> 升频延迟或频率受限
- Q1 ≈ 100% 且频率达峰 -> 纯计算量问题，不是频率问题

### 输出结构（硬性要求）

**1. 概览**
- 应用名、启动类型、总耗时、TTID、TTFD（如有）
- 分析边界说明
- 评级、数据质量提示

**2. 关键发现**（每个发现必须包含根因推理链和根因编号 A1-A18/B1-B12）
```
**[CRITICAL] 标题 <- 根因 A9: SharedPreferences 阻塞**
- 描述：XX slice 自身耗时 YY ms（self_percent ZZ%）
- 根因推理链：
  1. 四象限显示 Q4=NN%
  2. 线程状态：S = XX ms >> D = YY ms -> 阻塞主因是 S 状态
  3. blocked_functions 含 futex_wait_queue -> 锁等待
  4. 结合 hot_slice_states：此 slice 内部 S=400ms
- SR 交叉验证：SR10 检测到 futex 等待 XX ms
- 建议：[可操作的优化建议]
```

**3. 根因分析树**（层级式，使用 self_ms，标注根因编号）
```
启动总耗时 XXms
|- [Phase 1] bindApplication = XXms wall
|     |- contentProviderCreate (self=YYms) <- A1
|     |- OpenDexFilesFromOat (self=YYms) <- A5
|- [Phase 2] activityStart = XXms wall
|     |- inflate (self=YYms) <- A4 (CPU-bound)
|- [交叉因素] B3 内存压力 x A2 磁盘 IO
|- [可排除因素]
      |- Binder(B6) < Xms
      |- GC(A6) 主线程/后台 OK
```

**4. 优化建议**（三视角）
- **[App 层]**：App 开发者可直接实施（收益基于 self_ms）
- **[平台调度层]**：可直接执行的调度/频率/策略调优。包括：
  - uclamp.min 配置（给启动关键线程设频率地板）
  - sugov 参数（rate_limit、up_rate_limit 升频响应）
  - 启动 Boost 策略（是否触发、目标频率、持续时间）
  - EAS task placement（启动期间大核绑定策略）
  - thermal governor 阈值（启动场景是否需要临时放宽）
- **[Framework 层]**：Framework 代码级优化（如 Binder 服务端优化、system_server 锁优化）

**5. 平台策略审计**（对比分析时必须包含）
```
| 策略项 | 状态 | 评估 |
|--------|------|------|
| 启动 Boost | [触发/未触发] | 目标频率是否足够？持续时间是否覆盖关键路径？ |
| 频率地板 | [有/无] | 地板高度？是否覆盖 bindApplication 阶段？ |
| 场景识别 | [命中/未命中] | 是否识别为启动场景？ |
| Task Placement | [大核 XX%] | 关键线程是否稳定在大核？ |
```

### 禁止的做法

- 只说"XX 耗时 YYms"但不解释 WHY
- 把四象限、线程状态、Binder、GC 当独立章节罗列不做交叉引用
- 忽略 blocked_functions 数据
- 不区分 GC 在主线程还是后台线程
- 把延迟归因的 category 当真实阻塞原因（它只是启发式分类）
- 将嵌套 slice 的 wall time 作为独立根因并列
- 只分析 activityStart 阶段而遗漏 bindApplication 阶段

## Phase 4 — 对比分析模式（问题机 vs 对比机）

当 QA 同时提供问题机和对比机的 trace 时，在 Phase 1-3 完成各自独立分析后，执行对比分析。

### 前置条件

- 两个 trace 已分别完成 Phase 1-3 的独立分析
- 两个 trace 来自同一 App 的同一操作（如同一个页面的冷启动）
- 使用 `scripts/load_dual_traces.sh` 加载到不同端口

### 跨厂商对比注意

当对比机是**非 MTK 平台**（如高通 Snapdragon）时：
- **CPU 拓扑不同**：必须对每个 trace 独立识别大小核簇配置，不能假设相同
- **频率不可直接比**：用"占各自峰值百分比"归一化
- **vendor trace 不对称**：对比机无 FPSGO/急拉/频率地板数据，MTK 侧策略审计单独报告
- **Binder/system_server 可直接比**：AOSP 代码两平台行为应相似
- 详细方法见 `reference/comparison-methodology.md` 第 4.5 节

### 对比维度与归因框架

对以下维度逐项对比，差异超过阈值时标注并归因：

| 对比维度 | 关键指标 | 显著差异阈值 | 差异归因方向 |
|---------|---------|------------|------------|
| **启动总时长** | dur_ms, TTID | >20% 或 >200ms | 综合入口 |
| **阶段耗时** | bindApplication_ms, activityStart_ms | >30% | App 初始化 vs Activity 渲染 |
| **四象限分布** | Q1/Q2/Q3/Q4 占比 | Q2差>10%, Q3差>5%, Q4差>15% | CPU 调度/锁/IO 差异 |
| **CPU 频率** | big_avg_freq, peak_freq | >15% | governor 策略/thermal 差异 |
| **大小核分布** | big_core_pct | >20% | EAS/uclamp 配置差异 |
| **调度延迟** | total_runnable_ms, max_sched_delay | >2x | 后台负载/核数差异 |
| **Binder 延迟** | 同一服务的 avg_dur_ms | >2x | system_server 负载差异 |
| **GC 影响** | main_thread_gc_ms | >2x | 内存配置/GC 策略差异 |
| **内存压力** | pressure_score, kswapd_events | 一方有一方无 | RAM 大小/后台进程差异 |
| **Thermal** | big_max_freq vs device_peak | >10% 差距 | 散热设计/环境温度 |
| **IO 延迟** | D 状态占比 | >2x | 存储速度(UFS vs eMMC)/Page Cache |

### Android 版本差异维度

当两个 trace 来自**不同 Android 版本**（如 15 vs 16）时，需额外分析：
- **系统行为变化**：HWUI/RenderThread 流程变更、SF 合成策略、调度策略、GC tuning — 对比两个 trace 的 slice 名称列表取 diff，找新增/消失的 slice
- **App 适配缺失**：废弃 API 兼容层开销、权限模型变更导致的新增 Binder 调用、targetSdkVersion 不匹配触发 compat 模式
- 详细检测 SQL 和方法论见 `reference/comparison-methodology.md` 第 5.5 节

### 对比分析步骤

**Step 4.1 — 基线指标提取**

对两个 trace 执行相同的 SQL 查询，提取关键指标。如果 Android 版本不同，额外执行 slice 名称差异和线程列表差异检测。核心查询见 `reference/comparison-methodology.md`。

**Step 4.2 — Delta 分析**

计算每个维度的差异值和差异率：
```
delta = test_value - ref_value
delta_pct = (test_value - ref_value) / ref_value * 100%
```

**Step 4.3 — 差异归因**

按以下优先级归因（同 App 不同设备场景）：
1. **平台策略差异**（最高优先级）：启动 Boost 是否触发、频率地板配置、场景识别结果、uclamp 参数——两台设备策略配置不同是最常见的性能差异根因
2. **设备能力差异**（硬件层）：CPU 核数/频率天花板、RAM 大小、存储类型(UFS/eMMC)
3. **系统调度差异**（OS 层）：governor 参数、thermal 策略、EAS 配置、GC tuning
4. **运行状态差异**（环境层）：内存压力、后台负载、thermal 状态、并发启动
5. **App 行为差异**（排除项）：同一 App 同一版本在不同设备上行为不同通常不是 App 问题

### 对比结论输出格式

```
## 对比分析：问题机 vs 对比机

### 设备信息
| | 问题机 | 对比机 |
|---|---|---|
| 启动耗时 | XXms | YYms |
| 差异 | +ZZms (+WW%) | baseline |

### 关键差异（按影响大小排序）

**[差异 1] CPU 频率差距 — 贡献约 +XXms**
- 问题机：大核均频 1200MHz（峰值 50%）
- 对比机：大核均频 2100MHz（峰值 88%）
- 归因：问题机存在 thermal 限频
- 建议：[系统层] 检查 thermal_zone、governor 参数

### 可排除差异
- Binder：两台差异 <5ms
- GC：两台均 <10ms
```

详细对比 SQL 模板和方法论见 `reference/comparison-methodology.md`。

## 知识参考

启动根因分类体系（A1-A18 / B1-B12 / C1-C4）和底层机制解释见 `reference/knowledge-overview.md`。

各分析步骤的完整 SQL 模板见 `reference/sql-patterns-overview.md`。