// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import {
  HEAP_PATH_CLUSTER_SCHEMA_VERSION,
  HEAP_PATH_NORMALIZATION_VERSION,
  type HeapPathClusterAnalysisV1,
  type HeapPathClusterFailure,
  type HeapPathClusterInputRow,
  type HeapPathClusterSummaryV1,
} from '../../types/heapPathCluster';

export interface HeapPathClusterOptions {
  maxRows?: number;
  maxVocabulary?: number;
  maxMatrixCells?: number;
  maxK?: number;
  maxIterations?: number;
  collapseTolerancePct?: number;
  /** Eligible trace denominator, including valid traces with zero heap rows. */
  traceUniverseSize?: number;
}

interface ResolvedOptions {
  maxRows: number;
  maxVocabulary: number;
  maxMatrixCells: number;
  maxK: number;
  maxIterations: number;
  collapseTolerancePct: number;
  traceUniverseSize?: number;
}

interface NormalizedRow extends HeapPathClusterInputRow {
  normalizedPath: string;
}

type SparseVector = Map<number, number>;

interface KMeansResult {
  labels: number[];
  centroids: SparseVector[];
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  maxRows: 5000,
  maxVocabulary: 10000,
  maxMatrixCells: 1_000_000,
  maxK: 12,
  maxIterations: 50,
  collapseTolerancePct: 5,
};
const ABSOLUTE_MAX_INPUT_ROWS = 20_000;
const ABSOLUTE_MAX_CLUSTER_ROWS = 10_000;
const ABSOLUTE_MAX_K = 16;
const ABSOLUTE_MAX_ITERATIONS = 100;
const K_SELECTION_SAMPLE_SIZE = 512;
const K_SELECTION_RESTARTS = 2;
const FINAL_CLUSTER_RESTARTS = 2;
const K_SELECTION_WORK_UNITS = 3_000_000;
const FINAL_CLUSTER_WORK_UNITS = 5_000_000;
const SILHOUETTE_EVALUATION_SAMPLES = 256;
const SILHOUETTE_CLUSTER_SAMPLES = 64;
const MAX_HEAP_PATH_CHARS = 4096;
const MAX_HEAP_PATH_SEGMENTS = 64;
const MAX_HEAP_PATH_SEGMENT_CHARS = 256;
const MAX_TRACE_ID_CHARS = 256;
const MAX_SAMPLE_TS_CHARS = 128;
const MAX_PROCESS_NAME_CHARS = 256;
const MAX_CLASS_NAME_CHARS = 256;
const MAX_ROOT_TYPE_CHARS = 128;
const MAX_EVIDENCE_REF_CHARS = 512;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resolvePositiveInteger(name: keyof HeapPathClusterOptions, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`invalid_heap_path_cluster_option:${name}`);
  }
  return resolved;
}

