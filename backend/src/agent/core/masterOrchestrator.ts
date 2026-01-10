/**
 * SmartPerfetto Master Orchestrator
 *
 * 主编排者，负责：
 * 1. 协调整个分析流程
 * 2. 管理状态机和检查点
 * 3. 控制断路器和迭代
 * 4. 整合所有 SubAgent 的结果
 */

import { EventEmitter } from 'events';
import {
  MasterOrchestratorConfig,
  MasterOrchestratorResult,
  SubAgentContext,
  SubAgentResult,
  Intent,
  AnalysisPlan,
  Evaluation,
  StageResult,
  Finding,
  StreamingUpdate,
  ModelUsageSummary,
  PipelineStage,
  CircuitDecision,
} from '../types';
import { AgentStateMachine } from './stateMachine';
import { CircuitBreaker } from './circuitBreaker';
import { ModelRouter } from './modelRouter';
import { PipelineExecutor, StageExecutor } from './pipelineExecutor';
import { CheckpointManager } from '../state/checkpointManager';
import { SessionStore } from '../state/sessionStore';
import { PlannerAgent } from '../agents/plannerAgent';
import { EvaluatorAgent } from '../agents/evaluatorAgent';
import { AnalysisWorker } from '../agents/workers/analysisWorker';

// 默认配置
// 注意：降低 minQualityScore 从 0.7 到 0.5，减少不必要的迭代循环
const DEFAULT_CONFIG: Partial<MasterOrchestratorConfig> = {
  maxTotalIterations: 3,  // 降低最大迭代次数，避免过度循环
  enableTraceRecording: true,
  evaluationCriteria: {
    minQualityScore: 0.5,  // 降低阈值，Skills 系统已经产出高质量结果
    minCompletenessScore: 0.5,  // 降低阈值
    maxContradictions: 0,
    requiredAspects: [],
  },
};

/**
 * 主编排者实现
 */
export class MasterOrchestrator extends EventEmitter {
  private config: MasterOrchestratorConfig;
  private stateMachine!: AgentStateMachine;
  private circuitBreaker: CircuitBreaker;
  private modelRouter: ModelRouter;
  private pipelineExecutor: PipelineExecutor;
  private checkpointManager: CheckpointManager;
  private sessionStore: SessionStore;

  // SubAgents
  private plannerAgent: PlannerAgent;
  private evaluatorAgent: EvaluatorAgent;
  private analysisWorker: AnalysisWorker;
  private workerAgents: Map<string, StageExecutor>;

  // 执行状态
  private currentSessionId: string | null = null;
  private totalIterations: number = 0;
  private emittedFindingIds: Set<string> = new Set();  // 已发送的 Finding IDs，防止重复
  private emittedDiagnosticHashes: Set<string> = new Set();  // 内容哈希去重 diagnostics

  constructor(config: Partial<MasterOrchestratorConfig> = {}) {
    super();

    // 合并配置
    this.config = {
      ...DEFAULT_CONFIG,
      stateMachineConfig: config.stateMachineConfig || { sessionId: '', traceId: '' },
      circuitBreakerConfig: config.circuitBreakerConfig || {
        maxRetriesPerAgent: 3,
        maxIterationsPerStage: 5,
        cooldownMs: 30000,
        halfOpenAttempts: 1,
        failureThreshold: 3,
        successThreshold: 2,
      },
      // Don't pass empty models array - let ModelRouter use its DEFAULT_MODELS
      modelRouterConfig: config.modelRouterConfig || {
        defaultModel: 'deepseek-chat',
        taskModelMapping: {},
        fallbackChain: ['deepseek-chat'],
        enableEnsemble: false,
        ensembleThreshold: 0.8,
      },
      pipelineConfig: config.pipelineConfig || {
        stages: [],
        maxTotalDuration: 300000,
        enableParallelization: true,
      },
      evaluationCriteria: { ...DEFAULT_CONFIG.evaluationCriteria!, ...config.evaluationCriteria },
      maxTotalIterations: config.maxTotalIterations || DEFAULT_CONFIG.maxTotalIterations!,
      enableTraceRecording: config.enableTraceRecording ?? true,
      streamingCallback: config.streamingCallback,
    } as MasterOrchestratorConfig;

    // 初始化核心组件
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreakerConfig);
    this.modelRouter = new ModelRouter(this.config.modelRouterConfig);
    this.pipelineExecutor = new PipelineExecutor(this.config.pipelineConfig);
    this.checkpointManager = new CheckpointManager();
    this.sessionStore = new SessionStore();

