// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { aggregateBatchTraceResults } from '../batchTraceAggregator';
import {
  resolveBatchTraceApiExecutionLimits,
  resolveBatchTraceConcurrency,
  resolveBatchTraceLimits,
} from '../batchTraceLimits';
import type { BatchTraceResultV1 } from '../batchTraceTypes';

function result(ordinal: number, value: number | undefined, status: BatchTraceResultV1['status'] = 'completed'): BatchTraceResultV1 {
  return {
    ordinal,
    input: { ordinal, source: 'local_path', tracePath: `/tmp/${ordinal}.pftrace` },
    status,
    metrics: value === undefined ? [] : [{
      key: 'startup.total_ms',
      label: 'Startup total duration',
      value,
      numericValue: value,
      unit: 'ms',
      source: { skillId: 'startup_analysis', stepId: 'overview' },
      promotableMetricKey: 'startup.total_ms',
    }],
    evidenceEnvelopeIds: [],
    diagnostics: [],
    executionTimeMs: 10,
    ...(status !== 'completed' ? { error: 'failed trace' } : {}),
  };
}

describe('batch trace aggregation', () => {
  it('computes deterministic nearest-rank percentiles and outliers', () => {
    const aggregate = aggregateBatchTraceResults([
      result(0, 10),
      result(1, 11),
      result(2, 12),
      result(3, 13),
      result(4, 100),
    ]);

    expect(aggregate.metrics).toHaveLength(1);
    expect(aggregate.metrics[0]).toMatchObject({
      key: 'startup.total_ms',
      count: 5,
      missingCount: 0,
      min: 10,
      p50: 12,
      p90: 100,
      p95: 100,
      max: 100,
      outlierOrdinals: [4],
    });
  });

  it('keeps failed and missing traces visible in limitations', () => {
    const aggregate = aggregateBatchTraceResults([
      result(0, 10),
      result(1, undefined),
      result(2, undefined, 'failed'),
    ]);

    expect(aggregate.metrics[0].missingCount).toBe(2);
    expect(aggregate.limitations.join('\n')).toContain('trace ordinal 2 failed');
    expect(aggregate.limitations.join('\n')).toContain('metric startup.total_ms missing for trace ordinals: 1, 2');
  });
});

describe('batch trace limits', () => {
  it('resolves defaults and clamps by surface', () => {
    const limits = resolveBatchTraceLimits({});

    expect(limits).toMatchObject({
      maxTraceCount: 100,
      defaultConcurrency: 2,
      maxCliConcurrency: 4,
      maxApiConcurrency: 2,
    });
    expect(resolveBatchTraceConcurrency({ surface: 'cli', requested: 10, limits })).toBe(4);
    expect(resolveBatchTraceConcurrency({ surface: 'api', requested: 10, limits })).toBe(2);
    expect(resolveBatchTraceApiExecutionLimits({})).toMatchObject({
      maxSyncTraceCount: 20,
      maxInFlightRuns: 2,
    });
  });

  it('rejects invalid env overrides', () => {
    expect(() => resolveBatchTraceLimits({ SMARTPERFETTO_BATCH_TRACE_MAX_TRACES: '0' }))
      .toThrow('invalid_batch_trace_limit');
    expect(() => resolveBatchTraceLimits({ SMARTPERFETTO_BATCH_TRACE_DEFAULT_CONCURRENCY: 'abc' }))
      .toThrow('invalid_batch_trace_concurrency');
    expect(() => resolveBatchTraceApiExecutionLimits({
      SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES: '0',
    })).toThrow('invalid_batch_trace_limit');
  });
});
