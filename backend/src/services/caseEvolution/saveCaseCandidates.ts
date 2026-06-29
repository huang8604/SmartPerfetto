// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseCandidateCaptureInput, CaseEvolutionConfig } from '../../types/caseEvolution';
import {
  buildCaseCandidatesFromRun,
  caseCandidateDedupeKey,
  type BuildCaseCandidatesDeps,
} from './caseCandidateBuilder';
import {
  openCaseCandidateOutbox,
  type CaseCandidateOutboxHandle,
} from './caseCandidateOutbox';
import { anonymizeCaseCandidate } from './caseAnonymizer';
import { loadCaseEvolutionConfig } from './caseEvolutionConfig';

export interface SaveCaseCandidatesResult {
  captured: number;
  skipped?:
    | 'disabled'
    | 'no_trace_hash'
    | 'no_candidates'
    | 'duplicate'
    | 'queue_full'
    | 'pii_rejected'
    | 'error';
}

export interface SaveCaseCandidatesLogger {
  warn(component: string, message: string, metadata?: Record<string, unknown>): void;
  info(component: string, message: string, metadata?: Record<string, unknown>): void;
}

export interface SaveCaseCandidatesDeps extends BuildCaseCandidatesDeps {
  config?: CaseEvolutionConfig;
  outbox?: Pick<CaseCandidateOutboxHandle, 'enqueue' | 'close'>;
  openOutbox?: () => CaseCandidateOutboxHandle;
  logger?: SaveCaseCandidatesLogger;
}

export async function saveCaseCandidates(
  input: CaseCandidateCaptureInput,
  deps: SaveCaseCandidatesDeps = {},
): Promise<SaveCaseCandidatesResult> {
  const config = deps.config || loadCaseEvolutionConfig();
  if (!config.captureEnabled) return {captured: 0, skipped: 'disabled'};
  if (!input.provenance.traceContentHash) return {captured: 0, skipped: 'no_trace_hash'};

  try {
    const candidates = buildCaseCandidatesFromRun(input, {
      existingPublishedCaseKeys: deps.existingPublishedCaseKeys,
      existingPublishedSceneRootCauses: deps.existingPublishedSceneRootCauses,
    });
    if (candidates.length === 0) return {captured: 0, skipped: 'no_candidates'};

    let openedHere = false;
    const outbox = deps.outbox || (() => {
      openedHere = true;
      return (deps.openOutbox || openCaseCandidateOutbox)();
    })();

    try {
      let captured = 0;
      let duplicate = false;
      let piiRejected = false;
      let queueFull = false;
      for (const candidate of candidates) {
        // §3.4 PII gate: anonymize the candidate BEFORE it is persisted to
        // the outbox DB. The candidate payload is the only thing captured at
        // this stage (no review yet); we redact/bucket its free-text fields
        // and drop the whole candidate only if anonymization is impossible.
        const anonymized = anonymizeCaseCandidate(candidate);
        if (!anonymized.ok) {
          piiRejected = true;
          deps.logger?.warn('CaseEvolution', 'candidate rejected by anonymizer', {
            candidateId: candidate.candidateId,
            errors: anonymized.errors,
          });
          continue;
        }
        const result = outbox.enqueue(anonymized.candidate, {
          dedupeKey: caseCandidateDedupeKey(anonymized.candidate),
          queueMax: config.queueMax,
        });
        if (result.enqueued) {
          captured += 1;
        } else if (result.reason === 'duplicate_active') {
          duplicate = true;
        } else if (result.reason === 'queue_full') {
          queueFull = true;
          deps.logger?.info('CaseEvolution', 'candidate enqueue skipped (queue full)', {
            candidateId: candidate.candidateId,
          });
        } else if (result.reason === 'error') {
          deps.logger?.warn('CaseEvolution', 'candidate enqueue skipped', {
            candidateId: candidate.candidateId,
            reason: result.reason,
          });
        }
      }
      if (captured > 0) {
        deps.logger?.info('CaseEvolution', 'case candidates captured', {captured});
        return {captured};
      }
      return {
        captured: 0,
        skipped: duplicate
          ? 'duplicate'
          : queueFull
            ? 'queue_full'
            : piiRejected
              ? 'pii_rejected'
              : 'no_candidates',
      };
    } finally {
      if (openedHere) outbox.close();
    }
  } catch (err) {
    deps.logger?.warn('CaseEvolution', 'capture failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {captured: 0, skipped: 'error'};
  }
}
