/**
 * SmartPerfetto Agent-Driven Orchestrator
 *
 * Phase 3: Transform from "AI-assisted deterministic executor" to "AI Agents driven" system
 *
 * This orchestrator:
 * 1. Uses AI to understand user intent and generate hypotheses
 * 2. Dynamically dispatches tasks to domain agents based on hypotheses
 * 3. Collects and synthesizes feedback from agents
 * 4. Runs multi-round iterations until conclusions are reached
 * 5. Generates intelligent, evidence-backed conclusions
 *
 * Architecture:
 * User Query → Master Agent (AI decision core)
 *                    ↓
 *           Dynamic task dispatch
 *                    ↓
 *      ┌────────┬────────┬────────┬────────┐
 *      ↓        ↓        ↓        ↓        ↓
 *   Frame    CPU     Binder   Memory    ...
 *   Agent   Agent    Agent    Agent
 *      └────────┴────────┴────────┴────────┘
 *                    ↓
 *           Feedback & Reasoning
 *                    ↓
 *      Master Agent synthesizes findings,
 *      dispatches more tasks if needed
 *                    ↓
 *         AI-generated insights
 */

import { EventEmitter } from 'events';
import {
  Intent,
  Finding,
  StreamingUpdate,
  Evaluation,
  MasterOrchestratorResult,
} from '../types';
import {
  AgentTask,
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
  createTaskId,
  createHypothesisId,
} from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { AgentMessageBus, createAgentMessageBus } from '../communication';
import {
  DomainAgentRegistry,
  createDomainAgentRegistry,
} from '../agents/domain';
import {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
  StrategyDecision,
} from '../agents/iterationStrategyPlanner';
import {
  EnhancedSessionContext,
  sessionContextManager,
} from '../context/enhancedSessionContext';

// =============================================================================
// Types
// =============================================================================

export interface AgentDrivenOrchestratorConfig {
  /** Maximum analysis rounds */
  maxRounds: number;
  /** Maximum concurrent agent tasks */
  maxConcurrentTasks: number;
  /** Confidence threshold to conclude */
  confidenceThreshold: number;
  /** Enable logging */
  enableLogging: boolean;
  /** Streaming callback */
  streamingCallback?: (update: StreamingUpdate) => void;
}

const DEFAULT_CONFIG: AgentDrivenOrchestratorConfig = {
  maxRounds: 5,
  maxConcurrentTasks: 3,
  confidenceThreshold: 0.7,
  enableLogging: true,
};

export interface AnalysisResult {
  sessionId: string;
  success: boolean;
  findings: Finding[];
  hypotheses: Hypothesis[];
  conclusion: string;
  confidence: number;
  rounds: number;
  totalDurationMs: number;
}

// =============================================================================
// Agent-Driven Orchestrator
// =============================================================================

/**
 * Agent-Driven Orchestrator
 *
 * This is the AI decision core that coordinates domain agents
 * through dynamic task dispatch and feedback synthesis.
 */
export class AgentDrivenOrchestrator extends EventEmitter {
  private config: AgentDrivenOrchestratorConfig;
  private modelRouter: ModelRouter;
  private messageBus: AgentMessageBus;
  private agentRegistry: DomainAgentRegistry;
  private strategyPlanner: IterationStrategyPlanner;
  private sessionContext: EnhancedSessionContext | null = null;
  private currentRound: number = 0;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentDrivenOrchestratorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = modelRouter;

