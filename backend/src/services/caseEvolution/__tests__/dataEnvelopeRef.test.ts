// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DataEnvelope } from '../../../types/dataContract';
import { dataEnvelopeRefId } from '../dataEnvelopeRef';

function envelope(overrides: Partial<DataEnvelope> = {}): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis',
      skillId: 'scrolling_analysis',
      stepId: 'batch_frame_root_cause',
      timestamp: 123,
      ...(overrides.meta || {}),
    },
    display: {
      layer: 'list',
      format: 'table',
      title: 'Root cause frames',
      ...(overrides.display || {}),
    },
    data: overrides.data || {
      columns: ['reason_code', 'frame_count'],
      rows: [['shader_compile', 4]],
    },
  };
}

describe('dataEnvelopeRefId', () => {
  it('uses explicit evidenceRefId when present', () => {
    expect(dataEnvelopeRefId(envelope({meta: {...envelope().meta, evidenceRefId: 'ev-1'}}))).toBe('ev-1');
  });

  it('disambiguates duplicate evidenceRefId with sourceToolCallId', () => {
    expect(
      dataEnvelopeRefId(
        envelope({meta: {...envelope().meta, evidenceRefId: 'ev-1', sourceToolCallId: 'tool-1'}}),
        new Set(['ev-1']),
      ),
    ).toBe('ev-1:tool:tool-1');
  });

  it('uses timestamp fallback when evidenceRefId is absent', () => {
    expect(dataEnvelopeRefId(envelope())).toBe('data:scrolling_analysis:batch_frame_root_cause:123');
  });

  it('uses stable content hash fallback when timestamp is absent', () => {
    const envWithoutTimestamp = envelope();
    delete (envWithoutTimestamp.meta as Partial<typeof envWithoutTimestamp.meta>).timestamp;
    const id = dataEnvelopeRefId(envWithoutTimestamp);
    expect(id).toMatch(/^data:scrolling_analysis:batch_frame_root_cause:[a-f0-9]{12}$/);
    expect(id).toBe(dataEnvelopeRefId(envWithoutTimestamp));
  });
});
