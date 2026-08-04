// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {loadStrategies} from '../strategyLoader';

describe('general strategy contract', () => {
  it('bounds secondary-bottleneck closure for open-ended investigations', () => {
    const strategy = loadStrategies().get('general');

    expect(strategy).toBeDefined();
    const match = strategy?.content.match(
      /```json analysis-closure-contract\n([\s\S]*?)\n```/,
    );
    expect(match).toBeDefined();
    const contract = JSON.parse(match?.[1] ?? '{}') as {
      applies_to?: string;
      max_secondary_domains?: number;
      report_fields?: string[];
      skip_for?: string;
      stop_conditions?: string[];
    };
    expect(contract).toEqual({
      applies_to: 'open_ended_investigation',
      max_secondary_domains: 3,
      report_fields: [
        'checked_domains',
        'missing_data',
        'unresolved_alternatives',
      ],
      skip_for: 'bounded_question',
      stop_conditions: [
        'no_independent_high_impact_anomaly',
        'repeated_evidence',
        'missing_data',
        'budget_exhausted',
      ],
    });
  });
});
