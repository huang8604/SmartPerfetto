/**
 * SmartPerfetto Memory Agent
 *
 * Phase 2.5: AI Agent for memory analysis
 *
 * Skills wrapped as tools:
 * - memory_analysis
 * - gc_analysis
 * - lmk_analysis
 * - dmabuf_analysis
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

const MEMORY_SKILLS = [
  { skillId: 'memory_analysis', toolName: 'analyze_memory_overview', description: '分析内存使用概况，包括各进程内存分布' },
  { skillId: 'gc_analysis', toolName: 'analyze_gc', description: '分析 GC 活动，检测频繁 GC 问题' },
  { skillId: 'lmk_analysis', toolName: 'analyze_lmk', description: '分析 Low Memory Killer 活动' },
  { skillId: 'dmabuf_analysis', toolName: 'analyze_dmabuf', description: '分析 DMA-BUF 内存使用情况' },
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
        category: 'memory',
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

function createMemoryAgentConfig(modelRouter: ModelRouter): AgentConfig {
  const tools: AgentTool[] = [];
  ensureSkillRegistryInitialized();

  for (const skillInfo of MEMORY_SKILLS) {
    const skill = skillRegistry.getSkill(skillInfo.skillId);
    if (!skill) continue;

    tools.push({
      name: skillInfo.toolName,
      description: skillInfo.description,
      skillId: skillInfo.skillId,
      category: 'memory',
      parameters: skill.inputs?.map((input: any) => ({
        name: input.name, type: input.type as any, required: input.required,
        description: input.description || input.name, default: input.default,
      })),
      execute: createToolExecutorForSkill(skillInfo.skillId),
    });
  }

  return {
    id: 'memory_agent',
    name: 'Memory Analysis Agent',
    domain: 'memory',
    description: 'AI agent specialized in memory, GC, and LMK analysis',
    tools,
    maxIterations: 3,
    confidenceThreshold: 0.7,
    canDelegate: true,
    delegateTo: ['cpu_agent', 'frame_agent'],
  };
}

export class MemoryAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(createMemoryAgentConfig(modelRouter), modelRouter);
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个内存分析专家 Agent，负责分析 Android 系统的内存问题。

## 任务: ${task.description}
## 工具: ${this.getToolDescriptionsForLLM()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":[],"recommendedTools":[],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划内存分析：目标 ${understanding.objective}

请以 JSON 返回：{"steps":[{"toolName":"","params":{},"purpose":""}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思内存分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}

请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const memoryFindings = findings.filter(f =>
      f.title.includes('内存') || f.title.includes('GC') || f.title.includes('LMK') || f.title.includes('memory')
    );

    if (memoryFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '内存压力导致性能问题',
        0.6,
        memoryFindings.map(f => ({ id: f.id, description: f.title, source: 'memory_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = ['analyze_memory_overview'];

    if (query.includes('gc') || query.includes('垃圾回收')) tools.push('analyze_gc');
    if (query.includes('lmk') || query.includes('oom') || query.includes('kill')) tools.push('analyze_lmk');
    if (query.includes('dmabuf') || query.includes('gpu内存')) tools.push('analyze_dmabuf');

    return [...new Set(tools)];
  }
}

export function createMemoryAgent(modelRouter: ModelRouter): MemoryAgent {
  return new MemoryAgent(modelRouter);
}

export default MemoryAgent;
