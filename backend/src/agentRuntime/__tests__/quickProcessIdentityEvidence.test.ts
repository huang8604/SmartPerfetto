// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';

import {
  buildQuickProcessIdentityEvidence,
  shouldUseEvidenceOnlyQuickAnalysis,
  type QuickProcessIdentityEvidenceInput,
} from '../quickProcessIdentityEvidence';
import { buildQuickProcessIdentityDirectAnswer } from '../quickProcessIdentityDirectAnswer';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import type { SkillExecutionResult } from '../../services/skillEngine/types';
import type { DataEnvelope } from '../../types/dataContract';

type ExecuteSkill = QuickProcessIdentityEvidenceInput['skillExecutor']['execute'];

function resolverResult(): SkillExecutionResult {
  return {
    skillId: 'process_identity_resolver',
    skillName: '进程身份交叉解析',
    success: true,
    displayResults: [{
      stepId: 'root',
      title: '进程身份候选',
      level: 'key',
      layer: 'overview',
      format: 'table',
      data: {
        columns: [
          'rank',
          'confidence_score',
          'identity_status',
          'canonical_package_name',
          'recommended_process_name_param',
          'upid',
          'pid',
          'process_name',
          'package_name',
          'identity_warning',
        ],
        rows: [[
          1,
          95,
          'confirmed',
          'com.example.app',
          'com.example.app',
          42,
          4242,
          'com.example.app',
          'com.example.app',
          'ok',
        ]],
      },
    }],
    diagnostics: [],
    executionTimeMs: 12,
  };
}

function promptReadyEnvelope(overrides?: {
  rank?: number;
  status?: string;
  score?: number;
  warning?: string;
  canonicalPackageName?: string;
  recommendedProcessName?: string;
  processName?: string;
  extraRows?: unknown[][];
}): DataEnvelope {
  const row = [
    overrides?.rank ?? 1,
    overrides?.status ?? 'confirmed',
    overrides?.score ?? 95,
    overrides?.canonicalPackageName ?? 'com.example.app',
    overrides?.recommendedProcessName ?? 'com.example.app',
    42,
    4242,
    overrides?.processName ?? 'com.example.app',
    overrides?.warning ?? 'ok',
  ];
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'process_identity_resolver:root',
      timestamp: 1,
    },
    data: {
      columns: [
        'rank',
        'identity_status',
        'confidence_score',
        'canonical_package_name',
        'recommended_process_name_param',
        'upid',
        'pid',
        'process_name',
        'identity_warning',
      ],
      rows: [row, ...(overrides?.extraRows ?? [])],
    },
    display: {
      layer: 'overview',
      format: 'table',
      title: '进程身份候选',
    },
  };
}

