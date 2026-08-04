// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  BatchTraceAggregateMetricV1,
  BatchTraceMetricV1,
  BatchTraceResultV1,
  BatchTraceRunV1,
} from './batchTraceTypes';

interface NumericMetricPoint {
  ordinal: number;
  value: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function percentileNearestRank(values: number[], percentile: number): number | undefined {
  if (values.length === 0) return undefined;
  const rank = Math.ceil((percentile / 100) * values.length);
  const index = Math.max(0, Math.min(values.length - 1, rank - 1));
  return values[index];
}

function median(values: number[]): number | undefined {
  return percentileNearestRank(values, 50);
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricLabel(metric: BatchTraceMetricV1): string {
  return metric.promotableMetricKey ?? metric.label ?? metric.key;
}

function aggregateMetric(
  key: string,
  metricsByOrdinal: Map<number, BatchTraceMetricV1>,
  allOrdinals: number[],
  limitations: string[],
): BatchTraceAggregateMetricV1 {
  const points: NumericMetricPoint[] = [];
  let label = key;
  let unit: string | undefined;

  for (const [ordinal, metric] of metricsByOrdinal.entries()) {
    label = metricLabel(metric);
    unit = unit ?? metric.unit;
    if (isFiniteNumber(metric.numericValue)) {
      points.push({ ordinal, value: metric.numericValue });
    }
  }

  const missingOrdinals = allOrdinals.filter(ordinal => !metricsByOrdinal.has(ordinal));
  if (missingOrdinals.length > 0) {
    limitations.push(`metric ${key} missing for trace ordinals: ${missingOrdinals.join(', ')}`);
  }

  const sortedPoints = [...points].sort((a, b) => a.value - b.value || a.ordinal - b.ordinal);
  const values = sortedPoints.map(point => point.value);
  if (values.length === 0) {
    limitations.push(`metric ${key} has no finite numeric values`);
    return {
      key,
      label,
      ...(unit ? { unit } : {}),
      count: 0,
      missingCount: allOrdinals.length,
      outlierOrdinals: [],
    };
  }

  const outlierOrdinals = detectOutlierOrdinals(points, limitations, key);
  return {
    key,
    label,
    ...(unit ? { unit } : {}),
    count: values.length,
    missingCount: allOrdinals.length - values.length,
    min: values[0],
    p50: percentileNearestRank(values, 50),
    p90: percentileNearestRank(values, 90),
    p95: percentileNearestRank(values, 95),
    max: values[values.length - 1],
    mean: mean(values),
    outlierOrdinals,
  };
}

function detectOutlierOrdinals(
  points: NumericMetricPoint[],
  limitations: string[],
  key: string,
): number[] {
  if (points.length < 5) {
    limitations.push(`metric ${key} has fewer than five numeric samples; outlier detection skipped`);
    return [];
  }

  const values = points.map(point => point.value).sort((a, b) => a - b);
  const center = median(values);
  if (!isFiniteNumber(center)) return [];
  const deviations = values.map(value => Math.abs(value - center)).sort((a, b) => a - b);
  const mad = median(deviations);
  if (!isFiniteNumber(mad) || mad === 0) {
    limitations.push(`metric ${key} has zero median absolute deviation; outlier detection skipped`);
    return [];
  }

  return points
    .filter(point => Math.abs(point.value - center) / mad > 3.5)
    .map(point => point.ordinal)
    .sort((a, b) => a - b);
}

export function aggregateBatchTraceResults(
  results: BatchTraceResultV1[],
): NonNullable<BatchTraceRunV1['aggregate']> {
  const limitations: string[] = [];
  const allOrdinals = results.map(result => result.ordinal).sort((a, b) => a - b);
  const metricMaps = new Map<string, Map<number, BatchTraceMetricV1>>();

  for (const result of results) {
    if (result.status !== 'completed') {
      limitations.push(`trace ordinal ${result.ordinal} ${result.status}: ${result.error ?? 'no completed metrics'}`);
    }
    for (const metric of result.metrics) {
      const existing = metricMaps.get(metric.key) ?? new Map<number, BatchTraceMetricV1>();
      existing.set(result.ordinal, metric);
      metricMaps.set(metric.key, existing);
      if (metric.missingReason) {
        limitations.push(`trace ordinal ${result.ordinal} metric ${metric.key}: ${metric.missingReason}`);
      }
    }
  }

  const metrics = [...metricMaps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, byOrdinal]) => aggregateMetric(key, byOrdinal, allOrdinals, limitations));

  return {
    metrics,
    limitations: [...new Set(limitations)],
  };
}
