// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * BaselineDiffer — pure functions that compute `BaselineDiffArtifact`
 * and `RegressionGateResult` from a baseline plus a candidate
 * (another baseline or a per-trace metric summary).
 *
 * Plan 50 M1 scope (this file):
 * - `computeBaselineDiff(base, candidate, opts?)` — per-metric deltas
 *   with explicit `unsupportedReason` for the missing-data paths
 *   Codex round 1 P1#4 enumerated (missing on candidate, both
 *   unsupported, sample below threshold, divide-by-zero).
 * - `evaluateRegressionGate(baselineId, diff, rules, opts?)` — apply
 *   threshold rules to a diff. Skipped gates carry `skipReason` and
 *   omit `diff` per the §4.1 contract.
 *
 * Out of scope:
 * - GitHub / IM integration (§4.1 explicitly says "CI dry-run mode,
 *   no GitHub" for M1).
 * - Trace-vs-baseline extraction. The MCP read tools use `lookup_baseline`
 *   and `compare_baselines`; a future `compare_to_baseline` would need a
 *   trace metric extraction pipeline.
 *
 * @module baselineDiffer
 */

import {
  type BaselineMetric,
  type BaselineRecord,
  type BaselineDiffArtifact,
  type BaselineDiffDelta,
  type RegressionGateResult,
  makeSparkProvenance,
} from '../types/sparkContracts';

/** Trace-side counterpart to BaselineRecord: just the metrics, plus an
 * id pointer so the differ can record which trace was compared. The
 * caller (skill or pre-aggregated source) owns metric extraction; the
 * differ stays trace-agnostic. */
export interface TraceMetricSummary {
  kind: 'trace';
  traceId: string;
  metrics: BaselineMetric[];
}

export type DiffCandidate = BaselineRecord | TraceMetricSummary;

/** Default thresholds tuned for percent deltas. Callers can override
 * per-call via `DiffOptions`. */
const DEFAULT_NONE_THRESHOLD_PCT = 0.005; // 0.5% — counts as "none"
const DEFAULT_WARNING_THRESHOLD_PCT = 0.05; // 5% — bumps to "warning"
const DEFAULT_REGRESSION_THRESHOLD_PCT = 0.15; // 15% — flags "regression"
const DEFAULT_MIN_SAMPLE_COUNT = 3; // mirrors BASELINE_PUBLISH_MIN_SAMPLES

export interface DiffOptions {
  /** Below this absolute fractional delta the severity stays 'none'. */
  noneThresholdPct?: number;
  /** Above this fractional delta the severity becomes 'warning'. */
  warningThresholdPct?: number;
  /** Above this fractional delta the severity becomes 'regression'. */
  regressionThresholdPct?: number;
  /** Both sides need at least this many samples; below → unsupported. */
  minSampleCount?: number;
  /**
   * If true, a metric missing on the base is reported as 'unsupported'
   * with a clear reason; if false the metric is silently skipped.
   * Defaults to true so missing data stays visible.
   */
  reportMissingOnBase?: boolean;
}

interface ResolvedDiffOptions {
  noneThresholdPct: number;
  warningThresholdPct: number;
  regressionThresholdPct: number;
  minSampleCount: number;
  reportMissingOnBase: boolean;
}

function resolve(opts: DiffOptions): ResolvedDiffOptions {
  return {
    noneThresholdPct: opts.noneThresholdPct ?? DEFAULT_NONE_THRESHOLD_PCT,
    warningThresholdPct:
      opts.warningThresholdPct ?? DEFAULT_WARNING_THRESHOLD_PCT,
    regressionThresholdPct:
      opts.regressionThresholdPct ?? DEFAULT_REGRESSION_THRESHOLD_PCT,
    minSampleCount: opts.minSampleCount ?? DEFAULT_MIN_SAMPLE_COUNT,
    reportMissingOnBase: opts.reportMissingOnBase ?? true,
  };
}

/** Pull the central-tendency value used for diff arithmetic. The schema
 * exposes median / p95 / p99 / max — the diff focuses on `median`
 * because that's the most stable summary across capture variability.
 * If a future caller wants a percentile-aware diff this function
 * generalizes to a strategy. */
function pickRepresentativeValue(metric: BaselineMetric): number {
  return metric.median;
}

/** Compute the percent change from `base` to `candidate`. Returns null
 * (signaling divide-by-zero) when `base` is exactly 0. */
function percentDelta(base: number, candidate: number): number | null {
  if (base === 0) return null;
  return (candidate - base) / Math.abs(base);
}

/** Classify a percent delta into a severity bucket. */
function classifySeverity(
  deltaPct: number,
  resolved: ResolvedDiffOptions,
): 'none' | 'info' | 'warning' | 'regression' {
  const abs = Math.abs(deltaPct);
  if (abs <= resolved.noneThresholdPct) return 'none';
  // Negative deltas are improvements — counts as 'info' regardless of
  // magnitude. Don't flag improvements as regressions.
  if (deltaPct < 0) return 'info';
  if (abs >= resolved.regressionThresholdPct) return 'regression';
  if (abs >= resolved.warningThresholdPct) return 'warning';
  return 'none';
}

/** Build one delta. Encapsulates the four unsupported paths:
 *  1. metric.unsupportedReason set on either side
 *  2. sample count below minimum on either side
 *  3. divide-by-zero (baseValue exactly 0)
 *  4. unit mismatch (operator probably mis-keyed metricId)
 */
function buildDelta(
  base: BaselineMetric | undefined,
  candidate: BaselineMetric | undefined,
  metricId: string,
  unit: string,
  resolved: ResolvedDiffOptions,
): BaselineDiffDelta {
  if (!base && !candidate) {
    // Caller asked for a metric absent from both — surface it.
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: 'metric missing on both sides',
    };
  }
  if (!base) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: 'metric missing on baseline',
      candidateValue: candidate ? pickRepresentativeValue(candidate) : undefined,
    };
  }
  if (!candidate) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: 'metric missing on candidate',
      baseValue: pickRepresentativeValue(base),
    };
  }
  if (base.unsupportedReason || candidate.unsupportedReason) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason:
        base.unsupportedReason ?? candidate.unsupportedReason,
    };
  }
  if (base.unit !== candidate.unit) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: `unit mismatch: base='${base.unit}' candidate='${candidate.unit}'`,
    };
  }
  const baseSamples = base.sampleCount;
  const candSamples = candidate.sampleCount;
  if (
    baseSamples < resolved.minSampleCount ||
    candSamples < resolved.minSampleCount
  ) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: `sample count below minimum (${resolved.minSampleCount}); base=${baseSamples} candidate=${candSamples}`,
      baseValue: pickRepresentativeValue(base),
      candidateValue: pickRepresentativeValue(candidate),
    };
  }
  const baseValue = pickRepresentativeValue(base);
  const candidateValue = pickRepresentativeValue(candidate);
  const pct = percentDelta(baseValue, candidateValue);
  if (pct === null) {
    return {
      metricId,
      unit,
      severity: 'unsupported',
      unsupportedReason: 'divide-by-zero (baseValue is 0)',
      baseValue,
      candidateValue,
    };
  }
  return {
    metricId,
    unit,
    severity: classifySeverity(pct, resolved),
    baseValue,
    candidateValue,
    deltaAbs: candidateValue - baseValue,
    deltaPct: pct,
  };
}

