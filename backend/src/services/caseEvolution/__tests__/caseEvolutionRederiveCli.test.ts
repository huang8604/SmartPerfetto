// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import packageJson from '../../../../package.json';
import { parseRederiveCliArgs } from '../caseEvolutionRederiveCli';

describe('caseEvolutionRederiveCli', () => {
  it('exposes an operator-triggered rederive command', () => {
    expect(packageJson.scripts['case-evolution:rederive']).toBe(
      'tsx src/services/caseEvolution/caseEvolutionRederiveCli.ts',
    );
  });

  it('parses the default crash-recovery rederive scope', () => {
    expect(parseRederiveCliArgs([])).toEqual({
      ok: true,
      dryRun: false,
    });
  });
});
