<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
name: scrolling-analysis
description: Android 滑动/卡顿性能分析。基于 Perfetto FrameTimeline 数据，通过逐帧根因诊断定位滑动卡顿瓶颈。支持标准 HWUI、Flutter（TextureView/SurfaceView）、WebView、Compose 架构。覆盖 21 种根因分类码、双信号卡顿检测（present_type + present_ts interval）、缺帧检测、全帧根因分布统计。触发词：滑动、卡顿、掉帧、丢帧、jank、scroll、fps、帧、frame、流畅、fling、stuttering。
---

# Android 滑动/卡顿性能分析

当用户提到滑动、卡顿、掉帧、jank、scroll、fps、帧率、流畅度、fling 等关键词时，使用此 Skill 进行分析。

## 前置依赖

- Perfetto trace 已加载到 trace_processor
- 可通过 `execute_sql()` 或等效工具执行 SQL 查询
- trace 需包含以下数据（Android 12+）：
  - `actual_frame_timeline_slice` 和 `expected_frame_timeline_slice`（FrameTimeline 数据）
  - atrace 分类：`gfx`、`view`、`input`、`sched`
- 推荐额外开启：`binder_driver`、`freq`、`disk`
- **MTK 平台增强 trace**（可要求 QA 开启以获取调度策略数据）：
  - `fpsgo` / `FSTB`：FPSGO 帧感知调度决策（急拉/频率地板的直接证据）
  - `eas_util` / `sugov_util`：per-CPU 负载利用率
  - `thermal_zone`：温度传感器读数
  - vendor `perf_idx` / `ged_*`：GPU Energy-aware Driver、Boost 事件

## Android 版本要求

| 分析能力 | 最低版本 | 依赖 | Fallback |
|---------|---------|------|---------|
| **FrameTimeline** | Android 12 (API 31) | SurfaceFlinger atrace | **核心依赖**。无 FrameTimeline 时跳转到 SQL 回退方案 |
| **blocked_functions** | 任意 | 内核 CONFIG_SCHEDSTATS | 高通量产内核常关闭。为空时退回 S/D 比例间接推断 |
| **monitor_contention** | Android 13 | stdlib | 无 contention slice 时从 futex_wait 推断 |
| **input events** | Android 14 | InputFlinger | 无法做输入延迟和 VSync 相位分析 |
| **token 语义变化** | Android 14 | FrameTimeline | token 不再严格递增，token_gap 检测需调整 |
| **WebView BLAST** | Android 12 | SurfaceControl | 12+ 无传统 SurfaceTexture 单 buffer 问题 |
| **CC GC** | Android 10 | ART | 旧版本 GC slice 名称不同 |

## 核心原则

1. **逐帧根因诊断是最重要的**。概览统计（帧率、卡顿率）只是入口，真正有价值的是每个掉帧帧的根因分析。
2. **掉帧检测以 present_ts 间隔为主**：
   - 主要依据：相邻帧的 `present_ts` 间隔 > 1.5x VSync 周期 = 用户可感知卡顿
   - 辅助信号：`display_frame_token` 序列缺口（token_gap > 1 说明 Layer 在连续 DisplayFrame 间未提交新 buffer）
   - 注意：`jank_type` 和 `present_type` 需配合使用，Buffer Stuffing 帧的 present_type 可以是 Late/Early/On-Time，不能仅靠 present_type 判定
3. **Guilty Frame 溯源**：
   - BlastBufferQueue 多缓冲（通常 2-3 个 buffer）机制下，可见卡顿**通常**出现在慢帧 1-3 帧之后，具体延迟取决于管线深度和刷新率
   - `guilty_frame_id` 通过回溯前 5 帧寻找超预算帧来适配不同管线深度
   - 根因分析应针对 guilty frame 而非枯竭帧本身
