// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {DataEnvelope} from '../../../types/dataContract';
import type {SkillBatchAnalysisConfig} from '../../skillEngine/types';
import {runBatchPostProcessor} from '../batchTracePostProcessor';

const requiredColumns = [
  'upid',
  'process_name',
  'graph_sample_ts',
  'path',
  'class_name',
  'root_type',
  'self_count',
  'retained_count',
  'self_size_bytes',
  'retained_size_bytes',
];

function config(overrides: Partial<SkillBatchAnalysisConfig> = {}): SkillBatchAnalysisConfig {
  return {
    operation: 'heap_path_cluster',
    source_step: 'dominator_paths',
    output_contract: 'HeapPathClusterAnalysisV1',
    per_trace_row_limit: 500,
    total_row_limit: 5000,
    required_columns: requiredColumns,
    ...overrides,
  };
}

function envelope(rows: unknown[], columns: string[] = requiredColumns): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'android_heap_dominator_path_extract:dominator_paths',
      timestamp: 1,
      skillId: 'android_heap_dominator_path_extract',
      stepId: 'dominator_paths',
    },
    data: {columns, rows} as DataEnvelope['data'],
    display: {layer: 'list', format: 'table', title: 'Dominator paths', level: 'detail'},
  };
}

function values(path: string, retainedSizeBytes: number, upid = 1, sampleTs = '10'): unknown[] {
  const segments = path.split(' -> ');
  return [
    upid,
    'app',
    sampleTs,
    path,
    segments[segments.length - 1]?.replace(/ \[\d+\]$/, '') ?? 'Unknown',
    'ROOT_JNI_GLOBAL',
    1,
    2,
    128,
    retainedSizeBytes,
  ];
}

