/**
 * SmartPerfetto Agent-Driven Orchestrator (Thin Coordinator)
 *
 * This orchestrator is a thin coordination layer that:
 * 1. Initializes infrastructure (message bus, agent registry, etc.)
 * 2. Understands user intent and generates hypotheses
 * 3. Selects the appropriate executor (Strategy or Hypothesis)
 * 4. Delegates execution to the chosen executor
 * 5. Generates conclusion from executor results
 *
 * All heavy logic lives in extracted modules:
 * - intentUnderstanding.ts — intent parsing
 * - hypothesisGenerator.ts — hypothesis generation
 * - taskGraphPlanner.ts — task planning
 * - taskGraphExecutor.ts — dependency-ordered execution
 * - feedbackSynthesizer.ts — LLM synthesis
 * - conclusionGenerator.ts — conclusion generation
 * - executors/strategyExecutor.ts — deterministic pipeline
 * - executors/hypothesisExecutor.ts — adaptive loop
 */

import { EventEmitter } from 'events';
import { StreamingUpdate } from '../types';
import { ModelRouter } from './modelRouter';
import { AgentMessageBus, createAgentMessageBus } from '../communication';
import { DomainAgentRegistry, createDomainAgentRegistry } from '../agents/domain';
import {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
} from '../agents/iterationStrategyPlanner';
import {
  createStrategyRegistry,
  StrategyRegistry,
} from '../strategies';
import {
  sessionContextManager,
  EnhancedSessionContext,
} from '../context/enhancedSessionContext';
import { resolveFollowUp, FollowUpResolution } from './followUpHandler';
import { CircuitBreaker } from './circuitBreaker';
import { resolveDrillDown, DrillDownResolved } from './drillDownResolver';
import { applyCapturedEntities } from './entityCapture';

import {
  AgentDrivenOrchestratorConfig,
  DEFAULT_CONFIG,
  AnalysisResult,
  AnalysisOptions,
  AnalysisServices,
  ProgressEmitter,
  ExecutionContext,
} from './orchestratorTypes';
import type { Hypothesis } from '../types/agentProtocol';
import { understandIntent } from './intentUnderstanding';
import { generateInitialHypotheses, translateFollowUpType } from './hypothesisGenerator';
import { generateConclusion } from './conclusionGenerator';
import { StrategyExecutor } from './executors/strategyExecutor';
import { HypothesisExecutor } from './executors/hypothesisExecutor';
import { DirectDrillDownExecutor } from './executors/directDrillDownExecutor';
import { ClarifyExecutor } from './executors/clarifyExecutor';
import { ComparisonExecutor } from './executors/comparisonExecutor';
import { ExtendExecutor } from './executors/extendExecutor';
import type { AnalysisExecutor } from './executors/analysisExecutor';

// =============================================================================
// Agent-Driven Orchestrator
// =============================================================================

export class AgentDrivenOrchestrator extends EventEmitter {
  private config: AgentDrivenOrchestratorConfig;
  private modelRouter: ModelRouter;
  private messageBus: AgentMessageBus;
  private agentRegistry: DomainAgentRegistry;
  private strategyPlanner: IterationStrategyPlanner;
  private strategyRegistry: StrategyRegistry;
  private circuitBreaker: CircuitBreaker;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentDrivenOrchestratorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = modelRouter;

