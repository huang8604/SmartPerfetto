/**
 * Dialogue Protocol
 *
 * Manages the conversation flow between cross-domain experts and module experts.
 * Handles:
 * - Dialogue session lifecycle
 * - Context management across turns
 * - Query/response history tracking
 * - Turn limits and termination conditions
 */

import { v4 as uuidv4 } from 'uuid';
import {
  DialogueContext,
  ModuleQuery,
  ModuleResponse,
  ModuleFinding,
  Hypothesis,
  AnalysisDecision,
  CrossDomainEvent,
  CrossDomainEventType,
} from './types';
import { ArchitectureInfo } from '../../detectors';

/**
 * Configuration for dialogue sessions
 */
export interface DialogueConfig {
  /** Maximum number of dialogue turns */
  maxTurns: number;
  /** Confidence threshold to stop analysis */
  confidenceThreshold: number;
  /** Whether to allow user intervention */
  allowUserIntervention: boolean;
  /** Maximum hypotheses to track simultaneously */
  maxHypotheses: number;
  /** Timeout per turn in ms */
  turnTimeoutMs: number;
}

/**
 * Default dialogue configuration
 */
export const DEFAULT_DIALOGUE_CONFIG: DialogueConfig = {
  maxTurns: 8,
  confidenceThreshold: 0.85,
  allowUserIntervention: true,
  maxHypotheses: 5,
  turnTimeoutMs: 30000,
};

/**
 * Dialogue session state
 */
export type DialogueState =
  | 'initialized'
  | 'running'
  | 'waiting_user'
  | 'concluded'
  | 'timeout'
  | 'error';

/**
 * Dialogue session statistics
 */
export interface DialogueStats {
  totalTurns: number;
  totalQueries: number;
  totalFindings: number;
  modulesQueried: Set<string>;
  hypothesesExplored: number;
  totalExecutionTimeMs: number;
  startTime: number;
  endTime?: number;
}

/**
 * Event handler type
 */
export type DialogueEventHandler = (event: CrossDomainEvent) => void;

/**
 * DialogueSession - Manages a single dialogue between expert and modules
 */
export class DialogueSession {
  readonly sessionId: string;
  readonly expertId: string;
  private context: DialogueContext;
  private config: DialogueConfig;
  private state: DialogueState = 'initialized';
  private stats: DialogueStats;
  private eventHandlers: DialogueEventHandler[] = [];

  constructor(
    expertId: string,
    traceId: string,
    originalQuery: string,
    config: Partial<DialogueConfig> = {},
    options?: {
      architecture?: ArchitectureInfo;
      packageName?: string;
      traceProcessorService?: any;
    }
  ) {
    this.sessionId = uuidv4();
    this.expertId = expertId;
    this.config = { ...DEFAULT_DIALOGUE_CONFIG, ...config };

    // Initialize context
    this.context = {
      sessionId: this.sessionId,
      traceId,
      turnNumber: 0,
      architecture: options?.architecture,
      packageName: options?.packageName,
      originalQuery,
      queryHistory: [],
      responseHistory: [],
      collectedFindings: [],
      activeHypotheses: [],
      variables: {},
      traceProcessorService: options?.traceProcessorService,
    };

    // Initialize stats
    this.stats = {
      totalTurns: 0,
      totalQueries: 0,
      totalFindings: 0,
      modulesQueried: new Set(),
      hypothesesExplored: 0,
      totalExecutionTimeMs: 0,
      startTime: Date.now(),
    };
  }

  // ===========================================================================
  // State Management
  // ===========================================================================

  /**
   * Get current dialogue state
   */
  getState(): DialogueState {
    return this.state;
  }

  /**
   * Get current context
   */
  getContext(): DialogueContext {
    return { ...this.context };
  }

  /**
   * Get dialogue statistics
   */
  getStats(): DialogueStats {
    return { ...this.stats, modulesQueried: new Set(this.stats.modulesQueried) };
  }

  /**
   * Check if dialogue can continue
   */
  canContinue(): boolean {
    return (
      this.state === 'initialized' ||
      this.state === 'running'
    ) && this.context.turnNumber < this.config.maxTurns;
  }

