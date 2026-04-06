<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Skills-Standard 专家团队 Review 报告

日期: 2026-04-04
审查范围: Skills-Standard/ 全部 81 个文件
审查团队: SoC 硬件专家、Kernel 专家、Framework 专家、App 专家、性能优化专家（总审）

## 总体评价

方法论设计体现了大厂多年实战经验：21 种根因分类码的优先级决策树、四象限交叉分析、双信号掉帧检测、guilty frame 溯源、per-architecture 策略分支、MTK 全栈策略审计——这些都是业界顶级水平。

但从"投入使用后 Claude 能否正确执行"的角度，有若干结构性问题需修复。

## P0 — 必须修复（10 个，去重合并后）

### P0-1 [性能+SoC] reason_code 决策树 SKILL.md vs knowledge-overview 严重不一致
- SKILL.md 的 21 条 vs knowledge-overview 的详细 CASE 树：阈值不同（thermal 0.7 vs 0.60）、优先级不同（cpu_max_limited P3 vs P4.6）、条目缺失（SKILL.md 无 buffer_stuffing/binder_sync_blocking）
- **修复**: 以 knowledge-overview 为准同步 SKILL.md

### P0-2 [性能] 参数化风格 `${param}` vs `<param>` 混用（145 vs 369 处）
- sql-patterns-overview 用 `${}`，独立 reference 用 `<>`
- **修复**: 全局统一为一种

### P0-3 [性能] startup comparison 错误包含 scrolling 的 batch_frame_root_cause SQL
- **修复**: 删除 startup comparison-methodology.md 中的 Section 3

### P0-4 [SoC] CPU 拓扑 `<big_core_start>` 假设 CPU ID 有序排列
- 高通 8 Gen 3 大核在 CPU0，MTK 某些型号大核在 CPU7
- **修复**: 改用 `_cpu_topology.core_type` JOIN 或频率分簇结果

### P0-5 [SoC] CPU 拓扑自动检测在全大核 SoC (Dimensity 9300) 上误判
- A720 被标为 little（freq ratio 0.62 卡在边界）
- **修复**: 优先用 stdlib `_cpu_topology`，频率分簇仅作 fallback，阈值可配

### P0-6 [Kernel+Framework] `binder_wait_for_work` 在 blocked_function 映射中含义写反
- 它是 Binder 线程池空闲等待，不是客户端同步阻塞。客户端阻塞应是 `binder_ioctl`
- **修复**: 从"同步 Binder 阻塞"分类中移除，改为"Binder 线程池空闲（正常）"

### P0-7 [Kernel] `android_binder_txns.is_main_thread` 列在 Perfetto stdlib 中不存在
- 需要通过 `client_utid` JOIN thread 表判断
- **修复**: 修正 SQL

### P0-8 [Framework] token-gap 模型描述与实际实现不一致
- SKILL.md 核心原则强调 token-gap，但 consumer_jank_detection 已改用 present_ts interval
- **修复**: 核心原则改为 present_ts interval 为主，token_gap 为辅

### P0-9 [Framework] present_type + Buffer Stuffing 的描述不准确
- BS 帧的 present_type 不一定是 Late Present（可以是 Early/On-Time）
- **修复**: 修正描述，强调用 present_ts 间隔做二次验证

### P0-10 [SoC+Kernel] Thermal 限频检测无法区分 governor 正常行为 vs 真正 thermal
- 仅看 `big_max_freq < peak * 0.7` 产生大量假阳性
- **修复**: 要求 thermal_zone 温度证据或频率天花板持续下降作为补充条件

## P1 — 建议修复（Top 15，按影响排序）

| # | 来源 | 问题 |
|---|------|------|
| P1-1 | Kernel | 四象限缺少 DK 状态 + blocked_function 依赖 CONFIG_SCHEDSTATS 未在主方法论说明 |
| P1-2 | 性能 | reference 文件无按需加载指引，36 个文件一次加载 token 爆炸 |
| P1-3 | SoC | device_peak_freq 可能取到 boost 频率，应改用 P99 或 scaling_max_freq |
| P1-4 | SoC | GPU DVFS 分析严重不足（无频率-负载关联，无 Mali vs Adreno 区分） |
| P1-5 | SoC+Kernel | IPC 差异被频率归一化掩盖 + WALT vs PELT 未区分 + uclamp.max 未提及 |
| P1-6 | App | SP 建议过简(缺 MMKV)、Baseline Profile 缺实施细节、RecyclerView 核心优化(GapWorker/DiffUtil)未覆盖 |
| P1-7 | Framework | Guilty Frame "2-3 帧"过于绝对，BLAST 模型下管线深度动态变化 |
| P1-8 | Framework | GC 类型缺少 CC (Concurrent Copying) 说明，trace 中实际是 `concurrent copying GC` |
| P1-9 | Framework | Flutter 未区分 Impeller vs Skia backend |
| P1-10 | Framework | WebView 单 buffer 问题仅适用于 Android 11-，12+ 已迁移到 BLAST/SurfaceControl |
| P1-11 | Kernel | kswapd 检测 SQL 用错了表（slice vs sched_slice） |
| P1-12 | Kernel | schedutil ramp-up delay 数值不准（应 2-10ms 而非 10-30ms） |
| P1-13 | 性能 | Phase 编号混乱（Phase 1.3 vs Step 1.3 冲突） |
| P1-14 | App | Compose LazyColumn 优化建议不足（缺 key/contentType/stability） |
| P1-15 | Framework | `jank_type` 缺少 Display HAL 和 Prediction Error 类型映射 |

## P2 — 可选改进（精选 10 个）

| # | 来源 | 问题 |
|---|------|------|
| P2-1 | SoC | VSync 吸附缺少 80Hz |
| P2-2 | SoC | 缺少 interconnect/NoC 带宽瓶颈检测 |
| P2-3 | SoC | C-state exit latency 对升频延迟的影响未量化 |
| P2-4 | Kernel | direct_reclaim blocked_function 缺 throttle_direct_reclaim/congestion_wait |
| P2-5 | Kernel | cgroup v1→v2 迁移未提及 |
| P2-6 | App | 缺 ANR 超时阈值警告、SplashScreen API 注意事项、WorkManager 初始化影响 |
| P2-7 | 性能 | 滑动 SQL 回退方案缺四象限数据 |
| P2-8 | 性能 | 11 个完全重复的 reference 文件带维护同步风险 |
| P2-9 | 性能 | capture 脚本缺 MTK vendor trace tags |
| P2-10 | Framework | 缺帧 rt_no_drawframe 可能误判正常行为（无 dirty 区域时不触发 DrawFrame 是正常的） |

## 亮点（跨专家共识）

1. **双信号掉帧检测** (present_type + present_ts interval) — 5/5 专家认可
2. **四象限 + blocked_functions 交叉分析决策树** — 4/5 专家认可
3. **21 种 reason_code 优先级 CASE 树** — 4/5 专家认可其设计精良
4. **MTK 全栈策略审计框架** — 3/5 专家认为是差异化能力
5. **per-slice 线程状态分析 (hot_slice_states)** — 3/5 专家认可
6. **启动类型多信号校验** — Framework 专家特别认可
7. **阻塞链因果追溯** (waker_utid → waker_current_slice) — Kernel 专家认可
8. **knowledge-data-sources.md 数据采集指南** — Kernel + SoC 专家认可