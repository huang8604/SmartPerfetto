// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseNode } from '../../types/sparkContracts';
import { CaseLibrary } from '../caseLibrary';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import type { CaseCandidateOutboxHandle } from './caseCandidateOutbox';

export interface RecordCaseCandidateFeedbackInput {
  candidateId: string;
  sourceSessionId: string;
  sourceAnalysisRunId?: string;
  rating: 'positive' | 'negative';
  surfacedAt?: number;
  receivedAt?: number;
  outbox: CaseCandidateOutboxHandle;
  library?: CaseLibrary;
  knowledgeScope?: KnowledgeScope;
}

export interface RecordCaseCandidateFeedbackResult {
  added: boolean;
  reason?: 'missing_candidate' | 'mis_tap' | 'duplicate' | 'error';
  supported?: boolean;
  rejected?: boolean;
}

const TEN_SECONDS_MS = 10_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function recordCaseCandidateFeedback(
  input: RecordCaseCandidateFeedbackInput,
): RecordCaseCandidateFeedbackResult {
  const candidate = input.outbox.getCandidate(input.candidateId);
  if (!candidate) return { added: false, reason: 'missing_candidate' };
  const receivedAt = input.receivedAt ?? Date.now();
  const receivedWithinMs = input.surfacedAt === undefined ? undefined : receivedAt - input.surfacedAt;
  if (receivedWithinMs !== undefined && receivedWithinMs < TEN_SECONDS_MS) {
    return { added: false, reason: 'mis_tap' };
  }
  const withinTimeWindow = receivedWithinMs === undefined || receivedWithinMs <= ONE_DAY_MS
    ? 'short'
    : 'audit_only';
  const added = input.outbox.addFeedback(input.candidateId, {
    sourceSessionId: input.sourceSessionId,
    sourceAnalysisRunId: input.sourceAnalysisRunId,
    rating: input.rating,
    receivedAt,
    receivedWithinSeconds: receivedWithinMs === undefined ? undefined : Math.max(0, Math.floor(receivedWithinMs / 1000)),
    withinTimeWindow,
  });
  if (!added.added) return { added: false, reason: added.reason };

  const updated = input.outbox.getCandidate(input.candidateId);
  if (!updated) return { added: true };
  const library = input.library;
  if (library) syncLearnedCaseMarker(library, updated, input.knowledgeScope);

  if (updated.contradictingEvidence >= 2) {
    input.outbox.markRejected(input.candidateId, 'negative case feedback threshold reached');
    if (library) demoteLearnedCasePrivate(library, updated, input.knowledgeScope);
    return { added: true, rejected: true };
  }

  return { added: true, supported: updated.supported === 1 };
}

function syncLearnedCaseMarker(
  library: CaseLibrary,
  candidate: NonNullable<ReturnType<CaseCandidateOutboxHandle['getCandidate']>>,
  scope?: KnowledgeScope,
): void {
  const caseNode = resolveLearnedCase(library, candidate, scope);
  if (!caseNode?.knowledge) return;
  if (caseNode.status === 'published') return;
  library.saveCase({
    ...caseNode,
    knowledge: {
      ...caseNode.knowledge,
      context: {
        ...caseNode.knowledge.context,
        'caseEvolution.v1': {
          candidateId: candidate.candidateId,
          supportingEvidence: candidate.supportingEvidence,
          contradictingEvidence: candidate.contradictingEvidence,
          maintainerPromoted: candidate.maintainerPromoted === 1,
          supported: candidate.supported === 1,
          ...(candidate.supported === 1 ? { supportedAt: Date.now() } : {}),
        },
      },
    },
  }, scope);
}

function demoteLearnedCasePrivate(
  library: CaseLibrary,
  candidate: NonNullable<ReturnType<CaseCandidateOutboxHandle['getCandidate']>>,
  scope?: KnowledgeScope,
): void {
  const caseNode = resolveLearnedCase(library, candidate, scope);
  if (!caseNode || caseNode.status === 'private' || caseNode.status === 'published') return;
  library.saveCase({ ...caseNode, status: 'private' }, scope);
}

function resolveLearnedCase(
  library: CaseLibrary,
  candidate: NonNullable<ReturnType<CaseCandidateOutboxHandle['getCandidate']>>,
  scope?: KnowledgeScope,
): CaseNode | undefined {
  if (candidate.learnedCaseId) {
    const direct = library.getCase(candidate.learnedCaseId, scope);
    if (direct) return direct;
  }
  return library.listCases({}, scope).find(caseNode => {
    const marker = caseNode.knowledge?.context?.['caseEvolution.v1'];
    return !!marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      (marker as Record<string, unknown>).candidateId === candidate.candidateId;
  });
}
