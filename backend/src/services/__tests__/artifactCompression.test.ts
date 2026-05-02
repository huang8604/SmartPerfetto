// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {compressArtifact} from '../artifactCompression';
import type {ArtifactColumnSpec} from '../../types/sparkContracts';

const COLUMNS: ArtifactColumnSpec[] = [
  {name: 'frame_id', type: 'number'},
  {name: 'ts', type: 'timestamp', unit: 'ns'},
  {name: 'dur_ns', type: 'duration', unit: 'ns'},
];

function makeRow(frameId: number, ts: number, dur: number): any[] {
  return [frameId, ts, dur];
}

const ROWS = Array.from({length: 200}, (_, i) =>
  makeRow(i + 1, i * 16_667_000, (i % 50) * 100_000),
);

describe('compressArtifact', () => {
  it('top_k keeps highest dur rows and records the topK in compression info', () => {
    const result = compressArtifact({
      artifactId: 'art-1',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'top_k',
      rankBy: 'dur_ns',
      topK: 10,
    });
    expect(result.compressedRows).toHaveLength(10);
    expect(result.contract.compression.strategy).toBe('top_k');
    expect(result.contract.compression.topK).toBe(10);
    // Top row should have a higher dur than later rows.
    const top = result.compressedRows[0][2];
    const tail = result.compressedRows[9][2];
    expect(Number(top)).toBeGreaterThanOrEqual(Number(tail));
    // Schema-aware sampling note should be attached to the rankBy column.
    const dur = result.contract.columns.find(c => c.name === 'dur_ns');
    expect(dur?.samplingNote).toMatch(/top-10/);
  });

  it('p95_tail keeps only rows above the 95th percentile threshold', () => {
    const result = compressArtifact({
      artifactId: 'art-2',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'p95_tail',
      rankBy: 'dur_ns',
    });
    // 200 rows, p95 keeps roughly 5%
    expect(result.compressedRows.length).toBeLessThan(ROWS.length);
    expect(result.compressedRows.length).toBeGreaterThan(0);
    expect(result.contract.compression.strategy).toBe('p95_tail');
  });

  it('cuj_window keeps only rows whose timestamp lies inside the window', () => {
    const window = {startNs: 0, endNs: 10 * 16_667_000};
    const result = compressArtifact({
      artifactId: 'art-3',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'cuj_window',
      window,
      timestampColumn: 'ts',
    });
    expect(result.compressedRows.length).toBe(10);
    expect(result.contract.compression.window).toEqual(window);
    expect(result.contract.range).toEqual(window);
  });

  it('random sample is reproducible with the same seed', () => {
    const a = compressArtifact({
      artifactId: 'art-4',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'random',
      topK: 25,
      randomSeed: 7,
    });
    const b = compressArtifact({
      artifactId: 'art-4',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'random',
      topK: 25,
      randomSeed: 7,
    });
    expect(a.compressedRows.length).toBe(25);
    expect(a.compressedRows.map(r => r[0])).toEqual(b.compressedRows.map(r => r[0]));
    expect(a.contract.compression.randomSeed).toBe(7);
  });

  it('cluster_representative keeps one representative per cluster', () => {
    const result = compressArtifact({
      artifactId: 'art-5',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'cluster_representative',
      rankBy: 'dur_ns',
      clusterCount: 5,
    });
    expect(result.compressedRows).toHaveLength(5);
    expect(result.contract.clusterRepresentatives).toHaveLength(5);
  });

  it('cluster_representative samples the high tail when N is not divisible by K (Codex round 6 regression)', () => {
    // 10 rows with 6 clusters — old floor(N/K) = 1 ignored rows 6..9
    // because the bucketing only ran while start < clusterCount * 1 = 6.
    // The high-tail bias would silently lose the largest dur values.
    const tinyRows = Array.from({length: 10}, (_, i) => makeRow(i + 1, i, i * 100));
    const result = compressArtifact({
      artifactId: 'art-tail',
      columns: COLUMNS,
      rows: tinyRows,
      strategy: 'cluster_representative',
      rankBy: 'dur_ns',
      clusterCount: 6,
    });
    // Largest dur_ns value is in row 9 (dur 900). After float-boundary
    // bucketing, the last bucket should sample from the high end.
    const maxDurInResult = Math.max(...result.compressedRows.map(r => Number(r[2])));
    expect(maxDurInResult).toBeGreaterThanOrEqual(700);
  });

  it('falls back to full when rankBy is unknown', () => {
    const result = compressArtifact({
      artifactId: 'art-6',
      columns: COLUMNS,
      rows: ROWS,
      strategy: 'top_k',
      rankBy: 'nonexistent_column',
      topK: 10,
    });
    expect(result.compressedRows.length).toBe(ROWS.length);
    expect(result.contract.compression.strategy).toBe('full');
  });
});
