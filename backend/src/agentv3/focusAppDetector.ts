// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../services/traceProcessorService';

export interface DetectedFocusApp {
  packageName: string;
  totalDurationNs: number;
  switchCount: number;
}

export interface FocusAppDetectionResult {
  apps: DetectedFocusApp[];
  primaryApp?: string;
  method: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none';
}

// System processes to exclude — they're always in foreground but not user apps
const SYSTEM_PROCESS_FILTERS = [
  'system_server',
  'com.android.systemui',
  'com.android.launcher',
  'com.android.phone',
  'com.android.providers',
  '/system/bin/',
  'zygote',
  // Google system apps that frequently appear in foreground but are rarely analysis targets
  'com.google.android.inputmethod',   // Gboard
  'com.google.android.apps.nexuslauncher', // Pixel Launcher
  'com.android.inputmethod',          // AOSP keyboard
  'com.google.android.apps.wallpaper', // Wallpaper picker
];

function isSystemProcess(name: string): boolean {
  const lower = name.toLowerCase();
  return SYSTEM_PROCESS_FILTERS.some(f => lower.includes(f));
}

/**
 * Detect foreground ("focus") apps from a Perfetto trace using 2-tier SQL.
 *
 * Tier 1: android_battery_stats_event_slices — most reliable, tracks `battery_stats.top`
 * Tier 2: android_oom_adj_intervals — fallback, oom_adj=0 means foreground
 *
 * Both tiers guard against missing tables via sqlite_master checks.
 */
export async function detectFocusApps(
  traceProcessorService: TraceProcessorService,
  traceId: string,
): Promise<FocusAppDetectionResult> {
  // Tier 1: battery_stats.top
  try {
    const tableCheck = await traceProcessorService.query(traceId,
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='android_battery_stats_event_slices'`
    );
    const hasTable = tableCheck.rows?.[0]?.[0] > 0;

    if (hasTable) {
      const result = await traceProcessorService.query(traceId, `
        SELECT
          str_value AS package_name,
          SUM(safe_dur) AS total_duration_ns,
          COUNT(*) AS switch_count
        FROM android_battery_stats_event_slices
        WHERE track_name = 'battery_stats.top'
          AND safe_dur > 50000000
        GROUP BY str_value
        ORDER BY total_duration_ns DESC
        LIMIT 10
      `);

      if (result.rows.length > 0) {
        const apps = result.rows
          .map(row => ({
            packageName: String(row[0]),
            totalDurationNs: Number(row[1]),
            switchCount: Number(row[2]),
          }))
          .filter(app => !isSystemProcess(app.packageName));

        if (apps.length > 0) {
          return {
            apps,
            primaryApp: apps[0].packageName,
            method: 'battery_stats',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 1 (battery_stats) failed:', (err as Error).message);
  }

  // Tier 2: oom_adj intervals (oom_adj=0 = foreground)
  try {
    const tableCheck = await traceProcessorService.query(traceId,
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='android_oom_adj_intervals'`
    );
    const hasTable = tableCheck.rows?.[0]?.[0] > 0;

    if (hasTable) {
      const result = await traceProcessorService.query(traceId, `
        SELECT
          p.name AS package_name,
          SUM(oa.dur) AS total_duration_ns,
          COUNT(*) AS switch_count
        FROM android_oom_adj_intervals oa
        JOIN process p USING(upid)
        WHERE oa.oom_adj <= 0 AND oa.oom_adj > -900
          AND p.name IS NOT NULL
          AND p.name != ''
        GROUP BY p.name
        ORDER BY total_duration_ns DESC
        LIMIT 10
      `);

      if (result.rows.length > 0) {
        const apps = result.rows
          .map(row => ({
            packageName: String(row[0]),
            totalDurationNs: Number(row[1]),
            switchCount: Number(row[2]),
          }))
          .filter(app => !isSystemProcess(app.packageName));

        if (apps.length > 0) {
          return {
            apps,
            primaryApp: apps[0].packageName,
            method: 'oom_adj',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 2 (oom_adj) failed:', (err as Error).message);
  }

  // Tier 3: actual_frame_timeline_slice layer_name (always present when frames exist)
  // layer_name format: "TX - com.example.app/com.example.app.Activity#1234"
  try {
    const tableCheck = await traceProcessorService.query(traceId,
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='view' AND name='actual_frame_timeline_slice'`
    );
    const hasTable = tableCheck.rows?.[0]?.[0] > 0;

    if (hasTable) {
      const result = await traceProcessorService.query(traceId, `
        SELECT
          CASE
            WHEN layer_name LIKE 'TX - %/%'
              THEN SUBSTR(layer_name, 6, INSTR(SUBSTR(layer_name, 6), '/') - 1)
            WHEN layer_name LIKE 'TX - %'
              THEN SUBSTR(layer_name, 6)
            ELSE layer_name
          END AS package_name,
          SUM(dur) AS total_duration_ns,
          COUNT(*) AS frame_count
        FROM actual_frame_timeline_slice
        WHERE layer_name IS NOT NULL AND layer_name != ''
        GROUP BY package_name
        ORDER BY frame_count DESC
        LIMIT 10
      `);

      if (result.rows.length > 0) {
        const apps = result.rows
          .map(row => ({
            packageName: String(row[0]),
            totalDurationNs: Number(row[1]),
            switchCount: Number(row[2]),
          }))
          .filter(app => app.packageName && !isSystemProcess(app.packageName));

        if (apps.length > 0) {
          return {
            apps,
            primaryApp: apps[0].packageName,
            method: 'frame_timeline',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 3 (frame_timeline) failed:', (err as Error).message);
  }

  return { apps: [], method: 'none' };
}

/** Human-readable duration for system prompt (e.g. "2.3s", "145ms") */
export function formatDurationNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(1)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(0)}ms`;
  return `${(ns / 1_000).toFixed(0)}us`;
}