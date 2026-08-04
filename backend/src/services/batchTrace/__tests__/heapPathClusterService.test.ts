// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { HeapPathClusterInputRow } from '../../../types/heapPathCluster';
import { clusterHeapPaths, normalizeHeapPath } from '../heapPathClusterService';

function row(overrides: Partial<HeapPathClusterInputRow> = {}): HeapPathClusterInputRow {
  return {
    traceOrdinal: 0,
    traceId: 'trace-a',
    upid: 1,
    sampleTs: '10',
    processName: 'app',
    path: '[ROOT_JNI_GLOBAL] Root [1] -> LeakedActivity [2]',
    className: 'LeakedActivity',
    rootType: 'ROOT_JNI_GLOBAL',
    selfSizeBytes: 128,
    retainedSizeBytes: 4096,
    evidenceRefId: 'evidence-a',
    ...overrides,
  };
}

const clusteredRows: HeapPathClusterInputRow[] = [
  row(),
  row({traceOrdinal: 1, traceId: 'trace-b', sampleTs: '20', retainedSizeBytes: 4200, evidenceRefId: 'evidence-b'}),
  row({
    traceOrdinal: 2,
    traceId: 'trace-c',
    upid: 2,
    sampleTs: '30',
    path: '[ROOT_JAVA_FRAME] Thread [1] -> BitmapCache [5]',
    className: 'BitmapCache',
    rootType: 'ROOT_JAVA_FRAME',
    selfSizeBytes: 512,
    retainedSizeBytes: 9000,
    evidenceRefId: 'evidence-c',
  }),
  row({
    traceOrdinal: 3,
    traceId: 'trace-d',
    upid: 2,
    sampleTs: '40',
    path: '[ROOT_JAVA_FRAME] Thread [2] -> BitmapCache [8]',
    className: 'BitmapCache',
    rootType: 'ROOT_JAVA_FRAME',
    selfSizeBytes: 600,
    retainedSizeBytes: 9200,
    evidenceRefId: 'evidence-d',
  }),
];

