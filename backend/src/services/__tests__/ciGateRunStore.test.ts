// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {CiGateRunStore} from '../ciGateRunStore';
import {makeSparkProvenance} from '../../types/sparkContracts';
import {CiGateRunRecord} from '../../types/ciGateContracts';

let store: CiGateRunStore;

beforeEach(() => {
  store = new CiGateRunStore({dbPath: ':memory:'});
});

afterEach(() => {
  store.close();
});

function makeRun(overrides: Partial<CiGateRunRecord> = {}): CiGateRunRecord {
  const base: CiGateRunRecord = {
    ...makeSparkProvenance({source: 'ciGateRunStore-test'}),
    schemaVersion: 1,
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2)}`,
    gateId: 'startup-cold-p95',
    baselineId: 'app/dev/build/cuj',
    baselineStatus: 'published',
    ciSource: 'github_actions',
    candidateSnapshot: {kind: 'trace', metrics: [], traceId: 't1'},
    rulesSnapshot: [{metricId: 'm1', threshold: 0.1}],
    result: {
      ...makeSparkProvenance({source: 'test-gate'}),
      gateId: 'startup-cold-p95',
      baselineId: 'app/dev/build/cuj',
      status: 'pass',
    },
    createdAt: Date.now(),
  };
  return {...base, ...overrides};
}

describe('CiGateRunStore — recordRun + getRun', () => {
  it('persists a run and returns it verbatim', () => {
    const run = makeRun({runId: 'r1'});
    store.recordRun(run);
    const fetched = store.getRun('r1');
    expect(fetched?.runId).toBe('r1');
    expect(fetched?.gateId).toBe('startup-cold-p95');
    expect(fetched?.result.status).toBe('pass');
  });

  it('returns undefined for unknown runId', () => {
    expect(store.getRun('does-not-exist')).toBeUndefined();
  });

  it('refuses duplicate runId (PRIMARY KEY constraint)', () => {
    store.recordRun(makeRun({runId: 'dup'}));
    expect(() => store.recordRun(makeRun({runId: 'dup'}))).toThrow();
  });
});

describe('CiGateRunStore — listRuns', () => {
  it('returns empty list when store is empty', () => {
    expect(store.listRuns()).toEqual([]);
  });

  it('orders newest first by createdAt', () => {
    const now = Date.now();
    store.recordRun(makeRun({runId: 'old', createdAt: now - 3000}));
    store.recordRun(makeRun({runId: 'mid', createdAt: now - 2000}));
    store.recordRun(makeRun({runId: 'new', createdAt: now}));
    const ids = store.listRuns().map(r => r.runId);
    expect(ids).toEqual(['new', 'mid', 'old']);
  });

  it('filters by gateId', () => {
    store.recordRun(makeRun({runId: 'r1', gateId: 'gate-a'}));
    store.recordRun(makeRun({runId: 'r2', gateId: 'gate-b'}));
    const filtered = store.listRuns({gateId: 'gate-b'});
    expect(filtered.map(r => r.runId)).toEqual(['r2']);
  });

  it('filters by result status', () => {
    const fail = makeRun({runId: 'rf'});
    fail.result = {...fail.result, status: 'fail'};
    const pass = makeRun({runId: 'rp'});
    store.recordRun(fail);
    store.recordRun(pass);
    expect(store.listRuns({status: 'fail'}).map(r => r.runId)).toEqual(['rf']);
  });

  it('filters by ciSource', () => {
    store.recordRun(makeRun({runId: 'gh', ciSource: 'github_actions'}));
    store.recordRun(makeRun({runId: 'gl', ciSource: 'gitlab_ci'}));
    expect(store.listRuns({ciSource: 'gitlab_ci'}).map(r => r.runId)).toEqual([
      'gl',
    ]);
  });

  it('clamps limit to a hard ceiling of 200', () => {
    const now = Date.now();
    for (let i = 0; i < 250; i++) {
      store.recordRun(makeRun({runId: `r${i}`, createdAt: now - 250 + i}));
    }
    expect(store.listRuns({limit: 1000}).length).toBe(200);
  });

  it('uses default limit of 50 when none specified', () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      store.recordRun(makeRun({runId: `r${i}`, createdAt: now - 60 + i}));
    }
    expect(store.listRuns().length).toBe(50);
  });
});

describe('CiGateRunStore — retention eviction inside recordRun transaction', () => {
  it('evicts records older than the retention window when a new run is recorded', () => {
    const shortWindow = new CiGateRunStore({
      dbPath: ':memory:',
      retentionMs: 10_000,
    });
    try {
      const now = Date.now();
      shortWindow.recordRun(makeRun({runId: 'old', createdAt: now - 60_000}));
      shortWindow.recordRun(makeRun({runId: 'fresh', createdAt: now}));
      const ids = shortWindow.listRuns().map(r => r.runId);
      expect(ids).toContain('fresh');
      expect(ids).not.toContain('old');
    } finally {
      shortWindow.close();
    }
  });

  it('keeps records that are right at the retention boundary', () => {
    const shortWindow = new CiGateRunStore({
      dbPath: ':memory:',
      retentionMs: 10_000,
    });
    try {
      const now = Date.now();
      shortWindow.recordRun(makeRun({runId: 'edge', createdAt: now - 5_000}));
      shortWindow.recordRun(makeRun({runId: 'fresh', createdAt: now}));
      const ids = shortWindow.listRuns().map(r => r.runId);
      expect(ids).toContain('edge');
      expect(ids).toContain('fresh');
    } finally {
      shortWindow.close();
    }
  });
});
