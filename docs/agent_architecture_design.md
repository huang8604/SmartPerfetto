# SmartPerfetto Agent 架构设计文档

## 1. 现状分析：Workflow vs Agent

### 1.1 当前架构的问题

当前系统是一个典型的 **Workflow-Centric** 设计：

```
用户提问 → 意图匹配(关键词) → 选择固定Skill → 按预定义步骤执行 → 返回结果
              ↓                    ↓
         静态规则匹配        steps是硬编码的
              ↓                    ↓
         没有理解能力        没有动态决策能力
```

**核心问题**：

| 问题 | 表现 | 影响 |
|------|------|------|
| **意图理解弱** | 只能通过关键词匹配，无法理解复杂问题 | 用户必须用特定措辞才能触发正确Skill |
| **分析路径固定** | 每个Skill的步骤是预定义的 | 无法根据中间结果调整分析策略 |
| **无自主决策** | 不会判断"需要更多数据"或"已有足够信息" | 要么信息不足，要么冗余分析 |
| **无推理能力** | 只是执行SQL+拼接结果 | 无法进行跨步骤的复杂推理 |
| **无学习能力** | 每次分析都从零开始 | 无法积累分析经验 |

### 1.2 理想的 Agent 模式

```
用户提问
    ↓
┌─────────────────────────────────────────────────────┐
│                   分析 Agent                         │
│  ┌─────────────────────────────────────────────┐   │
│  │ 1. 理解用户意图（LLM 深度理解）               │   │
│  │    - 不只是关键词，而是理解"想解决什么问题"    │   │
│  ├─────────────────────────────────────────────┤   │
│  │ 2. 规划分析路径（Agent 自主规划）             │   │
│  │    - 决定先查什么，后查什么                  │   │
│  │    - 评估每步结果，决定下一步               │   │
│  ├─────────────────────────────────────────────┤   │
│  │ 3. 执行工具调用（调用原子能力）              │   │
│  │    - SQL查询、数据分析、可视化               │   │
│  ├─────────────────────────────────────────────┤   │
│  │ 4. 推理和判断（LLM 推理）                    │   │
│  │    - 分析结果意味着什么                      │   │
│  │    - 是否需要更多信息                       │   │
│  ├─────────────────────────────────────────────┤   │
│  │ 5. 生成结论（Agent 输出）                    │   │
│  │    - 综合所有发现                           │   │
│  │    - 给出可操作的建议                       │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 2. 架构设计：分层 Agent 系统

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户接口层                                │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │ Chat UI       │  │ API Endpoint  │  │ CLI Tool          │   │
│  └───────────────┘  └───────────────┘  └───────────────────┘   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                     Orchestrator Agent                           │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ 职责：理解用户意图、规划分析策略、协调子Agent、综合结论  │     │
│  │ 能力：自然语言理解、任务分解、结果综合                  │     │
│  │ 决策：选择调用哪个专家Agent、判断何时结束               │     │
│  └────────────────────────────────────────────────────────┘     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Scrolling Expert │  │ Startup Expert   │  │ Memory Expert    │
│     Agent        │  │     Agent        │  │     Agent        │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ 职责：滑动分析    │  │ 职责：启动分析    │  │ 职责：内存分析    │
│ 知识：掉帧原因    │  │ 知识：启动阶段    │  │ 知识：GC/LMK     │
│ 工具：帧分析SQL   │  │ 工具：启动SQL     │  │ 工具：内存SQL     │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┴─────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                         Tool Layer                               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ SQL Executor │  │ Data Analyzer│  │ Perfetto Linker    │     │
│  │ 执行SQL查询   │  │ 数据分析计算  │  │ 生成跳转链接        │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ Trace Reader │  │ Report Gen   │  │ Knowledge Base     │     │
│  │ 读取Trace元数据│ │ 生成报告      │  │ SQL模板/分析知识    │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Agent 定义

#### 2.2.1 Orchestrator Agent（编排器Agent）

```typescript
interface OrchestratorAgent {
  // 核心能力
  understandIntent(userQuery: string): Intent;
  planAnalysis(intent: Intent, traceContext: TraceContext): AnalysisPlan;
  selectExpert(task: AnalysisTask): ExpertAgent;
  synthesizeConclusion(results: ExpertResult[]): FinalAnswer;
  