    this.messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      enableLogging: this.config.enableLogging,
    });

    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);
    this.strategyRegistry = createStrategyRegistry();
    this.circuitBreaker = new CircuitBreaker();

    // Register all agents with message bus
    for (const agent of this.agentRegistry.getAll()) {
      this.messageBus.registerAgent(agent);
    }

    this.setupEventForwarding();
  }

  // ==========================================================================
  // Core Analysis Method
  // ==========================================================================

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {}
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    this.strategyPlanner.resetProgressTracking();
    // NOTE: CircuitBreaker is NOT reset per-call — failure history persists
    // across multi-turn sessions. Use orchestrator.reset() for full cleanup.

    const emitter = this.createProgressEmitter();
    emitter.log(`Starting agent-driven analysis for: ${query}`);
    emitter.emitUpdate('progress', { phase: 'starting', message: '开始 AI Agent 分析' });

    // Get or create session context for multi-turn support
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const turnCount = sessionContext.getAllTurns().length;
    emitter.log(`Session has ${turnCount} previous turns`);

    try {
      // 1. Initialize shared context
      const sharedContext = this.messageBus.createSharedContext(sessionId, traceId);

      // 2. Understand intent WITH session context for multi-turn awareness
      emitter.emitUpdate('progress', { phase: 'understanding', message: '理解用户意图' });
      const intent = await understandIntent(query, sessionContext, this.modelRouter, emitter);

      // Log follow-up detection
      if (intent.followUpType && intent.followUpType !== 'initial') {
        emitter.log(`Detected follow-up: ${intent.followUpType}, entities: ${JSON.stringify(intent.referencedEntities)}`);
        emitter.emitUpdate('progress', {
          phase: 'follow_up_detected',
          message: `检测到${translateFollowUpType(intent.followUpType!)}请求`,
          followUpType: intent.followUpType,
          referencedEntities: intent.referencedEntities,
        });
      }

      // 3. Resolve follow-up query - enriches params with details from previous findings
      const followUpResolution = resolveFollowUp(intent, sessionContext);
      if (followUpResolution.isFollowUp) {
        emitter.log(`Follow-up resolved: ${followUpResolution.resolutionDetails || 'params merged'}`);
        if (followUpResolution.focusIntervals?.length) {
          emitter.log(`Built ${followUpResolution.focusIntervals.length} focus interval(s) for drill-down`);
        }
      }

      // 4. Generate hypotheses - with smart skip for drill-down on cached entities
      // Fix: 对于 drill-down follow-up，如果目标实体已在 EntityStore 中有完整分析，
      // 跳过假设生成，避免重复工作
      let initialHypotheses: Hypothesis[] = [];
      const entityStore = sessionContext?.getEntityStore();
      const targetFrameId = intent.extractedParams?.frame_id;
      const targetSessionId = intent.extractedParams?.session_id;

      // Check if this is a drill-down with cached entity data
      // Use wasFrameAnalyzed/wasSessionAnalyzed to check if entity was already analyzed
      const isDrillDownWithCachedFrame =
        intent.followUpType === 'drill_down' &&
        targetFrameId &&
        entityStore?.wasFrameAnalyzed(String(targetFrameId));

      const isDrillDownWithCachedSession =
        intent.followUpType === 'drill_down' &&
        targetSessionId &&
        entityStore?.wasSessionAnalyzed(String(targetSessionId));

      const shouldSkipHypothesisGeneration = isDrillDownWithCachedFrame || isDrillDownWithCachedSession;

      if (shouldSkipHypothesisGeneration) {
        // Skip hypothesis generation for drill-down on already-analyzed entities
        const entityType = isDrillDownWithCachedFrame ? 'frame' : 'session';
        const entityId = isDrillDownWithCachedFrame ? targetFrameId : targetSessionId;
        emitter.log(`[DrillDown] Skipping hypothesis generation - ${entityType} ${entityId} already cached in EntityStore`);

        // Generate minimal targeted hypothesis for drill-down context
        initialHypotheses = [{
          id: `drill_down_${entityType}_${entityId}`,
          description: `深入分析 ${entityType === 'frame' ? '帧' : '会话'} ${entityId} 的详细数据`,
          status: 'investigating',
          confidence: 0.8,
          relevantAgents: ['frame_agent'],
          supportingEvidence: [],
          contradictingEvidence: [],
          proposedBy: 'drill_down_resolver',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }];
      } else {
        // Normal hypothesis generation for initial queries or new entities
        initialHypotheses = await generateInitialHypotheses(
          query, intent, sessionContext, this.modelRouter, this.agentRegistry, emitter
        );
      }

      for (const hypothesis of initialHypotheses) {
        this.messageBus.updateHypothesis(hypothesis);
      }
      emitter.emitUpdate('progress', {
        phase: 'hypotheses_generated',
        message: shouldSkipHypothesisGeneration
          ? `使用缓存数据，跳过假设生成`
          : `生成 ${initialHypotheses.length} 个假设`,
        hypotheses: initialHypotheses.map(h => h.description),
      });

      // 5. Enhanced drill-down resolution using EntityStore cache
      let drillDownResolved: DrillDownResolved | null = null;
      let effectiveIntervals = followUpResolution.focusIntervals;

      if (intent.followUpType === 'drill_down') {
        // Try cache-first resolution via drillDownResolver
        drillDownResolved = await resolveDrillDown(
          intent,
          followUpResolution,
          sessionContext,
          options.traceProcessorService,
          traceId
        );

        if (drillDownResolved && drillDownResolved.intervals.length > 0) {
          effectiveIntervals = drillDownResolved.intervals;

          // Log resolution traces for observability
          for (const trace of drillDownResolved.traces) {
            emitter.log(`[DrillDownResolver] ${trace.entityType}:${trace.entityId} resolved via [${trace.used.join(' → ')}]${trace.enriched ? ' (enriched)' : ''}`);
          }

          emitter.emitUpdate('progress', {
            phase: 'follow_up_resolved',
            message: `已解析 ${drillDownResolved.intervals.length} 个目标区间`,
            resolutionTraces: drillDownResolved.traces,
          });
        }
      }

      // 6. Build execution context with follow-up resolution
      const executionCtx: ExecutionContext = {
        query,
        sessionId,
        traceId,
        intent,
        initialHypotheses,
        sharedContext,
        options: {
          ...options,
          // Pass resolved parameters from follow-up for skill invocation
          ...(followUpResolution.resolvedParams && {
            resolvedFollowUpParams: followUpResolution.resolvedParams,
          }),
          // Pass pre-built focus intervals for drill-down (may be from drillDownResolver)
          ...(effectiveIntervals && {
            prebuiltIntervals: effectiveIntervals,
          }),
        },
        config: this.config,
      };

      // 7. Select and run executor
      const services: AnalysisServices = {
        modelRouter: this.modelRouter,
        messageBus: this.messageBus,
        circuitBreaker: this.circuitBreaker,
      };

      // Executor selection priority:
      // 1. Clarify executor for clarification follow-ups (read-only, no SQL)
      // 2. Comparison executor for compare follow-ups (multiple entities)
      // 3. Extend executor for extend follow-ups (analyze more entities)
      // 4. Direct drill-down executor for explicit drill-down follow-ups with focus intervals
      // 5. Strategy executor if a strategy matches the query
      // 6. Hypothesis executor as fallback for adaptive analysis
      let executor: AnalysisExecutor;

      const followUpType = intent.followUpType;

      if (followUpType === 'clarify') {
        // Clarify: read-only explanation, no SQL queries
        emitter.log('[Routing] Using ClarifyExecutor for clarification request');
        executor = new ClarifyExecutor(sessionContext, services);
      } else if (followUpType === 'compare') {
        // Compare: resolve multiple entities and produce comparison
        emitter.log('[Routing] Using ComparisonExecutor for comparison request');
        executor = new ComparisonExecutor(
          sessionContext,
          services,
          options.traceProcessorService,
          traceId
        );
      } else if (followUpType === 'extend') {
        // Extend: analyze unanalyzed candidate entities
        emitter.log('[Routing] Using ExtendExecutor for extend request');
        executor = new ExtendExecutor(
          sessionContext,
          services,
          options.traceProcessorService,
          traceId
        );
      } else {
        const isDrillDown = followUpResolution.isFollowUp &&
          followUpType === 'drill_down' &&
          effectiveIntervals &&
          effectiveIntervals.length > 0;

        if (isDrillDown) {
          // Direct drill-down: bypasses strategy pipeline, runs target skill directly
          // Update followUpResolution with resolved intervals
          const enhancedFollowUp: FollowUpResolution = {
            ...followUpResolution,
            focusIntervals: effectiveIntervals,
          };
          emitter.log(`[Routing] Using DirectDrillDownExecutor for ${effectiveIntervals!.length} interval(s)`);
          executor = new DirectDrillDownExecutor(enhancedFollowUp, services);
        } else {
          // Normal path: strategy matching or hypothesis-driven
          const matchedStrategy = this.strategyRegistry.match(query);
          if (matchedStrategy) {
            emitter.log(`[Routing] Using StrategyExecutor: ${matchedStrategy.name}`);
            executor = new StrategyExecutor(matchedStrategy, services);
          } else {
            emitter.log('[Routing] Using HypothesisExecutor (no strategy match)');
            executor = new HypothesisExecutor(services, this.agentRegistry, this.strategyPlanner);
          }
        }
      }

      const executorResult = await executor.execute(executionCtx, emitter);

      // 8. Apply captured entities to EntityStore (single write-back point)
      if (executorResult.capturedEntities) {
        applyCapturedEntities(sessionContext.getEntityStore(), executorResult.capturedEntities);
        emitter.log(`[EntityStore] Applied ${executorResult.capturedEntities.frames.length} frames, ${executorResult.capturedEntities.sessions.length} sessions`);
      }

      // Mark analyzed entity IDs
      if (executorResult.analyzedEntityIds) {
        const store = sessionContext.getEntityStore();
        for (const frameId of executorResult.analyzedEntityIds.frames || []) {
          store.markFrameAnalyzed(frameId);
        }
        for (const sessionId of executorResult.analyzedEntityIds.sessions || []) {
          store.markSessionAnalyzed(sessionId);
        }
      }

      // 9. Generate conclusion
      emitter.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
      const conclusion = await generateConclusion(
        sharedContext, executorResult.findings, intent,
        this.modelRouter, emitter, executorResult.stopReason || undefined
      );

      emitter.emitUpdate('conclusion', {
        sessionId,
        summary: conclusion,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
      });

      // 10. Build result
      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings: executorResult.findings,
        hypotheses: Array.from(sharedContext.hypotheses.values()),
        conclusion,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
        totalDurationMs: Date.now() - startTime,
      };

      // 11. Record this turn in session context for future follow-ups
      sessionContext.addTurn(query, intent, {
        success: result.success,
        findings: result.findings,
        confidence: result.confidence,
        message: conclusion,
      }, result.findings);

      emitter.log(`Analysis complete: ${executorResult.findings.length} findings, ${executorResult.rounds} rounds (turn ${turnCount + 1})`);
      return result;

    } catch (error: any) {
      emitter.log(`Analysis failed: ${error.message}`);
      emitter.emitUpdate('error', { message: error.message });

      // Record failed turn for context continuity
      sessionContext.addTurn(query, {
        primaryGoal: query,
        aspects: ['general'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
        followUpType: 'initial',
      }, undefined);

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `分析失败: ${error.message}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  // ==========================================================================
  // Infrastructure
  // ==========================================================================

  private createProgressEmitter(): ProgressEmitter {
    return {
      emitUpdate: (type, content) => {
        const update: StreamingUpdate = { type, content, timestamp: Date.now() };
        this.emit('update', update);
        if (this.config.streamingCallback) {
          this.config.streamingCallback(update);
        }
      },
      log: (message) => {
        if (this.config.enableLogging) {
          console.log(`[AgentDrivenOrchestrator] ${message}`);
        }
      },
    };
  }

  private setupEventForwarding(): void {
    this.messageBus.on('task_dispatched', (data) => {
      this.emitRaw('progress', { phase: 'task_dispatched', ...data });
    });
    this.messageBus.on('task_completed', (data) => {
      this.emitRaw('progress', { phase: 'task_completed', ...data });
    });
    this.messageBus.on('agent_question', (question) => {
      this.emitRaw('progress', { phase: 'agent_question', ...question });
    });
    this.messageBus.on('broadcast', (message) => {
      this.emitRaw('progress', { phase: 'broadcast', ...message });
    });
  }

  private emitRaw(type: StreamingUpdate['type'], content: any): void {
    const update: StreamingUpdate = { type, content, timestamp: Date.now() };
    this.emit('update', update);
    if (this.config.streamingCallback) {
      this.config.streamingCallback(update);
    }
  }

  reset(): void {
    this.messageBus.reset();
    this.circuitBreaker.reset();
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgentDrivenOrchestrator(
  modelRouter: ModelRouter,
  config?: Partial<AgentDrivenOrchestratorConfig>
): AgentDrivenOrchestrator {
  return new AgentDrivenOrchestrator(modelRouter, config);
}

// Re-export types for backward compatibility
export type { AgentDrivenOrchestratorConfig, AnalysisResult } from './orchestratorTypes';

export default AgentDrivenOrchestrator;
