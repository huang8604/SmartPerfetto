// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { ClaimVerificationResult } from '../../../types/claimVerification';
import type { DataEnvelope } from '../../../types/dataContract';
import {
  buildCaseCandidatesFromRun,
  caseCandidateDedupeKey,
  projectScrollingCandidateClusters,
} from '../caseCandidateBuilder';

function rootCauseEnvelope(rowOverrides: Record<string, unknown> = {}): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis',
      skillId: 'scrolling_analysis',
      stepId: 'batch_frame_root_cause',
      evidenceRefId: 'ev-root',
      timestamp: 2,
    },
    display: {layer: 'list', format: 'table', title: '掉帧列表'},
    data: {
      columns: ['reason_code', 'jank_responsibility', 'frame_count', 'percentage', 'frame_id', 'dur_ms', 'vsync_missed', 'render_slices_json'],
      rows: [[
        rowOverrides.reason_code ?? 'shader_compile',
        rowOverrides.jank_responsibility ?? 'APP',
        rowOverrides.frame_count ?? 4,
        rowOverrides.percentage ?? 18,
        rowOverrides.frame_id ?? 'f1',
        rowOverrides.dur_ms ?? 58.8,
        rowOverrides.vsync_missed ?? 3,
        rowOverrides.render_slices_json ?? '["makePipeline"]',
      ]],
    },
  };
}

function verification(overrides: Partial<ClaimVerificationResult> = {}): ClaimVerificationResult {
  return {
    schemaVersion: 'claim_verifier@1',
    status: 'passed',
    policy: 'warn_only',
    passed: true,
    checkedClaimCount: 1,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
    ...overrides,
  };
}

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'session-1',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'Shader compilation caused jank.',
    confidence: 0.9,
    rounds: 2,
    totalDurationMs: 1000,
    claimVerificationResult: verification(),
    ...overrides,
  };
}

function input(overrides: Parameters<typeof buildCaseCandidatesFromRun>[0] extends infer T ? Partial<T> : never = {}) {
  return {
    result: result(),
    claimVerificationResult: verification(),
    dataEnvelopes: [rootCauseEnvelope()],
    sceneType: 'scrolling',
    architectureType: 'unknown',
    snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
    provenance: {
      sessionId: 'session-1',
      runId: 'run-1',
      turnIndex: 1,
      engine: 'claude',
      traceContentHash: 'trace-hash',
    },
    ...overrides,
  };
}

describe('projectScrollingCandidateClusters', () => {
  it('projects promotable batch_frame_root_cause rows', () => {
    expect(projectScrollingCandidateClusters([rootCauseEnvelope()])).toMatchObject([
      {
        scene: 'scrolling',
        domainPack: 'scrolling.v1',
        rootCause: 'shader_compile',
        responsibility: 'app',
        frameCount: 4,
        percentage: 18,
        representativeFrame: {frameId: 'f1', durMs: 58.8, vsyncMissed: 3},
        evidenceSignatures: {
          reason_code: 'shader_compile',
          render_slices: ['makePipeline'],
        },
      },
    ]);
  });

  it('filters rows below the scrolling promotable threshold', () => {
    expect(projectScrollingCandidateClusters([rootCauseEnvelope({frame_count: 2})])).toEqual([]);
    expect(projectScrollingCandidateClusters([rootCauseEnvelope({percentage: 14.9})])).toEqual([]);
  });
});

describe('buildCaseCandidatesFromRun', () => {
  it('builds one candidate per promotable cluster with stable provenance and dedupe key', () => {
    const candidates = buildCaseCandidatesFromRun(input());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      schemaVersion: 'case_candidate@1',
      provenance: {
        sourceSessionId: 'session-1',
        sourceAnalysisRunId: 'run-1',
        sourceTurnIndex: 1,
        traceContentHash: 'trace-hash',
        engine: 'claude',
        sceneType: 'scrolling',
        architectureType: 'unknown',
      },
      cluster: {
        rootCause: 'shader_compile',
        frameCount: 4,
        percentage: 18,
      },
      evidenceHandle: {
        analysisRunId: 'run-1',
        clusterIndex: 0,
        evidenceRefIds: ['ev-root'],
        snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
      },
      verification: {
        verifierStatus: 'passed',
        verifierErrorCount: 0,
        confidenceNumeric: 0.9,
        confidenceBucket: 'high',
      },
    });
    expect(candidates[0].candidateId).toMatch(/^casecand-/);
    expect(candidates[0].candidateId).toContain('run-1');
    expect(caseCandidateDedupeKey(candidates[0])).toBe('trace-hash::scrolling::shader_compile');
  });

  it('fails closed when confidence, verifier, rounds, trace hash, or existing published keys disqualify the run', () => {
    expect(buildCaseCandidatesFromRun(input({result: result({confidence: 0.79})}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input({claimVerificationResult: undefined}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input({claimVerificationResult: verification({status: 'failed'})}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input({claimVerificationResult: verification({issues: [{claimId: 'c1', severity: 'error', code: 'unsupported', message: 'bad'}]})}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input({result: result({rounds: 1})}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input({provenance: {...input().provenance, traceContentHash: null}}))).toEqual([]);
    expect(buildCaseCandidatesFromRun(input(), {existingPublishedCaseKeys: new Set(['trace-hash::scrolling::shader_compile'])})).toEqual([]);
  });

  // MAJOR-4 regression: the scene+rootCause dedupe set (populated from the
  // live published CaseLibrary at capture time) must suppress a candidate
  // whose root cause already has published guidance. Unlike
  // existingPublishedCaseKeys this does not depend on a traceContentHash
  // (which published cases do not persist), so it catches the flooding case.
  it('suppresses a candidate whose scene::rootCause is already published', () => {
    // Without the dedupe set, a candidate is produced.
    expect(buildCaseCandidatesFromRun(input())).toHaveLength(1);
    // With scrolling::shader_compile in the published set, none is produced.
    expect(
      buildCaseCandidatesFromRun(input(), {existingPublishedSceneRootCauses: new Set(['scrolling::shader_compile'])}),
    ).toEqual([]);
    // An unrelated root cause is unaffected.
    expect(
      buildCaseCandidatesFromRun(input(), {existingPublishedSceneRootCauses: new Set(['scrolling::gc_jank'])}),
    ).toHaveLength(1);
  });
});
