<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 热节流分析 (thermal_throttling) - Composite Skill v3.0

分析系统温度、热节流对 CPU 频率和性能的影响。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名（可选） |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| enable_expert_probes | boolean | 否 | true | 是否启用专家探针 |
| thermal_predictor_high_drop_pct | number | 否 | 30 | 热预测高风险的平均降频阈值(%) |
| thermal_predictor_medium_drop_pct | number | 否 | 15 | 热预测中风险的平均降频阈值(%) |
| thermal_predictor_high_core_ratio_pct | number | 否 | 50 | 热预测高风险的限频核心占比阈值(%) |
| thermal_predictor_medium_core_ratio_pct | number | 否 | 25 | 热预测中风险的限频核心占比阈值(%) |
| thermal_predictor_core_drop_threshold_pct | number | 否 | 30 | 判定单核心疑似限频的降频阈值(%) |
| gpu_transition_threshold_pct | number | 否 | 12 | GPU 升降频判定阈值(%) |
| gpu_downshift_warning_pct | number | 否 | 25 | GPU 降频占比告警阈值(%) |

## 前置条件

- 必需表: `counter`

## 温度单位处理

部分设备上报 millidegrees（值 > 1000），需归一化为摄氏度。Skill 内部自动处理: `CASE WHEN c.value > 1000 THEN c.value / 1000.0 ELSE c.value END`。

## 步骤编排

### Step 1: data_check - L0 数据检测

检测三类数据源是否存在:
- has_thermal_data: counter_track 中含 thermal/temp/temperature/tsens
- has_freq_data: cpu_counter_track 中含 cpufreq
- has_gpu_freq_data: android_gpu_frequency 表/视图是否存在

### Step 2: expert_analysis_window - L0 分析时间窗

确定分析窗口: 用户传入优先，否则用观测数据边界自动推断。

### Step 3: thermal_predictor_probe (skill: thermal_predictor) - L0 热风险预测

专家探针。比较区间初段和末段的 CPU 频率变化:
- 高风险: 平均降幅 > 30% 或限频核心占比 > 50%
- 中风险: 平均降幅 > 15% 或限频核心占比 > 25%
- 低风险: 降幅在阈值以下

### Step 4: thermal_overview - L1 温度传感器概览

按传感器汇总: 采样数、最低/最高/平均温度、温度波动、评级。

评级: 严重过热(>80C) / 温度偏高(>60C) / 温度正常(>45C) / 温度良好(<=45C)。

### Step 5: cpu_freq_overview - L1 CPU 频率概览

按 CPU 核心统计: 最低/最高/平均频率、采样数、节流比例、状态。

节流状态: 严重节流(min < 30% max) / 显著节流(< 50%) / 中度节流(< 70%) / 正常。

### Step 6: gpu_power_probe (skill: gpu_power_state_analysis) - L1 GPU 功耗状态

GPU DVFS 探针，分析 GPU 频率变化、降频次数和降频占比。

### Step 7: thermal_timeline - L2 温度变化时间线

按时间排列的温度采样，均匀采样（每传感器最多 100 条）+ 高温/突变点保留。

### Step 8: frequency_drop_events - L2 频率骤降事件

CPU 频率骤降事件（降幅 > 30%）。严重程度基于最大频率的比例: critical(< 30%) / warning(< 50%) / notice。

### Step 9: thermal_freq_correlation - L2 温度-频率相关性

按秒聚合温度和频率数据，检测热节流关联:
- thermal_throttled: 温度 > 70C 且频率 < 50% 最大
- moderate_throttle: 温度 > 60C 且频率 < 70%
- high_temp: 温度 > 60C
- normal: 其他

### Step 10: high_temp_periods - L2 高温时段识别

识别温度 > 60C 的持续时段: 开始/结束时间、持续秒数、峰值温度。

### Step 11: root_cause_classification - 根因分类

SQL 驱动的根因分类:

| 分类 | 条件 |
|------|------|
| THERMAL_THROTTLING | > 4 核严重降频且峰值 > 70C，或 > 20 次骤降且 > 50C |
| SUSTAINED_HIGH_TEMP | 峰值 > 60C 且平均 > 55C |
| FREQ_INSTABILITY | > 10 次频率骤降 |
| THERMAL_NORMAL | 无明显热节流 |

### Step 12: thermal_diagnosis - 诊断

规则引擎诊断，综合所有步骤结果:
- THERMAL_THROTTLING -> critical
- SUSTAINED_HIGH_TEMP -> warning
- 热预测 high -> critical
- GPU 降频占比 >= 25% -> warning
- FREQ_INSTABILITY -> warning
- THERMAL_NORMAL -> info

### Step 13: no_data_fallback - 无数据回退

条件: 三类数据源均不存在。提示未检测到温度传感器数据。

## 参数流

```
data_check -> expert_analysis_window -> thermal_predictor_probe
           -> thermal_overview
           -> cpu_freq_overview
           -> gpu_power_probe
           -> thermal_timeline
           -> frequency_drop_events
           -> thermal_freq_correlation (needs thermal + freq)
           -> high_temp_periods
           -> root_cause_classification
           -> thermal_diagnosis (uses all above)
```

## 触发关键词

- 中文: 温度, 热节流, 降频, 发热, 过热, 散热, 温控
- 英文: thermal, throttling, temperature, frequency, overheat, cooling, heat