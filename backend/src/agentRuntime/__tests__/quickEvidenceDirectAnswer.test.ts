// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import type { ConclusionContract } from '../../agent/core/conclusionContract';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';
import {
  combineRuntimeQuickEvidenceDirectAnswers,
  countRuntimeQuickEvidenceCitedRefs,
  type RuntimeQuickEvidenceDirectAnswer,
} from '../quickEvidenceDirectAnswer';

function envelope(input: {
  evidenceRefId: string;
  sourceToolCallId: string;
  title: string;
  columns: string[];
  rows: unknown[][];
}): DataEnvelope {
  return {
    meta: {
      type: 'sql_result',
      version: '2.0.0',
      source: input.sourceToolCallId,
      timestamp: 1,
      evidenceRefId: input.evidenceRefId,
      sourceToolCallId: input.sourceToolCallId,
      traceSide: 'current',
      traceId: 'trace-1',
    },
    data: {
      columns: input.columns,
      rows: input.rows,
    },
    display: {
      layer: 'list',
      format: 'table',
      title: input.title,
    },
  };
}

function answer(input: {
  id: string;
  statement: string;
  claimKind: 'categorical' | 'numeric';
  evidenceText: string;
  references: NonNullable<ConclusionContract['claims']>[number]['references'];
}): RuntimeQuickEvidenceDirectAnswer {
  return {
    conclusion: input.statement,
    conclusionContract: {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{
        rank: 1,
        statement: input.statement,
        confidencePercent: 100,
      }],
      clusters: [],
      evidenceChain: [{
        conclusionId: input.id,
        text: input.evidenceText,
      }],
      claims: [{
        id: input.id,
        conclusionId: input.id,
        text: input.statement,
        kind: input.claimKind,
        references: input.references,
      }],
      uncertainties: [],
      nextSteps: [],
      metadata: {
        confidencePercent: 100,
        rounds: 0,
        claimDerivation: 'explicit_model_contract',
        claimVerificationScope: 'explicit_claims',
      },
    },
    confidence: 1,
  };
}

describe('combineRuntimeQuickEvidenceDirectAnswers', () => {
  it('combines process identity and trace fact direct answers without losing verifier coverage', () => {
    const identityEnvelope = envelope({
      evidenceRefId: 'data:skill:process_identity_resolver:current:abc:result_0',
      sourceToolCallId: 'runtime-skill:process_identity_resolver:abc',
      title: 'Runtime process identity pre-evidence',
      columns: [
        'canonical_package_name',
        'recommended_process_name_param',
        'process_name',
        'upid',
        'identity_status',
        'confidence_score',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        'com.example.app',
        42,
        'confirmed',
        100,
      ]],
    });
    const traceFactEnvelope = envelope({
      evidenceRefId: 'data:runtime_trace_fact:jank_frame_count:current:def',
      sourceToolCallId: 'runtime-trace-fact:jank_frame_count:def',
      title: 'Runtime FrameTimeline janky frame count pre-evidence',
      columns: [
        'package_name',
        'total_frames',
        'jank_frames',
        'jank_rate_pct',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        347,
        21,
        6.05,
        'actual_frame_timeline_slice',
      ]],
    });

    const identityAnswer = answer({
      id: 'quick-process-identity',
      statement: '当前 trace 的包名、推荐进程参数和首选进程均为 com.example.app；UPID=42，status=confirmed，confidence=100。',
      claimKind: 'categorical',
      evidenceText: 'Runtime process identity pre-evidence: canonical_package_name=com.example.app, process_name=com.example.app',
      references: [
        {
          evidenceRefId: identityEnvelope.meta.evidenceRefId,
          sourceToolCallId: identityEnvelope.meta.sourceToolCallId,
          sourceRef: identityEnvelope.display.title,
          rowIndex: 0,
          column: 'canonical_package_name',
          value: 'com.example.app',
        },
        {
          evidenceRefId: identityEnvelope.meta.evidenceRefId,
          sourceToolCallId: identityEnvelope.meta.sourceToolCallId,
          sourceRef: identityEnvelope.display.title,
          rowIndex: 0,
          column: 'process_name',
          value: 'com.example.app',
        },
      ],
    });
    const traceFactAnswer = answer({
      id: 'quick-trace-fact-jank_frame_count',
      statement: '焦点应用 com.example.app 的 FrameTimeline 中共有 347 帧，其中 21 帧标记为掉帧/卡顿（6.05%）。',
      claimKind: 'numeric',
      evidenceText: 'Runtime FrameTimeline janky frame count pre-evidence: package_name=com.example.app, total_frames=347, jank_frames=21, jank_rate_pct=6.05',
      references: [
        {
          evidenceRefId: traceFactEnvelope.meta.evidenceRefId,
          sourceToolCallId: traceFactEnvelope.meta.sourceToolCallId,
          sourceRef: traceFactEnvelope.display.title,
          rowIndex: 0,
          column: 'jank_frames',
          value: 21,
        },
        {
          evidenceRefId: traceFactEnvelope.meta.evidenceRefId,
          sourceToolCallId: traceFactEnvelope.meta.sourceToolCallId,
          sourceRef: traceFactEnvelope.display.title,
          rowIndex: 0,
          column: 'jank_rate_pct',
          value: 6.05,
        },
      ],
    });

    const combined = combineRuntimeQuickEvidenceDirectAnswers({
      processIdentityAnswer: identityAnswer,
      traceFactAnswer,
      outputLanguage: 'zh-CN',
    });

    expect(combined?.conclusion).toContain('com.example.app');
    expect(combined?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(combined?.conclusionContract.conclusions).toHaveLength(2);
    expect(combined?.conclusionContract.claims).toHaveLength(2);
    expect(countRuntimeQuickEvidenceCitedRefs(combined!)).toBe(2);

    const verified = runClaimVerification({
      conclusionContract: combined?.conclusionContract,
      dataEnvelopes: [identityEnvelope, traceFactEnvelope],
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 2,
      unsupportedClaimCount: 0,
    }));
  });
});
