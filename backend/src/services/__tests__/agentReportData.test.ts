// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';

jest.mock('../traceProcessorService', () => ({
  getTraceProcessorService: () => ({getTrace: () => undefined}),
}));

import {buildAgentDrivenReportData} from '../agentReportData';
import {HTMLReportGenerator} from '../htmlReportGenerator';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../security/codeAwareOutputRegistry';

describe('buildAgentDrivenReportData private knowledge projection', () => {
  it('keeps verified conclusion and deterministic evidence but drops intermediate model prose', () => {
    const sessionId = 'private-report-session';
    [
      'PRIVATE_CONCLUSION_CANARY',
      'PRIVATE_FINDING_CANARY',
      'PRIVATE_RESULT_HYPOTHESIS_CANARY',
      'PRIVATE_HYPOTHESIS_CANARY',
      'PRIVATE_CLAIM_CANARY',
      'PRIVATE_VERIFICATION_CANARY',
      'PRIVATE_IDENTITY_CANARY',
      'PRIVATE_ACTION_CANARY',
    ].forEach(canary => registerCodeAwareCanary(sessionId, canary));
    const report = buildAgentDrivenReportData({
      session: {
        sessionId,
        traceId: 'trace-a',
        query: 'analyze PRIVATE_QUERY_CANARY',
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        outputLanguage: 'en',
        orchestrator: {
          getSessionNotes: () => [{content: 'PRIVATE_NOTE_CANARY'}],
          getSessionPlan: () => ({successCriteria: 'PRIVATE_PLAN_CANARY'}),
          getSessionUncertaintyFlags: () => [{description: 'PRIVATE_FLAG_CANARY'}],
        },
        hypotheses: [{description: 'PRIVATE_HYPOTHESIS_CANARY'}],
        agentDialogue: [{content: 'PRIVATE_DIALOGUE_CANARY'}],
        conversationSteps: [{text: 'PRIVATE_STEP_CANARY'}],
        dataEnvelopes: [{meta: {kind: 'sql'}, data: {rows: [[1]]}, display: {type: 'table'}}],
        agentResponses: [{response: 'PRIVATE_RESPONSE_CANARY'}],
        runSequence: 1,
        queryHistory: [{query: 'PRIVATE_QUERY_HISTORY_CANARY'}],
        conclusionHistory: [{conclusion: 'PRIVATE_HISTORY_CANARY'}],
      } as any,
      result: {
        sessionId,
        success: true,
        findings: [{id: 'finding', title: 'PRIVATE_FINDING_CANARY'}] as any,
        hypotheses: [{description: 'PRIVATE_RESULT_HYPOTHESIS_CANARY'}] as any,
        conclusion: 'safe before PRIVATE_CONCLUSION_CANARY safe after',
        conclusionContract: {claims: [{text: 'PRIVATE_CLAIM_CANARY'}]},
        claimSupport: [{claimId: 'claim-1', text: 'PRIVATE_CLAIM_CANARY'}] as any,
        claimVerificationResult: {
          status: 'partial',
          issues: [{message: 'PRIVATE_VERIFICATION_CANARY'}],
        } as any,
        identityResolutions: [{
          identityRefId: 'identity-1',
          status: 'verified',
          warnings: ['PRIVATE_IDENTITY_CANARY'],
        }] as any,
        uiActionProposals: [{
          schemaVersion: 1,
          id: 'action-1',
          kind: 'navigate_timeline',
          title: 'PRIVATE_ACTION_CANARY',
          reason: 'PRIVATE_ACTION_CANARY',
          source: {evidenceRefId: 'data:action-1'},
          payload: {ts: '100'},
          requiresConfirmation: true,
        }] as any,
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 10,
      },
    });

    expect(report.dataEnvelopes).toHaveLength(1);
    expect(report.result.findings).toHaveLength(1);
    expect(report.result.hypotheses).toHaveLength(1);
    expect(report.hypotheses).toHaveLength(1);
    expect(report.result.claimSupport).toHaveLength(1);
    expect(report.result.claimVerificationResult).toBeDefined();
    expect(report.result.identityResolutions).toHaveLength(1);
    expect(report.result.uiActionProposals).toHaveLength(1);
    expect(report.dialogue).toEqual([]);
    expect(report.conversationTimeline).toEqual([]);
    expect(report.agentResponses).toEqual([]);
    expect(report.analysisNotes).toEqual([]);
    expect(report.analysisPlan).toBeNull();
    expect(report.uncertaintyFlags).toEqual([]);
    expect(report.outputLanguage).toBe('en');
    expect(report.query).toContain('Private source or knowledge analysis request');
    const html = new HTMLReportGenerator().generateAgentDrivenHTML({
      ...report,
      result: {
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Safe projected conclusion.',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 10,
      },
      hypotheses: [],
      dataEnvelopes: [],
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('SmartPerfetto Agent-Driven Analysis Report');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
    clearCodeAwareOutputGuards(sessionId);
  });
});
