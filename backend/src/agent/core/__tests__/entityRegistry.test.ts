// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildEntityLabel,
  getCaptureStepPatterns,
  getEntityDrillDownStrategy,
  getEntityIdFieldKeys,
  getEntityParamKey,
  resolveCaptureEntityKindByStepId,
} from '../entityRegistry';

describe('entityRegistry', () => {
  it('provides canonical param keys and id field keys', () => {
    expect(getEntityParamKey('frame')).toBe('frame_id');
    expect(getEntityParamKey('session')).toBe('session_id');
    expect(getEntityParamKey('startup')).toBe('startup_id');

    expect(getEntityIdFieldKeys('frame')).toEqual(['frame_id', 'frameId']);
    expect(getEntityIdFieldKeys('startup')).toEqual(['startup_id', 'startupId']);
  });

  it('provides drill-down strategy and localized labels', () => {
    expect(getEntityDrillDownStrategy('frame')).toBe('frame_drill_down');
    expect(getEntityDrillDownStrategy('startup')).toBe('startup_drill_down');
    expect(buildEntityLabel('session', 12)).toBe('滑动会话 12');
  });

  it('resolves capture entity kind by step id in exact mode', () => {
    expect(resolveCaptureEntityKindByStepId('get_app_jank_frames', 'exact')).toBe('frame');
    expect(resolveCaptureEntityKindByStepId('scroll_sessions', 'exact')).toBe('session');
    expect(resolveCaptureEntityKindByStepId('binder_calls', 'exact')).toBe('binder');
    expect(resolveCaptureEntityKindByStepId('unknown_step', 'exact')).toBeNull();
  });

  it('resolves capture entity kind by step id in contains mode', () => {
    expect(resolveCaptureEntityKindByStepId('scene_reconstruction:get_app_jank_frames', 'contains')).toBe('frame');
    expect(resolveCaptureEntityKindByStepId('abc:memory_events:v2', 'contains')).toBe('memory');
    expect(resolveCaptureEntityKindByStepId('other:step', 'contains')).toBeNull();
  });

  it('exposes stable step pattern lists', () => {
    const framePatterns = getCaptureStepPatterns('frame');
    expect(framePatterns).toContain('frames');
    expect(framePatterns).toContain('jank_frames');
  });
});