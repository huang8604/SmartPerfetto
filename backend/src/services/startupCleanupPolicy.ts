// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export function shouldCleanOrphanProcessorsOnStartup(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SMARTPERFETTO_SKIP_ORPHAN_TRACE_PROCESSOR_CLEANUP !== '1';
}