    // Initialize components
    this.messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      enableLogging: this.config.enableLogging,
    });

    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);

    // Register all agents with message bus
    for (const agent of this.agentRegistry.getAll()) {
      this.messageBus.registerAgent(agent);
    }

    // Set up event forwarding
    this.setupEventForwarding();
  }

  // ==========================================================================
  // Core Analysis Method
  // ==========================================================================

  /**
   * Run agent-driven analysis
   */
  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: {
      traceProcessorService?: any;
      packageName?: string;
      timeRange?: { start: number; end: number };
    } = {}
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    this.currentRound = 0;

    this.log(`Starting agent-driven analysis for: ${query}`);
    this.emitUpdate('progress', { phase: 'starting', message: '开始 AI Agent 分析' });

    try {
      // 1. Initialize session context
      this.sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const sharedContext = this.messageBus.createSharedContext(sessionId, traceId);

      // 2. Understand intent and generate initial hypotheses
      this.emitUpdate('progress', { phase: 'understanding', message: '理解用户意图' });
      const intent = await this.understandIntent(query);
      const initialHypotheses = await this.generateInitialHypotheses(query, intent);

      // Add hypotheses to shared context
      for (const hypothesis of initialHypotheses) {
        this.messageBus.updateHypothesis(hypothesis);
      }

      this.emitUpdate('progress', {
        phase: 'hypotheses_generated',
        message: `生成 ${initialHypotheses.length} 个假设`,
        hypotheses: initialHypotheses.map(h => h.description),
      });

      // 3. Run analysis loop
      let allFindings: Finding[] = [];
      let lastStrategy: StrategyDecision | null = null;

      while (this.currentRound < this.config.maxRounds) {
        this.currentRound++;
        this.log(`=== Round ${this.currentRound}/${this.config.maxRounds} ===`);

        this.emitUpdate('progress', {
          phase: 'round_start',
          round: this.currentRound,
          maxRounds: this.config.maxRounds,
          message: `分析轮次 ${this.currentRound}`,
        });

        // 3a. Dispatch tasks based on hypotheses
        const tasks = await this.dispatchTasks(query, intent, sharedContext, options);

        if (tasks.length === 0) {
          this.log('No tasks to dispatch, concluding');
          break;
        }

        this.emitUpdate('progress', {
          phase: 'tasks_dispatched',
          taskCount: tasks.length,
          agents: tasks.map(t => t.targetAgentId),
          message: `派发 ${tasks.length} 个任务`,
        });

        // 3b. Execute tasks and collect responses
        const responses = await this.messageBus.dispatchTasksParallel(tasks);

        // 3c. Synthesize feedback
        const synthesis = await this.synthesizeFeedback(responses, sharedContext);

        this.emitUpdate('progress', {
          phase: 'synthesis_complete',
          confirmedFindings: synthesis.confirmedFindings.length,
          updatedHypotheses: synthesis.updatedHypotheses.length,
          message: `综合 ${responses.length} 个 Agent 反馈`,
        });

        // Collect findings
        allFindings.push(...synthesis.newFindings);

        // Emit findings
        if (synthesis.newFindings.length > 0) {
          this.emitUpdate('finding', {
            round: this.currentRound,
            findings: synthesis.newFindings,
          });
        }

        // 3d. Decide next strategy
        const strategyContext = {
          evaluation: this.buildEvaluation(allFindings, sharedContext),
          previousResults: [],
          intent,
          iterationCount: this.currentRound,
          maxIterations: this.config.maxRounds,
          allFindings,
        };

        lastStrategy = await this.strategyPlanner.planNextIteration(strategyContext);

        this.emitUpdate('progress', {
          phase: 'strategy_decision',
          strategy: lastStrategy.strategy,
          confidence: lastStrategy.confidence,
          reasoning: lastStrategy.reasoning,
          message: `策略: ${this.translateStrategy(lastStrategy.strategy)}`,
        });

        if (lastStrategy.strategy === 'conclude') {
          this.log('Strategy: conclude - ending analysis');
          break;
        }

        // Handle deep_dive: update context and add additional skills to investigate
        if (lastStrategy.strategy === 'deep_dive' && lastStrategy.focusArea) {
          this.log(`Strategy: deep_dive - focusing on ${lastStrategy.focusArea}`);
          sharedContext.focusedTimeRange = options.timeRange;

          // Add a new hypothesis based on the focus area
          const deepDiveHypothesis: Hypothesis = {
            id: createHypothesisId(),
            description: `深入分析 ${lastStrategy.focusArea} 领域`,
            confidence: 0.6,
            status: 'investigating',
            supportingEvidence: [],
            contradictingEvidence: [],
            proposedBy: 'master_orchestrator',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.messageBus.updateHypothesis(deepDiveHypothesis);

          // Additional skills will be picked up in next iteration via dispatchTasks
        }

        // Handle pivot: change analysis direction
        if (lastStrategy.strategy === 'pivot' && lastStrategy.newDirection) {
          this.log(`Strategy: pivot - changing direction to ${lastStrategy.newDirection}`);

          // Mark current hypotheses as paused and create new one for new direction
          for (const hypothesis of sharedContext.hypotheses.values()) {
            if (hypothesis.status === 'investigating') {
              hypothesis.status = 'proposed'; // Reset to proposed
              hypothesis.confidence = Math.max(0.3, hypothesis.confidence - 0.2);
              hypothesis.updatedAt = Date.now();
            }
          }

          // Create hypothesis for new direction
          const pivotHypothesis: Hypothesis = {
            id: createHypothesisId(),
            description: lastStrategy.newDirection,
            confidence: 0.5,
            status: 'proposed',
            supportingEvidence: [],
            contradictingEvidence: [],
            proposedBy: 'master_orchestrator',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.messageBus.updateHypothesis(pivotHypothesis);
        }
      }

      // 4. Generate conclusion
      this.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
      const conclusion = await this.generateConclusion(sharedContext, allFindings, intent);

      this.emitUpdate('conclusion', {
        sessionId,
        summary: conclusion,
        confidence: lastStrategy?.confidence || 0.5,
        rounds: this.currentRound,
      });

      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings: allFindings,
        hypotheses: Array.from(sharedContext.hypotheses.values()),
        conclusion,
        confidence: lastStrategy?.confidence || 0.5,
        rounds: this.currentRound,
        totalDurationMs: Date.now() - startTime,
      };

      this.log(`Analysis complete: ${allFindings.length} findings, ${this.currentRound} rounds`);
      return result;

    } catch (error: any) {
      this.log(`Analysis failed: ${error.message}`);
      this.emitUpdate('error', { message: error.message });

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `分析失败: ${error.message}`,
        confidence: 0,
        rounds: this.currentRound,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  // ==========================================================================
  // Intent Understanding
  // ==========================================================================

  private async understandIntent(query: string): Promise<Intent> {
    const prompt = `分析以下用户查询，提取分析意图：

用户查询: "${query}"

请以 JSON 格式返回：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex"
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'intent_understanding');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as Intent;
      }
    } catch (error) {
      this.log(`Failed to parse intent: ${error}`);
    }

    return {
      primaryGoal: query,
      aspects: ['general'],
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
    };
  }

  // ==========================================================================
  // Hypothesis Generation
  // ==========================================================================

  private async generateInitialHypotheses(query: string, intent: Intent): Promise<Hypothesis[]> {
    const prompt = `基于以下用户查询，生成可能的性能问题假设：

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
分析方面: ${intent.aspects.join(', ')}

请以 JSON 格式返回假设列表：
{
  "hypotheses": [
    {
      "description": "假设描述",
      "confidence": 0.5,
      "relevantAgents": ["frame_agent", "cpu_agent"]
    }
  ]
}

可用的 Agent:
${this.agentRegistry.getAgentDescriptionsForLLM()}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'planning');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return (parsed.hypotheses || []).map((h: any) => ({
          id: createHypothesisId(),
          description: h.description,
          confidence: h.confidence || 0.5,
          status: 'proposed' as const,
          supportingEvidence: [],
          contradictingEvidence: [],
          proposedBy: 'master_orchestrator',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          relevantAgents: h.relevantAgents,
        }));
      }
    } catch (error) {
      this.log(`Failed to generate hypotheses: ${error}`);
    }

    // Default hypothesis based on query keywords
    return this.generateDefaultHypotheses(query, intent);
  }

  private generateDefaultHypotheses(query: string, intent: Intent): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const queryLower = query.toLowerCase();

    if (queryLower.includes('卡顿') || queryLower.includes('jank')) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '帧渲染超时导致卡顿',
        confidence: 0.6,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    if (queryLower.includes('滑动') || queryLower.includes('scroll')) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '滑动过程中存在性能瓶颈',
        confidence: 0.6,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    if (hypotheses.length === 0) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '存在性能问题需要诊断',
        confidence: 0.5,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return hypotheses;
  }

  // ==========================================================================
  // Task Dispatch
  // ==========================================================================

  private async dispatchTasks(
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    options: any
  ): Promise<AgentTask[]> {
    const tasks: AgentTask[] = [];
    const hypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'proposed' || h.status === 'investigating');

    // Use AI to decide which agents to dispatch
    const prompt = `基于以下信息，决定派发任务给哪些 Agent：

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
当前假设:
${hypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n')}

已确认发现:
${sharedContext.confirmedFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

可用 Agent:
${this.agentRegistry.getAgentDescriptionsForLLM()}

请以 JSON 格式返回任务分配：
{
  "tasks": [
    {
      "agentId": "agent_id",
      "description": "任务描述",
      "priority": 1-10,
      "context": { "focusArea": "可选的关注领域" }
    }
  ]
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'planning');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const taskDef of (parsed.tasks || [])) {
          const agent = this.agentRegistry.get(taskDef.agentId);
          if (agent) {
            tasks.push({
              id: createTaskId(),
              description: taskDef.description,
              targetAgentId: taskDef.agentId,
              priority: taskDef.priority || 5,
              context: {
                query,
                intent: {
                  primaryGoal: intent.primaryGoal,
                  aspects: intent.aspects,
                },
                hypothesis: hypotheses[0],
                relevantFindings: sharedContext.confirmedFindings.slice(-5),
                additionalData: {
                  traceProcessorService: options.traceProcessorService,
                  packageName: options.packageName,
                  ...taskDef.context,
                },
              },
              dependencies: [],
              createdAt: Date.now(),
            });
          }
        }
      }
    } catch (error) {
      this.log(`Failed to generate tasks: ${error}`);
    }

    // Fallback: dispatch to relevant agents based on query
    if (tasks.length === 0) {
      const relevantAgents = this.agentRegistry.getAgentsForTopic(query);
      for (const agent of relevantAgents.slice(0, 3)) {
        tasks.push({
          id: createTaskId(),
          description: `Analyze ${agent.config.domain} for: ${query}`,
          targetAgentId: agent.config.id,
          priority: 5,
          context: {
            query,
            intent: {
              primaryGoal: intent.primaryGoal,
              aspects: intent.aspects,
            },
            additionalData: {
              traceProcessorService: options.traceProcessorService,
              packageName: options.packageName,
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });
      }
    }

    return tasks;
  }

  // ==========================================================================
  // Feedback Synthesis
  // ==========================================================================

  private async synthesizeFeedback(
    responses: AgentResponse[],
    sharedContext: SharedAgentContext
  ): Promise<{
    newFindings: Finding[];
    confirmedFindings: Finding[];
    updatedHypotheses: Hypothesis[];
    informationGaps: string[];
  }> {
    const allFindings: Finding[] = [];
    const newFindings: Finding[] = [];

    // Collect all findings
    for (const response of responses) {
      allFindings.push(...response.findings);
    }

    // Deduplicate findings
    const seenTitles = new Set<string>();
    for (const finding of allFindings) {
      if (!seenTitles.has(finding.title)) {
        seenTitles.add(finding.title);
        newFindings.push(finding);
      }
    }

    // Use AI to synthesize
    const prompt = `综合以下 Agent 反馈：

