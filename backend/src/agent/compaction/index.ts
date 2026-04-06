// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Context Compaction System Exports
 *
 * SmartPerfetto Agent Context 压缩系统
 */

// Types
export * from './compactionTypes';

// Token Estimator
export {
  TokenEstimator,
  getTokenEstimator,
  createTokenEstimator,
} from './tokenEstimator';

// Context Compactor
export {
  ContextCompactor,
  getContextCompactor,
  setContextCompactor,
  resetContextCompactor,
  createContextCompactor,
  type ContextCompactorConfig,
  DEFAULT_CONTEXT_COMPACTOR_CONFIG,
} from './contextCompactor';

// Strategies
export * from './strategies';