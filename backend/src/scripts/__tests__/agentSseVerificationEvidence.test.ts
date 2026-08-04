// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeLookupLedgerEntry} from '../../services/codebase/codeLookupLedger';
import {
  privateProjectedSourceEventType,
  successfulCodeLookupToolCounts,
} from '../agentSseVerificationEvidence';

describe('Agent SSE verification evidence', () => {
  it('recognizes privacy-projected full-mode lifecycle events', () => {
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'plan_submitted',
    })).toBe('plan_submitted');
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'agent_response',
    })).toBe('agent_response');
    expect(privateProjectedSourceEventType({sourceEventType: 'plan_submitted'})).toBeUndefined();
  });

  it('credits only successful provenance-bearing code lookups', () => {
    const entry = (
      toolName: CodeLookupLedgerEntry['toolName'],
      outcome: CodeLookupLedgerEntry['outcome'],
      chunkIds: string[],
    ): CodeLookupLedgerEntry => ({
      turn: 1,
      ts: 1,
      toolName,
      chunkIds,
      consentApplied: true,
      tokensSpent: 10,
      outcome,
      legacyPath: false,
    });

    expect(successfulCodeLookupToolCounts([
      entry('lookup_app_source', 'success', ['chunk-app']),
      entry('lookup_blog_knowledge', 'success', ['chunk-rag']),
      entry('lookup_app_source', 'unresolved', []),
      entry('lookup_kernel_source', 'success', []),
    ])).toEqual({
      lookup_app_source: 1,
      lookup_blog_knowledge: 1,
    });
  });
});
