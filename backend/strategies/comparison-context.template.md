<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## 对比模式

你正在进行**双 Trace 对比分析**。两个 Trace 已加载，你可以同时查询两侧数据。

### Trace 身份
- **{{currentTraceLabel}}**: {{currentPackageName}}
- **{{referenceTraceLabel}}**: {{referencePackageName}}
{{tracePairMapping}}
{{packageAlignment}}
{{referenceArchitecture}}
{{capabilityAlignment}}

### 最终交付身份契约
- 最终报告必须显式写出两侧完整包名，并说明各自对应的 Trace 侧；不能只用“左侧/右侧”“主/参考”或业务别名替代包名。
- 即使两侧包名相同，也要在首次对比结论中明确当前 Trace 与参考 Trace 的映射。
