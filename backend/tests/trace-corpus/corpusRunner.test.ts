// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';

import {
  assertExpectationRows,
  loadCorpus,
  resolveParameterTokens,
  runCorpusRegression,
  sqlResultState,
} from './corpusRunner';

const repoRoot = path.resolve(__dirname, '../../..');

describe('Trace corpus regression runner', () => {
  it('loads the generated catalog and exact current coverage inventory', () => {
    const corpus = loadCorpus(repoRoot);

    expect(corpus.cases).toHaveLength(18);
    expect(corpus.coverage.missing).toEqual({skills: [], strategies: []});
    expect(corpus.coverage.covered.skills.length).toBeGreaterThan(200);
    expect(corpus.coverage.covered.strategies.length).toBeGreaterThan(20);
  });

  it('requires declared value-level semantic evidence', () => {
    expect(() => assertExpectationRows(
      [{kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 12_000_000}],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        min_rows: 1,
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).not.toThrow();
    expect(() => assertExpectationRows(
      [
        {kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 1},
        {kernel: 'wrong', dur_ns: 12_000_000},
      ],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).toThrow('no single result row satisfies');
  });

  it('resolves trace and fixture identity tokens without changing literals', () => {
    expect(resolveParameterTokens(
      {
        start_ts: '${trace_start}',
        end_ts: '${trace_end}',
        upid: '${fixture_upid}',
        utid: '${fixture_utid}',
        package: 'com.smartperfetto.fixture',
      },
      {trace_start: '10', trace_end: '20', fixture_upid: 30, fixture_utid: 40},
    )).toEqual({
      start_ts: '10',
      end_ts: '20',
      upid: 30,
      utid: 40,
      package: 'com.smartperfetto.fixture',
    });
  });

  it('does not treat skipped or optional-error SQL as executed', () => {
    expect(sqlResultState({success: true, code: 'condition_not_met'})).toBe('condition_skipped');
    expect(sqlResultState({
      success: true,
      code: 'optional_query_error',
      error: 'no such table: optional_table',
    })).toBe('failed');
    expect(sqlResultState({success: true})).toBe('executed');
  });

  it('executes startup_analysis and startup Strategy against the constructed startup case', async () => {
    const result = await runCorpusRegression(repoRoot, {
      caseIds: ['startup-lifecycle'],
      targetIds: ['startup_analysis', 'startup'],
      writeEvidence: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.executed).toEqual(expect.arrayContaining([
      'startup-lifecycle:skill:startup_analysis',
      'startup-lifecycle:strategy:startup',
    ]));
  }, 120_000);
});