describe('buildQuickProcessIdentityEvidence', () => {
  it('runs the resolver and returns quick process identity evidence', async () => {
    const execute = jest.fn<ExecuteSkill>(async () => resolverResult());
    const payload = await buildQuickProcessIdentityEvidence({
      skillExecutor: { execute },
      traceId: 'trace-1',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 1_700_000_000,
          switchCount: 347,
        }],
      },
    });

    expect(execute).toHaveBeenCalledWith(
      'process_identity_resolver',
      'trace-1',
      {
        package: 'com.example.app',
        process_name: 'com.example.app',
        max_rows: 5,
      },
      { __skipIdentityGate: true },
    );
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      type: 'skill_result',
      source: 'process_identity_resolver:root',
      skillId: 'process_identity_resolver',
      stepId: 'root',
      traceSide: 'current',
      traceId: 'trace-1',
      planPhaseId: 'quick',
      intent: 'runtime_process_identity_detection',
    });
    expect(payload.envelopes[0].meta.evidenceRefId)
      .toMatch(/^data:skill:process_identity_resolver:current:[a-f0-9]{12}:root$/);
    expect(payload.envelopes[0].meta.sourceToolCallId)
      .toMatch(/^runtime-skill:process_identity_resolver:[a-f0-9]{12}$/);
    expect(payload.promptContext).toContain('当前 Trace 运行时预证据');
    expect(payload.promptContext).toContain('data:skill:process_identity_resolver:current:');
    expect(payload.promptContext).toContain('recommended_process_name_param');
    expect(payload.promptContext).toContain('com.example.app');
  });

  it('skips resolver work when no package identity is known', async () => {
    const execute = jest.fn<ExecuteSkill>(async () => resolverResult());
    const payload = await buildQuickProcessIdentityEvidence({
      skillExecutor: { execute },
      traceId: 'trace-1',
      focusResult: {
        method: 'none',
        apps: [],
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(payload).toEqual({ envelopes: [] });
  });
});

describe('shouldUseEvidenceOnlyQuickAnalysis', () => {
  it('allows evidence-only quick analysis only when identity evidence is verified', () => {
    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope()],
        promptContext: 'process identity table',
      },
    })).toBe(true);
  });

  it('falls back to full tools when preflight is not skipped or evidence is incomplete', () => {
    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: false,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope()],
        promptContext: 'process identity table',
      },
    })).toBe(false);
    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: { envelopes: [], promptContext: 'process identity table' },
    })).toBe(false);
    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope()],
      },
    })).toBe(false);
  });

  it('falls back to full tools when verified rows lack canonical process identity names', () => {
    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope({ canonicalPackageName: '' })],
        promptContext: 'process identity table',
      },
    })).toBe(false);

    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope({ recommendedProcessName: '<unknown>' })],
        promptContext: 'process identity table',
      },
    })).toBe(false);
  });

  it('falls back to full tools for weak, warning-bearing, or ambiguous identity evidence', () => {
    for (const status of ['probable', 'weak_match', 'foreground_candidate', 'context']) {
      expect(shouldUseEvidenceOnlyQuickAnalysis({
        skipQuickTracePreflightDetection: true,
        processIdentityEvidence: {
          envelopes: [promptReadyEnvelope({ status })],
          promptContext: 'process identity table',
        },
      })).toBe(false);
    }

    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope({
          warning: '目标未命中 process.name，但命中了 metadata/cmdline/layer；不要只按 process.name 判断',
        })],
        promptContext: 'process identity table',
      },
    })).toBe(false);

    expect(shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: true,
      processIdentityEvidence: {
        envelopes: [promptReadyEnvelope({
          extraRows: [[
            2,
            'confirmed',
            90,
            'com.example.other',
            'com.example.other',
            43,
            4343,
            'com.example.other',
            'ok',
          ]],
        })],
        promptContext: 'process identity table',
      },
    })).toBe(false);
  });
});

describe('buildQuickProcessIdentityDirectAnswer', () => {
  it('builds a verifier-backed direct answer for confirmed process identity evidence', async () => {
    const execute = jest.fn<ExecuteSkill>(async () => resolverResult());
    const evidence = await buildQuickProcessIdentityEvidence({
      skillExecutor: { execute },
      traceId: 'trace-1',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 1_700_000_000,
          switchCount: 347,
        }],
      },
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickProcessIdentityDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('com.example.app');
    expect(direct?.conclusion).toContain('UPID=42');
    expect(direct?.conclusion).toContain('PID=4242');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'canonical_package_name', value: 'com.example.app' }),
      expect.objectContaining({ column: 'recommended_process_name_param', value: 'com.example.app' }),
      expect.objectContaining({ column: 'upid', value: 42 }),
      expect.objectContaining({ column: 'pid', value: 4242 }),
    ]));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('does not build a direct answer when process identity evidence is incomplete', () => {
    const direct = buildQuickProcessIdentityDirectAnswer({
      evidence: { envelopes: [], promptContext: 'process identity table' },
      outputLanguage: 'zh-CN',
    });

    expect(direct).toBeUndefined();
  });

  it('does not build a direct answer when the top process name is unknown', () => {
    const direct = buildQuickProcessIdentityDirectAnswer({
      evidence: {
        envelopes: [promptReadyEnvelope({ processName: '<unknown>' })],
        promptContext: 'process identity table',
      },
      outputLanguage: 'zh-CN',
    });

    expect(direct).toBeUndefined();
  });
});
