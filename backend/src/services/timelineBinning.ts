// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Timeline Binning + Counter RLE (Spark Plan 05)
 *
 * Two compressors on a shared contract:
 *  - binTimelineSamples: uniform fixed-width binning of (ts, value) pairs
 *    using a configurable aggregation (Spark #23 token compression).
 *  - encodeCounterRle: turn a counter trail into run-length encoded
 *    segments that capture each turning point exactly once
 *    (Spark #27 — counter RLE / turning-point compression).
 *
 * Both functions return a TimelineBinningContract sharing trackId, range
 * and originalSampleCount so callers can reason about the compression
 * ratio uniformly regardless of which encoder ran.
 */

import {
  makeSparkProvenance,
  type CounterRleSegment,
  type NsTimeRange,
  type TimelineBin,
  type TimelineBinAggregation,
  type TimelineBinningContract,
} from '../types/sparkContracts';

export interface TimelineSample {
  ts: number;
  value: number;
}

export interface BinTimelineSamplesOptions {
  trackId: string | number;
  samples: TimelineSample[];
  range: NsTimeRange;
  binDurNs: number;
  aggregation?: TimelineBinAggregation;
}

function aggregate(values: number[], op: TimelineBinAggregation): number {
  if (values.length === 0) return 0;
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'count':
      return values.length;
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
  }
}

/**
 * Uniform-width binning. Samples outside `range` are dropped.
 * Empty bins ARE included (with rowCount=0) so downstream consumers can
 * detect coverage gaps without needing to recompute the time axis.
 */
export function binTimelineSamples(
  options: BinTimelineSamplesOptions,
): TimelineBinningContract {
  const aggregation = options.aggregation ?? 'avg';
  const {trackId, range, binDurNs} = options;
  if (binDurNs <= 0 || range.endNs <= range.startNs) {
    return {
      ...makeSparkProvenance({
        source: 'timeline-binning',
        unsupportedReason: 'invalid bin width or range',
      }),
      trackId,
      range,
      originalSampleCount: options.samples.length,
      coverage: [{sparkId: 23, planId: '05', status: 'unsupported'}],
    };
  }

  const totalDur = range.endNs - range.startNs;
  const binCount = Math.ceil(totalDur / binDurNs);
  const buckets: number[][] = Array.from({length: binCount}, () => []);

  for (const s of options.samples) {
    if (s.ts < range.startNs || s.ts >= range.endNs) continue;
    const idx = Math.floor((s.ts - range.startNs) / binDurNs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].push(s.value);
  }

  // Codex round 5 caught that the final bucket extended past range.endNs
  // when totalDur isn't a multiple of binDurNs. Clamp the last bucket so
  // [startNs, startNs + durNs) stays inside the requested window.
  const bins: TimelineBin[] = buckets.map((values, i) => {
    const startNs = range.startNs + i * binDurNs;
    const naturalEnd = startNs + binDurNs;
    const clampedEnd = Math.min(naturalEnd, range.endNs);
    return {
      startNs,
      durNs: clampedEnd - startNs,
      value: aggregate(values, aggregation),
      rowCount: values.length,
    };
  });

  return {
    ...makeSparkProvenance({source: 'timeline-binning'}),
    trackId,
    range,
    binDurNs,
    aggregation,
    bins,
    originalSampleCount: options.samples.length,
    coverage: [
      {sparkId: 23, planId: '05', status: 'implemented'},
    ],
  };
}

export interface EncodeCounterRleOptions {
  trackId: string | number;
  samples: TimelineSample[];
  range: NsTimeRange;
}

/**
 * Run-length encode a counter trail. Adjacent samples with the same value
 * collapse into a single segment, and the segment delta is the change from
 * the prior segment so consumers can render turning-point arrows.
 */
export function encodeCounterRle(
  options: EncodeCounterRleOptions,
): TimelineBinningContract {
  const {trackId, range} = options;
  // Half-open window [startNs, endNs) matching binTimelineSamples.
  // Codex review caught that an inclusive endNs caused the boundary
  // sample to appear in both adjacent windows when callers chained them.
  const samples = options.samples
    .filter(s => s.ts >= range.startNs && s.ts < range.endNs)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const rle: CounterRleSegment[] = [];
  let prevValue: number | null = null;
  let segmentStart = range.startNs;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (prevValue === null) {
      prevValue = sample.value;
      segmentStart = sample.ts;
      continue;
    }
    if (sample.value !== prevValue) {
      rle.push({
        startNs: segmentStart,
        endNs: sample.ts,
        value: prevValue,
        ...(rle.length > 0 ? {delta: prevValue - rle[rle.length - 1].value} : {}),
      });
      segmentStart = sample.ts;
      prevValue = sample.value;
    }
  }

  // Close the last segment at range.endNs.
  if (prevValue !== null) {
    rle.push({
      startNs: segmentStart,
      endNs: range.endNs,
      value: prevValue,
      ...(rle.length > 0 ? {delta: prevValue - rle[rle.length - 1].value} : {}),
    });
  }

  return {
    ...makeSparkProvenance({source: 'counter-rle'}),
    trackId,
    range,
    rle,
    originalSampleCount: options.samples.length,
    coverage: [{sparkId: 27, planId: '05', status: 'implemented'}],
  };
}