4. **平台策略审计**：不只分析"帧为什么慢"，还要检查"平台给的能力够不够"。FPSGO 场景识别是否匹配、急拉是否触发、频率地板是否垫上、per-architecture 策略是否正确——**策略未生效或配置不匹配本身就是根因**
5. **jank_responsibility 分类**：
   - `APP`：App 侧原因（App Deadline Missed / Self Jank）
   - `SF`：SurfaceFlinger 侧原因
   - `HIDDEN`：缓冲区枯竭但框架未标记（帧颜色为绿色）
   - `BUFFER_STUFFING`：Buffer Stuffing
   - `DISPLAY`：Display HAL 延迟（显示控制器/HWC 问题，归入系统侧）
   - 注意：`Prediction Error` 类型是 FrameTimeline 预测误差。**不应一律忽略**——在管线 2-3 帧缓冲下用户可能感知延迟。检查 `prediction_type = 'Expired Prediction'` 的比例：>5% 时标注'FrameTimeline 预测精度不足，可能影响 jank 分类准确性'

## 分析阶段

### Phase 1 — 概览 + 掉帧列表 + 批量根因分类

**Step 1.1 — 检查 FrameTimeline 数据源**
```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'actual_frame_timeline_slice'
) THEN 1 ELSE 0 END as has_frame_timeline
```
如果为 0，跳转到"SQL 回退方案"（见末尾）。

**Step 1.2 — VSync 配置检测**

检测刷新率，详细 SQL 见 `reference-sql-patterns.md` 中 `vsync_config`。多源检测优先级：VSYNC-sf counter -> expected_frame_timeline_slice -> 默认 60Hz。

**Step 1.3 — 性能概览**

双信号卡顿检测（同时检查 present_type 和 present_ts 间隔）：
- **感知卡顿**：present_type IN ('Late Present', 'Dropped Frame') AND jank_type != 'Buffer Stuffing'
  OR: jank_type = 'Buffer Stuffing' AND 实际间隔 > 1.5x VSync（真实卡顿）
- **App 侧卡顿**：jank_type IN ('Self Jank', 'App Deadline Missed')

输出：total_frames, perceived_jank_frames, jank_rate, app_janky_frames, actual_fps, rating

**Step 1.4 — 滑动区间分割**

将帧序列按 gap > 6x VSync 分割为滑动会话（scroll sessions）。

**Step 1.5 — 批量帧根因分类**

对所有掉帧帧，计算以下数据并分配 reason_code：

