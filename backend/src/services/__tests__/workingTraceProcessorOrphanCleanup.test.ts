// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {
  findOrphanTraceProcessorPids,
  killOrphanProcessors,
  parseTraceProcessorProcessTable,
} from '../workingTraceProcessor';

const PROCESS_TABLE = `
  101     1 /opt/smartperfetto/trace_processor_shell
  202   200 /opt/Smart Perfetto/trace_processor_shell
  303   300 trace_processor
  404   400 /usr/bin/node
  505   500 /usr/bin/trace_processor_helper
`;

const resolveExecutable = (pid: number): string | undefined =>
  pid === 303 ? '/opt/smartperfetto/trace_processor_shell' : undefined;

describe('trace processor orphan cleanup', () => {
  it('parses only exact trace processor executables, including truncated comm names', () => {
    expect(parseTraceProcessorProcessTable(PROCESS_TABLE, resolveExecutable)).toEqual([
      expect.objectContaining({pid: 101, parentPid: 1}),
      expect.objectContaining({pid: 202, parentPid: 200}),
      expect.objectContaining({pid: 303, parentPid: 300}),
    ]);
  });

  it('does not classify a processor owned by a live backend as orphaned', () => {
    const liveParents = new Set([200]);
    expect(findOrphanTraceProcessorPids(
      PROCESS_TABLE,
      pid => liveParents.has(pid),
      resolveExecutable,
    )).toEqual([101, 303]);
  });

  it('uses the same owner-liveness contract for Windows process rows', () => {
    const windowsTable = [
      '601 600 trace_processor_shell.exe',
      '602 599 trace_processor_shell.exe',
    ].join('\n');
    expect(findOrphanTraceProcessorPids(
      windowsTable,
      pid => pid === 600,
    )).toEqual([602]);
  });

  it('does not depend on Darwin truncated comm output', () => {
    expect(parseTraceProcessorProcessTable('701 1 /Users/chris/Cod')).toEqual([]);
    expect(findOrphanTraceProcessorPids(
      '701 1 trace_processor_shell',
      () => false,
    )).toEqual([701]);
  });

  it('terminates only processors whose owner is gone', () => {
    const terminateProcess = jest.fn<(pid: number) => void>();
    const killed = killOrphanProcessors({
      processTable: PROCESS_TABLE,
      isProcessAlive: pid => pid === 200,
      resolveProcessExecutable: resolveExecutable,
      terminateProcess,
    });

    expect(killed).toBe(2);
    expect(terminateProcess.mock.calls).toEqual([[101], [303]]);
  });
});
