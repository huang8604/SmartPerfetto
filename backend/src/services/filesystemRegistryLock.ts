// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';

const DEFAULT_STALE_LOCK_MS = 60_000;

export interface FilesystemRegistryLease {
  assertHeld(): void;
}

interface AcquiredFilesystemLock extends FilesystemRegistryLease {
  release(): void;
}

function readOwnerToken(lockPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as {token?: unknown};
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function acquireFilesystemLock(
  storagePath: string,
  busyError: string,
  staleLockMs: number,
): AcquiredFilesystemLock {
  fs.mkdirSync(path.dirname(storagePath), {recursive: true});
  const lockPath = `${storagePath}.lock`;
  const ownerToken = randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    let createdDirectory = false;
    try {
      fs.mkdirSync(lockPath);
      createdDirectory = true;
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({token: ownerToken, pid: process.pid, acquiredAt: Date.now()}),
        {encoding: 'utf8', flag: 'wx'},
      );
      acquired = true;
    } catch (error) {
      if (createdDirectory) {
        fs.rmSync(lockPath, {recursive: true, force: true});
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleLockMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        continue;
      }
      if (!stale) throw new Error(busyError);
      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        fs.renameSync(lockPath, stalePath);
        fs.rmSync(stalePath, {recursive: true, force: true});
      } catch {
        throw new Error(busyError);
      }
    }
  }

  if (!acquired) throw new Error(busyError);
  let released = false;
  const assertHeld = (): void => {
    if (released || readOwnerToken(lockPath) !== ownerToken) {
      throw new Error(`${busyError}_lease_lost`);
    }
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  };
  return {
    assertHeld,
    release: () => {
      if (released) return;
      released = true;
      if (readOwnerToken(lockPath) === ownerToken) {
        fs.rmSync(lockPath, {recursive: true, force: true});
      }
    },
  };
}

/**
 * Serializes read-modify-write registry snapshots across backend processes.
 * Contention fails closed instead of allowing one process to overwrite a
 * consent or generation update made by another process.
 */
export function withFilesystemRegistryLock<T>(
  storagePath: string,
  busyError: string,
  operation: () => T,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
): T {
  const lease = acquireFilesystemLock(storagePath, busyError, staleLockMs);
  try {
    return operation();
  } finally {
    lease.release();
  }
}

/** Holds a cross-process lease until asynchronous ingest work settles. */
export async function withFilesystemRegistryLockAsync<T>(
  storagePath: string,
  busyError: string,
  operation: (lease: FilesystemRegistryLease) => Promise<T> | T,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
): Promise<T> {
  const lease = acquireFilesystemLock(storagePath, busyError, staleLockMs);
  const heartbeat = setInterval(() => {
    try {
      lease.assertHeld();
    } catch {
      clearInterval(heartbeat);
    }
  }, Math.max(1_000, Math.floor(staleLockMs / 3)));
  heartbeat.unref?.();
  try {
    return await operation(lease);
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}
