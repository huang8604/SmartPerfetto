// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { startCaseEvolutionWorker } from '../caseEvolutionWorkerBootstrap';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('startCaseEvolutionWorker', () => {
  it('validates case-evolution flags at startup even when the review worker is off', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const handle = startCaseEvolutionWorker({
      CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
    } as NodeJS.ProcessEnv);

    expect(handle.started).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PROMPT_INJECT_ENABLED requires RETRIEVE_ENABLED'),
    );
  });
});
