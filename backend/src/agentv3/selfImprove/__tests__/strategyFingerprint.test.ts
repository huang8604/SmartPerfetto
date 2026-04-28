// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  computePatchFingerprint,
  computeStrategyContentHash,
  detectDrift,
  RunSnapshotRegistry,
  type StrategyVersionFingerprint,
} from '../strategyFingerprint';
import { getRegisteredScenes, invalidateStrategyCache, type PhaseHint } from '../../strategyLoader';

const baseHint: PhaseHint = {
  id: 'phase_2_6',
  keywords: ['vsync', 'vrr'],
  constraints: 'invoke vsync_dynamics_analysis first',
  criticalTools: ['vsync_dynamics_analysis'],
  critical: true,
};

describe('computePatchFingerprint', () => {
  it('returns a 16-char hex hash', () => {
    expect(computePatchFingerprint(baseHint)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is stable for cosmetic differences', () => {
    const reordered: PhaseHint = {
      ...baseHint,
      keywords: ['vrr', 'vsync'],
      criticalTools: [' VSYNC_DYNAMICS_ANALYSIS '],
      constraints: '  invoke vsync_dynamics_analysis first  ',
    };
    expect(computePatchFingerprint(reordered)).toBe(computePatchFingerprint(baseHint));
  });

  it('differentiates entries with different content', () => {
    const changed: PhaseHint = { ...baseHint, constraints: 'invoke other_skill first' };
    expect(computePatchFingerprint(changed)).not.toBe(computePatchFingerprint(baseHint));
  });

  it('differentiates entries when only the id changes', () => {
    expect(computePatchFingerprint({ ...baseHint, id: 'phase_3_1' })).not.toBe(
      computePatchFingerprint(baseHint),
    );
  });

  it('differentiates `critical` true vs false', () => {
    expect(computePatchFingerprint({ ...baseHint, critical: false })).not.toBe(
      computePatchFingerprint(baseHint),
    );
  });
});

describe('detectDrift', () => {
  function fp(overrides: Partial<StrategyVersionFingerprint> = {}): StrategyVersionFingerprint {
    return {
      strategyFile: 'scrolling.strategy.md',
      strategyContentHash: 'aaa111',
      patchFingerprint: computePatchFingerprint(baseHint),
      phaseHintId: baseHint.id,
      appliedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  it('reports `none` when both hashes match exactly', () => {
    expect(detectDrift({
      fingerprint: fp(),
      currentHints: [baseHint],
      currentContentHash: 'aaa111',
    })).toBe('none');
  });

  it('reports `whole_file_only` when content hash differs but patch is intact', () => {
    expect(detectDrift({
      fingerprint: fp(),
      currentHints: [baseHint],
      currentContentHash: 'bbb222',
    })).toBe('whole_file_only');
  });

  it('reports `patch_changed` when targeted phase_hint normalized differently', () => {
    const changedHint: PhaseHint = { ...baseHint, constraints: 'something different now' };
    expect(detectDrift({
      fingerprint: fp(),
      currentHints: [changedHint],
      currentContentHash: 'bbb222',
    })).toBe('patch_changed');
  });

  it('reports `patch_deleted` when the targeted phase_hint id is gone', () => {
    expect(detectDrift({
      fingerprint: fp(),
      currentHints: [{ ...baseHint, id: 'unrelated_phase' }],
      currentContentHash: 'aaa111',
    })).toBe('patch_deleted');
  });

  it('falls back to fingerprint match when phaseHintId is missing', () => {
    expect(detectDrift({
      fingerprint: fp({ phaseHintId: undefined }),
      currentHints: [baseHint],
      currentContentHash: 'aaa111',
    })).toBe('none');
  });

  it('reports `none` for scene-level fingerprints when content hash matches', () => {
    expect(detectDrift({
      fingerprint: fp({ patchFingerprint: '' }),
      currentHints: [],
      currentContentHash: 'aaa111',
    })).toBe('none');
  });

  it('reports `whole_file_only` for scene-level fingerprints when content differs', () => {
    expect(detectDrift({
      fingerprint: fp({ patchFingerprint: '' }),
      currentHints: [],
      currentContentHash: 'bbb222',
    })).toBe('whole_file_only');
  });
});

describe('RunSnapshotRegistry', () => {
  it('returns undefined when nothing has been captured', () => {
    const r = new RunSnapshotRegistry();
    expect(r.get('sess-1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('captures a snapshot keyed on sessionId', () => {
    const r = new RunSnapshotRegistry();
    const snap = r.capture('sess-1', 'general');
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.sceneType).toBe('general');
    expect(snap.fingerprint.appliedAt).toBeGreaterThan(0);
    expect(r.get('sess-1')).toBeDefined();
    expect(r.size()).toBe(1);
  });

  it('release() removes the snapshot', () => {
    const r = new RunSnapshotRegistry();
    r.capture('sess-1', 'general');
    r.release('sess-1');
    expect(r.get('sess-1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('re-capture refreshes the snapshot in place (multi-turn)', () => {
    const r = new RunSnapshotRegistry();
    const first = r.capture('sess-1', 'general');
    const second = r.capture('sess-1', 'general');
    expect(r.size()).toBe(1);
    expect(second.fingerprint.appliedAt).toBeGreaterThanOrEqual(first.fingerprint.appliedAt);
  });
});

/**
 * Regression for Codex F.6: previously `strategyFilePath(scene)` joined
 * `${scene}.strategy.md`, which silently produced an empty content hash
 * for scenes whose file basename uses a hyphen (touch_tracking,
 * scroll_response). The loader now exposes the real source path; this
 * test exercises the real on-disk strategies (no mock).
 */
describe('computeStrategyContentHash resolves real source path', () => {
  beforeAll(() => invalidateStrategyCache());

  it('returns a 64-char hex hash for every registered scene', () => {
    const scenes = getRegisteredScenes().map(s => s.scene);
    expect(scenes.length).toBeGreaterThanOrEqual(12);
    for (const scene of scenes) {
      expect(computeStrategyContentHash(scene)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('resolves underscore scene ids whose file basename uses a hyphen', () => {
    expect(computeStrategyContentHash('touch_tracking')).toMatch(/^[a-f0-9]{64}$/);
    expect(computeStrategyContentHash('scroll_response')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns empty string for unknown scenes', () => {
    expect(computeStrategyContentHash('this-scene-does-not-exist')).toBe('');
  });
});
