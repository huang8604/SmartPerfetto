// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {generateTraceConfig} from '../traceConfigGenerator';

describe('generateTraceConfig', () => {
  it('emits FrameTimeline + ftrace for scrolling', () => {
    const c = generateTraceConfig({intent: 'scrolling', cuj: 'scroll_feed'});
    const sources = c.fragments.map(f => f.dataSource);
    expect(sources).toContain('android.frametimeline');
    expect(sources).toContain('linux.ftrace');
    expect(c.selfDescription?.intent).toBe('scrolling');
    expect(c.selfDescription?.cuj).toBe('scroll_feed');
  });

  it('emits binder + input for ANR', () => {
    const c = generateTraceConfig({intent: 'anr'});
    const sources = c.fragments.map(f => f.dataSource);
    expect(sources).toContain('android.binder');
    expect(sources).toContain('android.input');
  });

  it('emits mm_event ftrace knobs for memory', () => {
    const c = generateTraceConfig({intent: 'memory'});
    const ftrace = c.fragments.find(f => f.dataSource === 'linux.ftrace');
    expect(ftrace?.options?.mm_compaction_begin).toBe('true');
  });

  it('returns the foundation set for generic intent', () => {
    const c = generateTraceConfig({intent: 'generic'});
    expect(c.fragments.length).toBeGreaterThan(0);
    expect(c.fragments.find(f => f.dataSource === 'linux.process_stats')).toBeDefined();
  });

  it('preserves custom slice declarations on the contract', () => {
    const c = generateTraceConfig({
      intent: 'scrolling',
      customSlices: [
        {name: 'AppEvent.frame', emittedBy: 'analytics', fields: [{name: 'frame_id', type: 'number'}]},
      ],
    });
    expect(c.customSlices).toHaveLength(1);
    expect(c.coverage.find(x => x.sparkId === 53)?.status).toBe('implemented');
  });
});