function resolveNonNegativeInteger(name: keyof HeapPathClusterOptions, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_heap_path_cluster_option:${name}`);
  }
  return value;
}

function resolveOptions(options: HeapPathClusterOptions): ResolvedOptions {
  const collapseTolerancePct = options.collapseTolerancePct ?? DEFAULT_OPTIONS.collapseTolerancePct;
  if (!Number.isFinite(collapseTolerancePct) || collapseTolerancePct < 0 || collapseTolerancePct > 100) {
    throw new Error('invalid_heap_path_cluster_option:collapseTolerancePct');
  }
  return {
    maxRows: Math.min(
      resolvePositiveInteger('maxRows', options.maxRows, DEFAULT_OPTIONS.maxRows),
      ABSOLUTE_MAX_CLUSTER_ROWS,
    ),
    maxVocabulary: resolvePositiveInteger('maxVocabulary', options.maxVocabulary, DEFAULT_OPTIONS.maxVocabulary),
    maxMatrixCells: resolvePositiveInteger('maxMatrixCells', options.maxMatrixCells, DEFAULT_OPTIONS.maxMatrixCells),
    maxK: Math.min(resolvePositiveInteger('maxK', options.maxK, DEFAULT_OPTIONS.maxK), ABSOLUTE_MAX_K),
    maxIterations: Math.min(
      resolvePositiveInteger('maxIterations', options.maxIterations, DEFAULT_OPTIONS.maxIterations),
      ABSOLUTE_MAX_ITERATIONS,
    ),
    collapseTolerancePct,
    ...(options.traceUniverseSize !== undefined
      ? {traceUniverseSize: resolveNonNegativeInteger('traceUniverseSize', options.traceUniverseSize)}
      : {}),
  };
}

export function normalizeHeapPath(path: string): string {
  if (typeof path !== 'string' || path.length > MAX_HEAP_PATH_CHARS) return '';
  const withoutRoot = path.trim().replace(/^\[ROOT(?:_[A-Z0-9_]+)?\]\s*/i, '');
  const segments = withoutRoot.split('->');
  if (
    segments.length > MAX_HEAP_PATH_SEGMENTS
    || segments.some(segment => segment.length > MAX_HEAP_PATH_SEGMENT_CHARS)
  ) return '';
  return segments
    .map(segment => segment.trim().replace(/\s+\[\d+\]$/u, '').trim())
    .filter(Boolean)
    .join(' -> ');
}

function hasOversizedRowField(row: HeapPathClusterInputRow): boolean {
  const boundedStrings: Array<[unknown, number]> = [
    [row.traceId, MAX_TRACE_ID_CHARS],
    [row.sampleTs, MAX_SAMPLE_TS_CHARS],
    [row.processName, MAX_PROCESS_NAME_CHARS],
    [row.className, MAX_CLASS_NAME_CHARS],
    [row.rootType, MAX_ROOT_TYPE_CHARS],
    [row.evidenceRefId, MAX_EVIDENCE_REF_CHARS],
  ];
  if (boundedStrings.some(([value, limit]) => typeof value === 'string' && value.length > limit)) {
    return true;
  }
  if (typeof row.path !== 'string') return false;
  if (row.path.length > MAX_HEAP_PATH_CHARS) return true;
  const segments = row.path.split('->');
  return segments.length > MAX_HEAP_PATH_SEGMENTS
    || segments.some(segment => segment.length > MAX_HEAP_PATH_SEGMENT_CHARS);
}

function isValidRow(row: HeapPathClusterInputRow): boolean {
  return !hasOversizedRowField(row)
    && Number.isSafeInteger(row.traceOrdinal)
    && row.traceOrdinal >= 0
    && typeof row.traceId === 'string'
    && row.traceId.length > 0
    && Number.isSafeInteger(row.upid)
    && row.upid >= 0
    && typeof row.sampleTs === 'string'
    && row.sampleTs.length > 0
    && typeof row.processName === 'string'
    && typeof row.path === 'string'
    && normalizeHeapPath(row.path).length > 0
    && typeof row.className === 'string'
    && typeof row.rootType === 'string'
    && Number.isFinite(row.selfSizeBytes)
    && row.selfSizeBytes >= 0
    && Number.isFinite(row.retainedSizeBytes)
    && row.retainedSizeBytes >= 0
    && typeof row.evidenceRefId === 'string'
    && row.evidenceRefId.length > 0;
}

function compareRows(a: NormalizedRow, b: NormalizedRow): number {
  return a.traceOrdinal - b.traceOrdinal
    || a.traceId.localeCompare(b.traceId)
    || a.upid - b.upid
    || a.sampleTs.localeCompare(b.sampleTs)
    || a.normalizedPath.localeCompare(b.normalizedPath)
    || a.className.localeCompare(b.className)
    || a.retainedSizeBytes - b.retainedSizeBytes
    || a.selfSizeBytes - b.selfSizeBytes
    || a.evidenceRefId.localeCompare(b.evidenceRefId);
}

function canonicalSeed(rows: NormalizedRow[]): string {
  const hash = crypto.createHash('sha256');
  hash.update('[');
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) hash.update(',');
    hash.update('[');
    const fields: Array<string | number> = [
      row.traceOrdinal,
      row.traceId,
      row.upid,
      row.sampleTs,
      row.processName,
      row.normalizedPath,
      row.className,
      row.rootType,
      row.selfSizeBytes,
      row.retainedSizeBytes,
      row.evidenceRefId,
    ];
    fields.forEach((field, fieldIndex) => {
      if (fieldIndex > 0) hash.update(',');
      hash.update(JSON.stringify(field));
    });
    hash.update(']');
  });
  hash.update(']');
  return hash.digest('hex');
}

function sampleKey(row: HeapPathClusterInputRow): string {
  return `${row.traceId}\0${row.upid}\0${row.sampleTs}`;
}

function pathFeatures(path: string): string[] {
  const segments = path.split(' -> ').filter(Boolean);
  const features = segments.map((segment, index) => `node:${index}:${segment}`);
  for (let index = 1; index < segments.length; index += 1) {
    features.push(`edge:${segments[index - 1]}->${segments[index]}`);
  }
  return features;
}

function buildVectors(
  rows: NormalizedRow[],
  options: ResolvedOptions,
  limitations: string[],
): SparseVector[] {
  const documents = rows.map(row => pathFeatures(row.normalizedPath));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const feature of new Set(document)) {
      documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
    }
  }

  const allFeatures = [...documentFrequency.keys()].sort((a, b) =>
    (documentFrequency.get(b) ?? 0) - (documentFrequency.get(a) ?? 0) || a.localeCompare(b));
  const cellBoundVocabulary = Math.max(1, Math.floor(options.maxMatrixCells / rows.length));
  const vocabularyLimit = Math.min(options.maxVocabulary, cellBoundVocabulary);
  const vocabulary = allFeatures.slice(0, vocabularyLimit);
  if (vocabulary.length < allFeatures.length) {
    limitations.push(`vocabulary_limit_applied:${vocabulary.length}/${allFeatures.length}`);
  }
  const vocabularyIndex = new Map(vocabulary.map((feature, index) => [feature, index]));

  return documents.map(document => {
    const counts = new Map<number, number>();
    for (const feature of document) {
      const index = vocabularyIndex.get(feature);
      if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const vector = new Map<number, number>();
    const selectedFeatureCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (selectedFeatureCount === 0) return vector;
    let squaredNorm = 0;
    for (const [index, count] of counts) {
      const feature = vocabulary[index];
      const inverseDocumentFrequency = Math.log((rows.length + 1) / ((documentFrequency.get(feature) ?? 0) + 1)) + 1;
      const value = (count / selectedFeatureCount) * inverseDocumentFrequency;
      vector.set(index, value);
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (norm > 0) {
      for (const [index, value] of vector) vector.set(index, value / norm);
    }
    return vector;
  });
}

function dot(a: SparseVector, b: SparseVector): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let result = 0;
  for (const [index, value] of smaller) result += value * (larger.get(index) ?? 0);
  return result;
}

function squaredNorm(vector: SparseVector): number {
  let result = 0;
  for (const value of vector.values()) result += value * value;
  return result;
}

function distance(a: SparseVector, b: SparseVector): number {
  return Math.sqrt(Math.max(0, squaredNorm(a) + squaredNorm(b) - 2 * dot(a, b)));
}

function meanVector(vectors: SparseVector[], indexes: number[]): SparseVector {
  const centroid = new Map<number, number>();
  for (const index of indexes) {
    for (const [feature, value] of vectors[index]) {
      centroid.set(feature, (centroid.get(feature) ?? 0) + value / indexes.length);
    }
  }
  return centroid;
}

function randomUnit(seedHash: string, counter: number): number {
  const hex = sha256(`${seedHash}:${counter}`).slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10000000000000;
}

function initializeCentroids(vectors: SparseVector[], k: number, seedHash: string): SparseVector[] {
  const chosen = new Set<number>();
  const first = Math.floor(randomUnit(seedHash, 0) * vectors.length);
  chosen.add(first);
  const centroids = [new Map(vectors[first])];
  let counter = 1;

  while (centroids.length < k) {
    const weights = vectors.map((vector, index) => chosen.has(index)
      ? 0
      : Math.min(...centroids.map(centroid => distance(vector, centroid) ** 2)));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let next = weights.findIndex(value => value > 0);
    if (total > 0) {
      const threshold = randomUnit(seedHash, counter) * total;
      let cumulative = 0;
      for (let index = 0; index < weights.length; index += 1) {
        cumulative += weights[index];
        if (cumulative >= threshold && weights[index] > 0) {
          next = index;
          break;
        }
      }
    }
    if (next < 0) next = vectors.findIndex((_, index) => !chosen.has(index));
    chosen.add(next);
    centroids.push(new Map(vectors[next]));
    counter += 1;
  }
  return centroids;
}

function assignLabels(vectors: SparseVector[], centroids: SparseVector[]): number[] {
  return vectors.map(vector => {
    let bestCluster = 0;
    let bestDistance = distance(vector, centroids[0]);
    for (let cluster = 1; cluster < centroids.length; cluster += 1) {
      const candidateDistance = distance(vector, centroids[cluster]);
      if (candidateDistance < bestDistance - 1e-12) {
        bestCluster = cluster;
        bestDistance = candidateDistance;
      }
    }
    return bestCluster;
  });
}

function runKMeans(vectors: SparseVector[], k: number, seedHash: string, maxIterations: number): KMeansResult {
  let centroids = initializeCentroids(vectors, k, seedHash);
  let labels = assignLabels(vectors, centroids);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const nextCentroids = centroids.map((centroid, cluster) => {
      const members = labels.map((label, index) => label === cluster ? index : -1).filter(index => index >= 0);
      return members.length > 0 ? meanVector(vectors, members) : centroid;
    });
    const nextLabels = assignLabels(vectors, nextCentroids);
    centroids = nextCentroids;
    if (nextLabels.every((label, index) => label === labels[index])) {
      labels = nextLabels;
      break;
    }
    labels = nextLabels;
  }
  return {labels, centroids};
}

function kMeansInertia(vectors: SparseVector[], result: KMeansResult): number {
  return vectors.reduce((sum, vector, index) => {
    const pointDistance = distance(vector, result.centroids[result.labels[index]]);
    return sum + pointDistance * pointDistance;
  }, 0);
}

function partitionKey(labels: number[]): string {
  const members = new Map<number, number[]>();
  labels.forEach((label, index) => {
    const indexes = members.get(label) ?? [];
    indexes.push(index);
    members.set(label, indexes);
  });
  return [...members.values()].map(indexes => indexes.join(',')).sort().join('|');
}

function runBestKMeans(
  vectors: SparseVector[],
  k: number,
  seedHash: string,
  maxIterations: number,
  restarts: number,
): KMeansResult {
  const candidates = Array.from({length: restarts}, (_, initialization) =>
    runKMeans(vectors, k, `${seedHash}:init:${initialization}`, maxIterations));
  return candidates.sort((a, b) =>
    kMeansInertia(vectors, a) - kMeansInertia(vectors, b)
    || partitionKey(a.labels).localeCompare(partitionKey(b.labels)))[0];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function silhouetteScore(vectors: SparseVector[], labels: number[]): number | null {
  const membersByCluster = new Map<number, number[]>();
  labels.forEach((label, index) => {
    const members = membersByCluster.get(label) ?? [];
    members.push(index);
    membersByCluster.set(label, members);
  });
  const clusters = [...membersByCluster.keys()].sort((a, b) => a - b);
  if (clusters.length < 2 || clusters.length >= vectors.length) return null;
  if (clusters.some(cluster => (membersByCluster.get(cluster)?.length ?? 0) < 2)) return null;
  const sampledIndexes = evenlySampleIndexes(vectors.length, SILHOUETTE_EVALUATION_SAMPLES);
  return mean(sampledIndexes.map(index => {
    const vector = vectors[index];
    const own = labels[index];
    const ownIndexes = evenlySampleValues(
      (membersByCluster.get(own) ?? []).filter(candidate => candidate !== index),
      SILHOUETTE_CLUSTER_SAMPLES,
    );
    if (ownIndexes.length === 0) return 0;
    const within = mean(ownIndexes.map(candidate => distance(vector, vectors[candidate])));
    const nearestOther = Math.min(...clusters
      .filter(cluster => cluster !== own)
      .map(cluster => mean(evenlySampleValues(
        membersByCluster.get(cluster) ?? [],
        SILHOUETTE_CLUSTER_SAMPLES,
      )
        .map(candidate => distance(vector, vectors[candidate])))));
    const denominator = Math.max(within, nearestOther);
    return denominator === 0 ? 0 : (nearestOther - within) / denominator;
  }));
}

function evenlySampleIndexes(length: number, limit: number): number[] {
  if (length <= limit) return Array.from({length}, (_, index) => index);
  return Array.from({length: limit}, (_, index) =>
    Math.floor((index * (length - 1)) / (limit - 1)));
}

function evenlySampleValues<T>(values: readonly T[], limit: number): T[] {
  return evenlySampleIndexes(values.length, limit).map(index => values[index]);
}

function vectorKey(vector: SparseVector): string {
  return [...vector.entries()].map(([index, value]) => `${index}:${value.toFixed(15)}`).join('|');
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function pathIsStrictPrefix(parent: string, child: string): boolean {
  const parentParts = parent.split(' -> ');
  const childParts = child.split(' -> ');
  return parentParts.length < childParts.length
    && parentParts.every((part, index) => part === childParts[index]);
}

function collapsedPaths(rows: NormalizedRow[], tolerancePct: number): string[] {
  const sizesByPath = new Map<string, number[]>();
  for (const row of rows) {
    const sizes = sizesByPath.get(row.normalizedPath) ?? [];
    sizes.push(row.retainedSizeBytes);
    sizesByPath.set(row.normalizedPath, sizes);
  }
  const paths = [...sizesByPath.keys()].sort();
  const collapsed = new Set<string>();
  for (const child of paths) {
    const childParts = child.split(' -> ');
    for (let prefixLength = 1; prefixLength < childParts.length; prefixLength += 1) {
      const parent = childParts.slice(0, prefixLength).join(' -> ');
      if (!sizesByPath.has(parent) || !pathIsStrictPrefix(parent, child)) continue;
      const parentSize = mean(sizesByPath.get(parent) ?? []);
      const childSize = mean(sizesByPath.get(child) ?? []);
      const denominator = Math.max(parentSize, childSize, 1);
      if (Math.abs(parentSize - childSize) * 100 / denominator <= tolerancePct) {
        collapsed.add(child);
        break;
      }
    }
  }
  return [...collapsed].sort();
}

function summarizeCluster(
  rows: NormalizedRow[],
  seedHash: string,
  traceTotal: number,
  tolerancePct: number,
): HeapPathClusterSummaryV1 {
  const pathCounts = new Map<string, {count: number; retained: number}>();
  for (const row of rows) {
    const current = pathCounts.get(row.normalizedPath) ?? {count: 0, retained: 0};
    current.count += 1;
    current.retained += row.retainedSizeBytes;
    pathCounts.set(row.normalizedPath, current);
  }
  const representativePath = [...pathCounts.entries()].sort((a, b) =>
    b[1].count - a[1].count
    || b[1].retained / b[1].count - a[1].retained / a[1].count
    || a[0].localeCompare(b[0]))[0][0];
  const evidenceRefIds = rows.map(row => row.evidenceRefId).sort();
  const traces = new Set(rows.map(row => row.traceId));
  const retainedSizes = rows.map(row => row.retainedSizeBytes);
  return {
    id: `heap-cluster-${sha256(`${seedHash}:${evidenceRefIds.join('\0')}`).slice(0, 12)}`,
    representativePath,
    classNames: [...new Set(rows.map(row => row.className).filter(Boolean))].sort(),
    rootTypes: [...new Set(rows.map(row => row.rootType).filter(Boolean))].sort(),
    traceCount: traces.size,
    sampleCount: new Set(rows.map(sampleKey)).size,
    rowCount: rows.length,
    traceSupportPct: traceTotal === 0 ? 0 : Math.round((traces.size * 100000) / traceTotal) / 1000,
    meanRetainedBytes: Math.round(mean(retainedSizes)),
    p95RetainedBytes: percentile95(retainedSizes),
    collapsedPaths: collapsedPaths(rows, tolerancePct),
    evidenceRefIds,
  };
}

function baseResult(
  rows: NormalizedRow[],
  failures: HeapPathClusterFailure[],
  rejectedRowCount: number,
  seedHash: string,
  options: ResolvedOptions,
  limitations: string[],
): Omit<HeapPathClusterAnalysisV1, 'status' | 'selectedK' | 'silhouetteScore' | 'clusters'> {
  return {
    schemaVersion: HEAP_PATH_CLUSTER_SCHEMA_VERSION,
    normalizationVersion: HEAP_PATH_NORMALIZATION_VERSION,
    seedHash,
    collapseTolerancePct: options.collapseTolerancePct,
    input: {
      traceCount: Math.max(
        new Set(rows.map(row => row.traceId)).size,
        options.traceUniverseSize ?? 0,
      ),
      sampleCount: new Set(rows.map(sampleKey)).size,
      rowCount: rows.length,
      rejectedRowCount,
    },
    failures,
    limitations,
  };
}

export function clusterHeapPaths(
  inputRows: HeapPathClusterInputRow[],
  inputFailures: HeapPathClusterFailure[] = [],
  inputOptions: HeapPathClusterOptions = {},
): HeapPathClusterAnalysisV1 {
  const options = resolveOptions(inputOptions);
  const failures = [...inputFailures].sort((a, b) =>
    a.traceOrdinal - b.traceOrdinal || (a.traceId ?? '').localeCompare(b.traceId ?? '') || a.reason.localeCompare(b.reason));
  const boundedInputRows = inputRows.slice(0, ABSOLUTE_MAX_INPUT_ROWS);
  const oversizedRowCount = boundedInputRows.filter(hasOversizedRowField).length;
  const rejectedRowCount = boundedInputRows.filter(row => !isValidRow(row)).length;
  const allValidRows = boundedInputRows
    .filter(isValidRow)
    .map(row => ({...row, normalizedPath: normalizeHeapPath(row.path)}))
    .sort(compareRows);
  const limitations: string[] = [];
  if (boundedInputRows.length < inputRows.length) {
    limitations.push(`absolute_input_row_limit_applied:${boundedInputRows.length}/${inputRows.length}`);
  }
  const effectiveRowLimit = Math.min(options.maxRows, options.maxMatrixCells);
  const rows = allValidRows.slice(0, effectiveRowLimit);
  if (rows.length < allValidRows.length) limitations.push(`row_limit_applied:${rows.length}/${allValidRows.length}`);
  if (rejectedRowCount > 0) limitations.push(`rejected_rows:${rejectedRowCount}`);
  if (oversizedRowCount > 0) limitations.push(`oversized_rows:${oversizedRowCount}`);
  const seedHash = canonicalSeed(rows);
  const base = baseResult(rows, failures, rejectedRowCount, seedHash, options, limitations);

  if (rows.length === 0) {
    return {...base, status: 'unavailable', selectedK: null, silhouetteScore: null, clusters: []};
  }
  if (base.input.sampleCount < 3) {
    return {...base, status: 'insufficient_samples', selectedK: null, silhouetteScore: null, clusters: []};
  }

  const vectors = buildVectors(rows, options, limitations);
  if (vectors.length > SILHOUETTE_EVALUATION_SAMPLES) {
    limitations.push(`silhouette_sampled:${SILHOUETTE_EVALUATION_SAMPLES}/${vectors.length}`);
  }
  const uniqueVectorCount = new Set(vectors.map(vectorKey)).size;
  if (uniqueVectorCount === 1) {
    limitations.push('degenerate_vectors');
    return {
      ...baseResult(rows, failures, rejectedRowCount, seedHash, options, limitations),
      status: failures.length > 0 || rejectedRowCount > 0 || rows.length < allValidRows.length ? 'partial' : 'completed',
      selectedK: 1,
      silhouetteScore: null,
      clusters: [summarizeCluster(rows, seedHash, base.input.traceCount, options.collapseTolerancePct)],
    };
  }

  const selectionVectors = evenlySampleValues(vectors, K_SELECTION_SAMPLE_SIZE);
  if (selectionVectors.length < vectors.length) {
    limitations.push(`k_selection_sampled:${selectionVectors.length}/${vectors.length}`);
  }
  const selectionUniqueVectorCount = new Set(selectionVectors.map(vectorKey)).size;
  const maxK = Math.min(options.maxK, selectionVectors.length - 1, selectionUniqueVectorCount);
  let selectionWorkUnits = 0;
  let selected: {k: number; score: number} | null = null;
  for (let k = 2; k <= maxK; k += 1) {
    const candidateWorkUnits = selectionVectors.length * k * options.maxIterations * K_SELECTION_RESTARTS;
    if (selectionWorkUnits + candidateWorkUnits > K_SELECTION_WORK_UNITS) {
      limitations.push(`k_selection_work_budget_applied:${selectionWorkUnits}/${K_SELECTION_WORK_UNITS}`);
      break;
    }
    selectionWorkUnits += candidateWorkUnits;
    const candidate = runBestKMeans(
      selectionVectors,
      k,
      `${seedHash}:selection:${k}`,
      options.maxIterations,
      K_SELECTION_RESTARTS,
    );
    if (new Set(candidate.labels).size !== k) continue;
    const score = silhouetteScore(selectionVectors, candidate.labels);
    if (score === null) continue;
    if (!selected || score > selected.score + 1e-12 || (Math.abs(score - selected.score) <= 1e-12 && k < selected.k)) {
      selected = {k, score};
    }
  }
  if (!selected) {
    limitations.push('silhouette_selection_unavailable');
    return {
      ...baseResult(rows, failures, rejectedRowCount, seedHash, options, limitations),
      status: 'insufficient_samples',
      selectedK: null,
      silhouetteScore: null,
      clusters: [],
    };
  }

  const finalIterations = Math.max(1, Math.min(
    options.maxIterations,
    Math.floor(FINAL_CLUSTER_WORK_UNITS / Math.max(1, vectors.length * selected.k * FINAL_CLUSTER_RESTARTS)),
  ));
  if (finalIterations < options.maxIterations) {
    limitations.push(`final_cluster_work_budget_applied:${finalIterations}/${options.maxIterations}`);
  }
  const finalClustering = runBestKMeans(
    vectors,
    selected.k,
    `${seedHash}:final:${selected.k}`,
    finalIterations,
    FINAL_CLUSTER_RESTARTS,
  );
  const realizedK = new Set(finalClustering.labels).size;
  if (realizedK !== selected.k) limitations.push(`final_cluster_collapse:${realizedK}/${selected.k}`);
  const finalScore = silhouetteScore(vectors, finalClustering.labels);

  const clusters = [...new Set(finalClustering.labels)]
    .map(label => summarizeCluster(
      rows.filter((_, index) => finalClustering.labels[index] === label),
      seedHash,
      base.input.traceCount,
      options.collapseTolerancePct,
    ))
    .sort((a, b) => b.traceCount - a.traceCount
      || b.meanRetainedBytes - a.meanRetainedBytes
      || a.representativePath.localeCompare(b.representativePath));
  return {
    ...baseResult(rows, failures, rejectedRowCount, seedHash, options, limitations),
    status: failures.length > 0 || rejectedRowCount > 0 || rows.length < allValidRows.length || limitations.length > 0
      ? 'partial'
      : 'completed',
    selectedK: realizedK,
    silhouetteScore: finalScore === null ? null : Math.round(finalScore * 1_000_000) / 1_000_000,
    clusters,
  };
}
