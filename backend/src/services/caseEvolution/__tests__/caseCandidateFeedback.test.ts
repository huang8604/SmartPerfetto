// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { CaseLibrary } from '../../caseLibrary';
import { openCaseCandidateOutbox, type CaseCandidateOutboxHandle } from '../caseCandidateOutbox';
import { recordCaseCandidateFeedback } from '../caseCandidateFeedback';

let outbox: CaseCandidateOutboxHandle;
let library: CaseLibrary;
let tmpDir: string;

beforeEach(() => {
  outbox = openCaseCandidateOutbox({ dbPath: ':memory:' });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-feedback-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
});

afterEach(() => {
  outbox.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(candidateId = 'cand-feedback-1'): CaseCandidate {
  return {
    candidateId,
    schemaVersion: 'case_candidate@1',
    provenance: {
      sourceSessionId: 'session-1',
      sourceAnalysisRunId: 'run-1',
      sourceTurnIndex: 1,
      traceContentHash: 'trace-hash',
      capturedAt: 1_000,
      engine: 'claude',
      sceneType: 'scrolling',
      architectureType: 'unknown',
    },
    cluster: {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      responsibility: 'app',
      severity: 'warning',
      frameCount: 4,
      percentage: 20,
      evidenceSignatures: { reason_code: 'shader_compile' },
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'snapshot',
    },
    verification: {
      claimSupportSummary: 'verified',
      verifierStatus: 'passed',
      verifierIssueSeverities: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      confidenceNumeric: 0.9,
      confidenceBucket: 'high',
    },
  };
}

function review(candidateId = 'cand-feedback-1'): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader case',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: { required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }], supportive: [] },
      findings: [],
      recommendations: { app: [], oem: [] },
      relations: {},
    },
    evidenceSummary: 'summary',
    risks: [],
  };
}

function seedReviewedCase() {
  const item = candidate();
  outbox.enqueue(item, { dedupeKey: 'dedupe' });
  outbox.markReviewed(item.candidateId, { review: review() });
  outbox.setLearnedCaseId(item.candidateId, 'learned:cand-feedback');
  library.saveCase({
    schemaVersion: 1,
    source: 'runtime_analysis_candidate',
    createdAt: 1,
    caseId: 'learned:cand-feedback',
    title: 'Shader case',
    status: 'draft',
    redactionState: 'redacted',
    tags: ['scrolling'],
    findings: [],
    knowledge: {
      sourceFile: 'logs/case_candidates/cand-feedback-1.json',
      body: 'body',
      quality: 'imported',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: { 'caseEvolution.v1': { candidateId: item.candidateId, supportingEvidence: 0, contradictingEvidence: 0, supported: false } },
      evidenceSignatures: { required: [], supportive: [] },
      recommendations: { app: [], oem: [] },
    },
  });
}

describe('recordCaseCandidateFeedback', () => {
  it('ignores mis-taps under ten seconds', () => {
    seedReviewedCase();

    const result = recordCaseCandidateFeedback({
      candidateId: 'cand-feedback-1',
      sourceSessionId: 'session-a',
      rating: 'positive',
      surfacedAt: 1_000,
      receivedAt: 5_000,
      outbox,
      library,
    });

    expect(result).toMatchObject({ added: false, reason: 'mis_tap' });
    expect(outbox.getCandidate('cand-feedback-1')?.supportingEvidence).toBe(0);
  });

  it('marks a learned case supported after three distinct positive sessions', () => {
    seedReviewedCase();

    for (const sourceSessionId of ['a', 'b', 'c']) {
      expect(recordCaseCandidateFeedback({
        candidateId: 'cand-feedback-1',
        sourceSessionId,
        rating: 'positive',
        surfacedAt: 1_000,
        receivedAt: 20_000,
        outbox,
        library,
      }).added).toBe(true);
    }

    expect(outbox.getCandidate('cand-feedback-1')?.supported).toBe(1);
    expect(library.getCase('learned:cand-feedback')?.knowledge?.context['caseEvolution.v1']).toMatchObject({
      supportingEvidence: 3,
      supported: true,
    });
  });

  it('rejects the candidate and demotes its CaseNode to private after two negatives', () => {
    seedReviewedCase();

    for (const sourceSessionId of ['a', 'b']) {
      recordCaseCandidateFeedback({
        candidateId: 'cand-feedback-1',
        sourceSessionId,
        rating: 'negative',
        surfacedAt: 1_000,
        receivedAt: 20_000,
        outbox,
        library,
      });
    }

    expect(outbox.getCandidate('cand-feedback-1')?.state).toBe('rejected');
    expect(library.getCase('learned:cand-feedback')?.status).toBe('private');
  });
});
