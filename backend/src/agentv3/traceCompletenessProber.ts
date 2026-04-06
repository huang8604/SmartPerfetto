// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace Data Completeness Prober
 *
 * Probes key Perfetto stdlib tables to determine which analysis capabilities
 * are available for a given trace. Cross-references with architecture detection
 * to distinguish "config not enabled" from "not applicable".
 *
 * Two-layer probing:
 *   1. Schema existence — sqlite_master check (which tables/views exist)
 *   2. Data existence — EXISTS(SELECT 1 FROM table) for tables that exist in schema
 *
 * Result categories:
 *   - available: data present, analysis possible
 *   - missing_config_suspected: schema missing or empty, likely trace config issue
 *   - not_applicable: architecture/version mismatch, not a config issue
 *   - insufficient_or_scene_absent: sparse data, ambiguous cause
 */

import type { RenderingArchitectureType } from '../agent/detectors/types';
import type { TraceProcessorService } from '../services/traceProcessorService';
import type { CapabilityProbeResult, CapabilityStatus, TraceCompleteness } from './types';

/** Minimum row count below which data is considered "insufficient". */
const INSUFFICIENT_THRESHOLD = 3;

/** Capability definition — maps an analysis domain to its primary detection table. */
interface CapabilityDef {
  id: string;
  displayName: string;
  /** Primary table to probe for data existence */
  primaryTable: string;
  /** Architectures where this capability is relevant (empty = all) */
  applicableArchs?: RenderingArchitectureType[];
  /** Architectures where this capability is explicitly NOT relevant */
  excludedArchs?: RenderingArchitectureType[];
  /** Priority for reporting: CRITICAL capabilities are flagged prominently when missing */
  priority: 'critical' | 'recommended' | 'optional';
}

/**
 * Capability registry — the authoritative list of probed capabilities.
 * Order determines output order. Each entry maps to a section in
 * knowledge-data-sources.template.md for detailed capture guidance.
 */
const CAPABILITY_REGISTRY: CapabilityDef[] = [
  // ── Frame rendering (core for scrolling/jank analysis) ──
  {
    id: 'frame_rendering',
    displayName: '帧渲染/滑动分析',
    primaryTable: 'actual_frame_timeline_slice',
    excludedArchs: ['FLUTTER', 'WEBVIEW', 'GAME_ENGINE'],
    priority: 'critical',
  },
  {
    id: 'flutter_rendering',
    displayName: 'Flutter 渲染分析',
    // Flutter engine slices (1.ui, 1.raster, GPURasterizer) are in the generic slice table.
    // We use android_frames as the primary probe — it's populated when frame timeline + Flutter
    // pipeline detection succeeds. Falls back to architecture detection for flutter-specific analysis.
    primaryTable: 'android_frames',
    applicableArchs: ['FLUTTER'],
    priority: 'critical',
  },

  // ── Startup ──
  {
    id: 'startup',
    displayName: '启动性能分析',
    primaryTable: 'android_startups',
    priority: 'critical',
  },

  // ── IPC / synchronization ──
  {
    id: 'binder_ipc',
    displayName: 'Binder/IPC 分析',
    primaryTable: 'android_binder_txns',
    priority: 'recommended',
  },
  {
    id: 'lock_contention',
    displayName: '锁竞争分析',
    primaryTable: 'android_monitor_contention',
    priority: 'recommended',
  },

  // ── Memory ──
  {
    id: 'gc_memory',
    displayName: 'GC/内存分析',
    primaryTable: 'android_garbage_collection_events',
    priority: 'recommended',
  },
  {
    id: 'memory_pressure',
    displayName: '内存压力/LMK',
    primaryTable: 'android_oom_adj_intervals',
    priority: 'recommended',
  },

  // ── CPU ──
  {
    id: 'cpu_scheduling',
    displayName: 'CPU 调度分析',
    primaryTable: 'sched_slice',
    priority: 'critical',
  },
  {
    id: 'thermal_throttling',
    displayName: '热降频分析',
    primaryTable: 'android_dvfs_counters',
    priority: 'recommended',
  },

  // ── I/O ──
  {
    id: 'disk_io',
    displayName: 'I/O 分析',
    primaryTable: 'linux_active_block_io_operations_by_device',
    priority: 'optional',
  },

  // ── GPU ──
  {
    id: 'gpu',
    displayName: 'GPU 分析',
    primaryTable: 'gpu_slice',
    priority: 'optional',
  },

  // ── Profiling ──
  {
    id: 'cpu_profiling',
    displayName: 'CPU Profiling',
    primaryTable: 'linux_perf_samples_summary_tree',
    priority: 'optional',
  },

  // ── Input ──
  {
    id: 'input_latency',
    displayName: '输入延迟分析',
    primaryTable: 'android_input_events',
    priority: 'recommended',
  },

  // ── Display pipeline ──
  {
    id: 'surfaceflinger',
    displayName: 'SurfaceFlinger/Display 管线',
    primaryTable: 'android_surfaceflinger_workloads',
    priority: 'recommended',
  },

  // ── System state ──
  {
    id: 'device_state',
    displayName: '设备状态',
    primaryTable: 'android_screen_state',
    priority: 'optional',
  },
  {
    id: 'battery_power',
    displayName: '电池/功耗分析',
    primaryTable: 'android_battery_stats_state',
    priority: 'optional',
  },

  // ── IRQ ──
  {
    id: 'interrupts',
    displayName: 'IRQ/中断分析',
    primaryTable: 'linux_hard_irqs',
    priority: 'optional',
  },

  // ── ANR ──
  {
    id: 'anr',
    displayName: 'ANR 分析',
    primaryTable: 'android_anrs',
    priority: 'optional',
  },
];

