// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillExecutorAdapter } from '../skillExecutorAdapter';

describe('SkillExecutorAdapter startup normalization', () => {
  function transformStartup(response: any): any {
    const adapter = new SkillExecutorAdapter({ enableCache: false });
    return (adapter as any).transformResult('startup_analysis', response);
  }

  it('hydrates startup rows from layered get_startups step data', () => {
    const response = {
      skillId: 'startup_analysis',
      success: true,
      summary: 'ok',
      diagnostics: [],
      layeredResult: {
        layers: {
          overview: {
            get_startups: {
              stepId: 'get_startups',
              data: [
                {
                  startup_type: 'warm',
                  ttid_ms: 640,
                  dur_ms: 780,
                  ttfd_ms: 910,
                },
              ],
            },
          },
        },
      },
    };

    const result = transformStartup(response);
    expect(result.startups).toHaveLength(1);
    expect(result.startups[0].startup_type).toBe('warm');
    expect(result.transformed.launch_type).toBe('warm');
    expect(result.transformed.ttid).toBe(640);
    expect(result.transformed.dur_ms).toBe(780);
    expect(result.transformed.ttfd).toBe(910);
  });

  it('hydrates startup rows from sections when layered result is unavailable', () => {
    const response = {
      skillId: 'startup_analysis',
      success: true,
      summary: 'ok',
      diagnostics: [],
      sections: {
        get_startups: {
          data: [
            {
              startup_type: 'hot',
              ttid_ms: 180,
              dur_ms: 220,
            },
          ],
        },
      },
    };

    const result = transformStartup(response);
    expect(result.startups).toHaveLength(1);
    expect(result.transformed.launch_type).toBe('hot');
    expect(result.transformed.ttid).toBe(180);
    expect(result.transformed.dur_ms).toBe(220);
  });

  it('supports tabular rows+columns payloads for startup data', () => {
    const response = {
      skillId: 'startup_analysis',
      success: true,
      summary: 'ok',
      diagnostics: [],
      sections: {
        get_startups: {
          columns: ['startup_type', 'ttid_ms', 'dur_ms'],
          rows: [['cold', 1250, 1580]],
        },
      },
    };

    const result = transformStartup(response);
    expect(result.startups).toHaveLength(1);
    expect(result.transformed.launch_type).toBe('cold');
    expect(result.transformed.ttid).toBe(1250);
    expect(result.transformed.dur_ms).toBe(1580);
  });
});