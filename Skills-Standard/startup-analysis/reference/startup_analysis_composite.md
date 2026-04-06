<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 应用启动分析 (startup_analysis) — 组合 Skill

全方位的应用启动性能分析，是启动分析的顶层入口。包含启动事件定位、数据质量门禁、延迟归因、主线程分析、Binder 分析、状态分析、类加载、GC、调度延迟、逐事件详情迭代、诊断规则和证据矩阵。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名（不填则分析所有启动事件） |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤（cold/warm/hot） |
| start_ts | timestamp | 否 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 否 | - | 启动区间结束时间戳(ns) |
| analysis_mode | string | 否 | full | 分析模式：full（完整）或 overview（仅定位启动事件） |
| enable_startup_details | boolean | 否 | true | 是否执行逐个启动事件详情分析 |

## 步骤编排

```
get_startups (启动事件定位)
    │
    ▼
startup_quality (数据质量门禁)
    │ ── BLOCKER → 停止深挖
    ▼
┌─────────────────────────────────────────────────┐
│  以下步骤并行执行（condition: analysis_mode=full  │
│  && blocker_count=0）                            │
├─────────────────────────────────────────────────┤
│  startup_breakdown     → 启动延迟归因分析         │
│  main_thread_slices    → 主线程关键 Slice Top15   │
│  main_thread_file_io   → 主线程文件 IO Top15      │
│  startup_binder        → Binder 调用分析          │
│  main_thread_sync_binder → 主线程同步 Binder       │
│  main_thread_binder_blocking → Binder 阻塞分析    │
│  main_thread_state     → 主线程状态分布           │
│  class_loading         → 类加载分析              │
│  gc_during_startup     → GC 影响分析             │
│  sched_latency         → 调度延迟分析            │
└─────────────────────────────────────────────────┘
    │
    ▼
analyze_startups (Iterator: 逐个启动事件调用 startup_detail)
    │
    ▼
startup_diagnosis (诊断规则引擎)
    │
    ▼
startup_evidence_matrix (证据矩阵)
```

### 步骤详情

| Step ID | 类型 | 调用 Skill | 用途 |
|---------|------|-----------|------|
| get_startups | skill | startup_events_in_range | 定位所有启动事件，含类型校验 |
| startup_quality | atomic | (内联 SQL) | 数据质量门禁：检测 invalid_duration、TTID/TTFD 异常、类型重分类等 |
| startup_breakdown | skill | startup_breakdown_in_range | 启动延迟归因（opinionated_breakdown） |
| main_thread_slices | skill | startup_main_thread_slices_in_range | 主线程耗时操作 Top15 |
| main_thread_file_io | skill | startup_main_thread_file_io_in_range | 主线程文件 IO Top15 |
| startup_binder | skill | startup_binder_in_range | 启动期间 Binder 调用 |
| main_thread_sync_binder | skill | startup_main_thread_sync_binder_in_range | 主线程同步 Binder |
| main_thread_binder_blocking | skill | startup_main_thread_binder_blocking_in_range | 主线程 Binder 阻塞（深度 JOIN） |
| main_thread_state | skill | startup_main_thread_states_in_range | 主线程状态分布 |
| class_loading | skill | startup_class_loading_in_range | 类加载分析 |
| gc_during_startup | skill | startup_gc_in_range | GC 影响分析 |
| sched_latency | skill | startup_sched_latency_in_range | 调度延迟分析 |
| analyze_startups | iterator | startup_detail | 逐个启动事件详细分析 |
| startup_diagnosis | diagnostic | - | 诊断规则引擎（13+ 条规则） |
| startup_evidence_matrix | atomic | (内联 SQL) | 证据矩阵（主指标 + 佐证双证据） |

### 参数传递流

```
get_startups 输出 → startups (数组)
    → analyze_startups 迭代：每个 startup 的 startup_id/start_ts/end_ts/dur_ms/package/startup_type 传入 startup_detail
    → startup_diagnosis 使用所有 save_as 结果做规则判定
    → startup_evidence_matrix 引用各步骤的第一行数据做交叉验证
```

### 诊断规则（关键规则摘要）

| 条件 | 严重度 | 诊断 |
|------|--------|------|
| blocker_count > 0 | critical | 数据质量阻断 |
| 冷启动 > 2s | critical | 冷启动时间过长 |
| 冷启动 1-2s | warning | 冷启动时间偏长 |
| 温启动 > 1s | critical | 温启动严重偏长 |
| 热启动 > 500ms | critical | 热启动严重偏长 |
| Binder 占比 > 20% + 主线程证据 | warning | Binder 调用占比过高 |
| 主线程 Running < 50% + 阻塞/调度证据 | warning | 主线程 Running 比例偏低 |
| 主线程 GC > 3% | warning | GC 影响 |
| 调度延迟 > 8ms 次数 > 3 | warning | 调度延迟偏高 |
| 类加载 > 15%（需双证据） | info | 类加载耗时 |

## 使用说明

- **前置模块**: `android.startup.startups`, `android.startup.time_to_display`, `android.startup.startup_breakdowns`, `android.binder`
- 数据质量门禁检测 7 类问题：invalid_duration、TTID/TTFD 异常小、TTID/TTFD 超出 dur、TTFD < TTID、类型重分类
- 诊断规则采用"主指标 + 佐证"双证据模式，降低假阳性
- 证据矩阵将主指标和佐证指标并列展示，状态分为 confirmed/needs_corroboration/normal
- `analysis_mode=overview` 时只执行 get_startups，跳过所有深度分析