/**
 * Probe trace data completeness.
 *
 * @param tps TraceProcessorService instance
 * @param traceId Active trace ID
 * @param architectureType Detected architecture (used for not_applicable filtering)
 * @returns TraceCompleteness diagnosis
 */
export async function probeTraceCompleteness(
  tps: TraceProcessorService,
  traceId: string,
  architectureType?: RenderingArchitectureType,
): Promise<TraceCompleteness> {
  const t0 = Date.now();

  // ── Layer 1: Schema existence check ──────────────────────────────────────
  // Query sqlite_master for all table/view names relevant to our capabilities.
  const schemaResult = await tps.query(
    traceId,
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  ).catch(() => null);

  const existingTables = new Set<string>();
  if (schemaResult?.rows) {
    for (const row of schemaResult.rows) {
      existingTables.add(row[0] as string);
    }
  }

  // ── Layer 2: Data existence check (only for tables that exist in schema) ──
  // Build a single UNION ALL query for efficiency.
  const tablesToProbe = CAPABILITY_REGISTRY
    .filter(cap => existingTables.has(cap.primaryTable))
    .map(cap => cap.primaryTable);

  const dataPresence = new Map<string, number>(); // table → approximate row count

  if (tablesToProbe.length > 0) {
    // COUNT with LIMIT ${INSUFFICIENT_THRESHOLD} — only need to distinguish: 0 / 1..threshold / >threshold.
    const unionParts = tablesToProbe.map(
      t => `SELECT '${t}' AS tbl, COUNT(*) AS cnt FROM (SELECT 1 FROM ${t} LIMIT ${INSUFFICIENT_THRESHOLD})`,
    );
    const countSql = unionParts.join(' UNION ALL ');

    try {
      const countResult = await tps.query(traceId, countSql);
      if (countResult?.rows) {
        for (const row of countResult.rows) {
          dataPresence.set(row[0] as string, row[1] as number);
        }
      }
    } catch (err) {
      // If the batch query fails (rare — e.g., one table has incompatible schema),
      // fall back to individual probes.
      console.warn('[TraceCompleteness] Batch count failed, falling back to individual probes:', (err as Error).message);
      await Promise.all(tablesToProbe.map(async (t) => {
        try {
          const r = await tps.query(traceId, `SELECT COUNT(*) FROM (SELECT 1 FROM ${t} LIMIT ${INSUFFICIENT_THRESHOLD})`);
          dataPresence.set(t, r?.rows?.[0]?.[0] as number ?? 0);
        } catch {
          dataPresence.set(t, 0);
        }
      }));
    }
  }

  // ── Classify each capability ─────────────────────────────────────────────
  const available: CapabilityProbeResult[] = [];
  const missingConfig: CapabilityProbeResult[] = [];
  const notApplicable: CapabilityProbeResult[] = [];
  const insufficient: CapabilityProbeResult[] = [];

  for (const cap of CAPABILITY_REGISTRY) {
    // Architecture applicability check
    if (architectureType) {
      if (cap.applicableArchs && !cap.applicableArchs.includes(architectureType)) {
        notApplicable.push({
          id: cap.id,
          displayName: cap.displayName,
          status: 'not_applicable',
          primaryTable: cap.primaryTable,
          reason: `当前架构 ${architectureType} 不适用`,
        });
        continue;
      }
      if (cap.excludedArchs?.includes(architectureType)) {
        notApplicable.push({
          id: cap.id,
          displayName: cap.displayName,
          status: 'not_applicable',
          primaryTable: cap.primaryTable,
          reason: `${architectureType} 架构使用专用分析管线`,
        });
        continue;
      }
    }

    // Schema existence
    if (!existingTables.has(cap.primaryTable)) {
      missingConfig.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'missing_config_suspected',
        primaryTable: cap.primaryTable,
        reason: `表 ${cap.primaryTable} 不存在 — 可能未开启所需 trace 配置`,
      });
      continue;
    }

    // Data existence
    const rowCount = dataPresence.get(cap.primaryTable) ?? 0;
    if (rowCount === 0) {
      missingConfig.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'missing_config_suspected',
        primaryTable: cap.primaryTable,
        rowEstimate: 0,
        reason: `表 ${cap.primaryTable} 存在但无数据 — 可能未开启所需 atrace/ftrace 配置，或场景未发生`,
      });
    } else if (rowCount < INSUFFICIENT_THRESHOLD) {
      insufficient.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'insufficient_or_scene_absent',
        primaryTable: cap.primaryTable,
        rowEstimate: rowCount,
        reason: `仅 ${rowCount} 行数据 — trace 时长可能不够或场景未充分发生`,
      });
    } else {
      available.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'available',
        primaryTable: cap.primaryTable,
        rowEstimate: rowCount,
      });
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[TraceCompleteness] Probed ${CAPABILITY_REGISTRY.length} capabilities in ${elapsed}ms: ` +
    `available=${available.length}, missing=${missingConfig.length}, ` +
    `n/a=${notApplicable.length}, insufficient=${insufficient.length}`,
  );

  return {
    available,
    missingConfig,
    notApplicable,
    insufficient,
    diagnosedAt: Date.now(),
  };
}

/** Export the registry for use by comparison mode's capability dictionary. */
export { CAPABILITY_REGISTRY };
export type { CapabilityDef };