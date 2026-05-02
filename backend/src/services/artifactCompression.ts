// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Artifact Compression (Spark Plan 04)
 *
 * Takes a row-shaped artifact (columns + rows) and produces a compressed
 * view plus the schema-aware sidecar metadata required by
 * `ArtifactSchemaContract`. The full data still lives in the
 * `ArtifactStore`; this module only builds the compact summary that
 * downstream prompts and reporters consume.
 *
 * Strategies (Spark #24, #25, #26):
 *  - full        – no row drop (control case)
 *  - top_k       – keep top-K rows by `rankBy`
 *  - p95_tail    – keep rows whose `rankBy` value sits in the >=p95 tail
 *  - p99_tail    – same, p99
 *  - random      – seeded random sample of size `topK` (reproducible)
 *  - cuj_window  – keep rows whose timestamp falls inside `window`
 *  - cluster_representative – pick the densest representative per cluster
 *
 * Schema-aware columns (Spark #28) carry the type/unit/source/sampling
 * note so AI consumers know exactly what was preserved.
 */

import {
  makeSparkProvenance,
  type ArtifactColumnSpec,
  type ArtifactCompressionInfo,
  type ArtifactSamplingStrategy,
  type ArtifactSchemaContract,
  type NsTimeRange,
} from '../types/sparkContracts';

export interface CompressionOptions {
  artifactId: string;
  columns: ArtifactColumnSpec[];
  rows: any[][];
  strategy: ArtifactSamplingStrategy;
  /** Column name to rank by for top_k/p95_tail/p99_tail. */
  rankBy?: string;
  /** Top-K limit for `top_k` and `random`. Defaults to 50. */
  topK?: number;
  /** ns window for `cuj_window`. */
  window?: NsTimeRange;
  /** Column to read timestamp from when applying `cuj_window`. */
  timestampColumn?: string;
  /** Reproducibility seed for `random` strategy. */
  randomSeed?: number;
  /** Cluster count for `cluster_representative` (defaults to topK). */
  clusterCount?: number;
}

export interface CompressionResult {
  compressedRows: any[][];
  contract: ArtifactSchemaContract;
}

function indexOfColumn(columns: ArtifactColumnSpec[], name: string): number {
  return columns.findIndex(c => c.name === name);
}

function clamp(n: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, n));
}

/** Mulberry32 PRNG — deterministic and good enough for sampling. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickQuantileTail(
  rows: any[][],
  rankIndex: number,
  quantile: number,
): {kept: any[][]; threshold: number} {
  const values = rows
    .map(r => Number(r[rankIndex]))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length === 0) return {kept: rows.slice(), threshold: 0};
  const idx = clamp(Math.floor(values.length * quantile), 0, values.length - 1);
  const threshold = values[idx];
  const kept = rows.filter(r => Number(r[rankIndex]) >= threshold);
  return {kept, threshold};
}

function clusterRepresentatives(
  rows: any[][],
  rankIndex: number,
  clusterCount: number,
): {kept: any[][]; representativeIndices: number[]} {
  if (rows.length === 0 || clusterCount <= 0) {
    return {kept: rows.slice(), representativeIndices: []};
  }
  // Simple equi-frequency clustering: split sorted indices into N buckets
  // and keep the median row of each bucket as the representative.
  const indexed = rows
    .map((row, idx) => ({row, idx, value: Number(row[rankIndex])}))
    .sort((a, b) => a.value - b.value);
  const bucketSize = Math.max(1, Math.floor(indexed.length / clusterCount));
  const kept: any[][] = [];
  const representativeIndices: number[] = [];
  for (let b = 0; b < clusterCount; b++) {
    const start = b * bucketSize;
    if (start >= indexed.length) break;
    const median = Math.min(indexed.length - 1, start + Math.floor(bucketSize / 2));
    kept.push(indexed[median].row);
    representativeIndices.push(indexed[median].idx);
  }
  return {kept, representativeIndices};
}

/**
 * Compress an artifact according to `strategy` and emit the schema-aware
 * sidecar contract. Always returns at least an empty compressed-rows array
 * + a contract, never throws on bad inputs (downstream will surface the
 * fallback via `compression.strategy = 'full'` when the strategy can't run).
 */