| 每帧数据 | 说明 |
|---------|------|
| 主线程四象限 | Q1(大核运行)/Q2(小核运行)/Q3(调度等待)/Q4a(IO 阻塞, D/**DK** 状态)/Q4b(Sleep/等待, S/I 状态) — 注意 kernel 5.x+ 很多之前报 D 的场景改报 DK（D+killable） |

**特殊状态**：
- `R+` (Preempted)：被更高优先级任务抢占，归入 Q3 但说明"非调度队列等待，是被抢占"
- `T` (Stopped/Traced)：进程被 strace/ptrace 附加。如果 T > 5%，检查是否有调试工具
- `W` (Waking)：跨 CPU 唤醒过程中，归入 Q3

| RenderThread 四象限 | render_q1/render_q3/render_q4 |
| CPU 大核频率 | big_avg_freq_mhz, big_max_freq_mhz, ramp_ms |
| Binder/GC 重叠 | binder_overlap_ms, gc_overlap_ms |
| 根因分类 | reason_code, top_slice_name, top_slice_ms |

**21 种根因分类码（reason_code）**：

采用**优先级驱动的 CASE 树**，按从高到低的优先级依次匹配，第一个满足条件的规则胜出。分为管线短路、直接阻塞、CPU/调度、GPU、频率/温控、四象限/IO、兜底分类七大类。

**P0 — 管线短路（非 App 问题，跳过线程分析）**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| buffer_stuffing | jank_responsibility = 'BUFFER_STUFFING' | P0 |
| sf_composition_slow | jank_responsibility = 'SF' | P0.5 |

**P1 — 直接阻塞（Binder / GC）**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| binder_sync_blocking | top_slice_ms > slice_critical_ms AND binder_overlap_ms >= binder_overlap_critical_ms | P1 |
| gc_jank | gc_overlap_ms > 1.0 | P1.5 |
| gc_pressure_cascade | gc_count >= 3 AND gc_overlap_ms > 0.5 | P1.6 |

**P2-P3 — CPU 核心调度与 Slice 内延迟**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| small_core_placement | top_slice_ms > slice_critical_ms AND little_run_pct >= 45 | P2 |
| sched_delay_in_slice | top_slice_ms > slice_critical_ms AND runnable_pct >= 15 | P3 |

**P3.5-P3.7 — GPU 与 RenderThread**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| shader_compile | shader_count > 0 AND total_shader_dur_ns > vsync_period_ns * 0.3 | P3.5 |
| gpu_fence_wait | max_fence_dur_ns > vsync_period_ns * 0.5 | P3.6 |
| render_thread_heavy | (render_q1_pct + render_q2_pct) > 70 AND render_q4b_pct < 20 | P3.7 |

**P4-P6 — 频率 / 温控 / 工作负载**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| workload_heavy | top_slice_ms > frame_budget_ms * 2.0 | P4 |
| thermal_throttling | big_max_freq_mhz < device_peak_freq_mhz * 0.60 AND top_slice_ms > slice_critical_ms | P4.5 |
| cpu_max_limited | big_max_freq_mhz < device_peak_freq_mhz * 0.75 AND top_slice_ms > slice_critical_ms | P4.6 |
| big_core_low_freq | top_slice_ms > slice_critical_ms AND big_run_pct >= 40 AND big_avg_freq_mhz < big_max_freq_mhz * 0.55 | P5 |
| freq_ramp_slow | top_slice_ms > slice_critical_ms AND ramp_to_high_ms > freq_ramp_critical_ms AND top_slice_offset_ms <= ramp_to_high_ms | P6 |

**P7-P9.5 — 四象限 / IO / Binder 信号（不依赖 top_slice_ms 阈值）**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| cpu_saturation | main_q3_pct > 15 AND render_q3_pct > 15 | P7 |
| scheduling_delay | main_q3_pct > 20 | P7.5 |
| main_thread_file_io | file_io_overlap_ms > 1.0 | P8 |
| blocking_io | main_q4a_pct > 20 | P8.5 |
| binder_timeout | binder_overlap_ms > 500 | P9 |
| lock_binder_wait | main_q4b_pct > 30 | P9.5 |

**P10-P11 — 兜底分类**

| reason_code | 条件 | 优先级 |
|-------------|------|--------|
| small_core_placement | main_q2_pct > 50 | P10 |
| workload_heavy | top_slice_ms > slice_critical_ms | P11 |
| unknown | 以上均不匹配 | — |

> **device_peak_freq_mhz 取值注意**：应使用 `PERCENTILE(freq, 0.99)` 或 trace 前 5s 最高频率，而非 `MAX(freq)`。MAX 可能取到 boost 超频值，导致正常满频被判定为频率不足。

### Phase 1 补充 A — 全局上下文检查

检查以下全局标志，在结论概述段用粗体标注：

| 标志 | 说明 |
|------|------|
| video_during_scroll = 1 | 滑动期间有视频解码，workload_heavy 归因可能失真 |
| interpolation_active = 1 | OEM 插帧模式活跃，统计指标可能失真 |
| thermal_trending = 1 | trace 尾部频率天花板明显低于峰值 |
| background_cpu_heavy = 1 | 非 App 大核占比 >60%，后台 CPU 干扰 |

**MTK 平台策略检查**（搜索 vendor slice 判断策略是否生效）：

| 检查项 | 检测方法 | 未检测到时的含义 |
|--------|---------|---------------|
| **FPSGO 活跃** | 搜索 `*fpsgo*` / `*FSTB*` slice | 帧感知调度未启用，频率/摆核无帧级别保障 |
| **急拉触发** | 搜索 `*boost*` / `*rescue*` slice | 预判掉帧机制未触发，无紧急频率拉升 |
| **频率地板** | 大核 min_freq > peak * 0.5 | 无地板保障，帧间 idle 可能深度降频 |
| **场景识别** | 搜索 `*scene*` / `*perf_idx*` slice | 场景未识别，可能用了默认（非滑动优化）策略 |

检测到策略未生效时，在结论中标注为独立发现（可能是性能差异的核心原因）。
详细检测 SQL 见 `reference/mtk-scrolling-strategy-analysis.md`。

### Phase 1 补充 B — 架构感知分支

| 架构 | 调整动作 |
|------|---------|
| **Flutter** | 改用 Flutter 滑动分析流程。1.ui/1.raster 线程模型不同 |
| **WebView** | 注意 CrRendererMain 线程。**Android 11-**：SurfaceTexture 单 buffer 模式，背压更容易发生。**Android 12+**：已迁移到 BLAST/SurfaceControl 路径，单 buffer 问题大幅改善。两个版本都需关注 V8 GC 和 CSS Layout Thrashing |
| **Compose** | 注意 Recomposition* slices 可能是卡顿主因 |
| **标准 HWUI** | 使用标准流程 |

**MTK 策略匹配检查**：不同架构在 MTK 平台有不同的调度策略（频率地板、摆核策略、急拉阈值）。如果场景识别错误（如 Flutter 被当成标准 HWUI），会导致策略不匹配——**这本身就是一个需要报告的根因**。见 `reference/mtk-scrolling-strategy-analysis.md` 第 2 节。

### Phase 1 补充 C — 根因分支深钻

| 条件 | 深钻动作 | 目标 |
|------|---------|------|
| 多帧 `sf_composition_slow` | 查询 SurfaceFlinger 分析 | HWC 回退？Layer 过多？ |
| 多帧 `thermal_throttling` | 查询 thermal_zone 数据 | 温度曲线、限频策略 |
| 多帧 `gc_pressure_cascade` | 查询 `android_garbage_collection_events` | GC 频率趋势、内存泄漏 |
| 多帧 `render_thread_heavy` | 查询帧详情 RT top slices | uploadBitmap？shader？ |

### Phase 1 补充 D — 根因深钻（强制执行，不可跳过）

对占比 >15% 且绝对帧数 >3 的每个 reason_code，**必须**选最严重的 1 帧执行深钻。

**禁止**仅靠 reason_code 统计直接出结论——reason_code 只是分类标签，不是根因。
**必须**通过工具调用获取机制级证据，回答"WHY 这帧慢"。

| 条件 | 深钻动作 |
|------|---------|
| Q4 > 20% | 阻塞链分析：谁阻塞了主线程？锁？Binder？IO？ |
| binder_overlap > 5ms | Binder 根因：服务端还是客户端慢？ |
| gc_overlap > 3ms | GC 类型、回收量、是否有内存泄漏趋势 |
| thermal_throttling | 温度驱动 vs policy 驱动？限频比例？ |
| render_thread_heavy | RT 内部：uploadBitmap？syncFrameState？ |

**CONFIG_SCHEDSTATS 依赖**：`blocked_functions` 列的填充依赖 `sched_blocked_reason` ftrace 事件，需要内核编译 `CONFIG_SCHEDSTATS=y`。高通量产内核常关闭此选项。如果 blocked_functions 全部为空，整个第二步诊断需要退回到间接推断（见 hot_slice_states 的 Running/S/D 比例交叉分析）。

**workload_heavy 子分类**：当 reason_code = workload_heavy 时，检查 top_slice_name：

| top_slice_name 包含 | 子分类 | 优化方向 |
|--------------------|--------|---------|
| Choreographer/doFrame | doFrame 回调总时间过长 | 检查 measure/layout/draw |
| layout/measure | 布局计算密集 | 减少嵌套，ConstraintLayout |
| obtainView/inflate/RecyclerView | View 创建过长 | RecyclerView: ① setItemViewCacheSize() ② RecycledViewPool.setMaxRecycledViews() ③ GapWorker prefetch ④ DiffUtil/ListAdapter ⑤ setHasFixedSize(true) ⑥ 异步 inflate |
| animation/Animator | 动画回调过长 | 检查多动画叠加 |
| decodeBitmap/BitmapFactory | 主线程图片解码 | Glide/Coil 异步加载 |
| SharedPreferences/sqlite | 主线程 IO | 短期:拆分SP+延迟读取; 中期:MMKV替代; 长期:Proto DataStore |
| Recomposition/compose: | Compose 重组过长 | Compose: ① items(key={it.id}) ② contentType 参数 ③ stability report 排查 ④ derivedStateOf/remember ⑤ 避免 composition 中创建 Modifier ⑥ snapshotFlow |

**workload_heavy 频率复核**：
- `big_avg_freq_mhz < device_peak_freq_mhz * 0.70` -> 标注"负载过重 + 频率不足"
- `big_avg_freq_mhz >= device_peak_freq_mhz * 0.70` -> 确认纯负载问题

**WHY 链深度要求**：每个 CRITICAL/HIGH 发现至少 2 级推理链：
- OK: "帧超时" -> "Binder 阻塞" -> "服务端 system_server monitor_contention"
- NG: 仅 "帧超时 45ms，workload_heavy"

### Phase 1 补充 E — 缺帧检测（条件触发）

| 触发条件 |
|----------|
| real_jank_count < 5 但存在 >=2 个滑动区间 |
| false_positive 占比 > 50% |
| 检测到 WebView/SurfaceTexture 架构 |
| 高刷设备（>=90Hz）且 token_gap 异常密集（>10% 帧有 gap>=2） |
| 连续 session 中某 layer 持续无新 buffer（layer starvation） |

使用 `frame_production_gap` SQL 模板，检测帧间隙：

| Gap 类型 | 含义 | 常见原因 |
|----------|------|---------|
| ui_no_frame | UI Thread 未触发 doFrame | 无触摸事件、滑动到底/顶 |
| rt_no_drawframe | 有 doFrame 但 RT 未执行 | 无 dirty 区域 |
| sf_backpressure | 有 DrawFrame 但未被 SF 消费 | SurfaceTexture 单 buffer |

### Phase 2 — 补充深钻（可选）

仅在 Phase 1.9 深钻后仍需更多细节时执行。使用 `jank_frame_detail` SQL 模板获取：
- CPU 频率时间线
- RenderThread/主线程 top N slices 详情
- 最多 2 帧

### Phase 3 — 综合结论

**输出结构必须遵循：**

**1. 概览**（必须包含）：
- 总帧数、总真实掉帧数 = SUM(所有 jank_type 的 real_jank_count)
- 分类明细：App 侧 N 帧 + 隐形掉帧 N 帧 + 假阳性 N 帧
- **峰值体验指标**：
  - 最长帧耗时 XXms（超预算 N 倍）
  - 最长连续丢帧 VSync 数
  - >3 帧超过 3x VSync 预算 -> 标注"存在用户强感知卡顿峰值"
- **综合评级**（掉帧率 + 峰值同时考虑）：
  - 优秀：掉帧率 <1% 且最长帧 <2x VSync
  - 良好：掉帧率 <3% 且最长帧 <4x VSync
  - 一般：掉帧率 <5% 或最长帧 <8x VSync
  - 差：掉帧率 >=5% 或最长帧 >=8x VSync
- 隐形掉帧说明（jank_type=None 但 real_jank_count > 0）

**2. 各滑动区间运行特征**：
- 主线程四象限：Q1/Q2/Q3/Q4
- RenderThread 四象限
- CPU 频率：prime/big/little 均频
- 关键线程大小核分布

**3. 全帧根因分布**（覆盖所有掉帧帧）：
```
| 根因类型 | 帧数 | 占比 | 四象限特征 | 频率特征 |
|---------|------|------|-----------|---------|
| workload_heavy | 80 | 59% | Q1=45% | 大核均频 2200MHz |
| freq_ramp_slow | 30 | 22% | Q1=30% | 大核均频 1100MHz |
```

**4. 代表帧分析**（每个根因类别选最严重的 1 帧）：
```
### [reason_code] 代表帧: [start_ts]
- 帧耗时：XXms（预算 XXms）
- 主线程：Q1=XX% Q2=XX% Q3=XX% Q4=XX%
- 关键操作：[top_slice_name] 耗时 XXms
- CPU 频率：均频 XXMHz / 峰频 XXMHz
- Binder: XXms / GC: XXms
```

**5. 优化建议**：按根因类别给出，优先级按帧数占比排序。
- **[App 层]**：异步化、分帧、预加载、减少主线程阻塞
- **[平台调度层]**：可直接执行的调度/频率/策略调优：
  - FPSGO 策略配置（场景识别 + per-architecture 参数）
  - uclamp.min（关键线程频率地板）
  - sugov 参数（升降频响应速度）
  - 急拉策略（触发阈值、目标频率、持续时间）
  - thermal governor（滑动场景是否需要放宽限频阈值）
  - Task placement（关键线程大核绑定策略）
- **[Framework 层]**：SF 合成策略、BufferQueue 参数、Choreographer 行为调整

**6. 平台策略审计**（如有 MTK vendor trace data）：
```
| 策略项 | 状态 | 评估 |
|--------|------|------|
| FPSGO 场景识别 | [命中/未命中] | 是否识别为正确的架构(HWUI/Flutter/WebView)？ |
| 急拉 | [触发 N 次/未触发] | 触发时机？目标频率？有效帧数？ |
| 频率地板 | [有/无, 地板 XXMHz] | 帧间是否深度降频？ |
| Task Placement | [大核 XX%] | 主线程/RenderThread 是否稳定大核？ |
| Thermal | [正常/限频中] | 限频幅度？是否是持续降频？ |
```

## SQL 回退方案

当 FrameTimeline 不可用或 scrolling_analysis 返回空时，使用以下 SQL 直接检测卡顿：

```sql
WITH vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
vsync_cfg AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER)
     FROM vsync_intervals
     WHERE interval_ns BETWEEN 4000000 AND 50000000),
    16666667
  ) as period_ns
),
frames AS (
  SELECT a.ts, a.dur, a.jank_type,
    a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END as present_ts,
    LAG(a.ts + CASE WHEN a.dur > 0 THEN a.dur ELSE 0 END)
      OVER (PARTITION BY a.layer_name ORDER BY a.ts) as prev_present_ts
  FROM actual_frame_timeline_slice a
  LEFT JOIN process p ON a.upid = p.upid
  WHERE (p.name GLOB '<process_name>*' OR '<process_name>' = '')
    AND p.name NOT LIKE '/system/%'
)
SELECT printf('%d', ts) AS start_ts, printf('%d', ts + dur) AS end_ts,
  ROUND(dur/1e6, 2) AS dur_ms, jank_type,
  CASE WHEN jank_type = 'None' OR jank_type IS NULL THEN 'HIDDEN' ELSE 'APP' END as responsibility,
  MAX(CAST(ROUND((present_ts - prev_present_ts) * 1.0 /
    (SELECT period_ns FROM vsync_cfg) - 1, 0) AS INTEGER), 0) as vsync_missed
FROM frames
WHERE prev_present_ts IS NOT NULL
  AND (present_ts - prev_present_ts) > (SELECT period_ns FROM vsync_cfg) * 1.5
ORDER BY vsync_missed DESC, dur DESC
LIMIT 20
```

然后对 Top 5 卡顿帧执行逐帧详情分析（见 `reference-sql-patterns.md` 中 `jank_frame_detail`）。

## Flutter 滑动分析

Flutter 应用需要不同的分析流程：

- **关键线程**：`1.ui`（Dart UI）和 `1.raster`（GPU rasterization），而非标准 RenderThread
- **TextureView 模式**：双出图管线（1.ui -> texture -> RenderThread updateTexImage -> composite）
- **SurfaceView 模式**：单出图管线（1.ui -> 1.raster -> BufferQueue -> SurfaceFlinger）
- **Jank 来源**：检查 1.ui 和 1.raster 线程的 depth=0 slice 是否超过 VSync 预算

**Impeller vs Skia backend**（Flutter 3.16+ 默认 Impeller on Android）：
- **Skia**: `1.raster` 线程有 `SkGpu*` / `GrGLGpu*` / `Skia` slice
- **Impeller**: `1.raster` 线程有 `EntityPass*` / `Impeller*` slice
- 分析时根据 slice 名称判断 backend 类型。Impeller 的渲染行为和性能特征与 Skia 不同（如 shader 预编译策略、纹理管理）。

详细 SQL 模板见 `reference-sql-patterns.md` 中 `flutter_scrolling_analysis` 部分。

## Phase 4 — 对比分析模式（问题机 vs 对比机）

当 QA 同时提供问题机和对比机的 trace 时，在 Phase 1-3 完成各自独立分析后，执行对比分析。

### 前置条件

- 两个 trace 已分别完成 Phase 1-3 的独立分析
- 两个 trace 来自同一 App 的同一滑动操作
- 使用 `scripts/load_dual_traces.sh` 加载到不同端口

### 跨厂商对比注意

当对比机是**非 MTK 平台**（如高通）时：
- **CPU 拓扑不同**：对每个 trace 独立识别大小核配置（见 `reference/comparison-methodology.md` 第 4.5 节的自动检测 SQL）
- **频率用占峰值百分比归一化**，帧耗时用超预算倍数归一化
- **vendor trace 不对称**：对比机无 FPSGO 数据，MTK 策略审计单独报告
- **VSync/刷新率可能不同**：用掉帧率和超预算倍数比较，不直接比帧率

### 对比维度与归因框架

| 对比维度 | 关键指标 | 显著差异阈值 | 差异归因方向 |
|---------|---------|------------|------------|
| **卡顿率** | jank_rate, perceived_jank_frames | >2x 或绝对差 >5% | 综合入口 |
| **帧率** | actual_fps | >10% | 渲染能力差异 |
| **峰值卡顿** | max_frame_ms, max_vsync_missed | >2x | 极端场景差异 |
| **根因分布** | reason_code 占比 | 某类占比差 >15% | 系统瓶颈类型不同 |
| **四象限分布** | Q1/Q2/Q3/Q4 | Q2差>10%, Q3差>5% | CPU 调度差异 |
| **CPU 频率** | big_avg_freq (掉帧帧) | >15% | governor/thermal 差异 |
| **Binder/GC 重叠** | avg binder_overlap, gc_overlap | >2x | 系统服务响应差异 |
| **VSync 周期** | vsync_period_ns | 不同刷新率 | 硬件刷新率差异（需归一化） |
| **Thermal 状态** | thermal_trending, freq ceiling | 一方有限频 | 散热差异 |
| **帧生产 Gap** | gap_count (缺帧) | 一方有一方无 | BufferQueue/SF 差异 |

### 归一化注意事项

- **不同刷新率**：60Hz vs 120Hz 的设备不能直接比帧率。用"掉帧率"和"超预算倍数"（frame_ms / vsync_budget）做归一化比较
- **不同 SoC**：CPU 频率绝对值不可比，用"实际频率 / 设备峰值频率"的比率比较
- **reason_code 分布**：用百分比比较而非绝对帧数

### Android 版本差异维度

当两个 trace 来自**不同 Android 版本**（如 15 vs 16）时，需额外分析：
- **系统行为变化**：渲染管线流程变更（HWUI/SF）、帧调度策略、线程模型变化 — 对比 slice 名称列表取 diff
- **App 适配缺失**：废弃 API 兼容层、新权限检查导致的 Binder 增加、compat 模式开销
- 详细检测 SQL 见 `reference/comparison-methodology.md` 第 5.5 节

### 对比分析步骤

**Step 4.1 — 基线指标提取**：对两个 trace 执行相同 SQL，提取关键指标。如果 Android 版本不同，额外执行 slice/线程差异检测。

**Step 4.2 — Delta 计算**：逐维度计算差异值和差异率

**Step 4.3 — 差异归因**（同 App 不同设备）：
1. **平台滑动策略差异**（最高优先级）：FPSGO 配置、急拉策略、频率地板、per-architecture 策略——两台设备的滑动策略配置不同是最常见的根因
2. **设备能力差异**：CPU/GPU 性能天花板、刷新率、RAM
3. **系统调度差异**：governor 参数、thermal 策略、EAS 配置
4. **运行状态差异**：内存压力、后台负载、thermal 状态
5. **App 行为差异**（排除项）：同一 App 同一版本通常不是 App 问题

### 对比结论输出格式

```
## 对比分析：问题机 vs 对比机

### 滑动性能对比
| | 问题机 | 对比机 |
|---|---|---|
| 卡顿率 | XX% (N帧) | YY% (M帧) |
| 帧率 | XX fps | YY fps |
| 最长卡顿 | XXms (Nx VSync) | YYms (Mx VSync) |
| 刷新率 | XXHz | YYHz |

### 根因分布差异
| reason_code | 问题机 | 对比机 | 差异 |
|-------------|--------|--------|------|
| workload_heavy | 59% | 20% | +39% |
| thermal_throttling | 22% | 0% | +22% ← 关键差异 |

### 关键差异分析

**[差异 1] Thermal 限频 — 贡献 22% 额外掉帧**
- 问题机：大核均频 1200MHz（峰值 50%），thermal_trending = 1
- 对比机：大核均频 2200MHz（峰值 92%），无限频
- 归因：问题机散热不足导致持续降频
- 建议：[系统层] 检查 thermal_zone 温度曲线
```

详细对比 SQL 模板见 `reference/comparison-methodology.md`。

## 知识参考

渲染管线机制、Binder IPC、GC、CPU 调度、温控、锁竞争等背景知识见 `reference/knowledge-overview.md`。

各分析步骤的完整 SQL 模板见 `reference/sql-patterns-overview.md`。