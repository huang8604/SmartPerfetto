// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {shouldCleanOrphanProcessorsOnStartup} from '../startupCleanupPolicy';

describe('shouldCleanOrphanProcessorsOnStartup', () => {
  it('keeps the default startup cleanup behavior', () => {
    expect(shouldCleanOrphanProcessorsOnStartup({})).toBe(true);
  });

  it('skips global cleanup for isolated process owners', () => {
    expect(
      shouldCleanOrphanProcessorsOnStartup({
        SMARTPERFETTO_SKIP_ORPHAN_TRACE_PROCESSOR_CLEANUP: '1',
      }),
    ).toBe(false);
  });

  it('does not treat other values as an opt-out', () => {
    expect(
      shouldCleanOrphanProcessorsOnStartup({
        SMARTPERFETTO_SKIP_ORPHAN_TRACE_PROCESSOR_CLEANUP: 'true',
      }),
    ).toBe(true);
  });
});
