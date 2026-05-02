// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Jank Decision Tree builder (Spark Plan 10)
 *
 * Walks each candidate frame through a deterministic decision tree
 * anchored on FrameTimeline `jank_type` (Spark #16 ground truth) and
 * produces a `JankDecisionTreeContract`. Routing is fully driven by
 * structured inputs — no LLM prompting required. The agent is then free
 * to layer narrative on top of the routing path, but cannot conflate
 * AppDeadline / SurfaceFlinger / DisplayHAL conclusions with other
 * jank_type values.
 *
 * The function takes a JankFrameInput[] which the caller derives from
 * actual_frame_timeline_slice + thread_state aggregations (Plan 11
 * dependency).
 */

import {
  makeSparkProvenance,
  type FrameTimelineJankType,
  type JankDecisionNode,
  type JankDecisionTreeContract,
  type JankFrameAttribution,
  type SparkConfidence,
} from '../types/sparkContracts';

export interface JankFrameInput {
  frameId: number | string;
  startNs: number;
  endNs: number;
  jankType: FrameTimelineJankType | null;
  /** Time the UI thread spent runnable but not running, in ns. */
  uiRunnableNs?: number;
  /** Time blocked on lock contention. */
  lockBlockedNs?: number;
  /** Time blocked on IO. */
  ioBlockedNs?: number;
  /** Time blocked on binder. */
  binderBlockedNs?: number;
  /** Optional skill ids that contributed evidence. */
  evidenceSkills?: string[];
}

const ROOT_NODE_ID = 'root';

/** Static decision-tree skeleton mirroring AppDeadline / SF / GPU / DisplayHAL. */
const ROOT_TREE: JankDecisionNode = {
  nodeId: ROOT_NODE_ID,
  label: 'switch on FrameTimeline.jank_type',
  rule: 'actual_frame_timeline_slice.jank_type',
  children: [
    {
      nodeId: 'app_deadline_missed',
      label: 'AppDeadlineMissed',
      children: [
        {nodeId: 'app_cpu_starvation', label: 'CPU starvation on UI thread'},
        {nodeId: 'app_lock_contention', label: 'Lock contention'},
        {nodeId: 'app_io_blocked', label: 'IO blocked'},
        {nodeId: 'app_binder_blocked', label: 'Binder blocked'},
        {nodeId: 'app_workload_heavy', label: 'Workload heavy (fallback)'},
      ],
    },
    {nodeId: 'sf_cpu_deadline_missed', label: 'SurfaceFlingerCpuDeadlineMissed'},
    {nodeId: 'sf_gpu_deadline_missed', label: 'SurfaceFlingerGpuDeadlineMissed'},
    {nodeId: 'display_hal', label: 'DisplayHAL'},
    {nodeId: 'prediction_error', label: 'PredictionError'},
    {nodeId: 'buffer_stuffing', label: 'Buffer Stuffing'},
    {nodeId: 'unknown_jank', label: 'Unknown (FrameTimeline data missing)'},
  ],
};

const APP_FAULT_THRESHOLDS = {
  uiRunnableNs: 5_000_000,
  lockBlockedNs: 1_000_000,
  ioBlockedNs: 1_000_000,
  binderBlockedNs: 1_000_000,
};

function classifyAppDeadline(input: JankFrameInput): {
  leafId: string;
  confidence: SparkConfidence;
  reasonCode: string;
} {
  const ui = input.uiRunnableNs ?? 0;
  const lock = input.lockBlockedNs ?? 0;
  const io = input.ioBlockedNs ?? 0;
  const binder = input.binderBlockedNs ?? 0;

  // Take the dominant blocker.
  const buckets: Array<[string, number, string, SparkConfidence]> = [
    ['app_cpu_starvation', ui, 'cpu_starvation', 'medium'],
    ['app_lock_contention', lock, 'lock_contention', 'medium'],
    ['app_io_blocked', io, 'io_blocked', 'medium'],
    ['app_binder_blocked', binder, 'binder_blocked', 'medium'],
  ];

  const [leafId, dominantValue, reasonCode, confidence] = buckets
    .filter(([, v]) => v > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number))[0] ?? [
    'app_workload_heavy',
    0,
    'workload_heavy',
    'low',
  ];

  // Confidence drops to 'low' when even the dominant bucket is below threshold.
  const threshold = (() => {
    switch (leafId) {
      case 'app_cpu_starvation':
        return APP_FAULT_THRESHOLDS.uiRunnableNs;
      case 'app_lock_contention':
        return APP_FAULT_THRESHOLDS.lockBlockedNs;
      case 'app_io_blocked':
        return APP_FAULT_THRESHOLDS.ioBlockedNs;
      case 'app_binder_blocked':
        return APP_FAULT_THRESHOLDS.binderBlockedNs;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
  })();
  const finalConfidence: SparkConfidence =
    dominantValue > 0 && (dominantValue as number) >= threshold ? confidence : 'low';

  return {leafId, confidence: finalConfidence, reasonCode};
}

/**
 * Map a single canonical jank-reason token to its decision-tree branch id.
 * The strings here are the human-readable labels Perfetto's
 * frame_timeline_event_parser emits — e.g. "App Deadline Missed" with
 * spaces, NOT the proto enum form. Codex review caught a P1 where the
 * earlier code used the proto-style strings, so every real janky frame
 * fell into `unknown_jank` and the routing tree never ran.
 *
 * Both the legacy compact enum form (proto names) AND the canonical
 * Perfetto strings are accepted so callers can safely pass either.
 */
function jankTokenToBranchId(tokenRaw: string): string | null {
  const token = tokenRaw.trim().toLowerCase();
  switch (token) {
    case 'app deadline missed':
    case 'appdeadlinemissed':
      return 'app_deadline_missed';
    case 'surfaceflinger cpu deadline missed':
    case 'surfaceflingercpudeadlinemissed':
      return 'sf_cpu_deadline_missed';
    case 'surfaceflinger gpu deadline missed':
    case 'surfaceflingergpudeadlinemissed':
      return 'sf_gpu_deadline_missed';
    case 'display hal':
    case 'displayhal':
      return 'display_hal';
    case 'prediction error':
    case 'predictionerror':
      return 'prediction_error';
    case 'buffer stuffing':
    case 'bufferstuffing':
    case 'surfaceflinger stuffing':
    case 'sf_stuffing':
      return 'buffer_stuffing';
    case 'surfaceflinger scheduling':
    case 'surfaceflingerscheduling':
      // SF scheduling is a SurfaceFlinger-side cause; route to SF CPU branch
      // since both indicate SF main-thread scheduling pressure.
      return 'sf_cpu_deadline_missed';
    case 'app resynced jitter':
    case 'appresyncedjitter':
      return 'app_deadline_missed';
    case 'unknown jank':
    case 'unknown':
    case 'unspecified':
    case 'none':
      return null;
    default:
      return null;
  }
}

/**
 * Branch priority for combined jank reasons. Perfetto emits comma-joined
 * labels like "SurfaceFlinger Scheduling, App Deadline Missed" — when
 * multiple reasons are present we route to the most actionable one,
 * preferring app-side > SF-side > display-side, mirroring how the
 * scrolling decision tree actually triages root cause.
 */
const BRANCH_PRIORITY: Record<string, number> = {
  app_deadline_missed: 100,
  sf_cpu_deadline_missed: 80,
  sf_gpu_deadline_missed: 70,
  buffer_stuffing: 60,
  display_hal: 50,
  prediction_error: 40,
};

function pickJankBranchId(jankType: FrameTimelineJankType | null): string {
  if (!jankType) return 'unknown_jank';

  // Perfetto joins multiple jank reasons with ", " — split + match each.
  const tokens = String(jankType).split(',');
  const branches: string[] = [];
  for (const tok of tokens) {
    const branch = jankTokenToBranchId(tok);
    if (branch) branches.push(branch);
  }
  if (branches.length === 0) return 'unknown_jank';

  // Pick highest-priority branch deterministically.
  return branches.reduce((best, candidate) =>
    (BRANCH_PRIORITY[candidate] ?? 0) > (BRANCH_PRIORITY[best] ?? 0) ? candidate : best,
  );
}

/** Build the per-frame attribution rows. */
function attributeFrame(input: JankFrameInput): JankFrameAttribution {
  const branch = pickJankBranchId(input.jankType);

  if (branch === 'app_deadline_missed') {
    const leaf = classifyAppDeadline(input);
    return {
      frameId: input.frameId,
      range: {startNs: input.startNs, endNs: input.endNs},
      jankType: input.jankType ?? 'Unknown',
      routePath: [ROOT_NODE_ID, branch, leaf.leafId],
      reasonCode: leaf.reasonCode,
      evidence: (input.evidenceSkills ?? []).map(skillId => ({skillId})),
    };
  }

  return {
    frameId: input.frameId,
    range: {startNs: input.startNs, endNs: input.endNs},
    jankType: input.jankType ?? 'Unknown',
    routePath: [ROOT_NODE_ID, branch],
    reasonCode: branch,
    evidence: (input.evidenceSkills ?? []).map(skillId => ({skillId})),
  };
}

/**
 * Build a JankDecisionTreeContract from a list of frame inputs.
 * Frames missing FrameTimeline jank_type land in `unclassifiedFrames`
 * rather than being routed to a fabricated branch (ground-truth gate).
 */
export function buildJankDecisionTree(
  frames: JankFrameInput[],
): JankDecisionTreeContract {
  const classified: JankFrameAttribution[] = [];
  const unclassified: JankFrameAttribution[] = [];

  for (const frame of frames) {
    const attribution = attributeFrame(frame);
    if (attribution.routePath.includes('unknown_jank')) {
      unclassified.push(attribution);
    } else {
      classified.push(attribution);
    }
  }

  const allUnclassified = frames.length > 0 && classified.length === 0;
  return {
    ...makeSparkProvenance({
      source: 'jank-decision-tree',
      ...(allUnclassified ? {unsupportedReason: 'no FrameTimeline-attributed frames in input'} : {}),
    }),
    root: ROOT_TREE,
    frameAttributions: classified,
    ...(unclassified.length > 0 ? {unclassifiedFrames: unclassified} : {}),
    coverage: [
      {sparkId: 16, planId: '10', status: 'implemented'},
      {sparkId: 31, planId: '10', status: 'implemented'},
    ],
  };
}