${responses.map(r => `[${r.agentId}]:
- 发现: ${r.findings.map(f => f.title).join(', ') || '无'}
- 置信度: ${r.confidence.toFixed(2)}
- 建议: ${r.suggestions?.join('; ') || '无'}`).join('\n\n')}

当前假设:
${Array.from(sharedContext.hypotheses.values()).map(h => `- ${h.description} (${h.status})`).join('\n')}

请分析：
1. 哪些发现相互印证？
2. 是否存在矛盾？
3. 哪些假设得到支持或被否定？
4. 还缺少什么信息？

请以 JSON 返回：
{
  "correlatedFindings": ["相互印证的发现"],
  "contradictions": ["矛盾"],
  "hypothesisUpdates": [{"hypothesisId": "id", "action": "support/reject", "reason": "原因"}],
  "informationGaps": ["缺失的信息"]
}`;

    let informationGaps: string[] = [];

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        informationGaps = parsed.informationGaps || [];

        // Process hypothesis updates
        if (parsed.hypothesisUpdates) {
          for (const update of parsed.hypothesisUpdates) {
            const hypothesis = sharedContext.hypotheses.get(update.hypothesisId);
            if (hypothesis) {
              if (update.action === 'support') {
                hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.1);
              } else if (update.action === 'reject') {
                hypothesis.status = 'rejected';
                hypothesis.confidence = 0;
              }
              hypothesis.updatedAt = Date.now();
            }
          }
        }
      }
    } catch (error) {
      this.log(`Failed to synthesize feedback: ${error}`);
    }

    return {
      newFindings,
      confirmedFindings: sharedContext.confirmedFindings,
      updatedHypotheses: Array.from(sharedContext.hypotheses.values()),
      informationGaps,
    };
  }

  // ==========================================================================
  // Conclusion Generation
  // ==========================================================================

  private async generateConclusion(
    sharedContext: SharedAgentContext,
    allFindings: Finding[],
    intent: Intent
  ): Promise<string> {
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed' || h.confidence >= 0.7);

    const prompt = `基于以下分析结果生成诊断结论：

