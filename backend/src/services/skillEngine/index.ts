// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

// =============================================================================
// Skill Executor
// =============================================================================
export * from './skillExecutor';

// =============================================================================
// Skill Analysis Adapter
// =============================================================================
export * from './skillAnalysisAdapter';

// =============================================================================
// Skill Validator
// =============================================================================
export {
  validateSkillInputs,
  validateSkillConditions,
  validateFragmentReferences,
  type SkillValidationWarning,
} from './skillValidator';

// =============================================================================
// Expression Utilities
// =============================================================================
export { extractRootVariables, JS_BUILTINS } from './expressionUtils';

// =============================================================================
// Utilities
// =============================================================================

export { smartSummaryGenerator, SmartSummaryGenerator } from './smartSummaryGenerator';
export { answerGenerator, AnswerGenerator } from './answerGenerator';

export {
  SkillEventCollector,
  createEventCollector,
  EventSummary,
  ProgressInfo,
} from './eventCollector';

// =============================================================================
// Data Contract (v2.0 - DataEnvelope refactoring)
// =============================================================================

// Re-export DataEnvelope types and utilities for convenience
export {
  // Core types
  DataEnvelope,
  DataEnvelopeMeta,
  DataEnvelopeDisplay,
  ColumnDefinition,
  ColumnType,
  ColumnFormat,
  ClickAction,
  // Validation types
  VALID_COLUMN_TYPES,
  VALID_COLUMN_FORMATS,
  VALID_CLICK_ACTIONS,
  // Factory and utility functions
  createDataEnvelope,
  buildColumnDefinitions,
  displayResultToEnvelope,
  layeredResultToEnvelopes,
  envelopeToDisplayResult,
  envelopesToLayeredResult,
  inferColumnDefinition,
  validateDataEnvelope,
  validateColumnDefinition,
  generateEventId,
  // SSE event types
  DataEvent,
  isDataEvent,
  isLegacySkillEvent,
} from '../../types/dataContract';