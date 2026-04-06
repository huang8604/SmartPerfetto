// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Planner Agent
 *
 * 规划专家，负责：
 * 1. 理解用户意图
 * 2. 分解分析任务
 * 3. 规划执行顺序
 * 4. 估算资源需求
 */

import {
  SubAgentConfig,
  SubAgentContext,
  SubAgentResult,
  Finding,
  Intent,
  AnalysisPlan,
  AnalysisTask,
  PipelineStage,
  Evaluation,
  EvaluationFeedback,
} from '../types';
import { BaseSubAgent } from './base/baseSubAgent';
import { ModelRouter } from '../core/modelRouter';
import {
  EnhancedSessionContext,
} from '../context/enhancedSessionContext';
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

const LEGACY_INTENT_JSON_SCHEMA: LlmJsonSchema<Intent> = {
  name: 'intent_json@1.0.0',
  validate: (value: unknown): value is Intent => {
    if (!isPlainObject(value)) return false;
    if (typeof (value as any).primaryGoal !== 'string') return false;
    if (!isStringArray((value as any).aspects)) return false;
    if (!['diagnosis', 'comparison', 'timeline', 'summary'].includes(String((value as any).expectedOutputType))) {
      return false;
    }
    if (!['simple', 'moderate', 'complex'].includes(String((value as any).complexity))) return false;
    return true;
  },
};

type LegacyPlannerResponsePayload = {
  intent?: Intent;
  plan?: AnalysisPlan;
  confidence?: number;
};

const LEGACY_PLANNER_RESPONSE_JSON_SCHEMA: LlmJsonSchema<LegacyPlannerResponsePayload> = {
  name: 'legacy_planner_response_json@1.0.0',
  validate: (value: unknown): value is LegacyPlannerResponsePayload => {
    if (!isPlainObject(value)) return false;
    const confidence = (value as any).confidence;
    if (confidence !== undefined && confidence !== null && typeof confidence !== 'number') return false;
    const intent = (value as any).intent;
    if (intent !== undefined && intent !== null && !isPlainObject(intent)) return false;
    const plan = (value as any).plan;
    if (plan !== undefined && plan !== null && !isPlainObject(plan)) return false;
    return true;
  },
};

type AnalysisPlanPayload = {
  tasks: any[];
  estimatedDuration?: number;
  parallelizable?: boolean;
};

const ANALYSIS_PLAN_JSON_SCHEMA: LlmJsonSchema<AnalysisPlanPayload> = {
  name: 'plan_json@1.0.0',
  validate: (value: unknown): value is AnalysisPlanPayload => {
    if (!isPlainObject(value)) return false;
    if (!Array.isArray((value as any).tasks)) return false;
    const estimatedDuration = (value as any).estimatedDuration;
    if (estimatedDuration !== undefined && estimatedDuration !== null && typeof estimatedDuration !== 'number') return false;
    const parallelizable = (value as any).parallelizable;
    if (parallelizable !== undefined && parallelizable !== null && typeof parallelizable !== 'boolean') return false;
    return true;
  },
};

// 默认配置
const DEFAULT_CONFIG: SubAgentConfig = {
  id: 'planner',
  name: '规划专家',
  type: 'planner',
  description: '负责理解用户意图并规划分析任务',
  preferredModel: 'intent_understanding',
  tools: [],
  maxIterations: 1, // 规划通常一次完成
  confidenceThreshold: 0.7,
};

// 可用的分析领域
const ANALYSIS_DOMAINS = [
  { id: 'scrolling', name: '滑动性能', keywords: ['滑动', '卡顿', 'jank', 'fps', '帧率', '掉帧', 'scroll'] },
  { id: 'startup', name: '启动性能', keywords: ['启动', '冷启动', '热启动', 'launch', 'start', 'ttid', 'ttfd'] },
  { id: 'memory', name: '内存分析', keywords: ['内存', 'memory', 'gc', '泄漏', 'leak', 'oom'] },
  { id: 'cpu', name: 'CPU 分析', keywords: ['cpu', '负载', 'load', '占用', '调度'] },
  { id: 'binder', name: 'Binder 分析', keywords: ['binder', 'ipc', '进程间', '通信'] },
  { id: 'scene', name: '场景还原', keywords: ['场景', '操作', '时间线', '还原', 'scene'] },
  { id: 'general', name: '综合分析', keywords: ['分析', '性能', '问题', '整体'] },
];

/**
 * 规划专家实现
 */
export class PlannerAgent extends BaseSubAgent {
  constructor(modelRouter: ModelRouter, config?: Partial<SubAgentConfig>) {
    super({ ...DEFAULT_CONFIG, ...config }, modelRouter);
  }

  // ==========================================================================
  // 实现抽象方法
  // ==========================================================================

