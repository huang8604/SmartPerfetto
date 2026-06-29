// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { runClaimVerification } from '../claimVerificationRunner';
import { createDataEnvelope } from '../../../types/dataContract';
import type { ConclusionContract } from '../../../agent/core/conclusionContract';
import type { IdentityResolutionV1 } from '../../../types/identityContract';

function contract(value: number): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [{
      id: 'claim-main-thread-blocked',
      kind: 'numeric',
      text: '主线程 blocked_ms 为 120',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'blocked_ms',
        value,
      }],
    }],
    uncertainties: [],
    nextSteps: [],
    metadata: {},
  };
}

function contractWithoutKind(value: number): ConclusionContract {
  const base = contract(value);
  delete base.claims![0].kind;
  return base;
}

describe('runClaimVerification', () => {
  it('builds claim support and passes deterministic verifier for matching cells', () => {
    const identityResolution: IdentityResolutionV1 = {
      version: 'identity_contract@1',
      identityRefId: 'identity:test',
      target: { traceId: 'trace-a', traceSide: 'current', processName: 'com.example', source: 'skill_param' },
      status: 'verified',
      processes: [],
      threads: [],
      warnings: [],
    };
    const envelope = createDataEnvelope({
      columns: ['blocked_ms', 'upid', 'utid', 'process_name', 'thread_name'],
      rows: [[120, 1, 2, 'com.example', 'main']],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: identityResolution.identityRefId,
      identityStatus: identityResolution.status,
      identityResolution,
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport).toHaveLength(1);
    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimSupport[0].anchors[0].identity?.identityRefId).toBe('identity:test');
    expect(result.claimVerificationResult.status).toBe('passed');
    expect(result.identityResolutions).toHaveLength(1);
  });

  it('treats small floating point drift as a verified numeric reference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120.0000000001]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('fails deterministic verifier when a cited cell value does not match the claim reference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimSupport[0].supportLevel).toBe('unsupported');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
      severity: 'error',
    }));
  });

  it('checks references even when claim kind is omitted', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contractWithoutKind(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].kind).toBe('numeric');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('checks references even when the model labels a cited claim as inference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].kind = 'inference';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].kind).toBe('numeric');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('fails when the cited column exists but has no actual value', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].cells?.[0]).toEqual(expect.objectContaining({
      value: 120,
    }));
    expect(result.claimSupport[0].anchors[0].cells?.[0]).not.toHaveProperty('actualValue');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('marks out-of-range rows as missing instead of matching the claimed value', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references[0].rowIndex = 9;

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_missing',
    }));
  });

  it('marks missing columns as missing instead of matching the claimed value', () => {
    const envelope = createDataEnvelope({
      columns: ['other_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
      missingReason: expect.stringContaining('column'),
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
  });

  it('fails when explicit evidence identifiers do not resolve to the same envelope', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:actual',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references[0].sourceToolCallId = 'invoke_skill:wrong';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
      missingReason: expect.stringContaining('identifiers'),
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
  });

  it('anchors artifact-only claims without treating row existence as value verification', () => {
    const envelope = createDataEnvelope({
      columns: ['artifact_metric'],
      rows: [[1]],
    }, {
      type: 'skill_result',
      source: 'artifact_backed_rows',
      title: 'Artifact backed rows',
      layer: 'overview',
      format: 'table',
      artifactId: 'art-1',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-artifact-only',
      text: 'artifact row is available',
      references: [],
      artifactRefs: [{ artifactId: 'art-1', rowIndex: 0 }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].evidenceRefId).toBe('art-1');
    expect(result.claimSupport[0].anchors[0].missing).toBeUndefined();
    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-1');
    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('not_checked');
    expect(result.claimVerificationResult.claimResults[0]).toEqual(expect.objectContaining({
      status: 'not_checked',
    }));
  });

  it('does not verify column-only references that omit expected values', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[90]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    delete c.claims![0].references[0].value;

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('not_checked');
    expect(result.claimVerificationResult.claimResults[0].referenceResults?.[0]).toEqual(expect.objectContaining({
      status: 'not_checked',
    }));
  });

  it('resolves source_ref-only claims using table ordinals', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references = [{
      sourceRef: '表 1',
      rowIndex: 0,
      column: 'blocked_ms',
      value: 120,
    }];

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].missing).toBeUndefined();
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('treats artifact ids in evidence_ref_id as aliases and accepts display-title source refs', () => {
    const envelope = createDataEnvelope({
      columns: ['type_display', 'ttid_ms'],
      rows: [['冷启动', 1912.202655]],
    }, {
      type: 'skill_result',
      source: 'startup_events_in_range',
      title: '检测到的启动事件',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:startup_events_in_range',
      artifactId: 'art-2',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-startup-type',
      kind: 'categorical',
      text: '启动类型为冷启动',
      references: [{
        evidenceRefId: 'data:art-2',
        sourceRef: '检测到的启动事件',
        rowIndex: 0,
        column: 'type_display',
        value: '冷启动',
      }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].evidenceRefId).toBe('data:skill:startup_events_in_range');
    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-2');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('treats ev_art ids as artifact aliases from narrative claim refs', () => {
    const envelope = createDataEnvelope({
      columns: ['jank_type', 'count'],
      rows: [['App Deadline Missed', 6]],
    }, {
      type: 'skill_result',
      source: 'jank_type_stats',
      title: '掉帧类型分布',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:scrolling_analysis:jank_type_stats',
      artifactId: 'art-6',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-jank-type',
      kind: 'numeric',
      text: 'App Deadline Missed 有 6 帧',
      references: [{
        evidenceRefId: 'ev_art-6',
        sourceRef: '掉帧类型分布',
        rowIndex: 0,
        column: 'count',
        value: 6,
      }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-6');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('does not fully verify matched cells when trace provenance is missing', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'evidence_trace_unknown',
        severity: 'warning',
      }),
    ]));
  });

  it('requires verified identity sidecars for identity claims', () => {
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-identity',
      kind: 'identity',
      text: '目标进程是 com.example',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'process_name',
        value: 'com.example',
      }],
    };
    const envelope = createDataEnvelope({
      columns: ['process_name'],
      rows: [['com.example']],
    }, {
      type: 'skill_result',
      source: 'process_identity_probe',
      title: 'Process identity',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'identity_not_verified',
        severity: 'warning',
      }),
    ]));
  });

  it('downgrades ambiguous identity sidecars for identity claims', () => {
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-identity',
      kind: 'identity',
      text: '目标进程是 com.example',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'process_name',
        value: 'com.example',
      }],
    };
    const envelope = createDataEnvelope({
      columns: ['process_name'],
      rows: [['com.example']],
    }, {
      type: 'skill_result',
      source: 'process_identity_probe',
      title: 'Process identity',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: 'identity:ambiguous',
      identityStatus: 'ambiguous',
    });

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'identity_not_verified' }),
    ]));
  });

  it('ignores model-produced supportLevel when deterministic evidence disagrees', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].supportLevel = 'unsupported';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimVerificationResult.status).toBe('passed');
  });
});
