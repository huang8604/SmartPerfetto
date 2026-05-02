// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace Config Generator (Spark Plan 07)
 *
 * Given an analysis `intent` (scrolling / startup / anr / memory / generic)
 * the generator returns a `TraceConfigGeneratorContract` listing the
 * Perfetto data sources that should be enabled, plus the canonical custom
 * slice schema and a self-description block that should be embedded inside
 * the captured trace metadata.
 *
 * Spark coverage:
 *  - #197 — AI generated trace config (intent → fragments)
 *  - #53  — custom slice / business instrumentation schema
 *  - #201 — trace self-description metadata
 */

import {
  makeSparkProvenance,
  type CustomSliceSpec,
  type PerfettoConfigFragment,
  type TraceConfigGeneratorContract,
  type TraceSelfDescription,
} from '../types/sparkContracts';

export type TraceIntent =
  | 'scrolling'
  | 'startup'
  | 'anr'
  | 'memory'
  | 'gpu'
  | 'network'
  | 'generic';

export interface GenerateTraceConfigOptions {
  intent: TraceIntent;
  /** Optional package the capture is targeted at. */
  packageName?: string;
  /** CUJ name (`cold_start`, `scroll_feed`, `tap_interaction`, …). */
  cuj?: string;
  /** Device fingerprint to embed in self-description. */
  device?: string;
  /** Build id / git sha to embed in self-description. */
  buildId?: string;
  /** Extra custom slice declarations that should accompany the trace. */
  customSlices?: CustomSliceSpec[];
}

/** Common foundation that every intent benefits from. */
const FOUNDATION_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'linux.process_stats', reason: 'process inventory'},
  {dataSource: 'linux.sys_stats', reason: 'system-level CPU/memory probes'},
  {dataSource: 'android.log', reason: 'logcat correlation for analysis narration'},
];

// Note on binder + ANR coverage: there is no standalone `android.binder`
// data source. Binder transactions are captured via ftrace events
// (binder_transaction, binder_lock, etc.) under linux.ftrace. The
// scrolling/startup/anr fragments below enable those ftrace knobs and
// rely on the trace_processor stdlib to surface android_binder_txns.

const SCROLLING_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'linux.ftrace', reason: 'sched_switch / sched_waking for thread state', options: {sched_switch: 'true', sched_waking: 'true'}},
  {dataSource: 'android.surfaceflinger.frametimeline', reason: 'frame jank ground truth (Spark #16)'},
  {dataSource: 'android.surfaceflinger.layers', reason: 'layer composition timing'},
  {dataSource: 'android.input.inputevent', reason: 'input dispatch correlation for scroll start latency'},
];

const STARTUP_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'linux.ftrace', reason: 'sched + binder ftrace events for startup phase boundaries', options: {sched_switch: 'true', task_rename: 'true', binder_transaction: 'true'}},
  {dataSource: 'android.surfaceflinger.frametimeline', reason: 'first-frame latency'},
  {dataSource: 'linux.process_stats', reason: 'process create / app launch attribution'},
];

const ANR_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'linux.ftrace', reason: 'sched + binder events to localize main-thread blockage', options: {sched_switch: 'true', sched_blocked_reason: 'true', binder_transaction: 'true', binder_lock: 'true'}},
  {dataSource: 'android.input.inputevent', reason: 'input dispatch timeout decoration'},
];

const MEMORY_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'linux.ftrace', reason: 'mm_event / oom_score_adj / kill_one_process', options: {mm_compaction_begin: 'true', oom_score_adj_update: 'true'}},
  {dataSource: 'android.power', reason: 'battery / wakelock correlation'},
];

const GPU_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'gpu.counters', reason: 'GPU utilization + memory counters'},
  {dataSource: 'gpu.renderstages', reason: 'per-render-stage GPU timing'},
  {dataSource: 'android.surfaceflinger.frametimeline', reason: 'composition + HWC fallback frame correlation'},
];

const NETWORK_FRAGMENTS: PerfettoConfigFragment[] = [
  {dataSource: 'android.network_packets', reason: 'tcp/udp packet timing for net waits'},
];

function pickFragmentsForIntent(intent: TraceIntent): PerfettoConfigFragment[] {
  switch (intent) {
    case 'scrolling':
      return [...FOUNDATION_FRAGMENTS, ...SCROLLING_FRAGMENTS];
    case 'startup':
      return [...FOUNDATION_FRAGMENTS, ...STARTUP_FRAGMENTS];
    case 'anr':
      return [...FOUNDATION_FRAGMENTS, ...ANR_FRAGMENTS];
    case 'memory':
      return [...FOUNDATION_FRAGMENTS, ...MEMORY_FRAGMENTS];
    case 'gpu':
      return [...FOUNDATION_FRAGMENTS, ...GPU_FRAGMENTS];
    case 'network':
      return [...FOUNDATION_FRAGMENTS, ...NETWORK_FRAGMENTS];
    case 'generic':
    default:
      return FOUNDATION_FRAGMENTS;
  }
}

function buildSelfDescription(opts: GenerateTraceConfigOptions): TraceSelfDescription {
  return {
    ...makeSparkProvenance({source: 'self-description'}),
    packageName: opts.packageName,
    buildId: opts.buildId,
    cuj: opts.cuj,
    device: opts.device,
    intent: opts.intent,
    expectedCustomSlices: opts.customSlices,
  };
}

/**
 * Build a deterministic trace config for the given intent. AI-driven
 * customization can layer on top of this baseline, but the function alone
 * is enough to produce a working trace config without an LLM call.
 */
export function generateTraceConfig(
  opts: GenerateTraceConfigOptions,
): TraceConfigGeneratorContract {
  const fragments = pickFragmentsForIntent(opts.intent);
  return {
    ...makeSparkProvenance({source: 'trace-config-generator'}),
    fragments,
    customSlices: opts.customSlices,
    selfDescription: buildSelfDescription(opts),
    rationale: `Baseline trace config for intent='${opts.intent}'.`,
    coverage: [
      {sparkId: 53, planId: '07', status: opts.customSlices && opts.customSlices.length > 0 ? 'implemented' : 'scaffolded'},
      {sparkId: 197, planId: '07', status: 'implemented'},
      {sparkId: 201, planId: '07', status: 'implemented'},
    ],
  };
}