  // 决策能力
  shouldContinue(currentResults: any[]): boolean;
  needMoreData(analysis: any): { needed: boolean; what: string };
  evaluateConfidence(answer: any): number;
}
```

**关键决策点**：
1. 用户问"为什么卡"→ 应该调用 Scrolling Expert 还是 CPU Expert？
2. 分析结果显示"CPU频率低"→ 是否需要进一步查温控？
3. 已经分析了3帧→ 是否足够得出结论？

#### 2.2.2 Expert Agent（专家Agent）

以 Scrolling Expert 为例：

```typescript
interface ScrollingExpertAgent {
  // 知识库
  knowledge: {
    jankCauses: JankCauseKnowledge[];  // 掉帧原因知识
    analysisStrategies: Strategy[];     // 分析策略
    diagnosticRules: Rule[];            // 诊断规则
  };
  
  // 分析能力
  analyzeFrame(frame: FrameData): FrameAnalysis;
  diagnoseJank(symptoms: Symptom[]): Diagnosis[];
  suggestOptimization(diagnosis: Diagnosis): Suggestion[];
  
  // 自主决策
  decideNextStep(currentAnalysis: any): NextStep | 'done';
  prioritizeFrames(frames: Frame[]): Frame[];  // 决定先分析哪些帧
}
```

### 2.3 Tool 定义

工具是 Agent 的"手和眼"，是确定性的、可复用的原子能力：

```typescript
// SQL 执行工具
interface SQLExecutorTool {
  execute(sql: string): QueryResult;
  validateSQL(sql: string): ValidationResult;
}

// 数据分析工具
interface DataAnalyzerTool {
  calculateStats(data: any[]): Statistics;
  detectOutliers(data: any[]): Outlier[];
  correlate(seriesA: any[], seriesB: any[]): Correlation;
}

// Perfetto 链接工具
interface PerfettoLinkerTool {
  generateFrameLink(ts: string, dur: string): string;
  generateSliceLink(sliceId: number): string;
}

// 知识库工具
interface KnowledgeBaseTool {
  getSQLTemplate(templateName: string): string;
  getAnalysisPattern(patternName: string): AnalysisPattern;
  getDiagnosticRules(category: string): Rule[];
}
```

---

## 3. 工作流对比

### 3.1 当前 Workflow 模式

```
用户: "分析滑动卡顿"

系统执行 (固定流程):
  Step 1: detect_environment → 刷新率60Hz ✓
  Step 2: get_frames → 642帧 ✓
  Step 3: get_jank_frames → 512掉帧 ✓
  Step 4: frame_performance_summary → 掉帧率79.75% ✓
  Step 5: find_scroll_sessions → 2个滑动区间 ✓
  Step 6: session_jank_analysis → 区间分析 ✓
  Step 7: analyze_jank_frames → 遍历30帧做详细分析 ✓
    (即使前3帧已经能看出问题，仍然分析完30帧)

返回结果 (拼接式):
  L1: 帧性能汇总
  L2: 滑动区间列表
  L4: 30帧详细分析
```

**问题**：
- 每帧都分析，很多是重复的
- 没有"已经找到原因，可以停止"的判断
- 没有"这帧和上一帧原因相同"的归纳

### 3.2 Agent 模式

```
用户: "分析滑动卡顿"

Orchestrator Agent 思考:
  "用户想知道卡顿原因，我需要:
   1. 先确认是否有卡顿
   2. 找到典型的卡顿帧
   3. 分析卡顿原因
   4. 给出优化建议"

调用 Scrolling Expert:
  Agent 思考: "先看整体掉帧情况"
  → 调用 SQL 工具: 查询帧统计
  → 结果: 79.75%掉帧率，严重
  
  Agent 思考: "掉帧率很高，看看主要是什么类型"
  → 调用 SQL 工具: 查询掉帧类型分布
  → 结果: 94%是 Buffer Stuffing
  
  Agent 思考: "Buffer Stuffing 说明是渲染跟不上，需要看帧详情"
  → 选择最严重的3帧分析
  
  分析第1帧:
  → 调用 SQL 工具: 查四象限
  → 结果: Q4(Sleeping) 78%
  → Agent 推理: "主线程大部分时间在等待"
  
  → 调用 SQL 工具: 查主线程操作
  → 结果: Choreographer#doFrame 13.92ms
  → Agent 推理: "主线程有明显耗时操作"
  
  Agent 决策: "第1帧原因明确: 主线程耗时操作导致等待"
  
  分析第2帧:
  → 结果: 类似第1帧
  → Agent 决策: "与第1帧原因相同，归为同一类"
  
  分析第3帧:
  → 结果: 仍然类似
  → Agent 决策: "已有足够样本，可以得出结论"