  /**
   * Check if max turns reached
   */
  isMaxTurnsReached(): boolean {
    return this.context.turnNumber >= this.config.maxTurns;
  }

  // ===========================================================================
  // Turn Management
  // ===========================================================================

  /**
   * Start a new dialogue turn
   */
  startTurn(): number {
    if (!this.canContinue()) {
      throw new Error(`Cannot start turn: state=${this.state}, turn=${this.context.turnNumber}`);
    }

    this.context.turnNumber++;
    this.stats.totalTurns++;
    this.state = 'running';

    this.emitEvent('turn_started', {
      turnNumber: this.context.turnNumber,
      maxTurns: this.config.maxTurns,
    });

    return this.context.turnNumber;
  }

  /**
   * Record a query sent to a module
   */
  recordQuery(query: ModuleQuery): void {
    // Add context to query if not present
    if (!query.context) {
      query.context = this.context;
    }

    this.context.queryHistory.push(query);
    this.stats.totalQueries++;
    this.stats.modulesQueried.add(query.targetModule);

    this.emitEvent('module_queried', {
      queryId: query.queryId,
      targetModule: query.targetModule,
      questionId: query.questionId,
      turnNumber: this.context.turnNumber,
    });
  }

  /**
   * Record a response from a module
   */
  recordResponse(response: ModuleResponse): void {
    this.context.responseHistory.push(response);
    this.stats.totalExecutionTimeMs += response.executionTimeMs;

    // Collect findings
    if (response.findings.length > 0) {
      this.context.collectedFindings.push(...response.findings);
      this.stats.totalFindings += response.findings.length;

      for (const finding of response.findings) {
        this.emitEvent('finding_discovered', {
          findingId: finding.id,
          severity: finding.severity,
          title: finding.title,
          sourceModule: finding.sourceModule,
          confidence: finding.confidence,
        });
      }
    }

    this.emitEvent('module_responded', {
      queryId: response.queryId,
      success: response.success,
      findingsCount: response.findings.length,
      suggestionsCount: response.suggestions.length,
      confidence: response.confidence,
    });
  }

  // ===========================================================================
  // Hypothesis Management
  // ===========================================================================

  /**
   * Add a new hypothesis
   */
  addHypothesis(hypothesis: Hypothesis): void {
    // Check max hypotheses limit
    if (this.context.activeHypotheses.length >= this.config.maxHypotheses) {
      // Remove lowest confidence hypothesis
      this.context.activeHypotheses.sort((a, b) => b.confidence - a.confidence);
      this.context.activeHypotheses.pop();
    }

    this.context.activeHypotheses.push(hypothesis);
    this.stats.hypothesesExplored++;

    this.emitEvent('hypothesis_created', {
      hypothesisId: hypothesis.id,
      title: hypothesis.title,
      category: hypothesis.category,
      component: hypothesis.component,
      confidence: hypothesis.confidence,
    });
  }

  /**
   * Update an existing hypothesis
   */
  updateHypothesis(
    hypothesisId: string,
    updates: Partial<Hypothesis>
  ): Hypothesis | null {
    const index = this.context.activeHypotheses.findIndex(h => h.id === hypothesisId);
    if (index === -1) return null;

    const hypothesis = this.context.activeHypotheses[index];
    const updated: Hypothesis = {
      ...hypothesis,
      ...updates,
      updatedAt: Date.now(),
    };

    this.context.activeHypotheses[index] = updated;

    this.emitEvent('hypothesis_updated', {
      hypothesisId: updated.id,
      status: updated.status,
      confidence: updated.confidence,
      supportingCount: updated.supportingEvidence.length,
      contradictingCount: updated.contradictingEvidence.length,
    });

    return updated;
  }

  /**
   * Get the highest confidence hypothesis
   */
  getTopHypothesis(): Hypothesis | null {
    if (this.context.activeHypotheses.length === 0) return null;

    return this.context.activeHypotheses
      .filter(h => h.status !== 'rejected')
      .sort((a, b) => b.confidence - a.confidence)[0] || null;
  }

