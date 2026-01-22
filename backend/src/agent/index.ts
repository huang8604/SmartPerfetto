export * from './types';
export * from './toolRegistry';
export {
  registerCoreTools,
  sqlExecutorTool,
  frameAnalyzerTool,
  dataStatsTool,
  skillInvokerTool,
  getAvailableSkillIds,
  getSkillIdForSceneType,
} from './tools';

// Legacy architecture exports (保持向后兼容)
export {
  BaseExpertAgent,
  LLMClient,
  ScrollingExpertAgent,
  createScrollingExpertAgent,
  SceneReconstructionExpertAgent,
  createSceneReconstructionAgent,
  DetectedScene,
  TrackEvent,
  SceneReconstructionResult,
  SceneCategory,
} from './agents';
export { PerfettoOrchestratorAgent, createOrchestrator } from './orchestrator';
export {
  createLLMClient,
  createDeepSeekLLMClient,
  createOpenAILLMClient,
  LLMAdapterConfig,
  LLMConfigurationError,
} from './llmAdapter';
export {
  AgentTraceRecorder,
  getAgentTraceRecorder,
  resetAgentTraceRecorder,
  RecordedTrace,
  TraceRecorderConfig,
} from './traceRecorder';
export {
  AgentEvalSystem,
  createEvalSystem,
  EvalCase,
  EvalResult,
  EvalSummary,
  ExpectedFinding,
  SCROLLING_EVAL_CASES,
} from './evalSystem';

// =============================================================================
// New Architecture Exports (新架构导出)
// =============================================================================

// Core components
export {
  AgentStateMachine,
  CircuitBreaker,
  ModelRouter,
  PipelineExecutor,
} from './core';

// State management
export {
  CheckpointManager,
  SessionStore,
} from './state';

// New SubAgent architecture
export {
  BaseSubAgent,
  PlannerAgent,
  EvaluatorAgent,
} from './agents';

// Master Orchestrator (新的主编排者)
export { MasterOrchestrator, createMasterOrchestrator } from './core/masterOrchestrator';

// =============================================================================
// Agent-Driven Architecture (Phase 2-4 新架构)
// =============================================================================

// Agent-Driven Orchestrator (假设驱动分析)
export {
  AgentDrivenOrchestrator,
  createAgentDrivenOrchestrator,
  AnalysisResult as AgentDrivenAnalysisResult,
  AgentDrivenOrchestratorConfig,
} from './core/agentDrivenOrchestrator';

// Domain Agents (领域 Agent)
export {
  BaseAgent,
  FrameAgent,
  createFrameAgent,
  CPUAgent,
  createCPUAgent,
  BinderAgent,
  createBinderAgent,
  MemoryAgent,
  createMemoryAgent,
  StartupAgent,
  InteractionAgent,
  ANRAgent,
  SystemAgent,
  createStartupAgent,
  createInteractionAgent,
  createANRAgent,
  createSystemAgent,
  DomainAgentRegistry,
  createDomainAgentRegistry,
} from './agents/domain';

// Agent Communication (Agent 通信)
export {
  AgentMessageBus,
  createAgentMessageBus,
} from './communication';

// Agent Protocol Types (Agent 协议类型)
export {
  AgentTask,
  AgentResponse,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
  Evidence,
  SharedAgentContext,
  createTaskId,
  createHypothesisId,
  createMessageId,
} from './types/agentProtocol';

// Iteration Strategy Planner (迭代策略规划器)
export {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
  IterationStrategy,
  StrategyDecision,
} from './agents/iterationStrategyPlanner';
