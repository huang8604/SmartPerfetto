// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {createDataEnvelope} from '../../../types/dataContract';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  type QueryReviewV1,
} from '../../../types/queryReviewContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';

const queryReview: QueryReviewV1 = {
  schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
  id: 'qr:execute_sql:anchor',
  producer: {kind: 'execute_sql', sourceToolCallId: 'execute_sql:1'},
  title: 'SQL review',
  purpose: 'Review SQL',
  source: {evidenceRefId: 'data:sql:anchor', queryHash: 'hash-anchor'},
  reads: [{table: 'slice', confidence: 'observed'}],
  filters: [],
  outputShape: [{name: 'dur', type: 'duration', required: true}],
  guardrails: [],
  limitations: [],
  observedExecution: {executed: true, rowCount: 1},
  allowedUse: 'review_metadata_only',
};

describe('evidenceContractBuilder', () => {
  it('preserves queryReviewId in evidence anchor context', () => {
    const envelope = createDataEnvelope(
      {columns: ['dur'], rows: [[10]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'SQL',
        evidenceRefId: 'data:sql:anchor',
        queryHash: 'hash-anchor',
        traceId: 'trace-reference',
        traceSide: 'reference',
        paneSide: 'right',
        queryReview,
      },
    );
    const conclusionContract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        text: 'Duration is 10',
        kind: 'numeric',
        references: [{
          evidenceRefId: 'data:sql:anchor',
          rowIndex: 0,
          column: 'dur',
          value: 10,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    };

    const contract = buildEvidenceContract({
      conclusionContract,
      dataEnvelopes: [envelope],
    });

    expect(contract.anchors[0].context.queryReviewId).toBe('qr:execute_sql:anchor');
    expect(contract.anchors[0].context.traceSide).toBe('reference');
    expect(contract.anchors[0].context.paneSide).toBe('right');
    expect('queryReview' in contract.anchors[0].context).toBe(false);
  });

  it('does not treat the raw Trace comparison appendix as a conclusion claim', () => {
    const contract = buildEvidenceContract({
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims: [],
        uncertainties: [],
        nextSteps: [],
      },
      comparisonReportSection: {
        source: 'raw_trace_pair',
        title: 'Raw Trace comparison',
        markdown: 'Comparison appendix',
        html: '<p>Comparison appendix</p>',
        evidencePack: {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'},
      },
    });

    expect(contract.claimSupport).toEqual([]);
    expect(contract.anchors).toEqual([]);
  });
});
