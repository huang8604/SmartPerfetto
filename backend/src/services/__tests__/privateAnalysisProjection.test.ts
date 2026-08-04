// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';

import type {SessionStateSnapshot} from '../../agentv3/sessionStateSnapshot';
import {projectPrivateSessionStateSnapshot} from '../security/privateAnalysisProjection';

function snapshot(): SessionStateSnapshot {
  return {
    version: 1,
    snapshotTimestamp: 1,
    sessionId: 'session-private',
    traceId: 'trace-private',
    conversationSteps: [{
      eventId: 'event-1',
      ordinal: 1,
      phase: 'tool',
      role: 'agent',
      text: 'PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS',
      timestamp: 1,
    }],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    analysisNotes: [],
    analysisPlan: null,
    planHistory: [],
    uncertaintyFlags: [],
    codeLookupSummary: {
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
    },
    runSequence: 1,
    conversationOrdinal: 1,
  };
}

describe('private session snapshot provenance', () => {
  it('keeps bounded source generation provenance without private content', () => {
    const projected = projectPrivateSessionStateSnapshot(snapshot());

    expect(projected.codeLookupSummary).toEqual({
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS');
    expect(projected.conversationSteps).toEqual([]);
  });
});
