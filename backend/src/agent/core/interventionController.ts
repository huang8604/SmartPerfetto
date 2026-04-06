// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Intervention Controller
 *
 * Manages user intervention points during analysis.
 * Enables users to guide the analysis when the system needs human judgment.
 *
 * Intervention triggers:
 * 1. Low confidence - analysis results are uncertain
 * 2. Ambiguity - multiple valid analysis directions
 * 3. Timeout - analysis taking too long
 * 4. Agent request - agent explicitly asks for user input
 *
 * Design principles:
 * - Non-blocking by default (SSE notification, not synchronous wait)
 * - Clear context for user decision
 * - Timeout with default action (abort)
 * - State tracking for multi-turn interventions
 */

import { EventEmitter } from 'events';
import type { Finding } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Types of intervention triggers
 */
export type InterventionType =
  | 'low_confidence'
  | 'ambiguity'
  | 'timeout'
  | 'agent_request'
  | 'circuit_breaker'
  | 'validation_required';

/**
 * User actions for intervention
 */
export type InterventionAction =
  | 'continue'      // Continue with current analysis
  | 'focus'         // Focus on a specific direction
  | 'abort'         // Stop analysis
  | 'custom'        // Custom user input
  | 'select_option'; // Select from provided options

/**
 * Analysis direction candidate
 */
export interface AnalysisDirection {
  id: string;
  description: string;
  confidence: number;
  requiredAgents: string[];
  estimatedTime?: string;
}

/**
 * Context for an intervention point
 */
export interface InterventionContext {
  /** Current findings discovered so far */
  currentFindings: Finding[];
  /** Possible analysis directions */
  possibleDirections: AnalysisDirection[];
  /** Time elapsed so far */
  elapsedTimeMs: number;
  /** Current confidence level */
  confidence: number;
  /** Number of rounds completed */
  roundsCompleted: number;
  /** Summary of what's been done */
  progressSummary: string;
  /** Reason for intervention */
  triggerReason: string;
}

/**
 * Option for user selection
 */
export interface InterventionOption {
  id: string;
  label: string;
  description: string;
  action: InterventionAction;
  params?: Record<string, any>;
  /** Whether this is the recommended option */
  recommended?: boolean;
}

/**
 * Intervention point requiring user decision
 */
export interface InterventionPoint {
  id: string;
  sessionId: string;
  type: InterventionType;
  context: InterventionContext;
  options: InterventionOption[];
  /** Timestamp when intervention was created */
  createdAt: number;
  /** Timeout for user response (ms) */
  timeout: number;
  /** Default action if timeout expires */
  defaultAction: InterventionAction;
}

/**
 * User's decision for an intervention
 */
export interface UserDecision {
  interventionId: string;
  action: InterventionAction;
  selectedOptionId?: string;
  customInput?: string;
  params?: Record<string, any>;
}

/**
 * Directive for analysis based on user decision
 */
export interface AnalysisDirective {
  action: 'continue' | 'focus' | 'abort' | 'restart';
  reason: string;
  focusDirections?: string[];
  params?: Record<string, any>;
}

/**
 * Intervention state for a session
 */
interface InterventionState {
  pending: InterventionPoint | null;
  history: InterventionPoint[];
  timeoutHandle: NodeJS.Timeout | null;
}

// =============================================================================
// Configuration
// =============================================================================

export interface InterventionConfig {
  /** Confidence threshold below which intervention is triggered */
  confidenceThreshold: number;
  /** Maximum analysis time before timeout intervention (ms) */
  timeoutThresholdMs: number;
  /** Default timeout for user response (ms) */
  userResponseTimeoutMs: number;
  /** Enable automatic interventions */
  autoIntervention: boolean;
}

const DEFAULT_CONFIG: InterventionConfig = {
  confidenceThreshold: 0.5,
  timeoutThresholdMs: 120000, // 2 minutes
  userResponseTimeoutMs: 60000, // 1 minute for user to respond
  autoIntervention: true,
};

// =============================================================================
// Analysis State (for intervention checking)
// =============================================================================

export interface AnalysisState {
  sessionId: string;
  confidence: number;
  findings: Finding[];
  possibleDirections: AnalysisDirection[];
  elapsedTimeMs: number;
  roundsCompleted: number;
  progressSummary: string;
}

