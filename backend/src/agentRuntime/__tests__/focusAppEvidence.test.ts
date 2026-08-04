// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { buildFocusAppEvidencePayload } from '../focusAppEvidence';

describe('buildFocusAppEvidencePayload', () => {
  it('builds a stable DataEnvelope for quick focus app evidence', () => {
    const first = buildFocusAppEvidencePayload({
      method: 'frame_timeline',
      primaryApp: 'com.example.app',
      apps: [
        { packageName: 'com.example.app', totalDurationNs: 1_700_000_000, switchCount: 347 },
      ],
    }, 'trace-1');
    const second = buildFocusAppEvidencePayload({
      method: 'frame_timeline',
      primaryApp: 'com.example.app',
      apps: [
        { packageName: 'com.example.app', totalDurationNs: 1_700_000_000, switchCount: 347 },
      ],
    }, 'trace-1');

    expect(first.evidenceRefId).toMatch(/^data:focus_app:current:[a-f0-9]{12}$/);
    expect(second.evidenceRefId).toBe(first.evidenceRefId);
    expect(first.focusResult.apps[0]).toMatchObject({
      packageName: 'com.example.app',
      evidenceRefId: first.evidenceRefId,
      evidenceRowIndex: 0,
    });
    expect(first.envelope?.meta).toMatchObject({
      type: 'sql_result',
      source: 'runtime_focus_detection',
      evidenceRefId: first.evidenceRefId,
      traceId: 'trace-1',
      intent: 'runtime_focus_app_detection',
      planPhaseId: 'quick',
    });
    expect(first.envelope?.data).toEqual({
      columns: [
        'rank',
        'package_name',
        'is_primary',
        'foreground_duration_ns',
        'foreground_count',
        'count_source',
        'detection_method',
      ],
      rows: [[1, 'com.example.app', true, 1_700_000_000, 347, 'frame_count', 'frame_timeline']],
    });
  });

  it('does not build an envelope when focus detection has no apps', () => {
    const payload = buildFocusAppEvidencePayload({ method: 'none', apps: [] }, 'trace-1');

    expect(payload.envelope).toBeUndefined();
    expect(payload.evidenceRefId).toBeUndefined();
    expect(payload.focusResult.apps).toEqual([]);
  });

  it('includes selected range scope columns for scoped focus app evidence', () => {
    const payload = buildFocusAppEvidencePayload({
      method: 'battery_stats',
      primaryApp: 'com.example.app',
      timeRange: { startNs: 1_000_000_000, endNs: 2_000_000_000 },
      apps: [
        {
          packageName: 'com.example.app',
          totalDurationNs: 800_000_000,
          switchCount: 1,
          scopeStartNs: 1_000_000_000,
          scopeEndNs: 2_000_000_000,
        },
      ],
    }, 'trace-1');

    expect(payload.envelope?.data.columns).toEqual([
      'rank',
      'package_name',
      'is_primary',
      'foreground_duration_ns',
      'foreground_count',
      'count_source',
      'detection_method',
      'scope_start_ns',
      'scope_end_ns',
    ]);
    expect(payload.envelope?.data.rows).toEqual([[
      1,
      'com.example.app',
      true,
      800_000_000,
      1,
      'foreground_switch_count',
      'battery_stats',
      1_000_000_000,
      2_000_000_000,
    ]]);
  });
});
