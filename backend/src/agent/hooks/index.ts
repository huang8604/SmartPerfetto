// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Hook System Exports
 *
 * SmartPerfetto Agent 生命周期钩子系统
 */

// Types
export * from './hookTypes';

// Context
export { createHookContext, deriveHookContext, mergeContextMetadata } from './hookContext';

// Registry
export {
  HookRegistry,
  getHookRegistry,
  setHookRegistry,
  resetHookRegistry,
} from './hookRegistry';

// Middleware
export * from './middleware';