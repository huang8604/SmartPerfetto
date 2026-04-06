<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Perfetto 文档对照差距报告

基于 perfetto/docs/ 全部 105 个文档与 Skills-Standard 的交叉对比。
5 个 Agent 并行审查：FrameTimeline+GPU、Analysis+Metrics、Case Studies、Memory+Data Sources、Reference+Version Notes。

## CRITICAL — 必须补充

### G1. Android 版本特定数据可用性未说明
- 两个 SKILL.md 都没有标注哪些分析依赖特定 Android 版本
- FrameTimeline 需要 Android 12+；sched_blocked_reason 需要 CONFIG_SCHEDSTATS
- android-version-notes.md 有版本特有的注意事项（如 Android T- 的 CLONE_SNAPSHOT 问题）
- **建议**：两个 SKILL.md 各加 "Android 版本要求" 小节

### G2. Perfetto SQL 高级特性完全未使用
- 未使用 `INCLUDE PERFETTO MODULE`（stdlib 模块可预计算 70% 查询）
- 未使用 `CREATE PERFETTO TABLE/FUNCTION/MACRO`（SQL 全部是内联 CTE）
- 未使用 `SPAN_JOIN` 做时间重叠检测（Binder/GC overlap 手动计算）
- 未使用 `EXTRACT_ARG` helper
- 未使用 `ancestor_slice` / `descendant_slice` 层级遍历
- 未使用 `FOLLOWING_FLOW` / `PRECEDING_FLOW` 做 Binder 因果追踪
- **建议**：在 reference 中添加 "Perfetto SQL 高级特性指南"

### G3. Trace 配置最佳实践缺失
- capture 脚本没有多 buffer 策略（ftrace 高频 vs memory 低频应分 buffer）
- 没有 trigger 配置（STOP_TRACING 模式用于难复现卡顿）
- 没有 buffer 大小计算指导（~1-4 MB/s 典型速率）
- **建议**：更新 capture 脚本 + 在 SKILL.md 中增加 "Trace 配置建议"

## HIGH — 建议补充

### G4. GPU 分析严重不足
- 只靠 slice 名称匹配检测 GPU fence wait，未使用 GPU counter tracks
- 未做 GPU 频率与帧耗时的关联分析
- HWC 合成 vs GPU 回退合成未在 reason_code 中区分
- **建议**：补充 GPU frequency/utilization 查询，区分 HWC/GPU composition

### G5. CPU Idle (cpuidle) 状态分析缺失
- cpuidle counter tracks（C-state 深度）完全未使用
- 帧间 CPU 进入深 idle 是 ramp-up delay 的重要来源
- **建议**：在 MTK 调度深钻中补充 cpuidle 分析

### G6. sched_waking 唤醒延迟未分析
- 只用 sched_slice 看线程占用，未分析唤醒延迟和跨 CPU 迁移成本
- 对阻塞链分析（waker 追踪）有直接价值
- **建议**：在阻塞链分析 reference 中补充 sched_waking 使用

### G7. Memory 分析维度不足
- 未使用 `mem.mm.maj_flt` / `mem.mm.min_flt` 区分 major/minor page fault
- 未使用 `/proc/vmstat` counters（NR_FREE_PAGES 等）做内存压力基线
- 未使用 `mem.rss.watermark` 追踪 RSS 峰值
- 未集成 Java heap dump（android.java_hprof）用于 GC 根因的对象级分析
- **建议**：在 memory_pressure_in_range reference 中补充这些数据源

### G8. Prediction Error 处理可能不正确
- 当前 Skill 标记 Prediction Error 为"可忽略"
- 但 Perfetto 文档说 Prediction Error 帧确实会导致显示延迟（管线 2-3 帧缓冲意味着用户会感知）
- **建议**：将 Prediction Error 从"可忽略"改为"需区分：prediction drift 导致的轻微延迟 vs 真正的帧丢失"

### G9. Flight-Recorder 触发模式未提及
- Perfetto 支持 STOP_TRACING trigger 用于"持续录制 + 事件触发停止"
- 适合难复现的偶发卡顿场景
- **建议**：在 capture 脚本和 SKILL.md 中增加触发式抓取配置

### G10. Android Logcat 未集成
- `android.log` 数据源可以在 trace 中同步 Logcat（ANR、GC 警告、Binder 超时）
- 对启动分析特别有用（可检测 ANR、StrictMode 违规、GC 警告）
- **建议**：在 trace 配置中推荐开启 android.log

## MEDIUM — 可选改进

### G11. CPU Profiling (Stack Sampling) 未利用
- Perfetto 支持 `linux.perf` 数据源做 callstack sampling
- 对 Q1 > 70% 的 CPU-bound 场景，可以通过 flamegraph 定位热点函数
- **建议**：添加 "可选：CPU Profiling 深钻" 指南

### G12. FrameTimeline 字段未充分利用
- `is_buffer` 字段（区分 buffer 帧 vs animation 帧）未使用
- `prediction_type` 字段（Expired/Valid prediction）未验证
- 多 Layer 场景下的跨 Layer 因果分析缺失
- **建议**：在 scrolling reference 中补充这些字段的使用

### G13. end_state 解码过度简化
- thread_state.end_state 有 14 种值（R+, W, P, N, K, X, Z 等）
- 当前只分为 Running/S/D/R 四类，丢失了 "R+"（被高优先级抢占）等重要信息
- **建议**：在四象限分析中标注 R+ 和 DK 的特殊含义

### G14. Power Rail (ODPM) 数据未使用
- Android 设备的子系统级功耗数据可直接解释 thermal 触发原因
- Battery counter (current_ua/voltage_uv) 可关联功耗与频率
- **建议**：在 thermal 分析中补充 power rail 查询

### G15. Stdlib 内置 Metric 可简化查询
- `android_startup` metric 可替代启动分析中的部分手写 SQL
- `android_jank` / `android_frame_timeline_metric` 可简化滑动分析
- **建议**：在 sql-patterns-overview 中标注哪些查询有等效内置 metric