describe('batch trace post-processor registry', () => {
  it('adapts array and object rows into a generic domain envelope with resolvable evidence', () => {
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config(),
      traces: [
        {
          ordinal: 0,
          traceIdentity: 'trace-a',
          traceId: 'loaded-a',
          status: 'completed',
          sourceEnvelope: envelope([
            values('[ROOT] Root [1] -> LeakedActivity [1]', 4000),
            values('[ROOT] Root [1] -> LeakedActivity [2]', 4200),
          ]),
        },
        {
          ordinal: 1,
          traceIdentity: 'trace-b',
          traceId: 'loaded-b',
          status: 'completed',
          sourceEnvelope: envelope([
            {
              upid: 2,
              process_name: 'app',
              graph_sample_ts: '20',
              path: '[ROOT_JAVA_FRAME] Thread [1] -> BitmapCache [1]',
              class_name: 'BitmapCache',
              root_type: 'ROOT_JAVA_FRAME',
              self_count: 1,
              retained_count: 3,
              self_size_bytes: 512,
              retained_size_bytes: 9000,
            },
            {
              upid: 2,
              process_name: 'app',
              graph_sample_ts: '30',
              path: '[ROOT_JAVA_FRAME] Thread [2] -> BitmapCache [2]',
              class_name: 'BitmapCache',
              root_type: 'ROOT_JAVA_FRAME',
              self_count: 2,
              retained_count: 4,
              self_size_bytes: 600,
              retained_size_bytes: 9200,
            },
          ]),
        },
      ],
    });

    expect(domain).toMatchObject({
      schemaVersion: 'batch_trace_domain_analysis@1',
      operation: 'heap_path_cluster',
      evidence: {schemaVersion: 'batch_trace_domain_evidence@1', rowCount: 4, truncatedRowCount: 0},
      result: {schemaVersion: 'heap_path_cluster_analysis@1', status: 'completed', selectedK: 2},
    });
    const artifactRefs = new Set(domain.evidence.rows.map(row => row.refId));
    expect(artifactRefs.size).toBe(4);
    expect(domain.result.clusters.flatMap(cluster => cluster.evidenceRefIds)
      .every(refId => artifactRefs.has(refId))).toBe(true);
  });

  it('applies per-trace and total bounds before clustering', () => {
    const rows = [
      values('[ROOT] Root [1] -> A [1]', 1),
      values('[ROOT] Root [1] -> B [1]', 2),
      values('[ROOT] Root [1] -> C [1]', 3),
    ];
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config({per_trace_row_limit: 2, total_row_limit: 3}),
      traces: [
        {ordinal: 0, traceIdentity: 'trace-a', status: 'completed', sourceEnvelope: envelope(rows)},
        {ordinal: 1, traceIdentity: 'trace-b', status: 'completed', sourceEnvelope: envelope(rows)},
      ],
    });

    expect(domain.evidence).toMatchObject({rowCount: 3, truncatedRowCount: 3});
    expect(domain.evidence.rows.filter(row => row.traceOrdinal === 0).length).toBeLessThanOrEqual(2);
    expect(domain.evidence.rows.filter(row => row.traceOrdinal === 1).length).toBeLessThanOrEqual(2);
  });

  it('turns a missing required column into an explicit per-trace failure', () => {
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config(),
      traces: [{
        ordinal: 0,
        traceIdentity: 'trace-a',
        status: 'completed',
        sourceEnvelope: envelope([], requiredColumns.filter(column => column !== 'path')),
      }],
    });

    expect(domain.result.status).toBe('unavailable');
    expect(domain.result.failures[0]?.reason).toContain('missing_required_columns:path');
  });

  it('does not silently discard malformed source rows', () => {
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config(),
      traces: [
        {
          ordinal: 0,
          traceIdentity: 'trace-a',
          status: 'completed',
          sourceEnvelope: envelope([
            values('[ROOT] Root [1] -> LeakedActivity [1]', 4000),
            null,
            values('[ROOT] Root [1] -> LeakedActivity [2]', 4200),
          ]),
        },
        {
          ordinal: 1,
          traceIdentity: 'trace-b',
          status: 'completed',
          sourceEnvelope: envelope([
            values('[ROOT] Root [1] -> BitmapCache [1]', 9000, 2, '20'),
            values('[ROOT] Root [1] -> BitmapCache [2]', 9200, 2, '30'),
          ]),
        },
        {
          ordinal: 2,
          traceIdentity: 'trace-c',
          status: 'completed',
          sourceEnvelope: envelope([
            values('[ROOT] Root [1] -> BitmapCache [3]', 9100, 3, '40'),
          ]),
        },
      ],
    });

    expect(domain.result.status).toBe('partial');
    expect(domain.result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({traceOrdinal: 0, reason: 'malformed_source_rows:1'}),
    ]));
  });

  it('includes completed zero-row traces but excludes failed traces from cluster support', () => {
    const sharedRows = [
      values('[ROOT] Root [1] -> SharedLeak [1]', 4000, 1, '10'),
      values('[ROOT] Root [1] -> SharedLeak [2]', 4200, 1, '20'),
      values('[ROOT] Root [1] -> SharedLeak [3]', 4100, 1, '30'),
    ];
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config(),
      traces: [
        {ordinal: 0, traceIdentity: 'trace-a', status: 'completed', sourceEnvelope: envelope(sharedRows)},
        {ordinal: 1, traceIdentity: 'trace-b', status: 'completed', sourceEnvelope: envelope(sharedRows)},
        {ordinal: 2, traceIdentity: 'trace-zero', status: 'completed', sourceEnvelope: envelope([])},
        {ordinal: 3, traceIdentity: 'trace-failed', status: 'failed', error: 'query failed'},
      ],
    });

    expect(domain.result.input.traceCount).toBe(3);
    expect(domain.result.clusters).toHaveLength(1);
    expect(domain.result.clusters[0]).toMatchObject({
      traceCount: 2,
      traceSupportPct: 66.667,
    });
    expect(domain.result.failures).toContainEqual({
      traceOrdinal: 3,
      traceId: 'trace-failed',
      reason: 'query failed',
    });
  });

  it('excludes completed traces with invalid source-step contracts from support', () => {
    const sharedRows = [
      values('[ROOT] Root [1] -> SharedLeak [1]', 4000, 1, '10'),
      values('[ROOT] Root [1] -> SharedLeak [2]', 4200, 1, '20'),
      values('[ROOT] Root [1] -> SharedLeak [3]', 4100, 1, '30'),
    ];
    const domain = runBatchPostProcessor({
      skillId: 'android_heap_dominator_path_extract',
      config: config(),
      traces: [
        {ordinal: 0, traceIdentity: 'trace-valid', status: 'completed', sourceEnvelope: envelope(sharedRows)},
        {ordinal: 1, traceIdentity: 'trace-missing-envelope', status: 'completed'},
        {
          ordinal: 2,
          traceIdentity: 'trace-missing-column',
          status: 'completed',
          sourceEnvelope: envelope([], requiredColumns.filter(column => column !== 'path')),
        },
      ],
    });

    expect(domain.result.input.traceCount).toBe(1);
    expect(domain.result.clusters[0]).toMatchObject({traceCount: 1, traceSupportPct: 100});
    expect(domain.result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({traceOrdinal: 1, reason: 'source_step_missing:dominator_paths'}),
      expect.objectContaining({traceOrdinal: 2, reason: 'missing_required_columns:path'}),
    ]));
  });

  it('rejects an operation that is absent from the typed registry', () => {
    expect(() => runBatchPostProcessor({
      skillId: 'skill',
      config: {...config(), operation: 'unknown'} as unknown as SkillBatchAnalysisConfig,
      traces: [],
    })).toThrow('unknown_batch_analysis_operation:unknown');
  });
});