describe('heap path normalization and clustering', () => {
  it('removes only dynamic counts and root annotations', () => {
    expect(normalizeHeapPath(clusteredRows[0].path)).toBe('Root -> LeakedActivity');
    expect(normalizeHeapPath('[native] Buffer [4] -> byte[] [10]')).toBe('[native] Buffer -> byte[]');
  });

  it('is independent of input ordering and separates stable signatures', () => {
    const forward = clusterHeapPaths(clusteredRows);
    const reversed = clusterHeapPaths([...clusteredRows].reverse());

    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({status: 'completed', selectedK: 2});
    expect(forward.clusters).toHaveLength(2);
    expect(forward.clusters.flatMap(cluster => cluster.evidenceRefIds).sort()).toEqual([
      'evidence-a', 'evidence-b', 'evidence-c', 'evidence-d',
    ]);
  });

  it('does not manufacture clusters for fewer than three dump samples', () => {
    expect(clusterHeapPaths([clusteredRows[0]])).toMatchObject({
      status: 'insufficient_samples',
      selectedK: null,
      clusters: [],
    });
    expect(clusterHeapPaths(clusteredRows.slice(0, 2))).toMatchObject({
      status: 'insufficient_samples',
      selectedK: null,
      clusters: [],
    });
  });

  it('returns one explicit signature group for degenerate vectors', () => {
    const result = clusterHeapPaths([
      clusteredRows[0],
      row({traceOrdinal: 1, traceId: 'trace-b', sampleTs: '20', evidenceRefId: 'evidence-b'}),
      row({traceOrdinal: 2, traceId: 'trace-c', sampleTs: '30', evidenceRefId: 'evidence-c'}),
    ]);

    expect(result).toMatchObject({status: 'completed', selectedK: 1, silhouetteScore: null});
    expect(result.clusters).toHaveLength(1);
    expect(result.limitations).toContain('degenerate_vectors');
  });

  it('collapses near-equal parent-child attribution inside a cluster', () => {
    const result = clusterHeapPaths([
      row({path: '[ROOT] Root [1] -> Captions [1]', className: 'Captions', retainedSizeBytes: 1000}),
      row({path: '[ROOT] Root [1] -> Captions [1] -> SubtitleWindow [1]', className: 'SubtitleWindow', retainedSizeBytes: 980, evidenceRefId: 'evidence-a-child'}),
      row({traceOrdinal: 1, traceId: 'trace-b', sampleTs: '20', path: '[ROOT] Root [1] -> Captions [2]', className: 'Captions', retainedSizeBytes: 1010, evidenceRefId: 'evidence-b'}),
      row({traceOrdinal: 2, traceId: 'trace-c', sampleTs: '30', path: '[ROOT_JNI_GLOBAL] Root [1] -> BitmapCache [1]', className: 'BitmapCache', retainedSizeBytes: 9000, evidenceRefId: 'evidence-c'}),
      row({traceOrdinal: 3, traceId: 'trace-d', sampleTs: '40', path: '[ROOT_JNI_GLOBAL] Root [1] -> BitmapCache [2]', className: 'BitmapCache', retainedSizeBytes: 9100, evidenceRefId: 'evidence-d'}),
    ]);

    expect(result.selectedK).toBe(2);
    expect(result.clusters.flatMap(cluster => cluster.collapsedPaths)).toContain('Root -> Captions -> SubtitleWindow');
  });

  it('rejects invalid sizes and reports deterministic row bounding as partial', () => {
    const invalid = row({traceId: 'invalid', traceOrdinal: 9, retainedSizeBytes: -1, evidenceRefId: 'invalid'});
    const rejected = clusterHeapPaths([...clusteredRows, invalid]);
    const bounded = clusterHeapPaths(clusteredRows, [], {maxRows: 3});

    expect(rejected.status).toBe('partial');
    expect(rejected.input.rejectedRowCount).toBe(1);
    expect(rejected.clusters.flatMap(cluster => cluster.evidenceRefIds)).not.toContain('invalid');
    expect(bounded.status).toBe('insufficient_samples');
    expect(bounded.input.rowCount).toBe(3);
    expect(bounded.limitations).toContain('row_limit_applied:3/4');
  });

  it('rejects oversized paths before feature expansion and reports the resource limit', () => {
    const oversizedPath = `Root -> ${'VeryLongSegment -> '.repeat(100_000)}Leaf`;
    const result = clusterHeapPaths([
      ...clusteredRows,
      row({
        traceId: 'oversized',
        traceOrdinal: 99,
        path: oversizedPath,
        evidenceRefId: 'oversized-evidence',
      }),
    ]);

    expect(normalizeHeapPath(oversizedPath)).toBe('');
    expect(result.status).toBe('partial');
    expect(result.input.rejectedRowCount).toBe(1);
    expect(result.limitations).toContain('oversized_rows:1');
    expect(result.clusters.flatMap(cluster => cluster.evidenceRefIds))
      .not.toContain('oversized-evidence');
  });

  it('bounds rows when even a one-feature vocabulary would exceed the matrix limit', () => {
    const bounded = clusterHeapPaths(clusteredRows, [], {maxMatrixCells: 2});

    expect(bounded.input.rowCount).toBe(2);
    expect(bounded.limitations).toContain('row_limit_applied:2/4');
  });

  it('returns unavailable for invalid-only input and rejects invalid options', () => {
    expect(clusterHeapPaths([row({retainedSizeBytes: Number.NaN})])).toMatchObject({
      status: 'unavailable',
      selectedK: null,
      input: {rowCount: 0, rejectedRowCount: 1},
    });
    expect(() => clusterHeapPaths(clusteredRows, [], {maxK: 0}))
      .toThrow('invalid_heap_path_cluster_option:maxK');
  });

  it('keeps per-trace failures explicit', () => {
    const result = clusterHeapPaths(clusteredRows, [{traceOrdinal: 8, traceId: 'trace-failed', reason: 'query failed'}]);

    expect(result.status).toBe('partial');
    expect(result.failures).toEqual([{traceOrdinal: 8, traceId: 'trace-failed', reason: 'query failed'}]);
  });
});
