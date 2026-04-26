// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';

type ExecFileResult = { stdout: string; stderr: string };
const execFileMock = jest.fn<(cmd: string, args: string[], opts: unknown) => Promise<ExecFileResult>>();

jest.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, result?: ExecFileResult) => void) => {
    // Adapter shim — promisify(execFile) calls the cb-style signature.
    Promise.resolve(execFileMock(cmd, args, opts))
      .then(result => cb(null, result))
      .catch(err => cb(err as Error));
  },
}));

import {
  createWorktree,
  removeWorktree,
  withWorktree,
  WorktreeError,
  __testing,
} from '../worktreeRunner';

describe('worktreeRunner', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
  });

  describe('jobId validation', () => {
    it.each([
      'simple',
      'with_underscore',
      'with-dash',
      'mixed_123-abc',
      'a',
      'a'.repeat(64),
    ])('accepts valid jobId %s', async (jobId) => {
      await expect(createWorktree({ jobId })).resolves.toMatchObject({ jobId });
    });

    it.each([
      ['empty string', ''],
      ['contains slash', 'foo/bar'],
      ['contains dot dot', '..'],
      ['contains space', 'foo bar'],
      ['contains semicolon', 'foo;rm'],
      ['contains shell metachar', 'foo$bar'],
      ['too long (65 chars)', 'a'.repeat(65)],
    ])('rejects invalid jobId — %s', async (_label, jobId) => {
      await expect(createWorktree({ jobId })).rejects.toBeInstanceOf(WorktreeError);
    });

    it('exposes the JOB_ID_RE used for validation', () => {
      expect(__testing.JOB_ID_RE.source).toBe('^[a-zA-Z0-9_-]{1,64}$');
    });
  });

  describe('createWorktree', () => {
    it('places the worktree under os.tmpdir()/sp-autopatch-<jobId>', async () => {
      const handle = await createWorktree({ jobId: 'job123' });
      const expected = path.join(os.tmpdir(), 'sp-autopatch-job123');
      expect(handle.worktreePath).toBe(expected);
      expect(__testing.resolveWorktreePath('job123')).toBe(expected);
    });

    it('uses git worktree add --detach <path> <ref>', async () => {
      await createWorktree({ jobId: 'j1', baseRef: 'main' });
      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['worktree', 'add', '--detach', expect.stringContaining('sp-autopatch-j1'), 'main'],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
    });

    it('defaults baseRef to main when not supplied', async () => {
      const handle = await createWorktree({ jobId: 'j2' });
      expect(handle.baseRef).toBe('main');
    });

    it('honors a custom baseRef', async () => {
      const handle = await createWorktree({ jobId: 'j3', baseRef: 'develop' });
      expect(handle.baseRef).toBe('develop');
      expect(execFileMock.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['develop']),
      );
    });

    it('honors a custom workingDir', async () => {
      const handle = await createWorktree({ jobId: 'j4', workingDir: '/tmp/repo' });
      expect(handle.workingDir).toBe('/tmp/repo');
      expect(execFileMock.mock.calls[0][2]).toMatchObject({ cwd: '/tmp/repo' });
    });

    it('wraps git failures in WorktreeError with cause preserved', async () => {
      const gitErr = new Error('fatal: invalid reference: bogus');
      execFileMock.mockRejectedValueOnce(gitErr);
      const promise = createWorktree({ jobId: 'j5', baseRef: 'bogus' });
      await expect(promise).rejects.toBeInstanceOf(WorktreeError);
      await expect(promise).rejects.toMatchObject({ cause: gitErr });
    });
  });

  describe('removeWorktree', () => {
    it('uses git worktree remove --force <path> by default', async () => {
      const handle = { jobId: 'j6', worktreePath: '/tmp/x', baseRef: 'main', workingDir: '/repo' };
      await removeWorktree(handle);
      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', '--force', '/tmp/x'],
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('omits --force when called with force=false', async () => {
      const handle = { jobId: 'j7', worktreePath: '/tmp/y', baseRef: 'main', workingDir: '/repo' };
      await removeWorktree(handle, false);
      expect(execFileMock.mock.calls[0][1]).not.toContain('--force');
    });

    it('swallows errors when force=true (best-effort cleanup)', async () => {
      execFileMock.mockRejectedValueOnce(new Error('not a worktree'));
      const handle = { jobId: 'j8', worktreePath: '/tmp/z', baseRef: 'main', workingDir: '/repo' };
      await expect(removeWorktree(handle, true)).resolves.toBeUndefined();
    });

    it('throws WorktreeError when force=false and git fails', async () => {
      execFileMock.mockRejectedValueOnce(new Error('busy'));
      const handle = { jobId: 'j9', worktreePath: '/tmp/w', baseRef: 'main', workingDir: '/repo' };
      await expect(removeWorktree(handle, false)).rejects.toBeInstanceOf(WorktreeError);
    });
  });

  describe('withWorktree', () => {
    it('creates, runs the callback, and removes — happy path', async () => {
      const cb = jest.fn(async (h: { worktreePath: string }) => h.worktreePath);
      const result = await withWorktree({ jobId: 'happy' }, cb);
      expect(result).toContain('sp-autopatch-happy');
      expect(cb).toHaveBeenCalledTimes(1);
      // Two execFile calls: one create, one remove.
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(execFileMock.mock.calls[0][1][0]).toBe('worktree');
      expect(execFileMock.mock.calls[0][1][1]).toBe('add');
      expect(execFileMock.mock.calls[1][1][1]).toBe('remove');
    });

    it('removes the worktree even when the callback throws', async () => {
      const boom = new Error('callback failed');
      const cb = jest.fn(async () => { throw boom; });
      await expect(withWorktree({ jobId: 'fail' }, cb as never)).rejects.toBe(boom);
      // create + remove still both invoked.
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(execFileMock.mock.calls[1][1][1]).toBe('remove');
    });

    it('does not call remove if create fails', async () => {
      execFileMock.mockRejectedValueOnce(new Error('add failed'));
      const cb = jest.fn();
      await expect(withWorktree({ jobId: 'addfail' }, cb as never)).rejects.toBeInstanceOf(WorktreeError);
      expect(cb).not.toHaveBeenCalled();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });
});
