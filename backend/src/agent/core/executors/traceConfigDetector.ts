// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace Configuration Detector
 *
 * Detects trace-level configuration (VSync period, refresh rate, VRR mode)
 * by executing vsync_config and vrr_detection skills at the start of analysis.
 *
 * This information is used for:
 * - Accurate jank threshold calculation (帧预算因刷新率而异)
 * - Contradiction resolution in conclusionGenerator
 * - VRR-aware jank detection
 */

import { TraceConfig } from '../../types/agentProtocol';
import {
  SkillExecutor,
  createSkillExecutor,
} from '../../../services/skillEngine/skillExecutor';
import {
  skillRegistry,
  ensureSkillRegistryInitialized,
} from '../../../services/skillEngine/skillLoader';
import { ProgressEmitter } from '../orchestratorTypes';

/**
 * Default trace configuration when detection fails.
 * Uses 120Hz as the modern flagship default.
 */
const DEFAULT_TRACE_CONFIG: TraceConfig = {
  vsyncPeriodNs: 8333333,
  refreshRateHz: 120,
  vsyncPeriodMs: 8.33,
  vsyncSource: 'default_120hz',
  isVRR: false,
  vrrMode: 'FIXED_RATE',
};

/**
 * Detect trace configuration by executing vsync_config skill.
 *
 * @param traceProcessorService - Trace processor service for SQL queries
 * @param aiService - AI service (may be null for pure SQL skills)
 * @param traceId - Trace ID
 * @param emitter - Progress emitter for logging
 * @returns Detected TraceConfig or default values
 */
export async function detectTraceConfig(
  traceProcessorService: any,
  aiService: any,
  traceId: string,
  emitter: ProgressEmitter
): Promise<TraceConfig> {
  try {
    // Ensure skill registry is initialized
    await ensureSkillRegistryInitialized();

    // Create skill executor
    const skillExecutor = createSkillExecutor(traceProcessorService, aiService);
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    // Execute vsync_config skill
    emitter.log('[TraceConfig] Detecting VSync configuration...');
    const vsyncResult = await skillExecutor.execute('vsync_config', traceId, {});

    if (!vsyncResult.success) {
      emitter.log(`[TraceConfig] vsync_config failed: ${vsyncResult.error}, using defaults`);
      return DEFAULT_TRACE_CONFIG;
    }

    // Extract vsync config from result (support legacy step ids and save_as naming)
    const vsyncData = getFirstRowFromSkillResult(vsyncResult, [
      // legacy expectations (save_as)
      'vsync_config',
      // current vsync_config.skill.yaml step id
      'detect_vsync_config',
      // root-level atomic fallback
      'root',
    ]);
    if (!vsyncData) {
      emitter.log('[TraceConfig] No vsync_config data, using defaults');
      return DEFAULT_TRACE_CONFIG;
    }

    const config: TraceConfig = {
      vsyncPeriodNs: Number(vsyncData.vsync_period_ns) || DEFAULT_TRACE_CONFIG.vsyncPeriodNs,
      refreshRateHz: Number(vsyncData.refresh_rate_hz) || DEFAULT_TRACE_CONFIG.refreshRateHz,
      vsyncPeriodMs: Number(vsyncData.vsync_period_ms) || DEFAULT_TRACE_CONFIG.vsyncPeriodMs,
      vsyncSource: String(vsyncData.vsync_source || 'unknown'),
      isVRR: false,
      vrrMode: 'FIXED_RATE',
    };

    emitter.log(`[TraceConfig] Detected: ${config.refreshRateHz}Hz (${config.vsyncPeriodMs}ms), source: ${config.vsyncSource}`);

    // Optionally detect VRR mode and extract refresh rate distribution
    try {
      const vrrResult = await skillExecutor.execute('vrr_detection', traceId, {});
      if (vrrResult.success) {
        const vrrData = getFirstRowFromSkillResult(vrrResult, [
          // legacy expectations (save_as)
          'vrr_status',
          // current vrr_detection.skill.yaml step id
          'vrr_mode_detection',
          // root-level atomic fallback
          'root',
        ]);
        if (vrrData) {
          config.vrrMode = vrrData.vrr_mode as TraceConfig['vrrMode'] || 'FIXED_RATE';
          config.isVRR = config.vrrMode !== 'FIXED_RATE';

          if (config.isVRR) {
            emitter.log(`[TraceConfig] VRR detected: ${config.vrrMode}`);

            // Extract refresh rate distribution to determine min/max frame budgets
            const distribution = getRowsFromSkillResult(vrrResult, [
              // legacy expectations (save_as)
              'refresh_rate_distribution',
              // current vrr_detection.skill.yaml step id
              'vsync_interval_distribution',
            ]);
            if (distribution && Array.isArray(distribution) && distribution.length > 0) {
              // Parse refresh rates from distribution (e.g., "120Hz", "60Hz")
              const rates = distribution
                .map((row: any) => {
                  const bucket = String(row.refresh_rate_bucket || '');
                  const match = bucket.match(/(\d+)Hz/);
                  return match ? parseInt(match[1], 10) : 0;
                })
                .filter((r: number) => r > 0);

              if (rates.length > 0) {
                const minRate = Math.min(...rates);
                const maxRate = Math.max(...rates);
                // minFrameBudgetMs = 1000 / maxRate (strictest threshold)
                // maxFrameBudgetMs = 1000 / minRate (most lenient threshold)
                config.minFrameBudgetMs = Math.round(1000 / maxRate * 100) / 100;
                config.maxFrameBudgetMs = Math.round(1000 / minRate * 100) / 100;
                emitter.log(`[TraceConfig] VRR range: ${minRate}-${maxRate}Hz, frame budget: ${config.minFrameBudgetMs}-${config.maxFrameBudgetMs}ms`);
              }
            }
          }
        }
      }
    } catch (vrrError) {
      // VRR detection is optional, don't fail if it errors
      emitter.log(`[TraceConfig] VRR detection skipped: ${vrrError}`);
    }

    return config;
  } catch (error: any) {
    emitter.log(`[TraceConfig] Detection failed: ${error.message}, using defaults`);
    return DEFAULT_TRACE_CONFIG;
  }
}

function getRowsFromSkillResult(result: any, candidateKeys: string[]): any[] | null {
  const rawResults = result?.rawResults;
  if (!rawResults || typeof rawResults !== 'object') return null;

  for (const key of candidateKeys) {
    const step = rawResults[key];
    const data = step?.data;
    if (Array.isArray(data) && data.length > 0) return data;
  }

  return null;
}

function getFirstRowFromSkillResult(result: any, candidateKeys: string[]): any | null {
  const rows = getRowsFromSkillResult(result, candidateKeys);
  if (!rows || rows.length === 0) return null;
  return rows[0];
}

/**
 * Format trace config for inclusion in LLM prompts.
 */
export function formatTraceConfigForPrompt(config: TraceConfig): string {
  const lines: string[] = [];
  lines.push(`刷新率: ${config.refreshRateHz}Hz`);
  lines.push(`帧预算: ${config.vsyncPeriodMs}ms`);
  if (config.isVRR) {
    lines.push(`VRR 模式: ${config.vrrMode}`);
  }
  return lines.join(', ');
}