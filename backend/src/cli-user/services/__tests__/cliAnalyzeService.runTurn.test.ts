// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../../agent/types';
import { createDataEnvelope } from '../../../types/dataContract';
import { CliAnalyzeService } from '../cliAnalyzeService';

const mockAnalyze = jest.fn<() => Promise<AnalysisResult>>();
const mockPersistAgentTurn = jest.fn();
const mockGenerateAgentDrivenHTML = jest.fn<(data: unknown) => string>(() => '<html></html>');
const mockAnnotateLatestCompletedTurn = jest.fn();
const mockRunClaimVerification = jest.fn((_input: unknown): any => ({
  claimSupport: [],
  claimVerificationResult: {
    schemaVersion: 'claim_verifier@1',
    status: 'not_checked',
    policy: 'record_only',
    notCheckedReason: 'test',
    passed: false,
    checkedClaimCount: 0,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
  },
  identityResolutions: [],
}));

let mockPreparedSession: any;

jest.mock('../../../assistant/application/agentAnalyzeSessionService', () => ({
  AgentAnalyzeSessionService: jest.fn().mockImplementation(() => ({
    prepareSession: jest.fn(() => ({
      sessionId: 'cli-session-quality',
      session: mockPreparedSession,
      isNewSession: true,
    })),
  })),
  buildAgentQueryWithContinuityNotice: (query: string) => query,
}));

jest.mock('../../../services/sessionPersistenceService', () => ({
  SessionPersistenceService: {
    getInstance: jest.fn(() => ({})),
  },
}));

jest.mock('../../../services/persistAgentSession', () => ({
  persistAgentTurn: (...args: unknown[]) => mockPersistAgentTurn(...args),
}));

jest.mock('../../../services/htmlReportGenerator', () => ({
  getHTMLReportGenerator: () => ({
    generateAgentDrivenHTML: (data: unknown) => mockGenerateAgentDrivenHTML(data),
  }),
}));

jest.mock('../../../services/traceProcessorService', () => ({
  getTraceProcessorService: () => ({
    getTrace: jest.fn(() => undefined),
    cleanup: jest.fn(),
  }),
}));

jest.mock('../../../services/verifier/claimVerificationRunner', () => ({
  runClaimVerification: (input: unknown) => mockRunClaimVerification(input),
}));

jest.mock('../../../agent/context/enhancedSessionContext', () => ({
  sessionContextManager: {
    get: jest.fn(() => ({
      annotateLatestCompletedTurn: mockAnnotateLatestCompletedTurn,
    })),
  },
}));

jest.mock('../../../agentRuntime/runtimeSelection', () => ({
  resolveAgentRuntimeSelection: jest.fn(() => ({ kind: 'openai-agents-sdk' })),
}));

function makeSession(orchestrator: EventEmitter): any {
  return {
    sessionId: 'cli-session-quality',
    traceId: 'trace-cli',
    query: '分析启动慢',
    providerId: null,
    providerSnapshotHash: null,
    orchestrator,
    hypotheses: [],
    agentDialogue: [],
    dataEnvelopes: [],
    claimSupport: [],
    identityResolutions: [],
    agentResponses: [],
    conversationSteps: [],
    runSequence: 0,
    queryHistory: [],
    conclusionHistory: [],
  };
}

