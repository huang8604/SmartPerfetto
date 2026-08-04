// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeLookupLedgerEntry} from '../services/codebase/codeLookupLedger';

/**
 * Private source-aware sessions intentionally project plan/tool events into
 * generic progress events. The source event type is safe lifecycle metadata
 * and lets the verifier distinguish a real full run from quick mode without
 * weakening the privacy projection.
 */
export function privateProjectedSourceEventType(
  payload: Record<string, unknown> | null,
): string | undefined {
  if (payload?.privateModelTextSuppressed !== true) return undefined;
  return typeof payload.sourceEventType === 'string'
    ? payload.sourceEventType
    : undefined;
}

/**
 * Tool names and arguments are hidden from private SSE. Use the server-side
 * lookup ledger as the auditable source of truth, and only credit successful
 * lookups that returned provenance-bearing chunks.
 */
export function successfulCodeLookupToolCounts(
  entries: readonly CodeLookupLedgerEntry[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.outcome !== 'success' || entry.chunkIds.length === 0) continue;
    counts[entry.toolName] = (counts[entry.toolName] ?? 0) + 1;
  }
  return counts;
}
