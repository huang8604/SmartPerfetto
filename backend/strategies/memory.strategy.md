<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: memory
priority: 4
effort: medium
required_capabilities:
  - gc_memory
  - memory_pressure
optional_capabilities:
  - cpu_scheduling
  - binder_ipc
keywords:
  - 内存
  - memory
  - oom
  - 泄漏
  - leak
  - lmk
  - 内存压力
  - 内存不足
  - low memory
  - out of memory
  - dmabuf
  - 内存占用
compound_patterns:
  - "内存.*泄漏"
  - "内存.*压力"
  - "内存.*不足"
  - "memory.*leak"
  - "memory.*pressure"
---

#### 内存分析（用户提到 内存、memory、OOM、泄漏、LMK）

#### 内存场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_garbage_collection_events`、`android_oom_adj_intervals`、`android_screen_state`

**Phase 1 — 内存概览（1 次调用）：**
```
invoke_skill("memory_analysis")
```
返回：内存使用趋势、RSS/PSS 分布、内存分类统计。

**Phase 2 — LMK 分析（如果有 LMK 事件）：**
```
invoke_skill("lmk_analysis")
```
返回：LMK 事件列表、被杀进程、OOM-adj 分布、重启循环检测。

**Phase 3 — 深度分析（按需选择）：**

| 信号 | 工具 | 何时使用 |
|------|------|---------|
| GPU 内存 / DMA-BUF | `invoke_skill("dmabuf_analysis")` | 图形密集应用的 GPU 内存分析 |
| GC 压力 | `invoke_skill("gc_analysis")` | Java 堆内存问题、频繁 GC |
| 页缺失 | `execute_sql` 查询 `page_fault` | 内存映射文件访问延迟 |
| 系统内存压力 | `invoke_skill("memory_pressure_in_range", { start_ts, end_ts })` | 特定时间段的内存压力事件 |

**Phase 4 — 交叉分析：**
- 内存压力 + LMK → 检查是否有进程被反复杀死重启（thrashing）
- GC 频繁 + 内存增长 → 可能存在 Java 对象泄漏
- DMA-BUF 增长 → GPU 内存泄漏（纹理/Buffer 未释放）
- 内存压力 + ANR → 系统内存不足导致的 ANR（非 App 代码 Bug）

**输出结构：**

1. **内存概览**：总内存、已用内存、可用内存、趋势（增长/稳定/下降）
2. **LMK 事件**（如有）：被杀次数、受影响进程、OOM-adj 分布
3. **内存热点**：内存占用最大的进程/组件
4. **根因分析**：泄漏证据、压力来源
5. **优化建议**：按内存类型（Java 堆/Native/GPU/文件映射）分类