用户目标: ${intent.primaryGoal}

已确认的假设:
${confirmedHypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

发现的问题:
${allFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

调查路径:
${sharedContext.investigationPath.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n')}

请生成:
1. 根因分析（最可能的原因）
2. 证据支撑（每个结论的依据）
3. 置信度评估

注意：不要给出优化建议，只需要指出问题所在。`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      return response.response;
    } catch (error) {
      this.log(`Failed to generate conclusion: ${error}`);
    }

    // Fallback conclusion
    return this.generateSimpleConclusion(allFindings);
  }

  private generateSimpleConclusion(findings: Finding[]): string {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');

    let conclusion = '## 分析结论\n\n';

    if (critical.length > 0) {
      conclusion += `### 严重问题 (${critical.length})\n`;
      for (const f of critical) {
        conclusion += `- **${f.title}**\n`;
      }
      conclusion += '\n';
    }

    if (warnings.length > 0) {
      conclusion += `### 需要关注 (${warnings.length})\n`;
      for (const f of warnings) {
        conclusion += `- ${f.title}\n`;
      }
      conclusion += '\n';
    }

    if (findings.length === 0) {
      conclusion += '未发现明显的性能问题。\n';
    }

    return conclusion;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private buildEvaluation(findings: Finding[], sharedContext: SharedAgentContext): Evaluation {
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed').length;

    return {
      passed: findings.length > 0,
      qualityScore: Math.min(1, findings.length * 0.1 + confirmedHypotheses * 0.2),
      completenessScore: Math.min(1, findings.length * 0.15),
      contradictions: [],
      feedback: {
        strengths: findings.length > 0 ? ['发现了性能问题'] : [],
        weaknesses: [],
        missingAspects: [],
        improvementSuggestions: [],
        priorityActions: [],
      },
      needsImprovement: findings.length === 0,
      suggestedActions: [],
    };
  }

  private translateStrategy(strategy: string): string {
    const translations: Record<string, string> = {
      'continue': '继续分析',
      'deep_dive': '深入分析',
      'pivot': '转向新方向',
      'conclude': '生成结论',
    };
    return translations[strategy] || strategy;
  }

  private setupEventForwarding(): void {
    this.messageBus.on('task_dispatched', (data) => {
      this.emitUpdate('progress', { phase: 'task_dispatched', ...data });
    });

    this.messageBus.on('task_completed', (data) => {
      this.emitUpdate('progress', { phase: 'task_completed', ...data });
    });

    this.messageBus.on('agent_question', (question) => {
      this.emitUpdate('progress', { phase: 'agent_question', ...question });
    });

    this.messageBus.on('broadcast', (message) => {
      this.emitUpdate('progress', { phase: 'broadcast', ...message });
    });
  }

  private emitUpdate(type: StreamingUpdate['type'], content: any): void {
    const update: StreamingUpdate = {
      type,
      content,
      timestamp: Date.now(),
    };

    this.emit('update', update);

    if (this.config.streamingCallback) {
      this.config.streamingCallback(update);
    }
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[AgentDrivenOrchestrator] ${message}`);
    }
  }

  /**
   * Reset orchestrator state
   */
  reset(): void {
    this.messageBus.reset();
    this.currentRound = 0;
    this.sessionContext = null;
  }
}

/**
 * Create an agent-driven orchestrator
 */
export function createAgentDrivenOrchestrator(
  modelRouter: ModelRouter,
  config?: Partial<AgentDrivenOrchestratorConfig>
): AgentDrivenOrchestrator {
  return new AgentDrivenOrchestrator(modelRouter, config);
}

export default AgentDrivenOrchestrator;
