// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {signalProcessGroup} = require('../e2e/process-harness.cjs');

test('Windows process shutdown targets the complete descendant tree', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({command, args, options});
    return {status: 0, stdout: 'SUCCESS', stderr: '', error: null};
  };
  const tracked = {child: {pid: 4242}, exitResult: null};

  signalProcessGroup(tracked, 'SIGTERM', 'win32', runner);
  signalProcessGroup(tracked, 'SIGKILL', 'win32', runner);

  assert.deepEqual(calls.map(({command, args}) => ({command, args})), [
    {command: 'taskkill', args: ['/PID', '4242', '/T']},
    {command: 'taskkill', args: ['/PID', '4242', '/T', '/F']},
  ]);
  assert.equal(tracked.windowsTreeSignal.succeeded, true);
});

test('Windows process shutdown surfaces taskkill failures while the child is alive', () => {
  const tracked = {child: {pid: 5252}, exitResult: null};
  assert.throws(
    () => signalProcessGroup(tracked, 'SIGTERM', 'win32', () => ({
      status: 1,
      stdout: '',
      stderr: 'tree termination failed',
      error: null,
    })),
    /tree termination failed/,
  );
});

test('Windows process shutdown still surfaces unresolved trees after the parent exits', () => {
  const tracked = {
    child: {pid: 6262},
    exitResult: {code: 0, signal: null, error: null},
  };
  assert.throws(
    () => signalProcessGroup(tracked, 'SIGKILL', 'win32', () => ({
      status: 1,
      stdout: '',
      stderr: 'parent not found; descendants unresolved',
      error: null,
    })),
    /descendants unresolved/,
  );
  assert.equal(tracked.windowsTreeSignal.succeeded, false);
});
