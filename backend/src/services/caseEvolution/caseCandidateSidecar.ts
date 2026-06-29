// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import { backendLogPath } from '../../runtimePaths';
import type { CaseCandidate, CaseCandidateReview } from '../../types/caseEvolution';

const SAFE_CANDIDATE_ID_RE = /^[a-zA-Z0-9._:-]+$/;

export interface WriteCaseCandidateSidecarOptions {
  notesDir?: string;
  warnings?: string[];
  now?: number;
}

export type WriteCaseCandidateSidecarResult =
  | {ok: true; path: string}
  | {ok: false; reason: 'invalid_candidate_id' | 'io_error'; details: string};

export interface CaseCandidateSidecarPayload {
  schemaVersion: 'case_candidate_sidecar@1';
  writtenAt: number;
  candidate: CaseCandidate;
  review: CaseCandidateReview;
  validationWarnings: string[];
}

export function writeCaseCandidateSidecar(
  candidate: CaseCandidate,
  review: CaseCandidateReview,
  opts: WriteCaseCandidateSidecarOptions = {},
): WriteCaseCandidateSidecarResult {
  if (!isSafeCandidateId(candidate.candidateId)) {
    return {
      ok: false,
      reason: 'invalid_candidate_id',
      details: `unsafe candidateId '${candidate.candidateId}'`,
    };
  }
  if (review.candidateId !== candidate.candidateId) {
    return {
      ok: false,
      reason: 'invalid_candidate_id',
      details: `review candidateId '${review.candidateId}' does not match '${candidate.candidateId}'`,
    };
  }

  const notesDir = opts.notesDir ?? backendLogPath('case_candidates');
  const targetPath = path.join(notesDir, `${candidate.candidateId}.json`);
  const payload: CaseCandidateSidecarPayload = {
    schemaVersion: 'case_candidate_sidecar@1',
    writtenAt: opts.now ?? Date.now(),
    candidate,
    review,
    validationWarnings: opts.warnings ?? [],
  };

  const tmpPath = path.join(
    notesDir,
    `${candidate.candidateId}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.mkdirSync(notesDir, {recursive: true});
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, targetPath);
    return {ok: true, path: targetPath};
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures; the write error is the useful signal.
    }
    return {
      ok: false,
      reason: 'io_error',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

function isSafeCandidateId(candidateId: string): boolean {
  return SAFE_CANDIDATE_ID_RE.test(candidateId) &&
    !candidateId.includes('..') &&
    !candidateId.includes('/') &&
    !candidateId.includes('\\');
}

export const __testing = {SAFE_CANDIDATE_ID_RE};
