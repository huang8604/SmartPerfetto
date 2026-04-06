// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { unwrapStepResult } from '../helpers';

describe('strategy helpers unwrapStepResult', () => {
  it('unwraps plain StepResult payload', () => {
    const wrapped = {
      stepId: 'demo_step',
      success: true,
      data: [{ id: 1, name: 'row' }],
      executionTimeMs: 5,
    };

    expect(unwrapStepResult(wrapped)).toEqual([{ id: 1, name: 'row' }]);
  });

  it('unwraps nested skill result via rawResults.root.data', () => {
    const wrapped = {
      stepId: 'get_startups',
      success: true,
      data: {
        skillId: 'startup_events_in_range',
        success: true,
        rawResults: {
          root: {
            stepId: 'root',
            success: true,
            data: [{ startup_id: 2 }],
          },
        },
      },
      executionTimeMs: 12,
    };

    expect(unwrapStepResult(wrapped)).toEqual([{ startup_id: 2 }]);
  });

  it('unwraps nested skill result via first rawResults step fallback', () => {
    const wrapped = {
      stepId: 'some_skill_step',
      success: true,
      data: {
        skillId: 'some_skill',
        success: true,
        rawResults: {
          step_a: {
            stepId: 'step_a',
            success: true,
            data: [{ key: 'value' }],
          },
        },
      },
      executionTimeMs: 7,
    };

    expect(unwrapStepResult(wrapped)).toEqual([{ key: 'value' }]);
  });

  it('keeps non-wrapper payload unchanged', () => {
    const payload = { columns: ['a'], rows: [[1]] };
    expect(unwrapStepResult(payload)).toEqual(payload);
  });
});