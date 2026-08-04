// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import type { TraceDataset } from '../agent/core/orchestratorTypes';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  type DataEnvelope,
  type DataEnvelopeTraceSide,
} from '../types/dataContract';

function stableTraceContextHash(traceId: string, dataset: TraceDataset): string {
  return createHash('sha256')
    .update(JSON.stringify({
      traceId,
      label: dataset.label,
      columns: dataset.columns,
      rows: dataset.rows,
    }, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
    .digest('hex')
    .slice(0, 12);
}

function normalizeTraceSide(side: unknown): DataEnvelopeTraceSide {
  return side === 'reference' ? 'reference' : 'current';
}

export function decorateTraceContextDatasets(
  traceContext: TraceDataset[] | undefined,
  traceId: string,
): TraceDataset[] | undefined {
  if (!traceContext || traceContext.length === 0) return undefined;
  const decorated: TraceDataset[] = [];
  for (const dataset of traceContext) {
    if (!dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) continue;
    const queryHash = dataset.queryHash || stableTraceContextHash(traceId, dataset);
    const traceSide = normalizeTraceSide(dataset.traceSide);
    decorated.push({
      ...dataset,
      traceSide,
      traceId: dataset.traceId || traceId,
      queryHash,
      evidenceRefId: dataset.evidenceRefId || `data:frontend_prequery:${traceSide}:${queryHash}`,
      sourceToolCallId: dataset.sourceToolCallId || `frontend-prequery:${queryHash}`,
    });
  }
  return decorated.length > 0 ? decorated : undefined;
}

export function buildTraceContextDataEnvelopes(
  traceContext: TraceDataset[] | undefined,
  traceId: string,
): DataEnvelope[] {
  const decorated = decorateTraceContextDatasets(traceContext, traceId);
  if (!decorated || decorated.length === 0) return [];
  const envelopes: DataEnvelope[] = [];

  for (const dataset of decorated) {
    if (dataset.columns.length === 0 || dataset.rows.length === 0) continue;

    envelopes.push(createDataEnvelope(
      {
        columns: dataset.columns,
        rows: dataset.rows,
      },
      {
        type: 'sql_result',
        source: 'frontend_trace_context',
        title: dataset.label || 'Frontend pre-query result',
        layer: 'list',
        format: 'table',
        columns: buildColumnDefinitions(dataset.columns),
        evidenceRefId: dataset.evidenceRefId,
        traceSide: dataset.traceSide || 'current',
        paneSide: dataset.paneSide,
        traceId: dataset.traceId || traceId,
        queryHash: dataset.queryHash,
        sourceToolCallId: dataset.sourceToolCallId,
        paramsHash: dataset.queryHash,
        intent: 'frontend_prequeried_trace_context',
      },
    ));
  }

  return envelopes;
}
