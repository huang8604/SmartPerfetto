// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { CAPABILITY_REGISTRY, probeTraceCompleteness } from '../traceCompletenessProber';

function makeTraceProcessorMock(tables: Record<string, number>) {
  const query = jest.fn(async (_traceId: string, sql: string) => {
    if (sql.startsWith('INCLUDE PERFETTO MODULE')) {
      return { columns: [], rows: [], durationMs: 1 };
    }

    if (sql.includes('sqlite_master')) {
      return {
        columns: ['name'],
        rows: Object.keys(tables).map(name => [name]),
        durationMs: 1,
      };
    }

    if (sql.includes('UNION ALL')) {
      return {
        columns: ['tbl', 'cnt'],
        rows: Object.entries(tables).map(([name, count]) => [name, count]),
        durationMs: 1,
      };
    }

    throw new Error(`Unexpected SQL in trace completeness test: ${sql}`);
  });

  return { query } as any;
}

describe('probeTraceCompleteness', () => {
  it('loads power prerequisite modules before probing M2.0 capabilities', async () => {
    const tps = makeTraceProcessorMock({
      wattson_rails_aggregation: 3,
      android_battery_charge: 3,
      cpu_idle_counters: 3,
      android_gpu_work_period_track: 3,
    });

    const result = await probeTraceCompleteness(tps, 'trace-1');

    const includeSql = tps.query.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((sql: string) => sql.startsWith('INCLUDE PERFETTO MODULE'));

    expect(includeSql).toEqual(expect.arrayContaining([
      'INCLUDE PERFETTO MODULE wattson.aggregation;',
      'INCLUDE PERFETTO MODULE android.battery;',
      'INCLUDE PERFETTO MODULE linux.cpu.idle;',
      'INCLUDE PERFETTO MODULE android.gpu.work_period;',
    ]));

    expect(result.available.map(cap => cap.id)).toEqual(expect.arrayContaining([
      'power_rails',
      'battery_counters',
      'cpu_freq_idle',
      'gpu_work_period',
    ]));
  });

  it('reports actionable capture guidance when power capability tables are absent', async () => {
    const tps = makeTraceProcessorMock({});

    const result = await probeTraceCompleteness(tps, 'trace-1');

    const missingById = new Map(result.missingConfig.map(cap => [cap.id, cap.reason ?? '']));
    expect(missingById.get('power_rails')).toContain('collect_power_rails');
    expect(missingById.get('battery_counters')).toContain('battery_poll_ms');
    expect(missingById.get('cpu_freq_idle')).toContain('cpu_idle');
    expect(missingById.get('gpu_work_period')).toContain('android.gpu.work_period');
  });

  it('keeps all M2.0 power capability ids registered', () => {
    const ids = CAPABILITY_REGISTRY.map(cap => cap.id);
    expect(ids).toEqual(expect.arrayContaining([
      'power_rails',
      'battery_counters',
      'cpu_freq_idle',
      'gpu_work_period',
    ]));
  });
});