describe('CliAnalyzeService runTurn final quality gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunClaimVerification.mockReturnValue({
      claimSupport: [],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'not_checked',
        policy: 'record_only',
        notCheckedReason: 'test',
        passed: false,
        checkedClaimCount: 0,
        unsupportedClaimCount: 0,
        claimResults: [],
        issues: [],
      },
      identityResolutions: [],
    });
    const orchestrator = new EventEmitter() as EventEmitter & {
      analyze: typeof mockAnalyze;
      getSdkSessionId: () => string;
    };
    orchestrator.analyze = mockAnalyze;
    orchestrator.getSdkSessionId = () => 'sdk-cli-session-quality';
    mockPreparedSession = makeSession(orchestrator);
    mockAnalyze.mockResolvedValue({
      sessionId: 'cli-session-quality',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: [
        '## 综合结论',
        '',
        '完成综合结论输出。',
        '',
        '## 分阶段证据摘要',
        '',
        '- 启动概览采集: 获取启动概览。',
      ].join('\n'),
      confidence: 0.92,
      rounds: 1,
      totalDurationMs: 1000,
    });
  });

  it('marks phase-summary runtime output partial across CLI result, session, report, and event stream', async () => {
    const service = new CliAnalyzeService();
    const events: StreamingUpdate[] = [];

    const output = await service.runTurn({
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: update => events.push(update),
    });

    expect(output.result.partial).toBe(true);
    expect(output.result.confidence).toBe(0.55);
    expect(output.result.terminationMessage).toContain('最终结果质量闸门');
    expect(mockPreparedSession.result).toBe(output.result);
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        conclusion: expect.stringContaining('分阶段证据摘要'),
      }),
    }));
    expect(mockAnnotateLatestCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      partial: true,
      confidence: 0.55,
      terminationMessage: expect.stringContaining('最终结果质量闸门'),
    }));
    expect(mockGenerateAgentDrivenHTML).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
      }),
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'final_result_quality_gate',
          code: 'plan_summary_fallback',
          partial: true,
        }),
      }),
    ]));
  });

  it('surfaces runtime metadata from canonical snapshot engineState', async () => {
    mockPreparedSession.providerId = 'provider-from-session';
    mockPreparedSession.providerSnapshotHash = 'hash-from-session';
    mockPersistAgentTurn.mockImplementationOnce((input: any) => {
      input.session._lastSnapshot = {
        version: 1,
        snapshotTimestamp: Date.now(),
        sessionId: 'cli-session-quality',
        traceId: 'trace-cli',
        conversationSteps: [],
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
        engineState: {
          kind: 'openai-agents-sdk',
          provider: {
            providerId: 'provider-from-engine',
            providerSnapshotHash: 'hash-from-engine',
          },
          openai: {
            lastResponseId: 'resp-cli',
          },
        },
        runSequence: 0,
        conversationOrdinal: 0,
      };
    });

    const service = new CliAnalyzeService();
    const output = await service.runTurn({
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });

    expect(output.providerId).toBe('provider-from-engine');
    expect(output.agentRuntimeKind).toBe('openai-agents-sdk');
    expect(output.providerSnapshotHash).toBe('hash-from-engine');
  });

  it('passes prepared continuity agentQuery to the runtime while preserving the user query for persistence', async () => {
    mockPreparedSession.agentQuery = [
      'System context continuity notice:',
      'The provider SDK conversation context was reset before this turn.',
      '',
      'User query:',
      '分析启动慢',
    ].join('\n');

    const service = new CliAnalyzeService();
    await service.runTurn({
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });

    const analyzeCall = mockAnalyze.mock.calls[0] as unknown[];
    expect(analyzeCall[0]).toBe(mockPreparedSession.agentQuery);
    expect(analyzeCall[1]).toBe('cli-session-quality');
    expect(analyzeCall[2]).toBe('trace-cli');
    expect(analyzeCall[3]).toEqual(expect.any(Object));
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      query: '分析启动慢',
    }));
  });

  it('attaches CLI degraded lineage to the backend session before persistence', async () => {
    const lineage = {
      previousBackendSessionId: 'backend-before-level3',
      reason: 'cli-level3-degraded' as const,
      at: 1_780_000_000_000,
    };

    const service = new CliAnalyzeService();
    await service.runTurn({
      traceId: 'trace-cli',
      query: '继续分析',
      lineage,
      onEvent: jest.fn(),
    });

    expect(mockPreparedSession.lineage).toEqual(lineage);
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ lineage }),
    }));
  });

  it('derives verifier-ready contracts from CLI-collected DataEnvelopes before verification', async () => {
    const envelope = createDataEnvelope({
      columns: ['package', 'startup_type', 'ttid_ms'],
      rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
    }, {
      type: 'skill_result',
      source: 'startup_analysis',
      title: '启动概览',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:test',
      sourceToolCallId: 'invoke_skill:startup_analysis:test',
      traceId: 'trace-cli',
      traceSide: 'current',
    });
    mockAnalyze.mockImplementationOnce(async () => {
      mockPreparedSession.orchestrator.emit('update', {
        type: 'data',
        content: [envelope],
        timestamp: Date.now(),
      } satisfies StreamingUpdate);
      return {
        sessionId: 'cli-session-quality',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是冷启动，TTID=1912ms。',
        confidence: 0.9,
        rounds: 1,
        totalDurationMs: 1000,
      };
    });
    mockRunClaimVerification.mockReturnValueOnce({
      claimSupport: [],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        notCheckedReason: undefined,
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [],
        issues: [],
      },
      identityResolutions: [],
    });

    const service = new CliAnalyzeService();
    const output = await service.runTurn({
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });
    const verifierInput = mockRunClaimVerification.mock.calls[0]?.[0] as any;

    expect(output.result.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(verifierInput.conclusionContract?.claims?.some((claim: any) =>
      claim.references?.some((ref: any) => ref.column === 'ttid_ms' && ref.value === 1912),
    )).toBe(true);
    expect(output.result.claimVerificationResult?.status).toBe('passed');
  });
});