Orchestrator 综合结论:
  "滑动卡顿的主要原因是主线程在 Choreographer#doFrame 
   期间执行了耗时操作，导致帧渲染超时。
   
   建议:
   1. 检查 doFrame 中的具体操作
   2. 将耗时操作移到后台线程
   3. 考虑使用 RenderThread 分担工作"
```

**优势**：
- 动态决策分析多少帧
- 能归纳相似问题
- 推理能力让结论更有洞察力

---

## 4. 实现路径

### 4.1 Phase 1: Tool Layer 重构 (2周)

**目标**：将现有 Skills 改造为可被 Agent 调用的 Tools

```typescript
// 现有 Skill (YAML + 固定流程)
// ↓ 改造为
// Tool (独立函数，Agent 可调用)

// 帧分析工具
const frameAnalysisTool = {
  name: 'analyze_frame',
  description: '分析单帧的详细信息，包括四象限、Binder、CPU频率等',
  parameters: {
    start_ts: { type: 'string', required: true },
    end_ts: { type: 'string', required: true },
    package: { type: 'string', required: false },
  },
  execute: async (params) => {
    // 调用现有 SQL 查询逻辑
  },
};

// SQL 查询工具
const sqlQueryTool = {
  name: 'execute_sql',
  description: '执行 Perfetto SQL 查询',
  parameters: {
    sql: { type: 'string', required: true },
  },
  execute: async (params) => {
    // 调用 TraceProcessor
  },
};
```

**任务清单**：
- [ ] 提取原子 SQL 查询为独立 Tools
- [ ] 设计 Tool 标准接口
- [ ] 实现 Tool Registry
- [ ] 编写 Tool 描述文档（供 LLM 理解）

### 4.2 Phase 2: Expert Agent 实现 (3周)

**目标**：为每个分析领域实现专家 Agent

```typescript
class ScrollingExpertAgent implements ExpertAgent {
  private tools: Tool[];
  private knowledge: KnowledgeBase;
  private llm: LLMClient;
  
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    // Agent 循环
    let state = this.initializeState(context);
    
    while (!this.isComplete(state)) {
      // 1. Agent 思考下一步
      const thought = await this.think(state);
      
      // 2. 选择工具
      const toolCall = await this.selectTool(thought);
      
      // 3. 执行工具
      const result = await this.executeTool(toolCall);
      
      // 4. 更新状态
      state = this.updateState(state, result);
      
      // 5. 判断是否继续
      if (this.shouldStop(state)) break;
    }
    
    return this.generateConclusion(state);
  }
  
  private async think(state: State): Promise<Thought> {
    const prompt = `
      当前分析状态: ${JSON.stringify(state)}
      已有发现: ${state.findings.join('\n')}
      
      请思考:
      1. 目前发现了什么问题？
      2. 还需要什么信息？
      3. 下一步应该做什么？
    `;
    return this.llm.complete(prompt);
  }
}
```

**任务清单**：
- [ ] 实现 Agent 基类 (BaseExpertAgent)
- [ ] 实现 ScrollingExpertAgent
- [ ] 实现 StartupExpertAgent
- [ ] 实现 MemoryExpertAgent
- [ ] 设计 Agent 知识库格式

### 4.3 Phase 3: Orchestrator Agent 实现 (2周)

**目标**：实现顶层编排 Agent

```typescript
class OrchestratorAgent {
  private experts: Map<string, ExpertAgent>;
  private llm: LLMClient;
  
