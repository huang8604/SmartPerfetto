// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {buildJankDecisionTree, type JankFrameInput} from '../jankDecisionTree';

describe('buildJankDecisionTree', () => {
  it('routes AppDeadlineMissed with CPU starvation to cpu_starvation leaf', () => {
    const frames: JankFrameInput[] = [
      {
        frameId: 1,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'AppDeadlineMissed',
        uiRunnableNs: 8_000_000,
        lockBlockedNs: 200_000,
      },
    ];
    const c = buildJankDecisionTree(frames);
    expect(c.frameAttributions).toHaveLength(1);
    expect(c.frameAttributions[0].routePath).toEqual([
      'root',
      'app_deadline_missed',
      'app_cpu_starvation',
    ]);
    expect(c.frameAttributions[0].reasonCode).toBe('cpu_starvation');
  });

  it('classifies SurfaceFlinger CPU jank to sf_cpu_deadline_missed', () => {
    const c = buildJankDecisionTree([
      {
        frameId: 2,
        startNs: 0,
        endNs: 16_667_000,
        jankType: 'SurfaceFlingerCpuDeadlineMissed',
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
    ]);
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
        jankType: 'AppDeadlineMissed',
      },
    ]);
    expect(c.frameAttributions[0].reasonCode).toBe('workload_heavy');
  });
});
