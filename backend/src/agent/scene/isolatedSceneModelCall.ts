// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {getSdkBinaryOption} from '../../agentv3/claudeConfig';

/**
 * Scene verification/summarization consumes trace-derived text as untrusted
 * model input. Keep these one-shot calls detached from user settings, tools,
 * and resumable SDK transcripts even though they use the SDK permission bypass
 * needed by the headless runtime.
 */
export function isolatedSceneModelCallOptions(input: {
  model: string;
  env: NodeJS.ProcessEnv;
  stderr: (data: string) => void;
}): Record<string, unknown> {
  return {
    model: input.model,
    maxTurns: 1,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    tools: [],
    persistSession: false,
    env: input.env,
    stderr: input.stderr,
    ...getSdkBinaryOption(input.env),
  };
}