// =============================================================================
// Intervention Controller
// =============================================================================

/**
 * Controller for managing user interventions during analysis.
 */
export class InterventionController extends EventEmitter {
  private config: InterventionConfig;
  private sessions: Map<string, InterventionState>;

  constructor(config?: Partial<InterventionConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessions = new Map();
  }

  /**
   * Check if analysis state requires user intervention.
   *
   * @param state - Current analysis state
   * @returns Intervention point if intervention needed, null otherwise
   */
  checkIntervention(state: AnalysisState): InterventionPoint | null {
    if (!this.config.autoIntervention) {
      return null;
    }

    // 1. Check confidence threshold
    if (state.confidence < this.config.confidenceThreshold) {
      return this.buildLowConfidenceIntervention(state);
    }

    // 2. Check for ambiguity (multiple directions with similar confidence)
    if (state.possibleDirections.length > 1) {
      const maxConfidenceDiff = this.getMaxConfidenceDiff(state.possibleDirections);
      if (maxConfidenceDiff < 0.2) {
        return this.buildAmbiguityIntervention(state);
      }
    }

    // 3. Check timeout
    if (state.elapsedTimeMs > this.config.timeoutThresholdMs) {
      return this.buildTimeoutIntervention(state);
    }

    return null;
  }

  /**
   * Create an intervention for agent request.
   */
  createAgentIntervention(
    sessionId: string,
    reason: string,
    options: InterventionOption[],
    context: Partial<InterventionContext>
  ): InterventionPoint {
    const intervention = this.createIntervention(
      sessionId,
      'agent_request',
      {
        currentFindings: context.currentFindings || [],
        possibleDirections: context.possibleDirections || [],
        elapsedTimeMs: context.elapsedTimeMs || 0,
        confidence: context.confidence || 0.5,
        roundsCompleted: context.roundsCompleted || 0,
        progressSummary: context.progressSummary || '',
        triggerReason: reason,
      },
      options
    );

    this.registerIntervention(intervention);
    return intervention;
  }

  /**
   * Create a validation-required intervention (e.g., for generated SQL).
   */
  createValidationIntervention(
    sessionId: string,
    validationTarget: string,
    validationContext: Record<string, any>
  ): InterventionPoint {
    const options: InterventionOption[] = [
      {
        id: 'approve',
        label: '批准执行',
        description: `允许执行 ${validationTarget}`,
        action: 'continue',
        recommended: true,
      },
      {
        id: 'reject',
        label: '拒绝',
        description: '不执行，继续分析其他方向',
        action: 'focus',
        params: { skipValidation: true },
      },
      {
        id: 'abort',
        label: '中止分析',
        description: '停止当前分析',
        action: 'abort',
      },
    ];

    const intervention = this.createIntervention(
      sessionId,
      'validation_required',
      {
        currentFindings: [],
        possibleDirections: [],
        elapsedTimeMs: 0,
        confidence: 0.5,
        roundsCompleted: 0,
        progressSummary: '',
        triggerReason: `需要用户确认: ${validationTarget}`,
      },
      options
    );

    // Attach validation context for frontend
    (intervention as any).validationContext = validationContext;

    this.registerIntervention(intervention);
    return intervention;
  }