  protected buildSystemPrompt(_context: SubAgentContext): string {
    return `你是 SmartPerfetto 的规划专家，专门负责理解用户的性能分析需求并规划分析任务。

你的职责：
1. 理解用户想要分析什么类型的性能问题
2. 识别需要调用哪些分析专家
3. 规划分析任务的执行顺序
4. 估算分析的复杂度

可用的分析领域：
${ANALYSIS_DOMAINS.map(d => `- ${d.id}: ${d.name} (关键词: ${d.keywords.join(', ')})`).join('\n')}

输出格式要求：JSON`;
  }

  protected buildTaskPrompt(context: SubAgentContext): string {
    const previousContext = context.previousResults
      ? `\n\n之前的分析结果:\n${context.previousResults.map(r => `- ${r.stageId}: ${r.success ? '成功' : '失败'}`).join('\n')}`
      : '';

    return `用户查询: "${context.intent?.primaryGoal || '分析性能问题'}"

请分析用户意图并规划分析任务。
${previousContext}`;
  }

  protected parseResponse(response: string, _context: SubAgentContext): SubAgentResult {
    try {
      const parsed = parseLlmJson<LegacyPlannerResponsePayload>(response, LEGACY_PLANNER_RESPONSE_JSON_SCHEMA);
      return {
        agentId: this.config.id,
        success: true,
        findings: [],
        suggestions: [],
        data: {
          intent: parsed.intent,
          plan: parsed.plan,
        },
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
        executionTimeMs: 0,
      };
    } catch (error) {
      // 解析失败
    }

    return {
      agentId: this.config.id,
      success: false,
      findings: [],
      suggestions: [],
      confidence: 0,
      executionTimeMs: 0,
      error: 'Failed to parse planning response',
    };
  }

  // ==========================================================================
  // 规划方法
  // ==========================================================================

  /**
   * 理解用户意图
   * Phase 1.3: Now accepts sessionContext for multi-turn dialogue awareness
   */
  async understandIntent(
    query: string,
    context: SubAgentContext & { sessionContext?: EnhancedSessionContext }
  ): Promise<Intent> {
    // Build conversation history context if available (Phase 5: Multi-turn Dialogue)
    let historyContext = '';
    if (context.sessionContext) {
      const turns = context.sessionContext.getAllTurns();
      if (turns.length > 0) {
        const recentTurns = turns.slice(-3); // Last 3 turns for context
        historyContext = `
对话历史（最近 ${recentTurns.length} 轮）:
${recentTurns.map((t, i) => `第${t.turnIndex + 1}轮: "${t.query}" → ${t.findings.length} 个发现`).join('\n')}

基于对话历史，用户当前问题可能是：
1. 深入追问之前的发现
2. 切换到新的分析维度
3. 要求澄清或更多细节

请结合历史理解当前查询意图。
`;
      }
    }

    const prompt = `分析以下用户查询，提取分析意图：

用户查询: "${query}"
${historyContext}
请以 JSON 格式返回意图分析结果：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面1", "方面2"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex"
}`;

    const response = await this.modelRouter.callWithFallback(prompt, 'intent_understanding', {
      sessionId: context.sessionId,
      traceId: context.traceId,
      jsonMode: true,
      promptId: 'legacy.plannerAgent.intent',
      promptVersion: '1.0.0',
      contractVersion: 'intent_json@1.0.0',
    });

    try {
      return parseLlmJson<Intent>(response.response, LEGACY_INTENT_JSON_SCHEMA);
    } catch (error) {
      // 解析失败
    }

    // 默认意图
    return {
      primaryGoal: query,
      aspects: this.extractAspects(query),
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
    };
  }

