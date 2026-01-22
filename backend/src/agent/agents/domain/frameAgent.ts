/**
 * SmartPerfetto Frame Agent
 *
 * Phase 2.2: AI Agent for frame and scrolling performance analysis
 *
 * This agent specializes in:
 * - Detecting jank frames
 * - Analyzing scrolling performance
 * - Frame production/consumption timing
 * - Present fence analysis
 *
 * Skills wrapped as tools:
 * - janky_frame_analysis
 * - jank_frame_detail
 * - scrolling_analysis
 * - consumer_jank_detection
 * - sf_frame_consumption
 * - app_frame_production
 * - present_fence_timing
 */

import {
  BaseAgent,
  TaskUnderstanding,
  ExecutionPlan,
  ExecutionResult,
} from '../base/baseAgent';
import {
  AgentConfig,
  AgentTask,
  AgentTaskContext,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
  Evidence,
  createHypothesisId,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import {
  SkillExecutor,
  createSkillExecutor,
  skillRegistry,
  ensureSkillRegistryInitialized,
  SkillExecutionResult,
  DiagnosticResult,
} from '../../../services/skillEngine';

// =============================================================================
// Frame Agent Configuration
// =============================================================================

/**
 * Skills that FrameAgent wraps as tools
 */
const FRAME_SKILLS = [
  {
    skillId: 'janky_frame_analysis',
    toolName: 'analyze_jank_frames',
    description: '分析卡顿帧，返回超时帧列表和分布统计',
  },
  {
    skillId: 'jank_frame_detail',
    toolName: 'get_frame_detail',
    description: '获取单帧详细信息，包括每个阶段的耗时',
  },
  {
    skillId: 'scrolling_analysis',
    toolName: 'analyze_scrolling',
    description: '分析滑动性能，包括会话检测、FPS、掉帧率',
  },
  {
    skillId: 'consumer_jank_detection',
    toolName: 'detect_consumer_jank',
    description: '检测 Consumer 侧卡顿，分析 GPU/合成层问题',
  },
  {
    skillId: 'sf_frame_consumption',
    toolName: 'analyze_sf_frames',
    description: '分析 SurfaceFlinger 帧消费情况',
  },
  {
    skillId: 'app_frame_production',
    toolName: 'analyze_app_frames',
    description: '分析应用帧生产情况，包括 Choreographer 回调',
  },
  {
    skillId: 'present_fence_timing',
    toolName: 'analyze_present_fence',
    description: '分析 Present Fence 时序，检测显示延迟',
  },
];

/**
 * Create Frame Agent configuration
 */
function createFrameAgentConfig(modelRouter: ModelRouter): AgentConfig {
  const tools: AgentTool[] = [];

  // Ensure skill registry is initialized
  ensureSkillRegistryInitialized();

  // Create tools from skills
  for (const skillInfo of FRAME_SKILLS) {
    const skill = skillRegistry.getSkill(skillInfo.skillId);
    if (!skill) {
      console.warn(`[FrameAgent] Skill not found: ${skillInfo.skillId}`);
      continue;
    }

    const tool: AgentTool = {
      name: skillInfo.toolName,
      description: skillInfo.description,
      skillId: skillInfo.skillId,
      category: 'frame',
      parameters: skill.inputs?.map((input: any) => ({
        name: input.name,
        type: input.type as any,
        required: input.required,
        description: input.description || input.name,
        default: input.default,
      })),
      execute: createToolExecutorForSkill(skillInfo.skillId),
    };

    tools.push(tool);
  }

  return {
    id: 'frame_agent',
    name: 'Frame Analysis Agent',
    domain: 'frame',
    description: 'AI agent specialized in frame timing, jank detection, and scrolling performance analysis',
    tools,
    maxIterations: 3,
    confidenceThreshold: 0.7,
    canDelegate: true,
    delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
  };
}

/**
 * Create a tool executor function for a given skill ID
 * This wraps a skill as an agent tool
 */
function createToolExecutorForSkill(skillId: string): (params: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult> {
  return async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
    const startTime = Date.now();

    try {
      if (!context.traceProcessorService) {
        return {
          success: false,
          error: 'TraceProcessorService not available',
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Create skill executor with traceProcessorService and aiService
      const executor = createSkillExecutor(
        context.traceProcessorService,
        context.aiService
      );

      // Build params with package and time range
      const execParams: Record<string, any> = {
        ...params,
        package: context.packageName,
      };

      if (context.timeRange) {
        execParams.start_ts = context.timeRange.start;
        execParams.end_ts = context.timeRange.end;
      }

      // Execute skill with the correct signature: (skillId, traceId, params, inherited)
      const result = await executor.execute(skillId, context.traceId, execParams, {});

      // Extract findings from result
      const findings = extractFindingsFromResult(result, skillId);

      // Extract data from displayResults or rawResults
      const data = extractDataFromResult(result);

      return {
        success: result.success,
        data,
        findings,
        error: result.error,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  };
}

/**
 * Extract findings from skill execution result
 */
function extractFindingsFromResult(result: SkillExecutionResult, skillId: string): Finding[] {
  const findings: Finding[] = [];

  // Extract from diagnostics - DiagnosticResult always contains valid diagnostics
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const diag of result.diagnostics) {
      findings.push({
        id: `${skillId}_${Date.now()}_${findings.length}`,
        category: 'frame',
        type: 'diagnostic',
        severity: mapDiagnosticSeverity(diag.severity),
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

/**
 * Extract data from skill execution result
 */
function extractDataFromResult(result: SkillExecutionResult): any {
  // Prefer displayResults for structured data
  if (result.displayResults && result.displayResults.length > 0) {
    // Return merged data from all display results
    const data: Record<string, any> = {};
    for (const dr of result.displayResults) {
      data[dr.stepId] = dr.data;
    }
    return data;
  }

  // Fallback to rawResults
  if (result.rawResults) {
    const data: Record<string, any> = {};
    for (const [stepId, stepResult] of Object.entries(result.rawResults)) {
      data[stepId] = stepResult.data;
    }
    return data;
  }

  return null;
}

/**
 * Map diagnostic severity to Finding severity
 */
function mapDiagnosticSeverity(severity: DiagnosticResult['severity']): Finding['severity'] {
  // DiagnosticResult severity is already 'info' | 'warning' | 'critical'
  return severity;
}

// =============================================================================
// Frame Agent Implementation
// =============================================================================

/**
 * Frame Agent - AI agent for frame and scrolling analysis
 */
export class FrameAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(createFrameAgentConfig(modelRouter), modelRouter);
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个帧性能分析专家 Agent，负责分析 Android 应用的帧渲染和滑动性能问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${task.context.relevantFindings?.length ? `- 相关发现: ${task.context.relevantFindings.map(f => f.title).join(', ')}` : ''}

## 你的工具
${this.getToolDescriptionsForLLM()}

## 任务
分析这个任务，返回你的理解：

请以 JSON 格式返回：
{
  "objective": "任务的主要目标",
  "questions": ["需要回答的关键问题1", "问题2"],
  "relevantAreas": ["相关分析领域"],
  "recommendedTools": ["建议使用的工具名称"],
  "constraints": ["分析约束或限制"],
  "confidence": 0.0-1.0
}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `你是一个帧性能分析专家 Agent，需要规划执行步骤。

## 目标
${understanding.objective}

## 关键问题
${understanding.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

## 可用工具
${this.getToolDescriptionsForLLM()}

## 推荐工具
${understanding.recommendedTools.join(', ')}

## 任务
创建分析执行计划。

请以 JSON 格式返回：
{
  "steps": [
    {
      "toolName": "工具名称",
      "params": {},
      "purpose": "这一步的目的",
      "dependsOn": [依赖的步骤序号，可选]
    }
  ],
  "expectedOutcomes": ["预期结果1", "预期结果2"],
  "estimatedTimeMs": 预计执行时间毫秒,
  "confidence": 0.0-1.0
}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    const findings = result.findings.map(f => `- [${f.severity}] ${f.title}`).join('\n');
    const steps = result.steps.map(s =>
      `- ${s.toolName}: ${s.result.success ? '成功' : '失败'} - ${s.observations.join(', ')}`
    ).join('\n');

    return `你是一个帧性能分析专家 Agent，需要反思分析结果。

## 原始任务
${task.description}

## 执行结果
${steps}

## 发现的问题
${findings || '无'}

## 任务
反思分析结果，评估是否达成目标，识别差距。

请以 JSON 格式返回：
{
  "insights": ["分析洞察1", "洞察2"],
  "objectivesMet": true/false,
  "findingsConfidence": 0.0-1.0,
  "gaps": ["分析差距1", "差距2"],
  "nextSteps": ["建议的后续步骤"],
  "hypothesisUpdates": [
    {
      "hypothesisId": "假设ID（如果有的话）",
      "action": "support/contradict/confirm/reject",
      "reason": "原因"
    }
  ],
  "questionsForOthers": [
    {
      "toAgent": "其他Agent ID",
      "question": "需要问的问题",
      "priority": 1-10
    }
  ]
}`;
  }

  protected async generateHypotheses(findings: Finding[], task: AgentTask): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];

    if (findings.length === 0) {
      return hypotheses;
    }

    // Generate hypotheses based on findings
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    const jankFindings = findings.filter(f => f.title.toLowerCase().includes('jank') || f.title.includes('掉帧'));

    if (jankFindings.length > 0) {
      // Check for patterns in jank
      const hasMainThreadBlocking = findings.some(f =>
        f.title.includes('主线程') || f.title.includes('UI 线程') || f.title.includes('main thread')
      );
      const hasRenderThreadIssue = findings.some(f =>
        f.title.includes('渲染线程') || f.title.includes('RenderThread')
      );
      const hasGPUIssue = findings.some(f =>
        f.title.includes('GPU') || f.title.includes('合成')
      );

      if (hasMainThreadBlocking) {
        hypotheses.push(this.createHypothesis(
          '主线程阻塞导致帧超时',
          0.7,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.8,
          }))
        ));
      }

      if (hasRenderThreadIssue) {
        hypotheses.push(this.createHypothesis(
          'RenderThread 渲染耗时过长',
          0.6,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.7,
          }))
        ));
      }

      if (hasGPUIssue) {
        hypotheses.push(this.createHypothesis(
          'GPU/合成层存在性能瓶颈',
          0.5,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.6,
          }))
        ));
      }
    }

    // Generate hypothesis from critical findings
    for (const finding of criticalFindings) {
      hypotheses.push(this.createHypothesis(
        `${finding.title} 是主要性能瓶颈`,
        finding.confidence || 0.7,
        [{
          id: finding.id,
          description: finding.title,
          source: 'frame_agent',
          type: 'finding',
          strength: finding.confidence || 0.8,
        }]
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = [];

    // Always start with overview analysis
    tools.push('analyze_scrolling');

    // Add specific tools based on query
    if (query.includes('卡顿') || query.includes('jank') || query.includes('掉帧')) {
      tools.push('analyze_jank_frames');
      tools.push('detect_consumer_jank');
    }

    if (query.includes('帧') || query.includes('frame')) {
      tools.push('analyze_app_frames');
      tools.push('analyze_sf_frames');
    }

    if (query.includes('滑动') || query.includes('scroll') || query.includes('列表')) {
      tools.push('analyze_scrolling');
    }

    if (query.includes('vsync') || query.includes('fence') || query.includes('延迟')) {
      tools.push('analyze_present_fence');
    }

    // Default: use jank analysis
    if (tools.length === 0) {
      tools.push('analyze_jank_frames');
    }

    // Remove duplicates
    return [...new Set(tools)];
  }
}

/**
 * Factory function to create FrameAgent
 */
export function createFrameAgent(modelRouter: ModelRouter): FrameAgent {
  return new FrameAgent(modelRouter);
}

export default FrameAgent;