export function compressArtifact(opts: CompressionOptions): CompressionResult {
  const {artifactId, columns, rows} = opts;
  const originalRowCount = rows.length;
  const topK = opts.topK ?? 50;

  let compressedRows: any[][] = rows.slice();
  let strategy: ArtifactSamplingStrategy = opts.strategy;
  let representativeIndices: number[] | undefined;
  const samplingNotes = new Map<string, string>();

  switch (opts.strategy) {
    case 'full':
      compressedRows = rows.slice();
      break;
    case 'top_k': {
      const idx = opts.rankBy ? indexOfColumn(columns, opts.rankBy) : -1;
      if (idx < 0) {
        // Fallback to full when rankBy missing — schema records the fallback.
        strategy = 'full';
        break;
      }
      compressedRows = rows
        .slice()
        .sort((a, b) => Number(b[idx]) - Number(a[idx]))
        .slice(0, topK);
      samplingNotes.set(opts.rankBy!, `top-${topK} by ${opts.rankBy}`);
      break;
    }
    case 'p95_tail':
    case 'p99_tail': {
      const idx = opts.rankBy ? indexOfColumn(columns, opts.rankBy) : -1;
      if (idx < 0) {
        strategy = 'full';
        break;
      }
      const q = opts.strategy === 'p95_tail' ? 0.95 : 0.99;
      const {kept} = pickQuantileTail(rows, idx, q);
      compressedRows = kept;
      samplingNotes.set(opts.rankBy!, `${opts.strategy} on ${opts.rankBy}`);
      break;
    }
    case 'random': {
      const prng = makePrng(opts.randomSeed ?? 1);
      const indices = rows.map((_, i) => i);
      // Fisher-Yates partial shuffle to sample topK rows reproducibly.
      for (let i = 0; i < Math.min(topK, indices.length); i++) {
        const j = i + Math.floor(prng() * (indices.length - i));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      compressedRows = indices.slice(0, topK).map(i => rows[i]);
      break;
    }
    case 'cuj_window': {
      const tsCol = opts.timestampColumn ?? 'ts';
      const tsIdx = indexOfColumn(columns, tsCol);
      if (tsIdx < 0 || !opts.window) {
        strategy = 'full';
        break;
      }
      compressedRows = rows.filter(r => {
        const t = Number(r[tsIdx]);
        return t >= opts.window!.startNs && t < opts.window!.endNs;
      });
      samplingNotes.set(tsCol, `cuj_window [${opts.window.startNs}, ${opts.window.endNs})`);
      break;
    }
    case 'cluster_representative': {
      const idx = opts.rankBy ? indexOfColumn(columns, opts.rankBy) : -1;
      if (idx < 0) {
        strategy = 'full';
        break;
      }
      const clusterCount = opts.clusterCount ?? topK;
      const result = clusterRepresentatives(rows, idx, clusterCount);
      compressedRows = result.kept;
      representativeIndices = result.representativeIndices;
      samplingNotes.set(opts.rankBy!, `cluster representative on ${opts.rankBy}`);
      break;
    }
    default:
      strategy = 'full';
      compressedRows = rows.slice();
  }

  const compressedRowCount = compressedRows.length;
  const compression: ArtifactCompressionInfo = {
    strategy,
    originalRowCount,
    compressedRowCount,
    ratio: originalRowCount > 0 ? compressedRowCount / originalRowCount : 0,
    ...(opts.window ? {window: opts.window} : {}),
    ...(strategy === 'top_k' ? {topK} : {}),
    ...(strategy === 'random' ? {randomSeed: opts.randomSeed ?? 1} : {}),
  };

  const enrichedColumns: ArtifactColumnSpec[] = columns.map(c => ({
    ...c,
    ...(samplingNotes.has(c.name)
      ? {samplingNote: samplingNotes.get(c.name)}
      : {}),
  }));

  const contract: ArtifactSchemaContract = {
    ...makeSparkProvenance({source: 'artifact-compression'}),
    artifactId,
    columns: enrichedColumns,
    compression,
    ...(opts.window ? {range: opts.window} : {}),
    ...(opts.rankBy ? {rankBy: opts.rankBy} : {}),
    ...(representativeIndices ? {clusterRepresentatives: representativeIndices} : {}),
    coverage: [
      {sparkId: 24, planId: '04', status: strategy === 'cuj_window' ? 'implemented' : 'scaffolded'},
      {sparkId: 25, planId: '04', status: strategy === 'cluster_representative' ? 'implemented' : 'scaffolded'},
      {sparkId: 26, planId: '04', status: ['top_k', 'p95_tail', 'p99_tail', 'random'].includes(strategy) ? 'implemented' : 'scaffolded'},
      {sparkId: 28, planId: '04', status: 'implemented', note: 'Schema-aware columns + sampling notes preserved.'},
    ],
  };

  return {compressedRows, contract};
}
