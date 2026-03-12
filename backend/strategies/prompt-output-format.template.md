<!-- No template variables — static content -->
## 输出格式

### 通用分析规则（所有场景适用）

#### Slice 嵌套与 Exclusive Time
当分析主线程热点 slice 时，数据包含两组指标：
- **total_ms / percent**（wall time）：包含子 slice 时间，父子会重叠
- **self_ms / self_percent**（exclusive time）：仅自身独占时间，不含子 slice

**规则**：根因归因和优化收益估算必须基于 self_ms。嵌套 slice 的 wall time 不能简单相加（会导致百分比超过 100%）。根因分析树中的 slice 必须体现父子嵌套关系。

#### 测试/模拟器应用检测
当热点 slice 名称包含 `LoadSimulator`、`ChaosTask`、`SimulateInflation`、`Benchmark`、`StressTest`、`TestRunner`、`FakeLoad` 等特征词时，在概览中标注这是测试/基准应用，并调整分析措辞：描述模拟负载的性能特征，而不是给出通用的生产环境优化建议。

#### CPU 频率估算
- 均频是加权平均值，不代表恒定频率（min/max 可能差异很大）
- CPU-bound 耗时与频率不是简单线性反比关系
- **禁止**给出精确的百分比节省估算（如"升至满频可降低 28%"）。只应定性描述（如"频率未达峰值，CPU-bound 任务可能受影响"）
- Thermal 限频需要额外数据确认，不要仅凭均频<峰频就断定

### 发现格式
每个发现使用以下格式：

**[SEVERITY] 标题**
描述：具体问题描述
根因：**不能只报告"耗时XXms"——必须解释 WHY**。交叉引用四象限、CPU 频率、线程状态、Binder/GC 等数据，定位真正的原因（是 CPU-bound？是被阻塞？是跑小核？是频率不够？是 Binder/IO/锁等待？）
证据：引用具体的数据（时间戳、数值、四象限分布、频率、阻塞来源）
建议：可操作的优化建议

严重程度定义：
- [CRITICAL]: 严重性能问题，必须修复（如 ANR、严重卡顿 >100ms）
- [HIGH]: 明显性能问题，强烈建议修复（如频繁掉帧、高 CPU 占用）
- [MEDIUM]: 值得关注的性能问题（如偶发卡顿、内存波动）
- [LOW]: 轻微性能问题或优化建议
- [INFO]: 性能特征描述，非问题

### 结论结构
1. **概览**: 一句话总结性能状况
2. **关键发现**: 按严重程度排列的发现列表
3. **根因分析**: 如果能确定根因
4. **优化建议**: 可操作的建议，按优先级排列
