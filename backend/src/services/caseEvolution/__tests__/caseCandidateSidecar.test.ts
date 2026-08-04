// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { writeCaseCandidateSidecar } from '../caseCandidateSidecar';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-sidecar-'));
});

afterEach(() => {
  fs.rmSync(tempDir, {recursive: true, force: true});
});

function candidate(candidateId = 'cand-sidecar-1'): CaseCandidate {
  return {
    candidateId,
    schemaVersion: 'case_candidate@2',
    provenance: {
      sourceSessionId: 'session-1',
      sourceAnalysisRunId: 'run-1',
      sourceTurnIndex: 1,
      traceContentHash: 'trace-hash',
      capturedAt: 1000,
      engine: 'claude',
      sceneType: 'scrolling',
      architectureType: 'unknown',
      originScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    },
    cluster: {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      responsibility: 'app',
      severity: 'warning',
      frameCount: 4,
      percentage: 18,
      evidenceSignatures: {reason_code: 'shader_compile'},
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
    },
    verification: {
      claimSupportSummary: 'claims verified',
      verifierStatus: 'passed',
      verifierIssueSeverities: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      confidenceNumeric: 0.9,
      confidenceBucket: 'high',
    },
  };
}

function review(candidateId = 'cand-sidecar-1'): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader compilation causes jank',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: {
        required: [{field: 'reason_code', op: 'eq', value: 'shader_compile'}],
        supportive: [],
      },
      findings: [{id: 'finding-1', title: 'Shader compile frames', evidence_refs: ['ev-1'], confidence: 'high'}],
      recommendations: {
        app: [{id: 'rec-1', priority: 'P1', action: 'Warm shader cache', applies_when: 'shader_compile', risks: 'Startup cost'}],
        oem: [],
      },
      relations: {},
    },
    evidenceSummary: 'Supported by root-cause evidence',
    risks: [],
  };
}

describe('caseCandidateSidecar', () => {
  it('writes candidate review sidecars atomically with audit metadata', () => {
    const result = writeCaseCandidateSidecar(candidate(), review(), {
      notesDir: path.join(tempDir, 'nested', 'case_candidates'),
      warnings: ['dropped relation case-missing'],
      now: 1234,
    });

    expect(result).toMatchObject({ok: true});
    if (!result.ok) throw new Error(result.details);
    expect(result.path).toBe(path.join(tempDir, 'nested', 'case_candidates', 'cand-sidecar-1.json'));
    expect(fs.existsSync(result.path)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    expect(parsed.writtenAt).toBe(1234);
    expect(parsed.candidate.candidateId).toBe('cand-sidecar-1');
    expect(parsed.review.candidateId).toBe('cand-sidecar-1');
    expect(parsed.validationWarnings).toEqual(['dropped relation case-missing']);
    expect(fs.readdirSync(path.dirname(result.path)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('rejects candidate ids that could escape the sidecar directory', () => {
    const result = writeCaseCandidateSidecar(candidate('../escape'), review('../escape'), {
      notesDir: tempDir,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid_candidate_id',
    });
    expect(fs.existsSync(path.join(tempDir, '..', 'escape.json'))).toBe(false);
  });
});
