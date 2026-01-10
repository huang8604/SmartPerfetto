/**
 * Skill Engine
 *
 * A configurable skill system that allows performance experts to define
 * analysis workflows in YAML files without modifying code.
 *
 * Features:
 * - YAML-based skill definitions
 * - Composite skills with multi-step analysis
 * - AI-assisted diagnostics and summaries
 * - Automatic skill matching based on keywords and patterns
 * - Variable substitution in SQL queries
 * - Real-time execution events
 */

// =============================================================================
// Types
// =============================================================================
export * from './types';

// =============================================================================
// Skill Loader
// =============================================================================
export * from './skillLoader';

export {
  skillRegistry,
  ensureSkillRegistryInitialized,
  getSkillsDir,
} from './skillLoader';

// =============================================================================
// Skill Executor
// =============================================================================
export * from './skillExecutor';

export {
  SkillExecutor,
  createSkillExecutor,
  LayeredResult,
} from './skillExecutor';

// =============================================================================
// Skill Analysis Adapter
// =============================================================================
export * from './skillAnalysisAdapter';

export {
  SkillAnalysisAdapter,
  createSkillAnalysisAdapter,
  getSkillAnalysisAdapter,
  SkillAnalysisRequest,
  SkillAnalysisResponse,
  SkillListItem,
  AdaptedResult,
} from './skillAnalysisAdapter';

// =============================================================================
// Utilities
// =============================================================================

// 智能摘要和回答生成器
export { smartSummaryGenerator, SmartSummaryGenerator } from './smartSummaryGenerator';
export { answerGenerator, AnswerGenerator } from './answerGenerator';

// 事件收集器
export {
  SkillEventCollector,
  createEventCollector,
  EventSummary,
  ProgressInfo,
} from './eventCollector';

// =============================================================================
// Legacy Aliases (for backwards compatibility during migration)
// =============================================================================

// @deprecated - These aliases will be removed in a future version
export { skillRegistry as skillRegistryV2 } from './skillLoader';
export { ensureSkillRegistryInitialized as ensureSkillRegistryV2Initialized } from './skillLoader';
export { ensureSkillRegistryInitialized as initializeSkills } from './skillLoader';
export { SkillAnalysisAdapter as SkillAnalysisAdapterV2 } from './skillAnalysisAdapter';
export { createSkillAnalysisAdapter as createSkillAnalysisAdapterV2 } from './skillAnalysisAdapter';
export { getSkillAnalysisAdapter as getSkillAnalysisAdapterV2 } from './skillAnalysisAdapter';
export { SkillExecutor as SkillExecutorV2 } from './skillExecutor';
export { createSkillExecutor as createSkillExecutorV2 } from './skillExecutor';