  /**
   * Check if any hypothesis meets confidence threshold
   */
  hasConfidentHypothesis(): boolean {
    return this.context.activeHypotheses.some(
      h => h.status !== 'rejected' && h.confidence >= this.config.confidenceThreshold
    );
  }

  // ===========================================================================
  // Variable Management
  // ===========================================================================

  /**
   * Set a variable for use in subsequent queries
   */
  setVariable(key: string, value: any): void {
    this.context.variables[key] = value;
  }

  /**
   * Get a variable
   */
  getVariable(key: string): any {
    return this.context.variables[key];
  }

  /**
   * Get all variables
   */
  getVariables(): Record<string, any> {
    return { ...this.context.variables };
  }

  // ===========================================================================
  // Decision Recording
  // ===========================================================================

  /**
   * Record a decision made by the expert
   */
  recordDecision(decision: AnalysisDecision): void {
    this.emitEvent('decision_made', {
      action: decision.action,
      reasoning: decision.reasoning,
      hasConclusion: !!decision.conclusion,
      hasForkRequest: !!decision.forkRequest,
      hasUserQuestion: !!decision.userQuestion,
      nextQueriesCount: decision.nextQueries?.length || 0,
    });

    // Update state based on decision
    switch (decision.action) {
      case 'conclude':
        this.state = 'concluded';
        this.stats.endTime = Date.now();
        break;
      case 'ask_user':
        if (this.config.allowUserIntervention) {
          this.state = 'waiting_user';
        }
        break;
      // 'continue' and 'fork' keep state as 'running'
    }
  }

  /**
   * Resume after user response
   */
  resumeWithUserResponse(response: string): void {
    if (this.state !== 'waiting_user') {
      throw new Error(`Cannot resume: state is ${this.state}, expected 'waiting_user'`);
    }

    this.context.variables['user_response'] = response;
    this.state = 'running';
  }

  // ===========================================================================
  // Termination
  // ===========================================================================

  /**
   * Conclude the dialogue
   */
  conclude(): void {
    this.state = 'concluded';
    this.stats.endTime = Date.now();

    this.emitEvent('dialogue_completed', {
      state: 'concluded',
      totalTurns: this.stats.totalTurns,
      totalFindings: this.stats.totalFindings,
      totalExecutionTimeMs: this.stats.totalExecutionTimeMs,
    });
  }

  /**
   * Mark as timed out
   */
  timeout(): void {
    this.state = 'timeout';
    this.stats.endTime = Date.now();

    this.emitEvent('dialogue_completed', {
      state: 'timeout',
      turnNumber: this.context.turnNumber,
    });
  }

  /**
   * Mark as error
   */
  error(message: string): void {
    this.state = 'error';
    this.stats.endTime = Date.now();

    this.emitEvent('error', {
      message,
      turnNumber: this.context.turnNumber,
    });
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Register an event handler
   */
  onEvent(handler: DialogueEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Remove an event handler
   */
  offEvent(handler: DialogueEventHandler): void {
    const index = this.eventHandlers.indexOf(handler);
    if (index !== -1) {
      this.eventHandlers.splice(index, 1);
    }
  }

  /**
   * Emit an event
   */
  private emitEvent(type: CrossDomainEventType, data: Record<string, any>): void {
    const event: CrossDomainEvent = {
      type,
      timestamp: Date.now(),
      expertId: this.expertId,
      turnNumber: this.context.turnNumber,
      data,
    };

    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('[DialogueSession] Event handler error:', e);
      }
    }
  }
}

/**
 * Create a unique query ID
 */
export function createQueryId(moduleTarget: string, turnNumber: number): string {
  return `${moduleTarget}_t${turnNumber}_${Date.now()}`;
}

/**
 * Create a unique hypothesis ID
 */
export function createHypothesisId(category: string, component: string): string {
  return `hyp_${category}_${component}_${Date.now()}`;
}

/**
 * Build a ModuleQuery from parameters
 */
export function buildModuleQuery(
  targetModule: string,
  questionId: string,
  params: Record<string, any>,
  context: DialogueContext
): ModuleQuery {
  return {
    queryId: createQueryId(targetModule, context.turnNumber),
    targetModule,
    questionId,
    params,
    context,
  };
}
