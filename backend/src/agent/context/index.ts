// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Context Isolation System Exports
 *
 * SmartPerfetto Agent Context 隔离系统
 */

// Types
export * from './contextTypes';

// Builder
export {
  ContextBuilder,
  getContextBuilder,
  setContextBuilder,
  resetContextBuilder,
  createContextBuilder,
} from './contextBuilder';

// Policies
export * from './policies';

// Enhanced Session Context (Phase 5: Multi-turn Dialogue)
export {
  EnhancedSessionContext,
  SessionContextManager,
  sessionContextManager,
} from './enhancedSessionContext';