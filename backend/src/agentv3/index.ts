// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Public API surface — only export what external consumers actually import.
// Internal agentv3 modules import directly from their source files.
export { isClaudeCodeEnabled } from './claudeConfig';

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { ClaudeAgentConfig } from './claudeConfig';
import { ClaudeRuntime } from './claudeRuntime';

export function createClaudeRuntime(
  traceProcessorService: TraceProcessorService,
  config?: Partial<ClaudeAgentConfig>,
): ClaudeRuntime {
  return new ClaudeRuntime(traceProcessorService, config);
}