<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# SurfaceFlinger 分析 (surfaceflinger_analysis) - Composite Skill v3.0

分析 SurfaceFlinger 帧合成性能，包括 GPU/HWC 合成比例、慢合成检测和 Fence 等待。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名（可选，用于关联应用与 SF 交互） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| slow_composition_multiplier | number | 否 | 1.5 | 慢合成判定倍数（超过 VSync 周期该倍数） |
| composition_rating_poor_ms | number | 否 | 12 | 合成评级-较差阈值(ms) |
| composition_rating_fair_ms | number | 否 | 8 | 合成评级-一般阈值(ms) |
| composition_rating_good_ms | number | 否 | 4 | 合成评级-良好阈值(ms) |
| long_fence_threshold_ms | number | 否 | 10 | 长 Fence 等待阈值(ms) |
| fence_critical_ms | number | 否 | 16 | Fence 严重程度-critical 阈值(ms) |
| fence_warning_ms | number | 否 | 8 | Fence 严重程度-warning 阈值(ms) |
| slow_pct_threshold | number | 否 | 10 | 慢合成占比阈值(%) |
| gpu_comp_ratio_threshold | number | 否 | 0.5 | GPU 合成比例阈值 |

## 前置条件

- 必需模块: `android.frames.timeline`

## 步骤编排

### Step 1: data_check - L0 数据源检测

检测 SurfaceFlinger 进程是否存在，以及是否有合成数据（onMessageInvalidate/onMessageRefresh/composite slice）。

### Step 2: vsync_config - L1 VSync 配置

从 VSYNC-sf counter 计算 VSync 周期和刷新率。

### Step 3: composition_overview - L1 合成概览

统计合成性能: 总合成数、平均/最大/P95 合成耗时、慢合成次数、评级（优秀/良好/一般/较差）。

### Step 4: gpu_hwc_stats - L1 GPU/HWC 合成统计（可选）

区分 GPU 合成 vs HWC 合成的帧数、占比、平均/最大耗时。GPU 合成比例高通常意味着更高功耗。

### Step 5: slow_compositions - L2 慢合成列表

列出 dur > slow_composition_multiplier * VSync 的合成事件。包含时间、合成耗时、事件名、错过 VSync 数、严重程度(critical/warning/notice)。最多 30 条。

### Step 6: fence_analysis - L2 Fence 等待分析（可选）

列出 Fence 等待事件（fence/GPU completion/Waiting for GPU slice）。dur > 1ms 的条目按耗时降序。严重程度基于 fence_critical_ms/fence_warning_ms 阈值。

### Step 7: composition_phases - L2 合成阶段分布（可选）

将合成 slice 按阶段分类: Invalidate, Refresh, Composite, Latch Buffer, Update Texture, Post Composition, Present, Commit。统计各阶段的次数、总耗时、平均/最大耗时、时间占比。

### Step 8: layer_stats - L2 活跃 Layer 统计（可选）

统计各 Layer 的帧数、总耗时、平均耗时。最多 20 个 Layer。

### Step 9: root_cause_classification - 根因分类

SQL 驱动的根因分类:

| 分类 | 条件 |
|------|------|
| COMPOSITION_SLOW | 慢合成占比 > 10% 且平均合成耗时 > 12ms |
| GPU_COMPOSITION_HEAVY | GPU 合成 > 总合成 50% 且平均耗时 > 8ms |
| FENCE_TIMEOUT | 长 Fence > 5 次且最大 > 16ms |
| OCCASIONAL_SLOW | 存在慢合成但不严重 |
| NORMAL | 合成性能正常 |

### Step 10: fallback_no_sf_data - 无数据回退

**条件**: `has_sf_process === 0`

提示 SurfaceFlinger 进程不存在，建议 trace 包含 surfaceflinger category。

## 参数流

```
data_check -> vsync_config -> composition_overview -> slow_compositions
                           -> gpu_hwc_stats
                           -> fence_analysis
                           -> composition_phases
                           -> layer_stats
                           -> root_cause_classification
```

## 输出结论

```yaml
conclusion:
  category: $conclusion.sf_category       # COMPOSITION_SLOW / GPU_COMPOSITION_HEAVY / FENCE_TIMEOUT / OCCASIONAL_SLOW / NORMAL
  confidence: $conclusion.confidence       # 0.6 - 0.85
  summary: $conclusion.root_cause_summary  # 根因描述
  evidence: $conclusion.evidence           # 关键证据 JSON
  suggestion: $conclusion.suggestion       # 优化建议
```

## 触发关键词

- 中文: SurfaceFlinger, SF, 合成, GPU 合成, HWC 合成, VSYNC, 显示合成, fence, 帧合成
- 英文: surfaceflinger, sf, composition, gpu composition, hwc, vsync, display, fence