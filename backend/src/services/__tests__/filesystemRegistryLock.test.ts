// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';

import {
  withFilesystemRegistryLock,
  withFilesystemRegistryLockAsync,
} from '../filesystemRegistryLock';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

describe('withFilesystemRegistryLock', () => {
  it('fails closed during contention and releases after a successful mutation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lock-'));
    directories.push(directory);
    const storagePath = path.join(directory, 'registry.json');
    const lockPath = `${storagePath}.lock`;
    fs.mkdirSync(lockPath);

    expect(() => withFilesystemRegistryLock(storagePath, 'registry_busy', () => undefined))
      .toThrow('registry_busy');
    fs.rmSync(lockPath, {recursive: true, force: true});

    expect(withFilesystemRegistryLock(storagePath, 'registry_busy', () => 42)).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('recovers a stale lock directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lock-'));
    directories.push(directory);
    const storagePath = path.join(directory, 'registry.json');
    const lockPath = `${storagePath}.lock`;
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);

    expect(withFilesystemRegistryLock(storagePath, 'registry_busy', () => 'ok')).toBe('ok');
  });

  it('holds the lease until asynchronous work settles', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lock-'));
    directories.push(directory);
    const storagePath = path.join(directory, 'registry.json');
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });

    const first = withFilesystemRegistryLockAsync(storagePath, 'registry_busy', async lease => {
      entered();
      await held;
      lease.assertHeld();
      return 42;
    });
    await started;

    await expect(withFilesystemRegistryLockAsync(
      storagePath,
      'registry_busy',
      async () => 7,
    )).rejects.toThrow('registry_busy');
    release();
    await expect(first).resolves.toBe(42);
    expect(fs.existsSync(`${storagePath}.lock`)).toBe(false);
  });
});
