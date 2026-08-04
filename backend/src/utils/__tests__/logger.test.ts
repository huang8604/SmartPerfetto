// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import logger, {
  diagnosticLogIdentity,
  setLogLevel,
  sqlLogIdentity,
} from '../logger';

afterEach(() => {
  setLogLevel(null);
  jest.restoreAllMocks();
});

describe('privacy-safe SQL logging', () => {
  it('logs only a stable hash and byte length, never SQL literals', () => {
    const canary = 'PRIVATE_SQL_LOG_CANARY';
    const sql = `SELECT '${canary}' AS leaked_source`;
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    setLogLevel('debug');

    logger.sql('TraceProcessor', sql, 12);

    const output = JSON.stringify(consoleLog.mock.calls);
    expect(output).not.toContain(canary);
    expect(output).toContain(sqlLogIdentity(sql));
    expect(output).toContain('12ms');
  });

  it('classifies diagnostic errors without retaining echoed SQL literals', () => {
    const canary = 'PRIVATE_SQL_ERROR_CANARY';
    const diagnostic = diagnosticLogIdentity(`syntax error near '${canary}'`, {
      domain: 'trace_processor',
      classifier: 'sql',
    });

    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).toContain('domain=trace_processor');
    expect(diagnostic).toContain('code=syntax');
    expect(diagnostic).toMatch(/sha256=[a-f0-9]{16}/);
    expect(diagnostic).toMatch(/bytes=\d+/);
  });

  it('does not classify non-SQL failures as query errors', () => {
    const diagnostic = diagnosticLogIdentity('child process exited with status 7', {
      domain: 'runtime_process',
      code: 'process_exit',
    });

    expect(diagnostic).toContain('domain=runtime_process');
    expect(diagnostic).toContain('code=process_exit');
    expect(diagnostic).not.toContain('query_error');
  });
});
