// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  evaluateAssertion,
  resolvePath,
  runDomainSkillEvalHarness,
} from '../domainSkillEvalHarness';
import {
  makeSparkProvenance,
  type DomainSkillEvalContract,
} from '../../types/sparkContracts';

describe('resolvePath', () => {
  it('walks dot-notation paths', () => {
    const r = resolvePath({summary: {ttid_ms: 1234}}, '$.summary.ttid_ms');
    expect(r.found).toBe(true);
    expect(r.value).toBe(1234);
  });

  it('walks array index paths', () => {
    const r = resolvePath(
      {diagnostics: [{reason_code: 'workload_heavy'}]},
      '$.diagnostics[0].reason_code',
    );
    expect(r.found).toBe(true);
    expect(r.value).toBe('workload_heavy');
  });

  it('reports not found for missing keys', () => {
    expect(resolvePath({}, '$.missing.path').found).toBe(false);
  });
});

describe('evaluateAssertion', () => {
  it('checks equality without operator prefix', () => {
    expect(
      evaluateAssertion({a: 'x'}, {path: '$.a', expected: 'x'}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 'x'}, {path: '$.a', expected: 'y'}).ok,
    ).toBe(false);
  });

  it('honors numeric comparison operators', () => {
    expect(
      evaluateAssertion({a: 100}, {path: '$.a', expected: '<200'}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 100}, {path: '$.a', expected: '<=100'}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 100}, {path: '$.a', expected: '>=200'}).ok,
    ).toBe(false);
  });

  it('honors absolute tolerance on numeric comparisons (Codex regression)', () => {
    // Without tolerance, 101 vs 100 string-compares and fails.
    expect(
      evaluateAssertion({a: 101}, {path: '$.a', expected: '100'}).ok,
    ).toBe(false);
    // With tolerance >= 1, treat as absolute tolerance.
    expect(
      evaluateAssertion({a: 101}, {path: '$.a', expected: '100', tolerance: 2}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 110}, {path: '$.a', expected: '100', tolerance: 2}).ok,
    ).toBe(false);
  });

  it('treats tolerance < 1 as a fraction of expected value', () => {
    // 5% tolerance on 100 → ±5
    expect(
      evaluateAssertion({a: 104}, {path: '$.a', expected: '100', tolerance: 0.05}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 110}, {path: '$.a', expected: '100', tolerance: 0.05}).ok,
    ).toBe(false);
  });

  it('tolerance widens threshold operators rather than replacing them (Codex round 4 regression)', () => {
    // <2500 with 5% tolerance → effective bound is < 2625.
    // 100 must still pass because it's below 2500.
    expect(
      evaluateAssertion({a: 100}, {path: '$.a', expected: '<2500', tolerance: 0.05}).ok,
    ).toBe(true);
    // 2400 < 2500, also passes.
    expect(
      evaluateAssertion({a: 2400}, {path: '$.a', expected: '<2500', tolerance: 0.05}).ok,
    ).toBe(true);
    // 2600 > 2500 but within +5% slack (2625), passes.
    expect(
      evaluateAssertion({a: 2600}, {path: '$.a', expected: '<2500', tolerance: 0.05}).ok,
    ).toBe(true);
    // 2700 > 2625 even with slack, fails.
    expect(
      evaluateAssertion({a: 2700}, {path: '$.a', expected: '<2500', tolerance: 0.05}).ok,
    ).toBe(false);
    // >=10 with absolute tolerance 1 → effective bound is >= 9.
    expect(
      evaluateAssertion({a: 9}, {path: '$.a', expected: '>=10', tolerance: 1}).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({a: 8}, {path: '$.a', expected: '>=10', tolerance: 1}).ok,
    ).toBe(false);
  });
});

describe('runDomainSkillEvalHarness', () => {
  function buildContract(): DomainSkillEvalContract {
    return {
      ...makeSparkProvenance({source: 'eval-harness-test'}),
      cases: [
        {
          caseId: 'scrolling/jank/heavy',
          tracePath: 'fixtures/heavy.pftrace',
          skillId: 'scrolling_analysis',
        },
      ],
      assertions: {
        'scrolling/jank/heavy': [
          {path: '$.diagnostics[0].reason_code', expected: 'workload_heavy'},
          {path: '$.summary.jank_count', expected: '<10'},
        ],
      },
      coverage: [{sparkId: 99, planId: '18', status: 'implemented'}],
    };
  }

  it('marks pass when all assertions hold', async () => {
    const runner = async () => ({
      diagnostics: [{reason_code: 'workload_heavy'}],
      summary: {jank_count: 5},
    });
    const results = await runDomainSkillEvalHarness({contract: buildContract(), runner});
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
    expect(results[0].assertionsPassed).toBe(2);
    expect(results[0].assertionsFailed).toBe(0);
  });

  it('records per-assertion failures', async () => {
    const runner = async () => ({
      diagnostics: [{reason_code: 'lock_contention'}],
      summary: {jank_count: 50},
    });
    const results = await runDomainSkillEvalHarness({contract: buildContract(), runner});
    expect(results[0].status).toBe('fail');
    expect(results[0].assertionsFailed).toBe(2);
    expect(results[0].failures).toHaveLength(2);
  });

  it('captures runner exceptions as a single failure', async () => {
    const runner = async () => {
      throw new Error('trace_processor crash');
    };
    const results = await runDomainSkillEvalHarness({contract: buildContract(), runner});
    expect(results[0].status).toBe('fail');
    expect(results[0].failures && results[0].failures[0].actual).toMatch(/crash/);
  });

  it('respects filterCaseIds', async () => {
    const runner = async () => ({});
    const results = await runDomainSkillEvalHarness({
      contract: buildContract(),
      runner,
      filterCaseIds: ['some/other/case'],
    });
    expect(results).toEqual([]);
  });
});