/** Index a metric array by `metricId` for O(1) lookup. */
function indexMetrics(
  metrics: BaselineMetric[],
): Map<string, BaselineMetric> {
  const out = new Map<string, BaselineMetric>();
  for (const m of metrics) out.set(m.metricId, m);
  return out;
}

/** Get the candidate id descriptor for the diff artifact. */
function describeCandidate(
  candidate: DiffCandidate,
): BaselineDiffArtifact['candidate'] {
  if ('kind' in candidate && candidate.kind === 'trace') {
    return {kind: 'trace', traceId: candidate.traceId};
  }
  return {kind: 'baseline', id: (candidate as BaselineRecord).baselineId};
}

/**
 * Compute the diff between `base` and `candidate`. The diff covers
 * every metricId present on either side; missing-data paths are
 * surfaced as `severity: 'unsupported'` with a concrete reason rather
 * than silently skipped or zero-filled.
 */
export function computeBaselineDiff(
  base: BaselineRecord,
  candidate: DiffCandidate,
  opts: DiffOptions = {},
): BaselineDiffArtifact {
  const resolved = resolve(opts);
  const baseIndex = indexMetrics(base.metrics);
  const candidateIndex = indexMetrics(
    'kind' in candidate && candidate.kind === 'trace'
      ? candidate.metrics
      : (candidate as BaselineRecord).metrics,
  );

  const allIds = new Set<string>();
  for (const id of baseIndex.keys()) allIds.add(id);
  for (const id of candidateIndex.keys()) allIds.add(id);

  const deltas: BaselineDiffDelta[] = [];
  for (const metricId of Array.from(allIds).sort()) {
    const baseMetric = baseIndex.get(metricId);
    const candMetric = candidateIndex.get(metricId);
    // When the metric appears on only one side, we still need a unit
    // string for the delta; pick whichever side is populated.
    const unit = baseMetric?.unit ?? candMetric?.unit ?? '';
    const skipMissingBase =
      !baseMetric && candMetric && !resolved.reportMissingOnBase;
    if (skipMissingBase) continue;
    deltas.push(
      buildDelta(baseMetric, candMetric, metricId, unit, resolved),
    );
  }

  // Top regressions: rank actual regressions (severity='regression')
  // by absolute deltaPct, descending.
  const topRegressions = deltas
    .filter(d => d.severity === 'regression' && typeof d.deltaPct === 'number')
    .sort((a, b) => Math.abs(b.deltaPct!) - Math.abs(a.deltaPct!))
    .slice(0, 5)
    .map(d => ({metricId: d.metricId, deltaPct: d.deltaPct!}));

  return {
    ...makeSparkProvenance({source: 'baselineDiffer.computeBaselineDiff'}),
    baseBaselineId: base.baselineId,
    candidate: describeCandidate(candidate),
    deltas,
    ...(topRegressions.length ? {topRegressions} : {}),
  };
}

