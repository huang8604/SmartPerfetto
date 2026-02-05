/**
 * SmartPerfetto Agent State Module
 *
 * 导出状态管理组件
 */

export { CheckpointManager } from './checkpointManager';
export { SessionStore } from './sessionStore';

export type { SessionData } from './sessionStore';

export {
  TRACE_AGENT_STATE_VERSION,
  createInitialTraceAgentState,
  migrateTraceAgentState,
  summarizeTraceAgentState,
} from './traceAgentState';

export type {
  TraceAgentState,
  TraceAgentPreferences,
  TraceAgentGoalSpec,
  TraceAgentCoverage,
  TraceAgentTurnLogEntry,
} from './traceAgentState';
