// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { runCaptureAndroidCommand } from '../capture';
import type { AdbCommandRunner } from '../../services/androidCapture';

jest.mock('../../bootstrap', () => ({
  bootstrap: jest.fn(() => ({ paths: { root: '/tmp/smp', sessions: '/tmp/smp/sessions' } })),
}));

describe('capture CLI command', () => {
  const originalEnv = { ...process.env };
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, SMARTPERFETTO_AI_ENABLED: 'false' };
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('blocks capture android --analyze before starting adb capture work when AI is disabled', async () => {
    const runner: AdbCommandRunner = {
      run: jest.fn(async () => ({ stdout: '', stderr: '' })),
    };

    const exitCode = await runCaptureAndroidCommand({
      preset: 'startup',
      app: 'com.example.app',
      out: '/tmp/smartperfetto-disabled-policy-smoke.pftrace',
      analyze: true,
      verbose: false,
      noColor: true,
      format: 'json',
      runner,
    });

    expect(exitCode).toBe(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: false,
      type: 'error',
    });
    expect(payload.error).toContain('AI is disabled by SMARTPERFETTO_AI_ENABLED=false');
  });
});
