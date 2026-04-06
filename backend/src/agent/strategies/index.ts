// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Strategy System - Barrel Exports
 *
 * Usage:
 *   import { createStrategyRegistry, intervalHelpers } from '../strategies';
 *   const registry = createStrategyRegistry();
 *   const matched = registry.match(userQuery);
 */

export type {
  FocusInterval,
  IntervalHelpers,
  StageTaskTemplate,
  StageDefinition,
  StagedAnalysisStrategy,
  StrategyExecutionState,
  DirectSkillTask,
} from './types';

export {
  payloadToObjectRows,
  isLikelyAppProcessName,
  formatNsRangeLabel,
  intervalHelpers,
} from './helpers';

export {
  StrategyRegistry,
  createStrategyRegistry,
  createEnhancedStrategyRegistry,
  type StrategyMatchResult,
} from './registry';
export { scrollingStrategy } from './scrollingStrategy';
export { startupStrategy } from './startupStrategy';
export { sceneReconstructionQuickStrategy, sceneReconstructionStrategy } from './sceneReconstructionStrategy';