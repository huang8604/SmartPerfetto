// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {ArtifactStore} from '../artifactStore';

describe('ArtifactStore', () => {
  it('exposes pane-aware trace provenance in summaries and fetch results', () => {
    const store = new ArtifactStore();
    const traceProvenance = buildTraceProcessorQueryProvenance({
      traceId: 'trace-reference',
      traceSide: 'reference',
      paneSide: 'right',
    });
    const artifactId = store.store({
      skillId: 'startup_summary',
      stepId: 'duration',
      title: 'Startup duration',
      data: {
        columns: ['dur_ms'],
        rows: [[1234]],
      },
      traceProvenance,
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });

    expect(store.generateSummary(artifactId)).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.generateCompactSummary(artifactId)).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.fetch(artifactId, 'rows')).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.fetch(artifactId, 'full')).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
  });
});
