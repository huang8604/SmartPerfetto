<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: runtime-correctness
priority: 5
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - memory_pressure
  - binder_ipc
  - lock_contention
keywords:
  - runtime
  - correctness
  - anr
  - oom
  - lmk
  - leak
  - memory leak
  - native heap
  - heapprofd
  - 运行时
  - 正确性
  - 内存泄漏
  - 崩溃
  - 卡死
  - 杀进程
compound_patterns:
  - "(运行时|内存|ANR|OOM|LMK).*(正确性|泄漏|卡死|杀进程)"
  - "(runtime|memory|anr|oom|lmk).*(correctness|leak|freeze|kill)"

phase_hints:
  - id: anr_chain
    keywords: ['ANR', '卡死', 'freeze', 'binder', 'lock', 'monitor']
    constraints: 'ANR/卡死先调用 anr_analysis；若定位到具体 ANR 事件，再用 anr_detail 深钻。'
    critical_tools: ['anr_analysis', 'anr_detail']
    critical: false
  - id: memory_growth
    keywords: ['leak', 'growth', 'RSS', 'swap', '内存泄漏', '内存增长']
    constraints: '内存增长/泄漏先调用 memory_growth_detector；涉及 LMK/OOM 时补 lmk_kill_attribution 和 oom_adjuster_score_timeline。'
    critical_tools: ['memory_growth_detector', 'lmk_kill_attribution', 'oom_adjuster_score_timeline']
    critical: true
  - id: native_heap
    keywords: ['native heap', 'heapprofd', 'malloc', 'C++', 'native 内存']
    constraints: 'native heap 问题调用 native_heap_breakdown。无 heapprofd 数据时必须说明 trace 不支持 native heap attribution。'
    critical_tools: ['native_heap_breakdown']
    critical: false

plan_template:
  mandatory_aspects:
    - id: runtime_primary_signal
      match_keywords: ['anr_analysis', 'memory_growth_detector', 'native_heap_breakdown', 'lmk_kill_attribution', 'ANR', '内存', 'runtime']
      suggestion: '运行时正确性场景需要至少包含 ANR、内存增长、LMK/OOM 或 native heap 的一条主证据链'
---

#### 运行时正确性分析

运行时正确性关注"卡死、被杀、内存持续增长、native heap 泄漏"这类不是单纯帧时序的问题。

**Phase 1 — 选择主证据链：**

| 问题 | 调用 |
|---|---|
| ANR / 卡死 / 主线程无响应 | `invoke_skill("anr_analysis")`；有具体事件后 `invoke_skill("anr_detail", ...)` |
| 内存增长 / 疑似泄漏 | `invoke_skill("memory_growth_detector", { package: "<包名>" })` |
| LMK / OOM adj | `invoke_skill("lmk_kill_attribution")` + `invoke_skill("oom_adjuster_score_timeline", { package: "<包名>" })` |
| Native heap / heapprofd | `invoke_skill("native_heap_breakdown")` |

**Phase 2 — 交叉验证：**

内存增长需要和 GC、LMK、OOM adj、page fault/reclaim 区分；ANR 需要和 Binder、锁、IO、调度延迟区分。没有对应 trace 数据时必须标注不支持该维度。
