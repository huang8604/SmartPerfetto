// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {buildJankDecisionTree, type JankFrameInput} from '../jankDecisionTree';

describe('buildJankDecisionTree', () => {
  it('accepts canonical Perfetto "App Deadline Missed" string (Codex P1 regression)', () => {
    // Round 1 SQL test confirmed Perfetto emits "App Deadline Missed" with
    // spaces — proto-style "AppDeadlineMissed" never appears in real traces.
    const c = buildJankDecisionTree([
      {
        frameId: 1,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'App Deadline Missed',
        uiRunnableNs: 8_000_000,
      },
    ]);
    expect(c.frameAttributions).toHaveLength(1);
    expect(c.frameAttributions[0].routePath).toEqual([
      'root',
      'app_deadline_missed',
      'app_cpu_starvation',
    ]);
  });

  it('routes comma-joined jank reasons by priority (Codex P1 regression)', () => {
    // "SurfaceFlinger Scheduling, App Deadline Missed" must route to the
    // app-side branch (highest priority) so root-cause attribution lands
    // on the actor the developer can fix.
    const c = buildJankDecisionTree([
      {
        frameId: 9,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'SurfaceFlinger Scheduling, App Deadline Missed',
      },
    ]);
    expect(c.frameAttributions[0].routePath[1]).toBe('app_deadline_missed');
  });

  it('classifies SurfaceFlinger CPU jank to sf_cpu_deadline_missed', () => {
    const c = buildJankDecisionTree([
      {
        frameId: 2,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'SurfaceFlinger CPU Deadline Missed',
      },
    ]);
    expect(c.frameAttributions[0].routePath).toEqual([
      'root',
      'sf_cpu_deadline_missed',
    ]);
  });

  it('routes BufferStuffing string variants to buffer_stuffing branch', () => {
    const c = buildJankDecisionTree([
      {frameId: 3, startNs: 0, endNs: 1, jankType: 'Buffer Stuffing'},
      {frameId: 4, startNs: 0, endNs: 1, jankType: 'BufferStuffing'},
      {frameId: 5, startNs: 0, endNs: 1, jankType: 'SurfaceFlinger Stuffing'},
    ]);
    expect(c.frameAttributions).toHaveLength(3);
    for (const attr of c.frameAttributions) {
      expect(attr.routePath).toContain('buffer_stuffing');
    }
  });

  it('drops frames with missing jank_type into unclassifiedFrames', () => {
    const c = buildJankDecisionTree([
      {frameId: 5, startNs: 0, endNs: 1, jankType: null},
      {frameId: 6, startNs: 0, endNs: 1, jankType: 'None'},
    ]);
    expect(c.frameAttributions).toHaveLength(0);
    expect(c.unclassifiedFrames).toHaveLength(2);
    expect(c.unsupportedReason).toBeDefined();
  });

  it('falls back to workload_heavy when no blocker is dominant', () => {
    const c = buildJankDecisionTree([
      {
        frameId: 7,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'App Deadline Missed',
      },
    ]);
    expect(c.frameAttributions[0].reasonCode).toBe('workload_heavy');
  });
});
