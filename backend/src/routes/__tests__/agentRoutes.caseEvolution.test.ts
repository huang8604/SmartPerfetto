// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  applyCaseCandidateFeedbackForRoute,
  buildCaseEvolutionSnapshotPath,
  captureCaseCandidatesAfterQualityArtifacts,
  resolveCaseEvolutionArchitectureType,
} from '../agentRoutes';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('agentRoutes case evolution capture seam', () => {
  it('builds stable session-persistence snapshot references', () => {
    expect(buildCaseEvolutionSnapshotPath('session-abc')).toBe(
      'session-persistence://sessions/session-abc/metadata/sessionStateSnapshot',
    );
  });

  it('resolves architecture type from the orchestrator cache with unknown fallback', () => {
    expect(
      resolveCaseEvolutionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ type: 'android' })),
        },
      } as any, 'trace-1'),
    ).toBe('android');

    expect(
      resolveCaseEvolutionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ name: 'missing-type' })),
        },
      } as any, 'trace-1'),
    ).toBe('unknown');

    expect(resolveCaseEvolutionArchitectureType({ orchestrator: {} } as any, 'trace-1')).toBe('unknown');
  });

  it('passes verified artifacts and live session envelopes to saveCaseCandidates', async () => {
    const dataEnvelope = {
      schemaVersion: 'data-envelope@1',
      data: { columns: [], rows: [] },
      meta: { skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause' },
    };
    const claimVerificationResult = {
      status: 'passed',
      summary: { checkedClaims: 1, unsupportedClaims: 0 },
    };
    const result = {
      sessionId: 'session-1',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'Verified conclusion',
      confidence: 0.91,
      rounds: 2,
      totalDurationMs: 1250,
      claimVerificationResult,
    };
    const session = {
      activeRun: { sequence: 3 },
      dataEnvelopes: [dataEnvelope],
      orchestrator: {
        getCachedArchitecture: jest.fn(() => ({ type: 'android' })),
      },
    };
    const saveCandidates = jest.fn<(input: any) => Promise<{ captured: number }>>(
      async () => ({ captured: 1 }),
    );
    const computeTraceHash = jest.fn<(traceId: string) => Promise<string>>(
      async () => 'trace-hash-1',
    );
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: session as any,
      result: result as any,
      normalizedConclusionContract: { schemaVersion: 'conclusion-contract@1' } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      knowledgeScope: { tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1' },
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash,
      saveCandidates,
      logger: logger as any,
    });

    expect(computeTraceHash).toHaveBeenCalledWith('trace-1');
    expect(saveCandidates).toHaveBeenCalledWith(expect.objectContaining({
      result,
      conclusionContract: { schemaVersion: 'conclusion-contract@1' },
      claimVerificationResult,
      dataEnvelopes: [dataEnvelope],
      sceneType: 'scrolling',
      architectureType: 'android',
      knowledgeScope: { tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1' },
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
      provenance: expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        turnIndex: 3,
        engine: 'claude',
        traceContentHash: 'trace-hash-1',
      }),
    }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not touch trace hashing or persistence when capture is disabled', async () => {
    const computeTraceHash = jest.fn<(traceId: string) => Promise<string>>(
      async () => {
        throw new Error('should not hash');
      },
    );
    const saveCandidates = jest.fn<(input: any) => Promise<{ captured: number }>>(
      async () => ({ captured: 1 }),
    );
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: {
        activeRun: { sequence: 1 },
        dataEnvelopes: [],
        orchestrator: {},
      } as any,
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified conclusion',
        confidence: 0.95,
        rounds: 2,
        totalDurationMs: 100,
      } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      caseEvolutionConfig: {captureEnabled: false} as any,
      computeTraceHash,
      saveCandidates,
      logger: logger as any,
    });

    expect(computeTraceHash).not.toHaveBeenCalled();
    expect(saveCandidates).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows capture failures so terminal completion can continue', async () => {
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await expect(captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: {
        activeRun: { sequence: 1 },
        dataEnvelopes: [],
        orchestrator: {},
      } as any,
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified conclusion',
        confidence: 0.95,
        rounds: 2,
        totalDurationMs: 100,
      } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash: jest.fn<(traceId: string) => Promise<string>>(async () => 'trace-hash-1'),
      saveCandidates: jest.fn<(input: any) => Promise<never>>(async () => {
        throw new Error('capture boom');
      }),
      logger: logger as any,
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'CaseEvolution',
      'Candidate capture failed (non-fatal)',
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        error: 'capture boom',
      }),
    );
  });
});

describe('agentRoutes case candidate feedback seam', () => {
  it('passes CaseLibrary to the feedback state machine so CaseNode context stays in sync', () => {
    const outbox = { close: jest.fn() } as any;
    const library = { getCase: jest.fn() } as any;
    const recordFeedback = jest.fn<(input: any) => { added: boolean }>(
      () => ({ added: true }),
    );

    const result = applyCaseCandidateFeedbackForRoute({
      candidateId: 'cand-route',
      sessionId: 'session-1',
      rating: 'positive',
      surfacedAt: 1000,
      receivedAt: 2000,
      outbox,
      library,
      recordFeedback,
    });

    expect(result.added).toBe(true);
    expect(recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'cand-route',
      sourceSessionId: 'session-1',
      rating: 'positive',
      surfacedAt: 1000,
      receivedAt: 2000,
      outbox,
      library,
    }));
  });
});