/** Threshold rule for the regression gate. Applied per metric. */
export interface RegressionRule {
  metricId: string;
  /** Maximum allowed absolute fractional delta. 0.10 == 10%. */
  threshold: number;
  /** When true the gate fails if `deltaPct > threshold` (default).
   * When false (e.g. for "must-decrease" metrics) the gate fails
   * when `deltaPct < -threshold`. */
  expectIncrease?: boolean;
}

export interface GateOptions {
  /** Stable id surfaced on the result. Required for audit. */
  gateId: string;
  /** Skip the gate with this reason instead of evaluating rules. */
  skipReason?: string;
}

/**
 * Apply threshold rules to a precomputed diff. Returns a
 * `RegressionGateResult` whose `status` is `'skipped'` when
 * `opts.skipReason` is set (the diff is intentionally omitted in that
 * case, per the §4.1 contract).
 *
 * `'fail'` when any rule's threshold is breached. `'flaky'` when no
 * rule is breached but at least one delta is `'unsupported'` —
 * surfaces the gate's lack of confidence rather than passing silently.
 * `'pass'` otherwise.
 */
export function evaluateRegressionGate(
  baselineId: string,
  diff: BaselineDiffArtifact,
  rules: RegressionRule[],
  opts: GateOptions,
): RegressionGateResult {
  if (opts.skipReason) {
    return {
      ...makeSparkProvenance({source: 'baselineDiffer.evaluateRegressionGate'}),
      gateId: opts.gateId,
      baselineId,
      status: 'skipped',
      skipReason: opts.skipReason,
    };
  }

  const deltaIndex = indexMetricsByDelta(diff.deltas);
  let triggeredRule: RegressionGateResult['rule'];
  let sawUnsupported = false;

  for (const rule of rules) {
    const delta = deltaIndex.get(rule.metricId);
    if (!delta) continue;
    if (delta.severity === 'unsupported') {
      sawUnsupported = true;
      continue;
    }
    if (typeof delta.deltaPct !== 'number') continue;
    const expectIncrease = rule.expectIncrease ?? true;
    const breached = expectIncrease
      ? delta.deltaPct > rule.threshold
      : delta.deltaPct < -rule.threshold;
    if (breached) {
      triggeredRule = {
        metricId: rule.metricId,
        threshold: rule.threshold,
        observed: delta.deltaPct,
      };
      break;
    }
  }

  const status: RegressionGateResult['status'] = triggeredRule
    ? 'fail'
    : sawUnsupported
      ? 'flaky'
      : 'pass';

  return {
    ...makeSparkProvenance({source: 'baselineDiffer.evaluateRegressionGate'}),
    gateId: opts.gateId,
    baselineId,
    status,
    diff,
    ...(triggeredRule ? {rule: triggeredRule} : {}),
  };
}

function indexMetricsByDelta(
  deltas: BaselineDiffDelta[],
): Map<string, BaselineDiffDelta> {
  const out = new Map<string, BaselineDiffDelta>();
  for (const d of deltas) out.set(d.metricId, d);
  return out;
}
