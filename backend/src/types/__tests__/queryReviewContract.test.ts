// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {createDataEnvelope} from '../dataContract';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  compactQueryReviewForToolResponse,
  sanitizeQueryReview,
  type QueryReviewV1,
} from '../queryReviewContract';

function validReview(overrides: Partial<QueryReviewV1> = {}): QueryReviewV1 {
  return {
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id: 'qr:execute_sql:abc',
    producer: {kind: 'execute_sql', sourceToolCallId: 'execute_sql:1'},
    title: 'SQL review',
    purpose: 'Review SQL output',
    source: {evidenceRefId: 'data:sql:1', queryHash: 'abc'},
    reads: [{table: 'slice', confidence: 'observed'}],
    filters: [{expression: 'dur > 0', confidence: 'observed'}],
    outputShape: [{name: 'dur', type: 'duration', required: true}],
    guardrails: [],
    limitations: [],
    observedExecution: {executed: true, executableSql: 'SELECT dur FROM slice WHERE dur > 0', rowCount: 2},
    allowedUse: 'review_metadata_only',
    ...overrides,
  };
}

describe('queryReviewContract', () => {
  it('sanitizes a valid review and strips SQL from compact tool output', () => {
    const review = sanitizeQueryReview(validReview());
    expect(review?.id).toBe('qr:execute_sql:abc');
    expect(review?.producer.kind).toBe('execute_sql');

    const compact = compactQueryReviewForToolResponse(review!);
    expect(compact.observedExecution.rowCount).toBe(2);
    expect('executableSql' in compact.observedExecution).toBe(false);
  });

  it('fails closed for unsupported producer kinds', () => {
    const review = sanitizeQueryReview({
      ...validReview(),
      producer: {kind: 'compare_skill'},
    });

    expect(review).toBeUndefined();
  });

  it('sanitizes queryReview through createDataEnvelope', () => {
    const envelope = createDataEnvelope(
      {columns: ['dur'], rows: [[1]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'SQL',
        queryReview: validReview({id: 'qr:execute_sql:from-envelope'}),
      },
    );

    expect(envelope.meta.queryReview?.id).toBe('qr:execute_sql:from-envelope');
  });
});
