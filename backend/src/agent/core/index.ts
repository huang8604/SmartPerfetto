// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Agent Core Module
 *
 * 导出核心架构组件
 */

export { AgentStateMachine } from './stateMachine';
export { CircuitBreaker } from './circuitBreaker';
export { ModelRouter, AllModelsFailedError } from './modelRouter';
export { PipelineExecutor } from './pipelineExecutor';

// Orchestrator sub-modules
export { understandIntent } from './intentUnderstanding';
export { generateInitialHypotheses, generateDefaultHypotheses, createHypothesis } from './hypothesisGenerator';
export {
  generateConclusion,
  generateSimpleConclusion,
  deriveConclusionContract,
  renderConclusionContractMarkdown,
} from './conclusionGenerator';
export { executeTaskGraph, emitDataEnvelopes } from './taskGraphExecutor';
export { synthesizeFeedback } from './feedbackSynthesizer';
export { planTaskGraph, buildTasksFromGraph, parseTimeRange, resolveAgentIdForDomain } from './taskGraphPlanner';

// Jank cause analysis
export {
  summarizeJankCauses,
  formatJankSummaryForPrompt,
  CAUSE_TYPE_LABELS,
} from './jankCauseSummarizer';
export type {
  JankCauseSummary,
  CauseTypeStats,
} from './jankCauseSummarizer';

// Deduplication registry
export {
  EmittedEnvelopeRegistry,
  createEmittedEnvelopeRegistry,
  generateDeduplicationKey,
} from './emittedEnvelopeRegistry';

// Orchestrator types
export type {
  AgentRuntimeConfig,
  AnalysisResult,
  AnalysisOptions,
  AnalysisServices,
  ProgressEmitter,
  StreamingEventPayloads,
  PayloadFor,
  ExecutionContext,
  ExecutorResult,
  TaskGraphNode,
  TaskGraphPlan,
} from './orchestratorTypes';
export type {
  ConclusionContract,
  ConclusionClusterOutputMode,
  ConclusionClusterFrameListMode,
  ConclusionOutputMode,
  ConclusionContractClusterPolicy,
  ConclusionContractConclusionItem,
  ConclusionContractClusterItem,
  ConclusionContractEvidenceItem,
  ConclusionContractMetadata,
} from './conclusionContract';
export {
  AGENT_IDS,
  DEFAULT_CONFIG,
  DOMAIN_ALIASES,
  DEFAULT_EVIDENCE,
  normalizeDomain,
  concludeDecision,
  translateStrategy,
} from './orchestratorTypes';
export type { AnalysisExecutor } from './executors/analysisExecutor';
export type { SynthesisResult } from './feedbackSynthesizer';

// 重新导出类型
export type {
  // State Machine Types
  AgentPhase,
  StateEvent,
  Checkpoint,
  SerializedAgentState,
  StateMachineConfig,
  AgentStateMachineState,
  // Pipeline Types
  PipelineStage,
  StageResult,
  PipelineConfig,
  PipelineErrorDecision,
  PipelineResult,
  PipelineCallbacks,
  PipelineProgress,
  // Circuit Breaker Types
  CircuitState,
  CircuitBreakerConfig,
  CircuitDecision,
  CircuitDiagnostics,
  CircuitBreakerState,
  // Model Router Types
  ModelProvider,
  ModelStrength,
  TaskType,
  ModelProfile,
  ModelRouterConfig,
  ModelCallResult,
  EnsembleResult,
} from '../types';