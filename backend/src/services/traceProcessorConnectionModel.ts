// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorLeaseMode } from './traceProcessorLeaseStore';

export type TraceProcessorTraceSide = 'current' | 'reference';
export type TraceProcessorPaneSide = 'left' | 'right' | 'top' | 'bottom';
export type TraceProcessorDatabaseIsolation = 'shared' | 'isolated';

export interface TraceProcessorDatabaseScope {
  traceId: string;
  traceSide?: TraceProcessorTraceSide;
  paneSide?: TraceProcessorPaneSide;
  processorKey: string;
  isolation: TraceProcessorDatabaseIsolation;
  leaseId?: string;
  leaseMode?: TraceProcessorLeaseMode | string;
}

export interface TraceProcessorConnectionScope {
  connectionKey: string;
  database: TraceProcessorDatabaseScope;
}

export interface TraceProcessorQueryProvenance {
  traceSide?: TraceProcessorTraceSide;
  paneSide?: TraceProcessorPaneSide;
  traceId: string;
  processorKey: string;
  databaseScope: TraceProcessorDatabaseScope;
  connectionScope: TraceProcessorConnectionScope;
}

export interface TraceProcessorConnectionInput {
  traceId: string;
  traceSide?: TraceProcessorTraceSide;
  paneSide?: TraceProcessorPaneSide;
  leaseId?: string;
  leaseMode?: TraceProcessorLeaseMode | string;
}

export function traceProcessorProcessorKey(
  traceId: string,
  leaseId?: string,
  mode: TraceProcessorLeaseMode | string = 'shared',
): string {
  return mode === 'isolated' && leaseId ? `${traceId}:lease:${leaseId}` : traceId;
}

export function buildTraceProcessorDatabaseScope(
  input: TraceProcessorConnectionInput,
): TraceProcessorDatabaseScope {
  const processorKey = traceProcessorProcessorKey(input.traceId, input.leaseId, input.leaseMode);
  const isolation: TraceProcessorDatabaseIsolation =
    input.leaseMode === 'isolated' && input.leaseId ? 'isolated' : 'shared';
  return {
    traceId: input.traceId,
    ...(input.traceSide ? { traceSide: input.traceSide } : {}),
    ...(input.paneSide ? { paneSide: input.paneSide } : {}),
    processorKey,
    isolation,
    ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    ...(input.leaseMode ? { leaseMode: input.leaseMode } : {}),
  };
}

export function buildTraceProcessorQueryProvenance(
  input: TraceProcessorConnectionInput,
): TraceProcessorQueryProvenance {
  const databaseScope = buildTraceProcessorDatabaseScope(input);
  const connectionScope: TraceProcessorConnectionScope = {
    connectionKey: databaseScope.processorKey,
    database: databaseScope,
  };
  return {
    ...(input.traceSide ? { traceSide: input.traceSide } : {}),
    ...(input.paneSide ? { paneSide: input.paneSide } : {}),
    traceId: input.traceId,
    processorKey: databaseScope.processorKey,
    databaseScope,
    connectionScope,
  };
}
