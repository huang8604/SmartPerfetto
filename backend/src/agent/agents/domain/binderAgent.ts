/**
 * SmartPerfetto Binder Agent
 *
 * Phase 2.4: AI Agent for Binder IPC analysis
 *
 * Skills wrapped as tools:
 * - binder_analysis
 * - binder_detail
 * - binder_in_range
 * - lock_contention_analysis
 * - lock_contention_in_range
 */

import { BaseAgent, TaskUnderstanding, ExecutionResult } from '../base/baseAgent';
import {
  AgentConfig,
  AgentTask,
  AgentTaskContext,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import {
  createSkillExecutor,
  skillRegistry,
  ensureSkillRegistryInitialized,
  SkillExecutionResult,
  DiagnosticResult,
} from '../../../services/skillEngine';

const BINDER_SKILLS = [
  { skillId: 'binder_analysis', toolName: 'analyze_binder_overview', description: '分析 Binder IPC 通信概况，找出慢调用' },
  { skillId: 'binder_detail', toolName: 'get_binder_detail', description: '获取单个 Binder 调用的详细信息' },
  { skillId: 'binder_in_range', toolName: 'analyze_binder_range', description: '分析指定时间范围内的 Binder 调用' },
  { skillId: 'lock_contention_analysis', toolName: 'analyze_lock_contention', description: '分析锁竞争情况' },
  { skillId: 'lock_contention_in_range', toolName: 'analyze_lock_range', description: '分析指定时间范围内的锁竞争' },
];

function createToolExecutorForSkill(skillId: string): (params: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult> {
  return async (params, context): Promise<AgentToolResult> => {
    const startTime = Date.now();
    try {
      if (!context.traceProcessorService) {
        return { success: false, error: 'TraceProcessorService not available', executionTimeMs: Date.now() - startTime };
      }

      const executor = createSkillExecutor(context.traceProcessorService, context.aiService);
      const execParams: Record<string, any> = { ...params, package: context.packageName };

      const result = await executor.execute(skillId, context.traceId, execParams, {});
      const findings = extractFindingsFromResult(result, skillId);
      const data = extractDataFromResult(result);

      return { success: result.success, data, findings, error: result.error, executionTimeMs: Date.now() - startTime };
    } catch (error: any) {
      return { success: false, error: error.message, executionTimeMs: Date.now() - startTime };
    }
  };
}

function extractFindingsFromResult(result: SkillExecutionResult, skillId: string): Finding[] {
  const findings: Finding[] = [];
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const diag of result.diagnostics) {
      findings.push({
        id: `${skillId}_${Date.now()}_${findings.length}`,
        category: 'binder',
        severity: diag.severity,
        title: diag.diagnosis,
        description: diag.suggestions?.join('; ') || diag.diagnosis,
        source: skillId,
        confidence: typeof diag.confidence === 'number' ? diag.confidence : 0.8,
        details: diag.evidence,
      });
    }
  }
  return findings;
}

function extractDataFromResult(result: SkillExecutionResult): any {
  if (result.displayResults && result.displayResults.length > 0) {
    const data: Record<string, any> = {};
    for (const dr of result.displayResults) {
      data[dr.stepId] = dr.data;
    }
    return data;
  }
  if (result.rawResults) {
    const data: Record<string, any> = {};
    for (const [stepId, stepResult] of Object.entries(result.rawResults)) {
      data[stepId] = stepResult.data;
    }
    return data;
  }
  return null;
}

function createBinderAgentConfig(modelRouter: ModelRouter): AgentConfig {
  const tools: AgentTool[] = [];
  ensureSkillRegistryInitialized();

  for (const skillInfo of BINDER_SKILLS) {
    const skill = skillRegistry.getSkill(skillInfo.skillId);
    if (!skill) continue;

    tools.push({
      name: skillInfo.toolName,
      description: skillInfo.description,
      skillId: skillInfo.skillId,
      category: 'binder',
      parameters: skill.inputs?.map((input: any) => ({
        name: input.name, type: input.type as any, required: input.required,
        description: input.description || input.name, default: input.default,
      })),
      execute: createToolExecutorForSkill(skillInfo.skillId),
    });
  }

  return {
    id: 'binder_agent',
    name: 'Binder Analysis Agent',
    domain: 'binder',
    description: 'AI agent specialized in Binder IPC and lock contention analysis',
    tools,
    maxIterations: 3,
    confidenceThreshold: 0.7,
    canDelegate: true,
    delegateTo: ['cpu_agent', 'frame_agent'],
  };
}

export class BinderAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(createBinderAgentConfig(modelRouter), modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个 Binder IPC 分析专家 Agent，负责分析 Android 系统的进程间通信问题。

## 任务
${task.description}

## 你的工具
${this.getToolDescriptionsForLLM()}

请以 JSON 格式返回：{"objective":"","questions":[],"relevantAreas":[],"recommendedTools":[],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划 Binder 分析：
目标: ${understanding.objective}
工具: ${this.getToolDescriptionsForLLM()}

请以 JSON 返回：{"steps":[{"toolName":"","params":{},"purpose":""}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思 Binder 分析结果：
发现: ${result.findings.map(f => f.title).join(', ') || '无'}

请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const binderFindings = findings.filter(f => f.title.includes('Binder') || f.title.includes('锁'));

    if (binderFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        'Binder 调用或锁竞争导致阻塞',
        0.6,
        binderFindings.map(f => ({ id: f.id, description: f.title, source: 'binder_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = ['analyze_binder_overview'];

    if (query.includes('锁') || query.includes('lock') || query.includes('contention')) {
      tools.push('analyze_lock_contention');
    }

    return [...new Set(tools)];
  }
}

export function createBinderAgent(modelRouter: ModelRouter): BinderAgent {
  return new BinderAgent(modelRouter);
}

export default BinderAgent;
