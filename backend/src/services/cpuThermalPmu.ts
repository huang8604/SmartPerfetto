// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CPU Frequency / Thermal / PMU Aggregator (Spark Plan 13)
 *
 * Folds independent attribution facets into one
 * `CpuThermalPmuContract`. Caller passes only the facets they have
 * data for; missing facets surface as `unsupportedReason` rather than
 * being zero-filled.
 */

import {
  makeSparkProvenance,
  type CpuFreqResidency,
  type CpuThermalPmuContract,
  type NsTimeRange,
  type PmuAttributionRow,
  type ThermalDecision,
  type ThermalSample,
} from '../types/sparkContracts';

export interface CpuFreqResidencySample {
  cpu: number;
  freqHz: number;
  durNs: number;
}

export interface ThermalThrottleInput {
  zone: string;
  ts: number;
  tempMc: number;
  throttleStage?: number;
}

export interface PmuSampleInput {
  counter: string;
  utid?: number;
  process?: string;
  thread?: string;
  value: number;
  derived?: Record<string, number>;
}

export interface CpuThermalPmuOptions {
  range: NsTimeRange;
  freqSamples?: CpuFreqResidencySample[];
  thermalSamples?: ThermalThrottleInput[];
  pmuSamples?: PmuSampleInput[];
  smoothFraction?: number;
  jankFraction?: number;
}

/** Compute fraction-of-window residency for each (cpu,freq) bucket. */
function buildResidency(
  range: NsTimeRange,
  samples: CpuFreqResidencySample[] | undefined,
): CpuFreqResidency[] | undefined {
  if (!samples || samples.length === 0) return undefined;
  const totalDur = Math.max(1, range.endNs - range.startNs);
  return samples.map(s => ({
    cpu: s.cpu,
    freqHz: s.freqHz,
    durNs: s.durNs,
    fraction: s.durNs / totalDur,
  }));
}

/**
 * Decide a thermal verdict given the hottest sample's tempMc and
 * throttleStage. Thresholds chosen to match common Android thermal HAL
 * brackets (cool < 70°C, soft 70-85, hard 85-95, shutdown >= 95).
 *
 * Codex round 4 caught that traces from thermal zones often expose only
 * temperature counters (no HAL stage), so 95°C+ samples without a
 * throttleStage need to surface as `shutdown_imminent` based on
 * temperature alone — otherwise pre-shutdown conditions are
 * under-reported as ordinary hard throttling.
 */
function decideThermal(
  samples: ThermalThrottleInput[] | undefined,
): ThermalDecision | undefined {
  if (!samples || samples.length === 0) return undefined;
  const hottest = samples.reduce(
    (acc, s) => (s.tempMc > acc.tempMc ? s : acc),
    samples[0],
  );
  // Shutdown takes priority — either explicit HAL stage or pure
  // temperature evidence past the documented shutdown threshold.
  if ((hottest.throttleStage !== undefined && hottest.throttleStage >= 3)
      || hottest.tempMc >= 95_000) {
    return 'shutdown_imminent';
  }
  if (hottest.throttleStage === 2 || hottest.tempMc >= 85_000) return 'hard_throttle';
  if (hottest.throttleStage === 1 || hottest.tempMc >= 70_000) return 'soft_throttle';
  if (hottest.tempMc >= 60_000) return 'soft_throttle';
  return 'cool';
}

/**
 * "Has data" check that rejects both undefined and []. Codex review caught
 * the same bug here that ioNetworkWakeup had: empty result arrays were
 * being marked as supported coverage instead of missing evidence.
 */
function hasRows<T>(rows: T[] | undefined): rows is T[] {
  return Array.isArray(rows) && rows.length > 0;
}

export function buildCpuThermalPmu(
  options: CpuThermalPmuOptions,
): CpuThermalPmuContract {
  const freqHasRows = hasRows(options.freqSamples);
  const thermalHasRows = hasRows(options.thermalSamples);
  const pmuHasRows = hasRows(options.pmuSamples);

  const cpuFreqResidency = freqHasRows ? buildResidency(options.range, options.freqSamples) : undefined;
  const thermalSamples: ThermalSample[] | undefined = thermalHasRows
    ? options.thermalSamples!.map(s => ({
      zone: s.zone,
      ts: s.ts,
      tempMc: s.tempMc,
      ...(s.throttleStage !== undefined ? {throttleStage: s.throttleStage} : {}),
    }))
    : undefined;
  const thermalDecision = thermalHasRows ? decideThermal(options.thermalSamples) : undefined;

  const pmuAttribution: PmuAttributionRow[] | undefined = pmuHasRows
    ? options.pmuSamples!.map(s => ({
      counter: s.counter,
      ...(s.utid !== undefined ? {utid: s.utid} : {}),
      ...(s.process ? {process: s.process} : {}),
      ...(s.thread ? {thread: s.thread} : {}),
      value: s.value,
      ...(s.derived ? {derived: s.derived} : {}),
    }))
    : undefined;

  let smoothVsJank: CpuThermalPmuContract['smoothVsJankComparison'];
  if (options.smoothFraction !== undefined && options.jankFraction !== undefined) {
    smoothVsJank = {
      smoothFraction: options.smoothFraction,
      jankFraction: options.jankFraction,
      delta: options.smoothFraction - options.jankFraction,
    };
  }

  const allEmpty =
    !cpuFreqResidency
    && !thermalSamples
    && !pmuAttribution
    && !smoothVsJank;

  return {
    ...makeSparkProvenance({
      source: 'cpu-thermal-pmu',
      ...(allEmpty ? {unsupportedReason: 'no CPU / thermal / PMU samples supplied'} : {}),
    }),
    range: options.range,
    ...(cpuFreqResidency ? {cpuFreqResidency} : {}),
    ...(thermalSamples ? {thermalSamples} : {}),
    ...(thermalDecision ? {thermalDecision} : {}),
    ...(pmuAttribution ? {pmuAttribution} : {}),
    ...(smoothVsJank ? {smoothVsJankComparison: smoothVsJank} : {}),
    coverage: [
      {sparkId: 8, planId: '13', status: cpuFreqResidency ? 'implemented' : 'scaffolded'},
      {sparkId: 9, planId: '13', status: thermalSamples ? 'implemented' : 'scaffolded'},
      {sparkId: 10, planId: '13', status: pmuAttribution ? 'implemented' : 'scaffolded'},
      {sparkId: 35, planId: '13', status: thermalDecision ? 'implemented' : 'scaffolded'},
    ],
  };
}
