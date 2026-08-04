// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {introspectSqlForQueryReview} from '../sqlReviewIntrospector';

describe('sqlReviewIntrospector', () => {
  it('extracts source tables, filters, and output shape from simple SQL', () => {
    const review = introspectSqlForQueryReview({
      sql: `
        SELECT s.ts, s.dur, t.name AS thread_name
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        WHERE s.dur > 0 AND t.name GLOB 'main*'
        ORDER BY s.dur DESC
      `,
      outputColumns: [
        {name: 'ts', type: 'timestamp'},
        {name: 'dur', type: 'duration'},
        {name: 'thread_name', type: 'string'},
      ],
    });

    expect(review.reads.map(read => read.table)).toEqual(['slice', 'thread_track', 'thread']);
    expect(review.filters.map(filter => filter.expression)).toEqual(['s.dur > 0', "t.name GLOB 'main*'"]);
    expect(review.outputShape.map(column => column.name)).toEqual(['ts', 'dur', 'thread_name']);
  });

  it('marks complex SQL as partial and records limitations', () => {
    const review = introspectSqlForQueryReview({
      sql: `
        WITH blocked AS (
          SELECT *
          FROM thread_state
          WHERE state = 'D'
        )
        SELECT *
        FROM blocked
      `,
      outputColumns: ['state'],
    });

    expect(review.reads.some(read => read.confidence === 'partial')).toBe(true);
    expect(review.limitations.length).toBeGreaterThan(0);
    expect(review.limitations.join(' ')).toContain('SELECT *');
  });
});
