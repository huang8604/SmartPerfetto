// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Domain Skill Regression / Eval Harness (Spark Plan 18)
 *
 * Executes a `DomainSkillEvalContract` against a caller-supplied skill
 * runner. The harness:
 *  - Iterates `cases[]` and runs each via `runner(case)` to obtain output.
 *  - Evaluates `assertions[caseId][]` using a small JSONPath subset
 *    (dot + index access plus comparison operators "<", "<=", ">", ">=", "=").
 *  - Records SkillEvalRunResult entries with status + per-assertion failures.
 *
 * Design choices:
 *  - JSONPath subset is intentional: full JSONPath would require a parser
 *    library; the subset covers what real assertions need
 *    (`$.summary.ttid_ms`, `$.diagnostics[0].reason_code`, etc).
 *  - Numeric assertions support `"<2500"`, `"<=2500"`, `">=10"`, `">5"`,
 *    `"=workload_heavy"` style strings; absence of an operator falls back
 *    to deep equality.
 */

import {
  type DomainSkillEvalContract,
  type SkillEvalAssertion,
  type SkillEvalRunResult,
} from '../types/sparkContracts';

export interface SkillRunner {
  (caseSpec: {caseId: string; tracePath: string; skillId: string}): Promise<any>;
}

export interface RunHarnessOptions {
  contract: DomainSkillEvalContract;
  runner: SkillRunner;
  /** Restrict to a subset of caseIds. */
  filterCaseIds?: string[];
}

interface ResolveResult {
  found: boolean;
  value?: any;
}

/** Resolve a JSONPath-subset expression against a value. */
export function resolvePath(root: any, path: string): ResolveResult {
  if (path === '$' || path === '') return {found: true, value: root};
  const trimmed = path.startsWith('$') ? path.slice(1) : path;
  const tokens = trimmed
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(t => t.length > 0);
  let cursor: any = root;
  for (const tok of tokens) {
    if (cursor === undefined || cursor === null) return {found: false};
    if (Array.isArray(cursor)) {
      const idx = Number(tok);
      if (!Number.isFinite(idx)) return {found: false};
      cursor = cursor[idx];
    } else if (typeof cursor === 'object') {
      if (!(tok in cursor)) return {found: false};
      cursor = cursor[tok];
    } else {
      return {found: false};
    }
  }
  return {found: true, value: cursor};
}

/** Evaluate a single assertion. Returns {ok, actual} so failures can record details. */
export function evaluateAssertion(
  output: any,
  assertion: SkillEvalAssertion,
): {ok: boolean; actual: string} {
  const {value, found} = resolvePath(output, assertion.path);
  const actual = found ? String(value) : '<not_found>';
  if (!found) return {ok: false, actual};

  const expected = assertion.expected.trim();
  const opMatch = expected.match(/^(<=|>=|<|>|=)?\s*(.*)$/);
  const op = opMatch?.[1];
  const expectedValue = (opMatch?.[2] ?? expected).trim();

  // Tolerance is interpreted as absolute when >= 1 and as a fraction of
  // the expected bound when < 1, matching how callers naturally express
  // it in YAML strategies.
  const tolerance = (typeof assertion.tolerance === 'number' && Number.isFinite(assertion.tolerance))
    ? assertion.tolerance
    : 0;
  const slackFor = (boundary: number): number =>
    tolerance >= 1 ? tolerance : Math.abs(boundary) * tolerance;

  // String equality (no operator, no numeric coercion needed).
  if ((!op || op === '=') && tolerance === 0) {
    return {ok: actual === expectedValue, actual};
  }

  const actualNum = Number(value);
  const expectedNum = Number(expectedValue);
  if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) {
    return {ok: false, actual};
  }

  // Tolerance widens the bound rather than replacing the operator —
  // Codex round 4 caught that the previous code threw away `<` / `>=`
  // semantics when tolerance was set, so `<2500 with tolerance 0.05`
  // wrongly required actual ≈ 2500 instead of actual < 2500*1.05.
  const tol = slackFor(expectedNum);
  switch (op) {
    case '<':
      return {ok: actualNum < expectedNum + tol, actual};
    case '<=':
      return {ok: actualNum <= expectedNum + tol, actual};
    case '>':
      return {ok: actualNum > expectedNum - tol, actual};
    case '>=':
      return {ok: actualNum >= expectedNum - tol, actual};
    case '=':
    default:
      return {ok: Math.abs(actualNum - expectedNum) <= tol, actual};
  }
}

/**
 * Run every case in `contract.cases` (optionally filtered) and return
 * SkillEvalRunResult[] capturing pass/fail/flaky/skipped status with
 * per-assertion failure traces.
 */
export async function runDomainSkillEvalHarness(
  options: RunHarnessOptions,
): Promise<SkillEvalRunResult[]> {
  const {contract, runner, filterCaseIds} = options;
  const filter = filterCaseIds ? new Set(filterCaseIds) : undefined;
  const results: SkillEvalRunResult[] = [];

  for (const c of contract.cases) {
    if (filter && !filter.has(c.caseId)) continue;
    const startedAt = Date.now();
    let output: any;
    try {
      output = await runner({caseId: c.caseId, tracePath: c.tracePath, skillId: c.skillId});
    } catch (err: any) {
      results.push({
        caseId: c.caseId,
        ranAt: startedAt,
        status: 'fail',
        assertionsPassed: 0,
        assertionsFailed: 1,
        durationMs: Date.now() - startedAt,
        failures: [
          {path: '$', expected: 'runner did not throw', actual: err?.message ?? String(err)},
        ],
      });
      continue;
    }

    const assertions = contract.assertions[c.caseId] ?? [];
    let passed = 0;
    let failed = 0;
    const failures: Array<{path: string; expected: string; actual: string}> = [];
    for (const a of assertions) {
      const r = evaluateAssertion(output, a);
      if (r.ok) {
        passed += 1;
      } else {
        failed += 1;
        failures.push({path: a.path, expected: a.expected, actual: r.actual});
      }
    }

    results.push({
      caseId: c.caseId,
      ranAt: startedAt,
      status: failed === 0 ? 'pass' : 'fail',
      assertionsPassed: passed,
      assertionsFailed: failed,
      durationMs: Date.now() - startedAt,
      ...(failures.length > 0 ? {failures} : {}),
    });
  }

  return results;
}