    // 初始化 SubAgents
    this.plannerAgent = new PlannerAgent(this.modelRouter);
    this.evaluatorAgent = new EvaluatorAgent(
      this.modelRouter,
      undefined,
      this.config.evaluationCriteria
    );
    this.analysisWorker = new AnalysisWorker(this.modelRouter);
    this.workerAgents = new Map();

    // 注册阶段执行器
    this.registerDefaultExecutors();

    // 设置事件监听
    this.setupEventListeners();
  }

  // ==========================================================================
  // 核心执行方法
  // ==========================================================================

  /**
   * 处理用户查询
   */
  async handleQuery(
    query: string,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<MasterOrchestratorResult> {
    const startTime = Date.now();

    try {
      // 1. 创建会话
      const session = await this.sessionStore.createSession(traceId, query);
      this.currentSessionId = session.sessionId;
      this.emittedFindingIds.clear();  // 重置已发送的 Finding IDs
      this.emittedDiagnosticHashes.clear();  // 重置内容哈希
      this.totalIterations = 0;  // 重置迭代计数

      // 重置 AnalysisWorker 的会话状态（用于 skill_data 去重）
      this.analysisWorker.resetForNewSession(session.sessionId);

      // 2. 初始化状态机
      this.stateMachine = AgentStateMachine.create(session.sessionId, traceId);
      this.stateMachine.transition({ type: 'START_ANALYSIS' });

      this.emitUpdate('progress', { phase: 'starting', message: '开始分析' });

      // 3. 理解意图
      const intent = await this.understandIntent(query, traceId, options);
      await this.sessionStore.updateIntent(session.sessionId, intent);
      this.stateMachine.transition({ type: 'INTENT_UNDERSTOOD', payload: { intent } });

      this.emitUpdate('progress', { phase: 'planning', message: '规划分析任务' });

      // 4. 创建计划
      const plan = await this.createPlan(intent, traceId, options);
      await this.sessionStore.updatePlan(session.sessionId, plan);
      this.stateMachine.transition({ type: 'PLAN_CREATED', payload: { plan } });

      // 5. 执行分析循环
      let evaluation: Evaluation | null = null;
      let stageResults: StageResult[] = [];

      while (this.totalIterations < this.config.maxTotalIterations) {
        this.totalIterations++;

        // emit iteration_state 事件：通知前端当前迭代状态
        this.emitUpdate('iteration_state' as any, {
          current: this.totalIterations,
          max: this.config.maxTotalIterations,
          phase: 'execute',
          previousScore: evaluation?.qualityScore,
        });

        // 检查断路器
        const circuitCheck = this.circuitBreaker.canExecute();
        if (circuitCheck.action === 'ask_user') {
          return this.createAwaitingUserResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            circuitCheck.reason!,
            startTime
          );
        }

        // 如果当前是 refining 状态，需要先转换到 executing
        if (this.stateMachine.phase === 'refining') {
          this.stateMachine.transition({
            type: 'NEEDS_REFINEMENT',
            payload: { iteration: this.totalIterations },
          });
        }

        // 执行流水线
        this.emitUpdate('progress', {
          phase: 'executing',
          iteration: this.totalIterations,
          message: `执行分析 (迭代 ${this.totalIterations})`,
        });

        const context = this.buildContext(session.sessionId, traceId, intent, plan, stageResults, options);
        const pipelineResult = await this.pipelineExecutor.execute(context, {
          onStageStart: (stage) => {
            this.emitUpdate('progress', { phase: 'stage', stage: stage.id, message: stage.name });
          },
          onStageComplete: (stage, result) => {
            this.handleStageComplete(session.sessionId, stage, result);
          },
          onError: async (stage, error) => {
            return this.handleStageError(stage, error);
          },
          onProgress: (progress) => {
            // Format progress as human-readable message
            const message = `执行阶段 ${progress.currentStage} (${progress.completedStages}/${progress.totalStages})`;
            this.emitUpdate('progress', {
              phase: 'stage_progress',
              message,
              ...progress,  // Include raw data for advanced UI usage
            });
          },
        });

        stageResults = pipelineResult.stageResults;

        // 检查是否暂停
        if (pipelineResult.pausedAt) {
          return this.createPausedResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            pipelineResult.pausedAt,
            startTime
          );
        }

        // 转换到评估阶段 (executing -> evaluating)
        this.stateMachine.transition({
          type: 'STAGE_COMPLETED',
          payload: { stageResults },
        });

        // 评估结果
        this.emitUpdate('progress', { phase: 'evaluating', message: '评估分析结果' });
        evaluation = await this.evaluateResults(stageResults, intent);

        this.stateMachine.transition({
          type: 'EVALUATION_COMPLETE',
          payload: { evaluation, passed: evaluation.passed },
        });

        // 检查是否通过
        if (evaluation.passed) {
          break;
        }

        // 检查迭代次数
        const iterationDecision = this.circuitBreaker.recordIteration('main');
        if (iterationDecision.action === 'ask_user') {
          return this.createAwaitingUserResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            iterationDecision.reason!,
            startTime
          );
        }

        // 继续迭代
        this.emitUpdate('progress', {
          phase: 'refining',
          message: '根据反馈优化分析',
          feedback: evaluation.feedback,
        });
      }

      // 6. 综合最终答案
      this.emitUpdate('progress', { phase: 'synthesizing', message: '综合分析结论' });
      const synthesizedAnswer = await this.synthesize(stageResults, intent, evaluation!);

      // 7. 完成
      this.stateMachine.transition({ type: 'ANALYSIS_COMPLETE' });
      await this.sessionStore.updatePhase(session.sessionId, 'completed');

      this.emitUpdate('conclusion', { answer: synthesizedAnswer });

      return this.createSuccessResult(
        session.sessionId,
        intent,
        plan,
        stageResults,
        evaluation!,
        synthesizedAnswer,
        startTime
      );
    } catch (error: any) {
      this.stateMachine?.transition({ type: 'ERROR_OCCURRED', payload: { error: error.message } });

      if (this.currentSessionId) {
        await this.sessionStore.setError(this.currentSessionId, error.message);
      }

      this.emitUpdate('error', { message: error.message });

      throw error;
    }
  }

  /**
   * 从检查点恢复
   */
  async resumeFromCheckpoint(
    sessionId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<MasterOrchestratorResult> {
    // 加载会话
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 加载最新检查点
    const checkpoint = await this.checkpointManager.getLatestCheckpoint(sessionId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for session: ${sessionId}`);
    }

    // 恢复状态机
    this.stateMachine = (await AgentStateMachine.load(sessionId, session.traceId)) ||
      AgentStateMachine.create(sessionId, session.traceId);
    this.stateMachine.restoreFromCheckpoint(checkpoint);

    // 恢复执行
    const intent = session.intent || await this.understandIntent(session.query, session.traceId, options);
    const plan = session.plan || await this.createPlan(intent, session.traceId, options);

    // 从检查点继续执行
    return this.handleQuery(session.query, session.traceId, options);
  }

  // ==========================================================================
  // 子步骤方法
  // ==========================================================================

  /**
   * 理解意图
   */
  private async understandIntent(
    query: string,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): Promise<Intent> {
    const context: SubAgentContext = {
      sessionId: this.currentSessionId || '',
      traceId,
      ...options,
    };

    return this.plannerAgent.understandIntent(query, context);
  }

  /**
   * 创建计划
   */
  private async createPlan(
    intent: Intent,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): Promise<AnalysisPlan> {
    const context: SubAgentContext = {
      sessionId: this.currentSessionId || '',
      traceId,
      intent,
      ...options,
    };

    return this.plannerAgent.createPlan(intent, context);
  }

  /**
   * 评估结果
   */
  private async evaluateResults(results: StageResult[], intent: Intent): Promise<Evaluation> {
    return this.evaluatorAgent.evaluate(results, intent);
  }

  /**
   * 综合最终答案
   */
  private async synthesize(
    results: StageResult[],
    intent: Intent,
    evaluation: Evaluation
  ): Promise<string> {
    const findings = this.collectFindings(results);

    const prompt = `基于以下分析结果，生成简洁的分析结论：

用户意图: ${intent.primaryGoal}

分析发现:
${findings.map(f => `- [${f.severity}] ${f.title}`).join('\n')}

评估结果:
- 质量分数: ${evaluation.qualityScore.toFixed(2)}
- 完整性: ${evaluation.completenessScore.toFixed(2)}

请生成简洁的分析结论，只包括：
1. 发现的关键问题（简要列出）
2. 可能的根因（一句话概括）

注意：不要给出优化建议或改进方案，只需要指出问题所在。`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      return response.response;
    } catch (error) {
      // 生成简单结论
      return this.generateSimpleSynthesis(findings, evaluation);
    }
  }

  /**
   * 生成简单综合
   * 只列出关键问题，不包含优化建议
   */
  private generateSimpleSynthesis(findings: Finding[], _evaluation: Evaluation): string {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const infos = findings.filter(f => f.severity === 'info');

    let synthesis = '## 分析结论\n\n';

    if (critical.length > 0) {
      synthesis += `### 🔴 严重问题 (${critical.length})\n`;
      for (const f of critical) {
        synthesis += `- **${f.title}**\n`;
      }
      synthesis += '\n';
    }

    if (warnings.length > 0) {
      synthesis += `### 🟡 需要关注 (${warnings.length})\n`;
      for (const f of warnings) {
        synthesis += `- ${f.title}\n`;
      }
      synthesis += '\n';
    }

    if (infos.length > 0 && critical.length === 0 && warnings.length === 0) {
      synthesis += `### ℹ️ 发现 (${infos.length})\n`;
      for (const f of infos) {
        synthesis += `- ${f.title}\n`;
      }
      synthesis += '\n';
    }

    if (findings.length === 0) {
      synthesis += '未发现明显的性能问题。\n';
    }

    return synthesis;
  }

  // ==========================================================================
  // 事件处理
  // ==========================================================================

  /**
   * 处理阶段完成
   */
  private handleStageComplete(sessionId: string, stage: PipelineStage, result: StageResult): void {
    // 创建检查点
    this.checkpointManager.createCheckpoint(
      sessionId,
      stage.id,
      this.stateMachine.phase,
      [result],
      result.findings
    );

    // 过滤已发送的 Finding，防止重复（双重去重：ID + 内容哈希）
    const newFindings = result.findings.filter(f => {
      // 1. ID 去重
      if (this.emittedFindingIds.has(f.id)) {
        return false;
      }

      // 2. 内容哈希去重（防止相同诊断文字重复出现）
      const contentHash = this.hashFindingContent(f);
      if (this.emittedDiagnosticHashes.has(contentHash)) {
        console.log(`[MasterOrchestrator] Skipping duplicate finding by content hash: ${f.title}`);
        return false;
      }

      this.emittedFindingIds.add(f.id);
      this.emittedDiagnosticHashes.add(contentHash);
      return true;
    });

    // 只发送新的 findings
    if (newFindings.length > 0) {
      this.emitUpdate('finding', { stage: stage.id, findings: newFindings });
    }
  }

  /**
   * 计算 Finding 内容哈希（用于去重）
   */
  private hashFindingContent(f: Finding): string {
    // 使用标题+描述+严重程度作为内容标识
    return `${f.title}::${f.description}::${f.severity}`;
  }

  /**
   * 处理阶段错误
   */
  private async handleStageError(stage: PipelineStage, error: Error): Promise<'retry' | 'skip' | 'abort' | 'ask_user'> {
    const decision = this.circuitBreaker.recordFailure(stage.id, error.message);

    this.emitUpdate('error', { stage: stage.id, error: error.message, decision });

    return decision.action as 'retry' | 'skip' | 'abort' | 'ask_user';
  }

  // ==========================================================================
  // 结果构建
  // ==========================================================================

  /**
   * 构建执行上下文
   */
  private buildContext(
    sessionId: string,
    traceId: string,
    intent: Intent,
    plan: AnalysisPlan,
    previousResults: StageResult[],
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): SubAgentContext {
    // Debug: Log whether traceProcessorService is in options
    console.log(`[MasterOrchestrator] buildContext called`);
    console.log(`[MasterOrchestrator] options keys: ${Object.keys(options).join(', ')}`);
    console.log(`[MasterOrchestrator] has traceProcessorService: ${!!options.traceProcessorService}`);
    if (options.traceProcessorService) {
      console.log(`[MasterOrchestrator] traceProcessorService type: ${typeof options.traceProcessorService}`);
      console.log(`[MasterOrchestrator] traceProcessorService has getTrace: ${typeof options.traceProcessorService?.getTrace === 'function'}`);
    }

    const context: SubAgentContext = {
      sessionId,
      traceId,
      intent,
      plan,
      previousResults,
      ...options,
    };

    // Debug: Verify context was built correctly
    console.log(`[MasterOrchestrator] built context keys: ${Object.keys(context).join(', ')}`);
    console.log(`[MasterOrchestrator] context.traceProcessorService: ${!!context.traceProcessorService}`);

    return context;
  }

  /**
   * 收集所有发现
   */
  private collectFindings(results: StageResult[]): Finding[] {
    const findings: Finding[] = [];
    for (const result of results) {
      findings.push(...result.findings);
    }
    return findings;
  }

  /**
   * 创建成功结果
   */
  private createSuccessResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    evaluation: Evaluation,
    synthesizedAnswer: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation,
      synthesizedAnswer,
      confidence: evaluation.qualityScore,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: false,
    };
  }

  /**
   * 创建暂停结果
   */
  private createPausedResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    pausedAt: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation: {
        passed: false,
        qualityScore: 0,
        completenessScore: 0,
        contradictions: [],
        feedback: { strengths: [], weaknesses: [], missingAspects: [], improvementSuggestions: [], priorityActions: [] },
        needsImprovement: true,
        suggestedActions: [`已在阶段 ${pausedAt} 暂停`],
      },
      synthesizedAnswer: `分析已暂停，可以恢复执行`,
      confidence: 0,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: true,
      checkpointId: pausedAt,
    };
  }

  /**
   * 创建等待用户结果
   */
  private createAwaitingUserResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    reason: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation: {
        passed: false,
        qualityScore: 0,
        completenessScore: 0,
        contradictions: [],
        feedback: { strengths: [], weaknesses: [], missingAspects: [], improvementSuggestions: [], priorityActions: [reason] },
        needsImprovement: true,
        suggestedActions: [reason],
      },
      synthesizedAnswer: `需要用户决策: ${reason}`,
      confidence: 0,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: true,
    };
  }

  /**
   * 获取模型使用统计
   */
  private getModelUsage(): ModelUsageSummary {
    const stats = this.modelRouter.getStats();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    const modelBreakdown: Record<string, { calls: number; tokens: number; cost: number }> = {};

    for (const [modelId, modelStats] of Object.entries(stats)) {
      totalInputTokens += modelStats.tokens;
      totalOutputTokens += modelStats.tokens; // 简化
      totalCost += modelStats.cost;
      modelBreakdown[modelId] = modelStats;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      modelBreakdown,
    };
  }

  // ==========================================================================
  // 事件发送
  // ==========================================================================

  /**
   * 发送更新事件
   */
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

  // ==========================================================================
  // 执行器注册
  // ==========================================================================

  /**
   * 注册默认执行器
   */
  private registerDefaultExecutors(): void {
    this.pipelineExecutor.registerExecutor('plan', this.plannerAgent);
    this.pipelineExecutor.registerExecutor('execute', this.analysisWorker);
    this.pipelineExecutor.registerExecutor('evaluate', this.evaluatorAgent);
    this.pipelineExecutor.registerExecutor('refine', this.analysisWorker);
    this.pipelineExecutor.registerExecutor('conclude', this.analysisWorker);
  }

  /**
   * 注册工作 Agent
   */
  registerWorkerAgent(stageId: string, executor: StageExecutor): void {
    this.workerAgents.set(stageId, executor);
    this.pipelineExecutor.registerExecutor(stageId, executor);
  }

  // ==========================================================================
  // 事件监听设置
  // ==========================================================================

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    // 断路器事件
    this.circuitBreaker.on('tripped', (data) => {
      this.emitUpdate('error', { type: 'circuit_tripped', ...data });
    });

    // 模型路由事件
    this.modelRouter.on('modelError', (data) => {
      this.emitUpdate('error', { type: 'model_error', ...data });
    });

    // SubAgent 事件
    this.plannerAgent.on('complete', (data) => {
      this.emitUpdate('thought', { agent: 'planner', ...data });
    });

    this.evaluatorAgent.on('complete', (data) => {
      this.emitUpdate('thought', { agent: 'evaluator', ...data });
    });

    // AnalysisWorker 的 skill_data 事件 - 发送层级数据到前端
    this.analysisWorker.on('skill_data', (data) => {
      // 兼容新旧层级命名
      const layers = data.layers || {};
      console.log('[MasterOrchestrator] Received skill_data event from AnalysisWorker:', {
        skillId: data.skillId,
        skillName: data.skillName,
        hasLayers: !!layers,
        // 语义名称（新）
        overviewKeys: layers.overview ? Object.keys(layers.overview) : [],
        listKeys: layers.list ? Object.keys(layers.list) : [],
        deepKeys: layers.deep ? Object.keys(layers.deep) : [],
        // 兼容名称（旧）- 应与语义名称相同
        L1Keys: layers.L1 ? Object.keys(layers.L1) : [],
        L2Keys: layers.L2 ? Object.keys(layers.L2) : [],
        L4Keys: layers.L4 ? Object.keys(layers.L4) : [],
        diagnosticsCount: data.diagnostics?.length || 0,
      });
      console.log('[MasterOrchestrator] Forwarding skill_data to frontend via emitUpdate');
      this.emitUpdate('skill_data' as any, data);
    });

    // AnalysisWorker 的 worker_thought 事件 - 发送 Worker 思考过程到前端
    this.analysisWorker.on('worker_thought', (data) => {
      console.log('[MasterOrchestrator] Received worker_thought event:', {
        agent: data.agent,
        skillId: data.skillId,
        step: data.step,
      });
      this.emitUpdate('worker_thought' as any, data);
    });
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  /**
   * 关闭编排者
   */
  async close(): Promise<void> {
    await this.sessionStore.close();
    this.stateMachine?.destroy();
    this.removeAllListeners();
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.totalIterations = 0;
    this.currentSessionId = null;
    this.circuitBreaker.reset();
    this.modelRouter.resetStats();
    this.pipelineExecutor.reset();
  }
}

/**
 * Factory function for creating MasterOrchestrator
 */
export function createMasterOrchestrator(
  config: Partial<MasterOrchestratorConfig> = {}
): MasterOrchestrator {
  return new MasterOrchestrator(config);
}

export default MasterOrchestrator;
