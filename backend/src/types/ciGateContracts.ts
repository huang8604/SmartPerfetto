// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Plan 51 — CI Gate contract types.
 *
 * Lives in its own file to avoid a cycle between sparkContracts (which
 * has the regression gate result type) and baselineDiffer (which
 * defines the rule type the snapshot needs).
 */

import type {RegressionRule} from '../services/baselineDiffer';
import type {
  BaselineMetric,
  BaselineRecord,
  RegressionGateResult,
  SparkProvenance,
} from './sparkContracts';

/**
 * Snapshot of the candidate measured against the baseline. The route
 * resolves an inbound `{kind:'baseline', baselineId}` reference into the
 * stored baseline's metrics and writes the resolved metrics into the
 * snapshot, so the run remains replayable even if the candidate
 * baseline is later mutated or evicted.
 */
export interface CiGateRunCandidateSnapshot {
  kind: 'baseline' | 'trace';
  metrics: BaselineMetric[];
  baselineId?: string;
  traceId?: string;
  sampleCount?: number;
}

/**
 * Persisted CI gate evaluation record. Every external CI invocation
 * — including ones that resolved to `'skipped'` because the baseline
 * was missing or not yet published — produces one immutable record.
 * The stable `runId` is the audit anchor that downstream IM/Bug/PR
 * adapters reference.
 *
 * `rulesSnapshot` and `candidateSnapshot` are stored verbatim so the
 * run is replayable after the underlying rule set or candidate
 * baseline changes.
 */
export interface CiGateRunRecord extends SparkProvenance {
  schemaVersion: 1;
  runId: string;
  gateId: string;
  baselineId: string;
  baselineStatus: BaselineRecord['status'];
  /**
   * CI provider label as the caller supplied it. Free-form string —
   * soft-validated for length and shape only — so new providers
   * (CircleCI, Buildkite, Drone…) need no schema change.
   */
  ciSource: string;
  ciContext?: {
    repo?: string;
    pr?: number;
    commit?: string;
    workflow?: string;
    runUrl?: string;
  };
  /** Subject identifier from the auth middleware (req.user.id). */
  authSubject?: string;
  candidateSnapshot: CiGateRunCandidateSnapshot;
  rulesSnapshot: RegressionRule[];
  result: RegressionGateResult;
  /** Set when status='skipped' so triagers can audit why the gate did not run. */
  skipReason?: string;
  createdAt: number;
}
