// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import type { AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { CaseCandidateCaptureInput } from '../../../types/caseEvolution';
import type { ClaimVerificationResult } from '../../../types/claimVerification';
import type { DataEnvelope } from '../../../types/dataContract';
import { openCaseCandidateOutbox } from '../caseCandidateOutbox';
import { saveCaseCandidates } from '../saveCaseCandidates';

function rootCauseEnvelope(): DataEnvelope {
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
      rows: [['shader_compile', 'APP', 4, 18, 'f1', 58.8, 3, '["makePipeline"]']],
    },
  };
}

function verification(): ClaimVerificationResult {
  return {
    schemaVersion: 'claim_verifier@1',
    status: 'passed',
    policy: 'warn_only',
    passed: true,
    checkedClaimCount: 1,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
  };
}

function result(): AnalysisResult {
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
  };
}

function input(overrides: Partial<CaseCandidateCaptureInput> = {}): CaseCandidateCaptureInput {
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

describe('saveCaseCandidates', () => {
  it('is a no-op and does not open the outbox when capture is disabled', async () => {
    const outboxFactory = jest.fn();
    await expect(saveCaseCandidates(input(), {
      config: {captureEnabled: false} as any,
      openOutbox: outboxFactory as any,
    })).resolves.toEqual({captured: 0, skipped: 'disabled'});
    expect(outboxFactory).not.toHaveBeenCalled();
  });

  it('fails closed for traces without a content hash', async () => {
    const outboxFactory = jest.fn();
    await expect(saveCaseCandidates(input({
      provenance: {...input().provenance, traceContentHash: null},
    }), {
      config: {captureEnabled: true} as any,
      openOutbox: outboxFactory as any,
    })).resolves.toEqual({captured: 0, skipped: 'no_trace_hash'});
    expect(outboxFactory).not.toHaveBeenCalled();
  });

  it('enqueues qualifying candidates and treats duplicates as non-fatal skips', async () => {
    const outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
    try {
      const first = await saveCaseCandidates(input(), {
        config: {captureEnabled: true} as any,
        outbox,
      });
      const second = await saveCaseCandidates(input(), {
        config: {captureEnabled: true} as any,
        outbox,
      });
      expect(first).toMatchObject({captured: 1});
      expect(second).toMatchObject({captured: 0, skipped: 'duplicate'});
    } finally {
      outbox.close();
    }
  });

  it('logs and swallows outbox errors', async () => {
    const warn = jest.fn();
    const result = await saveCaseCandidates(input(), {
      config: {captureEnabled: true} as any,
      outbox: {
        enqueue: () => {
          throw new Error('db unavailable');
        },
      } as any,
      logger: {warn: warn as any, info: jest.fn() as any},
    });
    expect(result).toEqual({captured: 0, skipped: 'error'});
    expect(warn).toHaveBeenCalled();
  });

  // MAJOR-1 regression: the candidate payload must be anonymized BEFORE it
  // is persisted to the outbox DB, so raw PII (package names, app data paths)
  // never lands at rest. We enqueue a candidate whose trace features would
  // otherwise carry a raw package name, then read the stored row back and
  // assert the package was bucketed.
  it('anonymizes the candidate payload before persisting to the outbox', async () => {
    const outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
    try {
      // Inject a raw package name into the root-cause envelope's render
      // slices JSON so the projected candidate carries it. The anonymizer
      // should bucket com.example.app before the row is written.
      const envelopeWithPii: DataEnvelope = {
        ...rootCauseEnvelope(),
        data: {
          columns: rootCauseEnvelope().data.columns,
          rows: [['shader_compile', 'APP', 4, 18, 'f1', 58.8, 3, '["com.example.app:makePipeline"]']],
        },
      };
      const res = await saveCaseCandidates(input({dataEnvelopes: [envelopeWithPii]}), {
        config: {captureEnabled: true} as any,
        outbox,
      });
      expect(res.captured).toBe(1);
      const pending = outbox.listCandidates({states: ['pending_review']});
      expect(pending.length).toBe(1);
      const storedJson = JSON.stringify(pending[0]);
      // Raw package name must NOT appear at rest; the bucketed form should.
      expect(storedJson).not.toContain('com.example.app');
    } finally {
      outbox.close();
    }
  });

  // MAJOR-2 regression: queueMax must be enforced on the production capture
  // path. With queueMax=1 and one pending row already present, a second
  // enqueue must report queue_full rather than growing the queue unbounded.
  it('honors config.queueMax and rejects overflow enqueues as queue_full', async () => {
    const outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
    try {
      const first = await saveCaseCandidates(input(), {
        config: {captureEnabled: true, queueMax: 1} as any,
        outbox,
      });
      expect(first.captured).toBe(1);
      // A distinct trace hash → distinct dedupe key (so this is a genuine
      // overflow, not a duplicate) → the queue (cap 1) is full → queue_full.
      const secondInput = input({
        provenance: {...input().provenance, runId: 'run-2', traceContentHash: 'trace-hash-2'},
      });
      const second = await saveCaseCandidates(secondInput, {
        config: {captureEnabled: true, queueMax: 1} as any,
        outbox,
      });
      expect(second).toMatchObject({captured: 0, skipped: 'queue_full'});
    } finally {
      outbox.close();
    }
  });
});