  /**
   * 创建分析计划
   * Phase 1.2: Now accepts previousEvaluation for feedback-driven refinement
   */
  async createPlan(
    intent: Intent,
    context: SubAgentContext,
    previousEvaluation?: Evaluation
  ): Promise<AnalysisPlan> {
    // Build feedback context from previous evaluation (Phase 1.2)
    let feedbackContext = '';
    if (previousEvaluation?.feedback) {
      const fb = previousEvaluation.feedback;
      feedbackContext = `
【上一轮评估反馈 - 请根据此反馈优化计划】
- 质量分数: ${previousEvaluation.qualityScore.toFixed(2)}
- 完整性分数: ${previousEvaluation.completenessScore.toFixed(2)}
${fb.missingAspects.length > 0 ? `- 缺失方面: ${fb.missingAspects.join(', ')}` : ''}
${fb.weaknesses.length > 0 ? `- 不足之处: ${fb.weaknesses.join('; ')}` : ''}
${fb.improvementSuggestions.length > 0 ? `- 改进建议: ${fb.improvementSuggestions.join('; ')}` : ''}
${fb.priorityActions.length > 0 ? `- 优先行动: ${fb.priorityActions.join('; ')}` : ''}

请根据以上反馈调整分析计划，重点解决缺失方面和不足之处。
`;
    }

    const prompt = `基于以下意图创建分析计划：

意图：
- 主要目标: ${intent.primaryGoal}
- 分析方面: ${intent.aspects.join(', ')}
- 复杂度: ${intent.complexity}
${feedbackContext}
可用分析专家：
${ANALYSIS_DOMAINS.map(d => `- ${d.id}: ${d.name}`).join('\n')}

请以 JSON 格式返回分析计划：
{
  "tasks": [
    {
      "id": "任务ID",
      "expertAgent": "专家ID",
      "objective": "任务目标",
      "dependencies": [],
      "priority": 1,
      "context": {}
    }
  ],
  "estimatedDuration": 30000,
  "parallelizable": true
}`;

    const response = await this.modelRouter.callWithFallback(prompt, 'planning', {
      sessionId: context.sessionId,
      traceId: context.traceId,
      jsonMode: true,
      promptId: 'legacy.plannerAgent.plan',
      promptVersion: '1.0.0',
      contractVersion: 'plan_json@1.0.0',
    });

    try {
      const parsed = parseLlmJson<AnalysisPlanPayload>(response.response, ANALYSIS_PLAN_JSON_SCHEMA) as any;
      return this.validateAndEnrichPlan(parsed as AnalysisPlan, intent);
    } catch (error) {
      // 解析失败
    }

    // 生成默认计划
    return this.generateDefaultPlan(intent);
  }

  /**
   * 从查询中提取分析方面
   */
  private extractAspects(query: string): string[] {
    const aspects: string[] = [];
    const lowerQuery = query.toLowerCase();

    for (const domain of ANALYSIS_DOMAINS) {
      for (const keyword of domain.keywords) {
        if (lowerQuery.includes(keyword.toLowerCase())) {
          if (!aspects.includes(domain.id)) {
            aspects.push(domain.id);
          }
          break;
        }
      }
    }

    if (aspects.length === 0) {
      aspects.push('general');
    }

    return aspects;
  }

  /**
   * 验证并丰富计划
   */
  private validateAndEnrichPlan(plan: AnalysisPlan, intent: Intent): AnalysisPlan {
    // 确保每个任务都有有效的专家
    for (const task of plan.tasks) {
      const validDomain = ANALYSIS_DOMAINS.find(d => d.id === task.expertAgent);
      if (!validDomain) {
        task.expertAgent = 'general';
      }
    }

    // 确保至少有一个任务
    if (plan.tasks.length === 0) {
      plan.tasks = this.generateDefaultTasks(intent);
    }

    // 计算估计时间
    if (!plan.estimatedDuration) {
      plan.estimatedDuration = plan.tasks.length * 15000; // 每个任务约 15 秒
    }

    return plan;
  }

  /**
   * 生成默认计划
   */
  private generateDefaultPlan(intent: Intent): AnalysisPlan {
    return {
      tasks: this.generateDefaultTasks(intent),
      estimatedDuration: 60000,
      parallelizable: intent.complexity !== 'complex',
    };
  }

  /**
   * 生成默认任务
   */
  private generateDefaultTasks(intent: Intent): AnalysisTask[] {
    const tasks: AnalysisTask[] = [];
    let priority = 1;

    for (const aspect of intent.aspects) {
      tasks.push({
        id: `task_${aspect}_${Date.now()}`,
        expertAgent: aspect,
        objective: `分析 ${ANALYSIS_DOMAINS.find(d => d.id === aspect)?.name || aspect}`,
        dependencies: priority > 1 ? [tasks[priority - 2].id] : [],
        priority: priority++,
        context: {},
      });
    }

    return tasks;
  }

  // ==========================================================================
  // 重写执行方法
  // ==========================================================================

  /**
   * 执行规划（简化版，不使用 Think-Act 循环）
   */
  async execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult> {
    const startTime = Date.now();

    try {
      this.emit('start', { agentId: this.config.id, stage: stage.id });

      // 理解意图
      const query = context.intent?.primaryGoal || '';
      const intent = await this.understandIntent(query, context);

      // 创建计划
      const plan = await this.createPlan(intent, context);

      const result: SubAgentResult = {
        agentId: this.config.id,
        success: true,
        findings: [],
        suggestions: [`计划包含 ${plan.tasks.length} 个分析任务`],
        data: { intent, plan },
        confidence: 0.85,
        executionTimeMs: Date.now() - startTime,
      };

      this.emit('complete', { agentId: this.config.id, result });
      return result;
    } catch (error: any) {
      this.emit('error', { agentId: this.config.id, error: error.message });

      return {
        agentId: this.config.id,
        success: false,
        findings: [],
        suggestions: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }
}

export default PlannerAgent;