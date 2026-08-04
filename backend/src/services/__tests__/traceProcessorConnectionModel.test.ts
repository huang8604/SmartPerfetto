// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildTraceProcessorDatabaseScope,
  buildTraceProcessorQueryProvenance,
  traceProcessorProcessorKey,
} from '../traceProcessorConnectionModel';

describe('traceProcessorConnectionModel', () => {
  it('uses the trace id as the shared database processor key', () => {
    expect(traceProcessorProcessorKey('trace-a')).toBe('trace-a');
    expect(traceProcessorProcessorKey('trace-a', 'lease-a', 'shared')).toBe('trace-a');
  });

  it('uses lease-qualified processor keys only for isolated databases', () => {
    expect(traceProcessorProcessorKey('trace-a', 'lease-a', 'isolated')).toBe('trace-a:lease:lease-a');

    const scope = buildTraceProcessorDatabaseScope({
      traceId: 'trace-a',
      traceSide: 'reference',
      paneSide: 'right',
      leaseId: 'lease-a',
      leaseMode: 'isolated',
    });

    expect(scope).toEqual({
      traceId: 'trace-a',
      traceSide: 'reference',
      paneSide: 'right',
      processorKey: 'trace-a:lease:lease-a',
      isolation: 'isolated',
      leaseId: 'lease-a',
      leaseMode: 'isolated',
    });
  });

  it('builds query provenance with explicit trace side and database scope', () => {
    const provenance = buildTraceProcessorQueryProvenance({
      traceId: 'ref-trace',
      traceSide: 'reference',
      paneSide: 'bottom',
    });

    expect(provenance.traceSide).toBe('reference');
    expect(provenance.paneSide).toBe('bottom');
    expect(provenance.traceId).toBe('ref-trace');
    expect(provenance.databaseScope).toMatchObject({
      traceId: 'ref-trace',
      traceSide: 'reference',
      paneSide: 'bottom',
      processorKey: 'ref-trace',
      isolation: 'shared',
    });
    expect(provenance.connectionScope.connectionKey).toBe('ref-trace');
  });
});