  async handleQuery(query: string, traceId: string): Promise<Answer> {
    // 1. 理解意图
    const intent = await this.understandIntent(query);
    
    // 2. 规划分析
    const plan = await this.planAnalysis(intent);
    
    // 3. 执行分析
    const results: ExpertResult[] = [];
    for (const task of plan.tasks) {
      const expert = this.selectExpert(task);
      const result = await expert.analyze(task.context);
      results.push(result);
      
      // 动态调整计划
      if (this.needsReplan(results)) {
        plan = await this.replan(plan, results);
      }
    }
    
    // 4. 综合结论
    return this.synthesize(results);
  }
  
  private async understandIntent(query: string): Promise<Intent> {
    const prompt = `
      用户问题: "${query}"
      
      请分析:
      1. 用户想解决什么问题？
      2. 需要分析哪些方面？
      3. 期望得到什么样的答案？
      
      返回 JSON: { problem, aspects, expectedAnswer }
    `;
    return this.llm.complete(prompt);
  }
}
```

**任务清单**：
- [ ] 设计 Intent 分类体系
- [ ] 实现意图理解模块
- [ ] 实现分析规划模块
- [ ] 实现专家选择逻辑
- [ ] 实现结论综合模块

### 4.4 Phase 4: 持续优化 (持续)

**目标**：基于真实使用数据优化

- [ ] 添加 Trace 记录（每次分析的完整过程）
- [ ] 实现 Eval 系统（评估分析质量）
- [ ] 收集失败案例，改进 Agent
- [ ] 优化 Prompt，提高准确率
- [ ] 添加缓存，减少重复 LLM 调用

---

## 5. 关键设计决策

### 5.1 Workflow vs Agency 平衡

| 环节 | 使用 Workflow | 使用 Agency |
|------|---------------|-------------|
| SQL 执行 | ✓ (确定性) | |
| 数据聚合计算 | ✓ (确定性) | |
| 意图理解 | | ✓ (需要理解) |
| 分析路径规划 | | ✓ (需要决策) |
| 结果解读 | | ✓ (需要推理) |
| 报告生成 | 模板部分 ✓ | 总结部分 ✓ |

### 5.2 成本控制

Agent 模式会增加 LLM 调用，需要控制成本：

```typescript
class CostController {
  // 决策缓存
  private decisionCache: Map<string, Decision>;
  
  // 相似问题复用
  async getDecision(context: string): Promise<Decision | null> {
    const similar = this.findSimilar(context);
    if (similar && similar.confidence > 0.9) {
      return similar.decision;
    }
    return null;
  }
  
  // 批量思考
  async batchThink(contexts: string[]): Promise<Thought[]> {
    // 合并多个思考请求，减少 API 调用
  }
}
```

### 5.3 可观测性

```typescript
interface AgentTrace {
  id: string;
  query: string;
  
  // 完整思考过程
  thoughts: {
    step: number;
    input: string;
    thinking: string;
    decision: string;
    toolCalls: ToolCall[];
    result: any;
  }[];
  
  // 最终输出
  answer: string;
  confidence: number;
  
  // 元数据
  duration: number;
  llmCalls: number;
  tokenUsage: { input: number; output: number };
}
```

---

## 6. 预期收益

| 指标 | 当前 Workflow | Agent 模式 | 改进 |
|------|---------------|------------|------|
| 问题覆盖率 | 只能处理预定义场景 | 可处理开放式问题 | +300% |
| 分析深度 | 固定步骤，可能遗漏 | 根据需要深入 | +50% |
| 用户体验 | 需要知道关键词 | 自然语言交互 | +200% |
| 维护成本 | 每个场景都要写 Skill | 只需维护 Tools | -60% |
| 结论质量 | 拼接式展示 | 推理式结论 | +100% |

---

## 7. 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| LLM 幻觉 | 给出错误结论 | 关键数据用确定性计算验证 |
| 成本过高 | 每次分析费用增加 | 缓存、批处理、模型选择 |
| 延迟增加 | 用户等待变长 | 流式输出、并行处理 |
| 行为不可预测 | 难以调试 | 完整 Trace 记录 |

---

## 8. 下一步行动

1. **本周**：完成 Tool Layer 设计文档
2. **下周**：实现 3 个核心 Tools (SQL执行、帧分析、数据统计)
3. **第3周**：实现 ScrollingExpertAgent MVP
4. **第4周**：实现 Orchestrator Agent MVP
5. **第5周**：集成测试、性能优化
