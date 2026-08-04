// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const HEAP_PATH_CLUSTER_SCHEMA_VERSION = 'heap_path_cluster_analysis@1' as const;
export const HEAP_PATH_NORMALIZATION_VERSION = 'heap_path_normalization@1' as const;

export type HeapPathClusterStatus =
  | 'completed'
  | 'partial'
  | 'unavailable'
  | 'insufficient_samples';

export interface HeapPathClusterInputRow {
  traceOrdinal: number;
  traceId: string;
  upid: number;
  sampleTs: string;
  processName: string;
  path: string;
  className: string;
  rootType: string;
  selfSizeBytes: number;
  retainedSizeBytes: number;
  evidenceRefId: string;
}

export interface HeapPathClusterFailure {
  traceOrdinal: number;
  traceId?: string;
  reason: string;
}

export interface HeapPathClusterSummaryV1 {
  id: string;
  representativePath: string;
  classNames: string[];
  rootTypes: string[];
  traceCount: number;
  sampleCount: number;
  rowCount: number;
  traceSupportPct: number;
  meanRetainedBytes: number;
  p95RetainedBytes: number;
  collapsedPaths: string[];
  evidenceRefIds: string[];
}

export interface HeapPathClusterAnalysisV1 {
  schemaVersion: typeof HEAP_PATH_CLUSTER_SCHEMA_VERSION;
  normalizationVersion: typeof HEAP_PATH_NORMALIZATION_VERSION;
  status: HeapPathClusterStatus;
  seedHash: string;
  selectedK: number | null;
  silhouetteScore: number | null;
  collapseTolerancePct: number;
  input: {
    traceCount: number;
    sampleCount: number;
    rowCount: number;
    rejectedRowCount: number;
  };
  clusters: HeapPathClusterSummaryV1[];
  failures: HeapPathClusterFailure[];
  limitations: string[];
}
