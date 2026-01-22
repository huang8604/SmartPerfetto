/**
 * SmartPerfetto Additional Domain Agents
 *
 * Phase 2.6: Additional AI Agents for specific analysis domains
 *
 * This file contains:
 * - StartupAgent: App launch and startup analysis
 * - InteractionAgent: Click response and user interaction analysis
 * - ANRAgent: ANR detection and analysis
 * - SystemAgent: System-level analysis (thermal, IO, suspend/wakeup)
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

// =============================================================================
// Shared Utilities
// =============================================================================

function createToolExecutorForSkill(skillId: string, category: string): (params: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult> {
  return async (params, context): Promise<AgentToolResult> => {
    const startTime = Date.now();
    try {
      if (!context.traceProcessorService) {
        return { success: false, error: 'TraceProcessorService not available', executionTimeMs: Date.now() - startTime };
      }

      const executor = createSkillExecutor(context.traceProcessorService, context.aiService);
      const execParams: Record<string, any> = { ...params, package: context.packageName };

      const result = await executor.execute(skillId, context.traceId, execParams, {});
      const findings = extractFindingsFromResult(result, skillId, category);
      const data = extractDataFromResult(result);

      return { success: result.success, data, findings, error: result.error, executionTimeMs: Date.now() - startTime };
    } catch (error: any) {
      return { success: false, error: error.message, executionTimeMs: Date.now() - startTime };
    }
  };
}

function extractFindingsFromResult(result: SkillExecutionResult, skillId: string, category: string): Finding[] {
  const findings: Finding[] = [];
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const diag of result.diagnostics) {
      findings.push({
        id: `${skillId}_${Date.now()}_${findings.length}`,
        category,
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

function createAgentTools(
  skills: Array<{ skillId: string; toolName: string; description: string }>,
  category: AgentTool['category']
): AgentTool[] {
  const tools: AgentTool[] = [];
  ensureSkillRegistryInitialized();

  for (const skillInfo of skills) {
    const skill = skillRegistry.getSkill(skillInfo.skillId);
    if (!skill) continue;

    tools.push({
      name: skillInfo.toolName,
      description: skillInfo.description,
      skillId: skillInfo.skillId,
      category,
      parameters: skill.inputs?.map((input: any) => ({
        name: input.name,
        type: input.type as any,
        required: input.required,
        description: input.description || input.name,
        default: input.default,
      })),
      execute: createToolExecutorForSkill(skillInfo.skillId, category),
    });
  }

  return tools;
}

// =============================================================================
// Startup Agent
// =============================================================================

const STARTUP_SKILLS = [
  { skillId: 'startup_analysis', toolName: 'analyze_startup', description: '分析应用启动性能，包括冷启动、热启动' },
  { skillId: 'startup_detail', toolName: 'get_startup_detail', description: '获取启动过程详细阶段耗时' },
];

export class StartupAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super({
      id: 'startup_agent',
      name: 'Startup Analysis Agent',
      domain: 'startup',
      description: 'AI agent specialized in app startup and launch performance analysis',
      tools: createAgentTools(STARTUP_SKILLS, 'startup'),
      maxIterations: 3,
      confidenceThreshold: 0.7,
      canDelegate: true,
      delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
    }, modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个启动性能分析专家 Agent，负责分析 Android 应用的启动性能问题。

任务: ${task.description}
工具: ${this.getToolDescriptionsForLLM()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["startup"],"recommendedTools":["analyze_startup"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划启动分析：目标 ${understanding.objective}
请以 JSON 返回：{"steps":[{"toolName":"analyze_startup","params":{},"purpose":"分析启动性能"}],"expectedOutcomes":["启动时间分析"],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思启动分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const startupFindings = findings.filter(f => f.title.includes('启动') || f.title.includes('launch'));

    if (startupFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '启动过程存在性能瓶颈',
        0.6,
        startupFindings.map(f => ({ id: f.id, description: f.title, source: 'startup_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    return ['analyze_startup', 'get_startup_detail'];
  }
}

// =============================================================================
// Interaction Agent
// =============================================================================

const INTERACTION_SKILLS = [
  { skillId: 'click_response_analysis', toolName: 'analyze_click_response', description: '分析点击响应延迟' },
  { skillId: 'click_response_detail', toolName: 'get_click_detail', description: '获取单次点击的详细响应时间' },
];

export class InteractionAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super({
      id: 'interaction_agent',
      name: 'Interaction Analysis Agent',
      domain: 'interaction',
      description: 'AI agent specialized in click response and user interaction analysis',
      tools: createAgentTools(INTERACTION_SKILLS, 'interaction'),
      maxIterations: 3,
      confidenceThreshold: 0.7,
      canDelegate: true,
      delegateTo: ['frame_agent', 'cpu_agent', 'binder_agent'],
    }, modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个交互响应分析专家 Agent，负责分析用户点击响应延迟问题。
任务: ${task.description}
工具: ${this.getToolDescriptionsForLLM()}
请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["interaction"],"recommendedTools":["analyze_click_response"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划交互分析：目标 ${understanding.objective}
请以 JSON 返回：{"steps":[{"toolName":"analyze_click_response","params":{},"purpose":"分析点击响应"}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思交互分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const interactionFindings = findings.filter(f => f.title.includes('点击') || f.title.includes('响应'));

    if (interactionFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '点击响应存在延迟问题',
        0.6,
        interactionFindings.map(f => ({ id: f.id, description: f.title, source: 'interaction_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    return ['analyze_click_response'];
  }
}

// =============================================================================
// ANR Agent
// =============================================================================

const ANR_SKILLS = [
  { skillId: 'anr_analysis', toolName: 'analyze_anr', description: '分析 ANR 事件，定位阻塞原因' },
  { skillId: 'anr_detail', toolName: 'get_anr_detail', description: '获取单个 ANR 事件的详细信息' },
];

export class ANRAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super({
      id: 'anr_agent',
      name: 'ANR Analysis Agent',
      domain: 'anr',
      description: 'AI agent specialized in ANR detection and root cause analysis',
      tools: createAgentTools(ANR_SKILLS, 'system'),
      maxIterations: 3,
      confidenceThreshold: 0.7,
      canDelegate: true,
      delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
    }, modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个 ANR 分析专家 Agent，负责分析 Android 应用的 ANR 问题。
任务: ${task.description}
工具: ${this.getToolDescriptionsForLLM()}
请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["anr"],"recommendedTools":["analyze_anr"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划 ANR 分析：目标 ${understanding.objective}
请以 JSON 返回：{"steps":[{"toolName":"analyze_anr","params":{},"purpose":"分析 ANR"}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思 ANR 分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const anrFindings = findings.filter(f => f.title.includes('ANR') || f.title.includes('无响应'));

    if (anrFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '主线程阻塞导致 ANR',
        0.8,
        anrFindings.map(f => ({ id: f.id, description: f.title, source: 'anr_agent', type: 'finding' as const, strength: 0.9 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    return ['analyze_anr', 'get_anr_detail'];
  }
}

// =============================================================================
// System Agent
// =============================================================================

const SYSTEM_SKILLS = [
  { skillId: 'thermal_throttling', toolName: 'analyze_thermal', description: '分析热节流情况' },
  { skillId: 'io_pressure', toolName: 'analyze_io_pressure', description: '分析 IO 压力' },
  { skillId: 'suspend_wakeup_analysis', toolName: 'analyze_suspend_wakeup', description: '分析休眠唤醒' },
];

export class SystemAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super({
      id: 'system_agent',
      name: 'System Analysis Agent',
      domain: 'system',
      description: 'AI agent specialized in system-level analysis: thermal, IO, suspend/wakeup',
      tools: createAgentTools(SYSTEM_SKILLS, 'system'),
      maxIterations: 3,
      confidenceThreshold: 0.7,
      canDelegate: true,
      delegateTo: ['cpu_agent', 'memory_agent'],
    }, modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个系统级分析专家 Agent，负责分析热节流、IO 压力等系统问题。
任务: ${task.description}
工具: ${this.getToolDescriptionsForLLM()}
请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["system"],"recommendedTools":[],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划系统分析：目标 ${understanding.objective}
请以 JSON 返回：{"steps":[{"toolName":"","params":{},"purpose":""}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思系统分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const systemFindings = findings.filter(f =>
      f.title.includes('热') || f.title.includes('IO') || f.title.includes('thermal')
    );

    if (systemFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '系统级问题影响性能',
        0.6,
        systemFindings.map(f => ({ id: f.id, description: f.title, source: 'system_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = [];

    if (query.includes('热') || query.includes('thermal') || query.includes('温度')) tools.push('analyze_thermal');
    if (query.includes('io') || query.includes('磁盘') || query.includes('存储')) tools.push('analyze_io_pressure');
    if (query.includes('休眠') || query.includes('唤醒') || query.includes('suspend')) tools.push('analyze_suspend_wakeup');

    if (tools.length === 0) tools.push('analyze_thermal');

    return tools;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createStartupAgent(modelRouter: ModelRouter): StartupAgent {
  return new StartupAgent(modelRouter);
}

export function createInteractionAgent(modelRouter: ModelRouter): InteractionAgent {
  return new InteractionAgent(modelRouter);
}

export function createANRAgent(modelRouter: ModelRouter): ANRAgent {
  return new ANRAgent(modelRouter);
}

export function createSystemAgent(modelRouter: ModelRouter): SystemAgent {
  return new SystemAgent(modelRouter);
}
