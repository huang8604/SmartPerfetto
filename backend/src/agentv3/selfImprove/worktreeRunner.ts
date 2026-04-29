// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Git worktree wrapper for strategy auto-patch.
 *
 * Auto-patch must NEVER touch the developer's primary working tree: a failed
 * test, a regression, or a crash mid-patch could leave dirty state on `main`
 * and confuse the human reviewing the patch. Every patch attempt runs in a
 * tmp worktree keyed by jobId so multiple jobs can run in parallel without
 * stepping on each other.
 *
 * `withWorktree(opts, fn)` is the recommended entry — it guarantees cleanup
 * via try/finally even if `fn` throws.
 *
 * See docs/architecture/self-improving-design.md §13.2 (Worktree isolation).
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';

const execFile = promisify(execFileCb);

/** Whitelist for jobId — prevents shell injection and path traversal in tmp dir name. */
const JOB_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** In-flight jobIds; rejecting a duplicate avoids racing on the same tmp path. */
const ACTIVE_JOBS = new Set<string>();

export interface WorktreeOptions {
  /** Unique job ID. Must match `[a-zA-Z0-9_-]{1,64}`. */
  jobId: string;
  /** Branch / commit / ref to base the worktree on. Default: `main`. */
  baseRef?: string;
  /** Repository root. Default: `process.cwd()`. */
  workingDir?: string;
}

export interface WorktreeHandle {
  jobId: string;
  worktreePath: string;
  baseRef: string;
  workingDir: string;
}

export class WorktreeError extends Error {
  // Manual `cause` because tsconfig lib targets ES2020; ES2022's Error.cause
  // option to `super()` isn't available without a project-wide lib bump.
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WorktreeError';
  }
}

function assertValidJobId(jobId: string): void {
  if (!JOB_ID_RE.test(jobId)) {
    throw new WorktreeError(
      `invalid jobId "${jobId}" — must match ${JOB_ID_RE.source}`,
    );
  }
}

function resolveWorktreePath(jobId: string): string {
  return path.join(os.tmpdir(), `sp-autopatch-${jobId}`);
}

/**
 * Create a git worktree at `<tmpdir>/sp-autopatch-<jobId>` based on `baseRef`.
 *
 * Throws WorktreeError if jobId is invalid, already in flight, or git refuses.
 * Callers should pair this with `removeWorktree` in a `finally` block, or
 * simply use `withWorktree` which handles that automatically.
 */
export async function createWorktree(opts: WorktreeOptions): Promise<WorktreeHandle> {
  assertValidJobId(opts.jobId);
  if (ACTIVE_JOBS.has(opts.jobId)) {
    throw new WorktreeError(`jobId "${opts.jobId}" already has an active worktree`);
  }
  const baseRef = opts.baseRef || 'main';
  const workingDir = opts.workingDir || process.cwd();
  const worktreePath = resolveWorktreePath(opts.jobId);

  ACTIVE_JOBS.add(opts.jobId);
  try {
    await execFile('git', ['worktree', 'add', '--detach', worktreePath, baseRef], {
      cwd: workingDir,
    });
  } catch (err) {
    ACTIVE_JOBS.delete(opts.jobId);
    throw new WorktreeError(
      `failed to create worktree at ${worktreePath} from ${baseRef}: ${(err as Error).message}`,
      err,
    );
  }

  return { jobId: opts.jobId, worktreePath, baseRef, workingDir };
}

/**
 * Remove a previously-created worktree. Idempotent: if the path doesn't exist
 * git emits a recoverable error, which we swallow when `force === true` so
 * cleanup never masks the original error from the caller's main flow. The
 * swallowed error is logged for debuggability.
 */
export async function removeWorktree(handle: WorktreeHandle, force = true): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(handle.worktreePath);

  try {
    await execFile('git', args, { cwd: handle.workingDir });
  } catch (err) {
    if (force) {
      console.warn(
        `[worktreeRunner] best-effort cleanup of ${handle.worktreePath} failed: ${(err as Error).message}`,
      );
      return;
    }
    throw new WorktreeError(
      `failed to remove worktree ${handle.worktreePath}: ${(err as Error).message}`,
      err,
    );
  } finally {
    ACTIVE_JOBS.delete(handle.jobId);
  }
}

/**
 * Run `fn` inside a freshly-created worktree, cleaning up afterwards.
 *
 * Cleanup uses `force=true` so a failure inside `fn` doesn't leave an orphan
 * worktree on disk; the original error from `fn` always propagates.
 */
export async function withWorktree<T>(
  opts: WorktreeOptions,
  fn: (handle: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const handle = await createWorktree(opts);
  try {
    return await fn(handle);
  } finally {
    await removeWorktree(handle, true);
  }
}

/** Exposed for tests so they can inspect path resolution and validation rules. */
export const __testing = { resolveWorktreePath, JOB_ID_RE, ACTIVE_JOBS };
