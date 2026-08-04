/**
 * Trace-backed SPAN_JOIN guardrail regression.
 *
 * The annotation is review metadata. This suite supplies the runtime proof:
 * both inputs are disjoint per utid on the pinned trace before SPAN_JOIN is
 * executed, and the resulting overlap matches the independently reviewed
 * fixture value.
 */

import {afterAll, beforeAll, expect, it} from '@jest/globals';

import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
} from '../../src/services/sqlGuardrailAnalyzer';
import {
  createSkillEvaluator,
  describeWithTrace,
  getTestTracePath,
  SkillEvaluator,
} from './runner';

const TRACE_FILE = 'launch_light.pftrace';
const EXPECTED_OVERLAP_NS = 233_648_518;

const SPAN_JOIN_INPUTS_SQL = `
INCLUDE PERFETTO MODULE slices.flat_slices;

CREATE OR REPLACE PERFETTO VIEW target_main_thread_slices AS
SELECT
  fs.ts,
  IIF(fs.dur = -1, trace_end() - fs.ts, fs.dur) AS dur,
  fs.utid,
  fs.slice_id,
  fs.name AS slice_name
FROM _slice_flattened fs
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'com.example.androidappdemo'
  AND t.is_main_thread = 1
  AND IIF(fs.dur = -1, trace_end() - fs.ts, fs.dur) > 0;

CREATE OR REPLACE PERFETTO VIEW target_main_thread_running AS
SELECT
  st.ts,
  IIF(st.dur = -1, trace_end() - st.ts, st.dur) AS dur,
  st.utid,
  st.id AS thread_state_id,
  st.cpu
FROM thread_state st
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'com.example.androidappdemo'
  AND t.is_main_thread = 1
  AND st.state = 'Running'
  AND IIF(st.dur = -1, trace_end() - st.ts, st.dur) > 0;
`;

const NON_OVERLAP_WITNESS_SQL = `
${SPAN_JOIN_INPUTS_SQL}

WITH slice_overlaps AS (
  SELECT
    utid,
    ts,
    dur,
    LAG(ts + dur) OVER (PARTITION BY utid ORDER BY ts) AS previous_end
  FROM target_main_thread_slices
),
running_overlaps AS (
  SELECT
    utid,
    ts,
    dur,
    LAG(ts + dur) OVER (PARTITION BY utid ORDER BY ts) AS previous_end
  FROM target_main_thread_running
)
SELECT
  (SELECT COUNT(*) FROM slice_overlaps WHERE previous_end > ts)
    AS slice_overlap_violations,
  (SELECT COUNT(*) FROM running_overlaps WHERE previous_end > ts)
    AS running_overlap_violations;
`;

const GUARDED_SPAN_JOIN_SQL = `
${SPAN_JOIN_INPUTS_SQL}

DROP TABLE IF EXISTS target_main_thread_slice_running_overlap;
-- perfetto-span-join-non-overlap-proof: sql_guardrail_span_join.eval.ts witness query
CREATE VIRTUAL TABLE target_main_thread_slice_running_overlap
USING SPAN_JOIN(
  target_main_thread_slices PARTITIONED utid,
  target_main_thread_running PARTITIONED utid
);

SELECT
  SUM(dur) AS overlap_ns,
  COUNT(*) AS overlap_rows
FROM target_main_thread_slice_running_overlap;
`;

function firstRow(
  result: {columns: string[]; rows: any[][]; error?: string},
): Record<string, unknown> {
  expect(result.error).toBeUndefined();
  expect(result.rows).toHaveLength(1);
  return Object.fromEntries(
    result.columns.map((column, index) => [column, result.rows[0][index]]),
  );
}

describeWithTrace('SQL guardrail SPAN_JOIN regression', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('global_trace_sanity_check');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60_000);

  afterAll(async () => {
    await evaluator.cleanup();
  });

  it('accepts the reviewed guarded statement', () => {
    expect(analyzeSqlGuardrails(GUARDED_SPAN_JOIN_SQL, {
      includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
    })).toEqual([]);
  });

  it('proves disjoint inputs before executing SPAN_JOIN on the real trace', async () => {
    const witness = firstRow(await evaluator.executeSQL(NON_OVERLAP_WITNESS_SQL));
    expect(Number(witness.slice_overlap_violations)).toBe(0);
    expect(Number(witness.running_overlap_violations)).toBe(0);

    const overlap = firstRow(await evaluator.executeSQL(GUARDED_SPAN_JOIN_SQL));
    expect(Number(overlap.overlap_ns)).toBe(EXPECTED_OVERLAP_NS);
    expect(Number(overlap.overlap_rows)).toBeGreaterThan(0);
  }, 60_000);
});
