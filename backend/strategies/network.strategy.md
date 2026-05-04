<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: network
priority: 6
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - network_packets
  - power_rails
  - battery_counters
keywords:
  - 网络
  - 流量
  - 数据包
  - network
  - traffic
  - packet
  - wifi
  - cellular
  - 4g
  - 5g
  - tcp
  - udp
compound_patterns:
  - "网络.*(流量|耗电|唤醒|请求|包)"
  - "network.*(traffic|power|wakeup|packet)"

phase_hints:
  - id: network_packets
    keywords: ['network', 'traffic', 'packet', '网络', '流量', '数据包', 'tcp', 'udp']
    constraints: '优先调用 network_analysis。若 android_network_packets 不存在或为空，必须标注 trace 未启用 network_packets，不能解释为没有网络活动。'
    critical_tools: ['network_analysis']
    critical: true
  - id: network_power
    keywords: ['battery', 'power', 'wakeup', '耗电', '唤醒', '掉电']
    constraints: '网络耗电问题需要把 network_analysis 与 battery_drain_attribution / power_consumption_overview 组合，区分网络事件链和 rail 级功耗归因。'
    critical_tools: ['network_analysis', 'battery_drain_attribution', 'power_consumption_overview']
    critical: false

plan_template:
  mandatory_aspects:
    - id: network_data
      match_keywords: ['network_analysis', 'network', '网络', '流量', 'packet']
      suggestion: '网络场景必须先调用 network_analysis 或明确说明 network_packets 数据缺失'
    - id: network_power_context
      match_keywords: ['battery_drain_attribution', 'power_consumption_overview', '耗电', '唤醒', 'power']
      suggestion: '网络耗电/唤醒问题需要补充功耗或唤醒上下文'
---

#### 网络活动分析

网络场景先判断 trace 是否真的采集了 `android.network_packets`。如果没有该数据源，只能给采集建议，不能把空结果解释为"没有网络问题"。

**Phase 1 — 网络流量/协议/接口总览：**

```
invoke_skill("network_analysis", { package: "<包名>" })
```

重点看接口分布、方向、协议、socket tag、活跃周期。如果用户关心具体时间段，必须传入 `start_ts` / `end_ts`。

**Phase 2 — 网络耗电/唤醒链路：**

```
invoke_skill("battery_drain_attribution", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

如果 power_rails 可用，再补：

```
invoke_skill("power_consumption_overview", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

输出时明确区分：
1. 网络包/活跃周期证据
2. wakelock / suspend-wakeup / job 事件链
3. rail 级能耗归因是否可用
