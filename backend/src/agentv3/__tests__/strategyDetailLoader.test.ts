// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildStrategyDetailExcerpt,
  getRegisteredScenes,
  getStrategyContent,
  getStrategyDetails,
  matchStrategyDetailForPhase,
} from '../strategyLoader';

describe('strategy detail loader', () => {
  it('keeps every normal strategy split into core plus on-demand detail', () => {
    for (const scene of getRegisteredScenes().map(def => def.scene)) {
      const core = getStrategyContent(scene) || '';
      const details = getStrategyDetails(scene);
      expect(core).toContain('Core Strategy');
      expect(core).not.toContain('<!-- strategy-detail');
      expect(details.length).toBeGreaterThan(0);
    }
  });

  it('matches scrolling root-cause phases to the root-cause detail', () => {
    const match = matchStrategyDetailForPhase('scrolling', {
      id: 'p2',
      name: '根因深钻',
      goal: '对 reason_code 代表帧执行 jank_frame_detail + frame_blocking_calls + blocking_chain_analysis',
      expectedTools: ['invoke_skill', 'fetch_artifact'],
      expectedCalls: [
        { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
        { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
        { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
      ],
    });

    expect(match?.detail.ref).toBe('scrolling:root_cause_drill');
    expect(match?.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('caps strategy detail excerpts so plan tool history cannot re-expand the prompt', () => {
    const detail = getStrategyDetails('startup').find(section => section.id === 'overview_timing');
    expect(detail).toBeDefined();
    const excerpt = buildStrategyDetailExcerpt(detail!, 800);
    expect(excerpt.excerpt.length).toBeLessThanOrEqual(800);
    expect(excerpt.truncated).toBe(true);
  });
});