  /**
   * Handle user's decision for an intervention.
   *
   * @param decision - User's decision
   * @returns Directive for how to proceed with analysis
   */
  handleUserDecision(decision: UserDecision): AnalysisDirective {
    // Find the intervention
    let intervention: InterventionPoint | null = null;
    let sessionState: InterventionState | null = null;

    for (const [sessionId, state] of this.sessions) {
      if (state.pending?.id === decision.interventionId) {
        intervention = state.pending;
        sessionState = state;
        break;
      }
    }

    if (!intervention || !sessionState) {
      return {
        action: 'abort',
        reason: '未找到对应的干预请求',
      };
    }

    // Clear timeout
    if (sessionState.timeoutHandle) {
      clearTimeout(sessionState.timeoutHandle);
      sessionState.timeoutHandle = null;
    }

    // Move to history
    sessionState.history.push(intervention);
    sessionState.pending = null;

    // Emit resolution event
    this.emit('interventionResolved', {
      interventionId: decision.interventionId,
      action: decision.action,
      sessionId: intervention.sessionId,
    });

    // Build directive based on action
    switch (decision.action) {
      case 'continue':
        return {
          action: 'continue',
          reason: '用户选择继续分析',
          params: decision.params,
        };

      case 'focus':
        const focusOption = intervention.options.find(o => o.id === decision.selectedOptionId);
        return {
          action: 'focus',
          reason: `用户选择聚焦: ${focusOption?.label || '自定义方向'}`,
          focusDirections: focusOption?.params?.directions || [decision.customInput].filter(Boolean),
          params: { ...focusOption?.params, ...decision.params },
        };

      case 'abort':
        return {
          action: 'abort',
          reason: '用户选择中止分析',
        };

      case 'select_option':
        const selectedOption = intervention.options.find(o => o.id === decision.selectedOptionId);
        if (!selectedOption) {
          return {
            action: 'abort',
            reason: '无效的选项',
          };
        }
        return this.handleOptionAction(selectedOption, decision);

      case 'custom':
        return {
          action: 'continue',
          reason: `用户自定义输入: ${decision.customInput}`,
          params: { customInput: decision.customInput, ...decision.params },
        };

      default:
        return {
          action: 'abort',
          reason: '未知的用户决策',
        };
    }
  }

  /**
   * Check if there's a pending intervention for a session.
   */
  hasPendingIntervention(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state?.pending !== null;
  }

  /**
   * Get pending intervention for a session.
   */
  getPendingIntervention(sessionId: string): InterventionPoint | null {
    const state = this.sessions.get(sessionId);
    return state?.pending || null;
  }

  /**
   * Cancel pending intervention.
   */
  cancelIntervention(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }

    if (state.pending) {
      this.emit('interventionCancelled', {
        interventionId: state.pending.id,
        sessionId,
      });
      state.pending = null;
    }
  }

  /**
   * Reset state for a session.
   */
  resetSession(sessionId: string): void {
    this.cancelIntervention(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<InterventionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Build intervention for low confidence situation.
   */
  private buildLowConfidenceIntervention(state: AnalysisState): InterventionPoint {
    const options: InterventionOption[] = [
      {
        id: 'continue',
        label: '继续分析',
        description: '继续当前分析，可能需要更多轮次',
        action: 'continue',
      },
      {
        id: 'abort',
        label: '停止分析',
        description: '以当前结果结束分析',
        action: 'abort',
      },
    ];

    // Add focus options if there are possible directions
    if (state.possibleDirections.length > 0) {
      const topDirections = state.possibleDirections
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);

      for (const dir of topDirections) {
        options.push({
          id: `focus_${dir.id}`,
          label: `聚焦: ${dir.description}`,
          description: `置信度 ${(dir.confidence * 100).toFixed(0)}%`,
          action: 'focus',
          params: { directions: [dir.id] },
        });
      }
    }

    return this.createIntervention(
      state.sessionId,
      'low_confidence',
      {
        currentFindings: state.findings,
        possibleDirections: state.possibleDirections,
        elapsedTimeMs: state.elapsedTimeMs,
        confidence: state.confidence,
        roundsCompleted: state.roundsCompleted,
        progressSummary: state.progressSummary,
        triggerReason: `分析置信度过低 (${(state.confidence * 100).toFixed(0)}%)`,
      },
      options
    );
  }

  /**
   * Build intervention for ambiguity situation.
   */
  private buildAmbiguityIntervention(state: AnalysisState): InterventionPoint {
    const options: InterventionOption[] = state.possibleDirections
      .sort((a, b) => b.confidence - a.confidence)
      .map((dir, index) => ({
        id: `direction_${dir.id}`,
        label: dir.description,
        description: `置信度 ${(dir.confidence * 100).toFixed(0)}%${dir.estimatedTime ? `, 预计 ${dir.estimatedTime}` : ''}`,
        action: 'focus' as InterventionAction,
        params: { directions: [dir.id] },
        recommended: index === 0,
      }));

    // Add continue option to let agent decide
    options.push({
      id: 'auto_decide',
      label: '自动选择',
      description: '让 AI 自动选择最佳方向',
      action: 'continue',
    });

    return this.createIntervention(
      state.sessionId,
      'ambiguity',
      {
        currentFindings: state.findings,
        possibleDirections: state.possibleDirections,
        elapsedTimeMs: state.elapsedTimeMs,
        confidence: state.confidence,
        roundsCompleted: state.roundsCompleted,
        progressSummary: state.progressSummary,
        triggerReason: '存在多个可能的分析方向',
      },
      options
    );
  }

  /**
   * Build intervention for timeout situation.
   */
  private buildTimeoutIntervention(state: AnalysisState): InterventionPoint {
    const options: InterventionOption[] = [
      {
        id: 'continue',
        label: '继续分析',
        description: '延长分析时间',
        action: 'continue',
      },
      {
        id: 'conclude',
        label: '生成结论',
        description: '以当前发现生成分析结论',
        action: 'abort',
        recommended: true,
      },
    ];

    return this.createIntervention(
      state.sessionId,
      'timeout',
      {
        currentFindings: state.findings,
        possibleDirections: state.possibleDirections,
        elapsedTimeMs: state.elapsedTimeMs,
        confidence: state.confidence,
        roundsCompleted: state.roundsCompleted,
        progressSummary: state.progressSummary,
        triggerReason: `分析时间超过 ${Math.round(state.elapsedTimeMs / 1000)} 秒`,
      },
      options
    );
  }

  /**
   * Create an intervention point.
   */
  private createIntervention(
    sessionId: string,
    type: InterventionType,
    context: InterventionContext,
    options: InterventionOption[]
  ): InterventionPoint {
    return {
      id: `intervention_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      type,
      context,
      options,
      createdAt: Date.now(),
      timeout: this.config.userResponseTimeoutMs,
      defaultAction: 'abort',
    };
  }

  /**
   * Register intervention and start timeout.
   */
  private registerIntervention(intervention: InterventionPoint): void {
    let state = this.sessions.get(intervention.sessionId);
    if (!state) {
      state = {
        pending: null,
        history: [],
        timeoutHandle: null,
      };
      this.sessions.set(intervention.sessionId, state);
    }

    // Cancel existing intervention if any
    if (state.pending) {
      if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
      }
      state.history.push(state.pending);
    }

    state.pending = intervention;

    // Start timeout
    state.timeoutHandle = setTimeout(() => {
      this.handleTimeout(intervention);
    }, intervention.timeout);

    // Emit event
    this.emit('interventionRequired', intervention);
  }

  /**
   * Handle intervention timeout.
   */
  private handleTimeout(intervention: InterventionPoint): void {
    const state = this.sessions.get(intervention.sessionId);
    if (!state || state.pending?.id !== intervention.id) {
      return; // Already resolved
    }

    // Apply default action
    this.emit('interventionTimeout', {
      interventionId: intervention.id,
      sessionId: intervention.sessionId,
      defaultAction: intervention.defaultAction,
    });

    // Resolve with default action
    this.handleUserDecision({
      interventionId: intervention.id,
      action: intervention.defaultAction,
    });
  }

  /**
   * Handle option-specific action.
   */
  private handleOptionAction(
    option: InterventionOption,
    decision: UserDecision
  ): AnalysisDirective {
    switch (option.action) {
      case 'continue':
        return {
          action: 'continue',
          reason: option.label,
          params: { ...option.params, ...decision.params },
        };
      case 'focus':
        return {
          action: 'focus',
          reason: option.label,
          focusDirections: option.params?.directions,
          params: { ...option.params, ...decision.params },
        };
      case 'abort':
        return {
          action: 'abort',
          reason: option.label,
        };
      default:
        return {
          action: 'continue',
          reason: option.label,
          params: { ...option.params, ...decision.params },
        };
    }
  }

  /**
   * Get max confidence difference among directions.
   */
  private getMaxConfidenceDiff(directions: AnalysisDirection[]): number {
    if (directions.length < 2) return 1;

    const confidences = directions.map(d => d.confidence);
    const max = Math.max(...confidences);
    const min = Math.min(...confidences);
    return max - min;
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an intervention controller instance.
 */
export function createInterventionController(
  config?: Partial<InterventionConfig>
): InterventionController {
  return new InterventionController(config);
}

export default InterventionController;