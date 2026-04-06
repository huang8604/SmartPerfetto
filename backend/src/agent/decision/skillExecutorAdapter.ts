// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Executor Adapter
 *
 * Bridges the Decision Tree's SkillExecutorInterface with the actual
 * Skill system (SkillAnalysisAdapter). This allows decision trees to
 * invoke YAML-defined skills transparently.
 */

import { SkillExecutorInterface } from './decisionTreeExecutor';
import { DecisionContext } from './types';

/**
 * Adapter that implements SkillExecutorInterface for decision trees
 */
export class SkillExecutorAdapter implements SkillExecutorInterface {
  private cache: Map<string, any> = new Map();
  private enableCache: boolean;

  constructor(options: { enableCache?: boolean } = {}) {
    this.enableCache = options.enableCache ?? true;
  }

  /**
   * Execute a skill and return its result
   */
  async execute(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): Promise<any> {
    const cacheKey = this.buildCacheKey(skillId, params, context);

    // Check cache first
    if (this.enableCache && this.cache.has(cacheKey)) {
      console.log(`[SkillExecutorAdapter] Cache hit for skill: ${skillId}`);
      return this.cache.get(cacheKey);
    }

    console.log(`[SkillExecutorAdapter] Executing skill: ${skillId}`);
    console.log(`[SkillExecutorAdapter] Params: ${JSON.stringify(params)}`);

    try {
      // Dynamically import to avoid circular dependencies
      const { SkillAnalysisAdapter } = await import(
        '../../services/skillEngine/skillAnalysisAdapter'
      );

      // Create adapter instance
      const adapter = new SkillAnalysisAdapter(context.traceProcessorService);

      // Build request
      const request = {
        traceId: context.traceId,
        skillId,
        packageName: params.packageName || context.packageName,
        // Pass additional params if the skill supports them
        ...params,
      };

      // Execute skill
      const response = await adapter.analyze(request);

      // Transform result to a more usable format for decision trees
      const result = this.transformResult(skillId, response);

      // Cache the result
      if (this.enableCache) {
        this.cache.set(cacheKey, result);
      }

      return result;
    } catch (error: any) {
      console.error(`[SkillExecutorAdapter] Error executing skill ${skillId}:`, error);
      throw error;
    }
  }

  /**
   * Transform skill response to a flattened format for decision tree evaluation
   */
  private transformResult(skillId: string, response: any): any {
    // Base result with common fields
    const result: Record<string, any> = {
      skillId: response.skillId,
      success: response.success,
      summary: response.summary,
      diagnostics: response.diagnostics || [],
      sections: response.sections || {},
    };

    // Extract layered data
    if (response.layeredResult?.layers) {
      const layers = response.layeredResult.layers;
      // Keep original layered structure for decision trees that read layers.* directly.
      result.layers = layers;
      result.layeredResult = response.layeredResult;

      // Merge overview data into result
      if (layers.overview) {
        for (const [key, value] of Object.entries(layers.overview)) {
          if (typeof value === 'object' && value !== null && 'data' in (value as any)) {
            result[key] = (value as any).data;
          } else {
            result[key] = value;
          }
        }
      }

      // Merge list data into result
      if (layers.list) {
        result.sessions = layers.list;
        for (const [key, value] of Object.entries(layers.list)) {
          if (typeof value === 'object' && value !== null && 'data' in (value as any)) {
            result[`list_${key}`] = (value as any).data;
          }
        }
      }

      // Include deep data
      if (layers.deep) {
        result.frameDetails = layers.deep;
      }
    }

    // Backfill startup aliases used by decision trees.
    // Layered results are keyed by step id (e.g. get_startups), while
    // startup decision logic may read save_as alias (startups).
    if (skillId === 'startup_analysis') {
      const startupRows = this.extractStartupRows(result, response);
      if (startupRows.length > 0) {
        if (!Array.isArray(result.startups) || result.startups.length === 0) {
          result.startups = startupRows;
        }
        if (!Array.isArray(result.get_startups) || result.get_startups.length === 0) {
          result.get_startups = startupRows;
        }
      }
    }

    // Skill-specific transformations
    result.transformed = this.applySkillSpecificTransform(skillId, result, response);

    return result;
  }

  /**
   * Apply skill-specific transformations to make data easier to query
   */
  private applySkillSpecificTransform(
    skillId: string,
    result: Record<string, any>,
    response: any
  ): Record<string, any> {
    switch (skillId) {
      case 'scrolling_analysis':
        return this.transformScrollingResult(result);

      case 'startup_analysis':
        return this.transformStartupResult(result);

      case 'jank_frame_detail':
        return this.transformJankResult(result);

      case 'cpu_analysis':
        return this.transformCpuResult(result);

      case 'binder_analysis':
        return this.transformBinderResult(result);

      default:
        return result;
    }
  }

  /**
   * Transform scrolling analysis result
   */
  private transformScrollingResult(result: Record<string, any>): Record<string, any> {
    // scrolling_analysis currently emits overview step `performance_summary`.
    // Keep compatibility with older `scrolling_summary` naming while preferring the new schema.
    const performanceSummaryRows = this.normalizeRowArray(result.performance_summary);
    const legacySummaryRows = this.normalizeRowArray(result.scrolling_summary);
    const summaryRows = performanceSummaryRows.length > 0 ? performanceSummaryRows : legacySummaryRows;
    const summary = summaryRows[0] || {};

    const sessionRows = this.normalizeRowArray(result.list_scroll_sessions);
    const sessionFpsList = sessionRows
      .map((row) => this.extractNumber(row, ['session_fps', 'fps', 'avg_fps']))
      .filter((v) => v > 0);

    const actualFps = this.extractNumber(summary, ['actual_fps', 'avg_fps', 'averageFps']);
    const rawJankRate = this.extractNumber(summary, ['jank_rate', 'janky_rate', 'jankyRate']);
    const normalizedJankRate = rawJankRate > 1 ? rawJankRate / 100 : rawJankRate;
    const avgFrameDurNs = this.extractNumber(summary, ['avg_frame_dur']);
    const avgFrameDurMs = this.extractNumber(summary, ['avg_frame_time_ms', 'avgFrameTimeMs']);
    const minFpsFromSessions = sessionFpsList.length > 0 ? Math.min(...sessionFpsList) : 0;

    return {
      avg_fps: actualFps,
      min_fps: this.extractNumber(summary, ['min_fps', 'minFps']) || minFpsFromSessions,
      janky_frame_count: this.extractNumber(summary, ['janky_frames', 'janky_frame_count', 'jankyFrameCount', 'janky_count']),
      total_frame_count: this.extractNumber(summary, ['total_frames', 'total_frame_count', 'totalFrameCount', 'total_count']),
      janky_rate: normalizedJankRate,
      jank_rate_pct: rawJankRate > 1 ? rawJankRate : rawJankRate * 100,
      avg_frame_time_ms: avgFrameDurMs || (avgFrameDurNs > 0 ? avgFrameDurNs / 1e6 : 0),
      session_count: sessionRows.length || (result.sessions ? Object.keys(result.sessions).length : 0),
    };
  }

  /**
   * Transform startup analysis result
   *
   * startup_analysis.skill.yaml saves data as 'startups' (save_as: startups),
   * with columns: startup_type, dur_ms, ttid_ms, ttfd_ms, rating, perfetto_start.
   * Phase-level breakdown (process_start_time, etc.) is NOT available from
   * startup_analysis — it would require future startup_detail enhancements.
   */
  private transformStartupResult(result: Record<string, any>): Record<string, any> {
    const startups = this.extractStartupRows(result);
    if (startups.length > 0) {
      result.startups = startups;
      if (!Array.isArray(result.get_startups) || result.get_startups.length === 0) {
        result.get_startups = startups;
      }
    }

    const first: Record<string, any> = startups.length > 0 ? startups[0] : {};
    const summary = result.startup_summary?.data || result.startup_summary || {};
    const source = Object.keys(first).length > 0 ? first : summary;

    return {
      // startup_analysis outputs startup_type (not launch_type)
      launch_type: source.startup_type || source.launch_type || 'cold',
      startup_type: source.startup_type || source.launch_type || 'cold',
      // startup_analysis outputs ttid_ms (not ttid)
      ttid: this.extractNumber(source, ['ttid_ms', 'ttid', 'time_to_initial_display']),
      ttid_ms: this.extractNumber(source, ['ttid_ms']),
      dur_ms: this.extractNumber(source, ['dur_ms', 'duration_ms', 'dur']),
      ttfd: this.extractNumber(source, ['ttfd_ms', 'ttfd', 'time_to_full_display']),
      // Phase breakdown fields — not available from startup_analysis currently.
      // These are placeholders for when startup_detail adds phase-level breakdown.
      process_start_time: this.extractNumber(source, ['process_start_time', 'processStartTime']),
      application_init_time: this.extractNumber(source, ['application_init_time', 'applicationInitTime']),
      activity_create_time: this.extractNumber(source, ['activity_create_time', 'activityCreateTime']),
      first_frame_time: this.extractNumber(source, ['first_frame_time', 'firstFrameTime']),
      zygote_fork_time: this.extractNumber(source, ['zygote_fork_time', 'zygoteForkTime', 'fork_time']),
      layout_inflate_time: this.extractNumber(source, ['layout_inflate_time', 'layoutInflateTime', 'inflate_time']),
    };
  }

  private extractStartupRows(
    result: Record<string, any>,
    response?: any
  ): Array<Record<string, any>> {
    const candidates = [
      result.startups,
      result.get_startups,
      result.list_get_startups,
      response?.sections?.startups,
      response?.sections?.get_startups,
      response?.layeredResult?.layers?.overview?.get_startups,
      response?.layeredResult?.layers?.list?.get_startups,
    ];

    for (const candidate of candidates) {
      const rows = this.normalizeRowArray(candidate);
      if (rows.length > 0) {
        return rows;
      }
    }

    return [];
  }

  private normalizeRowArray(value: any): Array<Record<string, any>> {
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, any> =>
        !!row && typeof row === 'object' && !Array.isArray(row)
      );
    }

    if (!value || typeof value !== 'object') {
      return [];
    }

    if (Array.isArray((value as any).data)) {
      return this.normalizeRowArray((value as any).data);
    }

    const columns = Array.isArray((value as any).columns) ? (value as any).columns : [];
    const rows = Array.isArray((value as any).rows) ? (value as any).rows : [];
    if (columns.length > 0 && rows.length > 0) {
      return rows
        .filter((row: any) => Array.isArray(row))
        .map((row: any[]) => this.mapColumnsToRow(columns, row));
    }

    return [];
  }

  private mapColumnsToRow(columns: string[], row: any[]): Record<string, any> {
    const mapped: Record<string, any> = {};
    for (let i = 0; i < columns.length; i++) {
      mapped[columns[i]] = row[i];
    }
    return mapped;
  }

  /**
   * Transform jank analysis result
   */
  private transformJankResult(result: Record<string, any>): Record<string, any> {
    const summary = result.jank_summary?.data || result.jank_summary || {};
    const rootCause = this.findFirstRowByStepId(result, ['root_cause_summary', 'root_cause']);

    const reasonCode = String(rootCause?.reason_code || '').toLowerCase();
    const jankResponsibility = String(rootCause?.jank_responsibility || '').toUpperCase();
    const amplificationPath = String(rootCause?.amplification_path || '').toLowerCase();
    const mechanismGroup = String(rootCause?.mechanism_group || '').toLowerCase();
    const diagnosticsText = Array.isArray(result.diagnostics)
      ? result.diagnostics.map((d: any) => String(d?.message || d?.diagnosis || '')).join(' ')
      : '';
    const diagnosticsLower = diagnosticsText.toLowerCase();

    const appDeadlineMissed =
      jankResponsibility === 'APP' ||
      amplificationPath.includes('app_deadline') ||
      diagnosticsLower.includes('app deadline');
    const sfStuffing =
      jankResponsibility === 'SF' ||
      amplificationPath.includes('sf_consumer') ||
      diagnosticsLower.includes('surfaceflinger') ||
      diagnosticsLower.includes('sf stuffing');
    const binderBlocking =
      reasonCode === 'binder_sync_blocking' ||
      mechanismGroup.includes('blocking') ||
      diagnosticsLower.includes('binder');

    const mainSliceRows = this.findRowsByStepId(result, ['main_thread_slices', 'main_slices']);
    const renderSliceRows = this.findRowsByStepId(result, ['render_thread_slices', 'render_slices']);
    const avgMainDur = this.averageByKey(mainSliceRows, ['dur_ms', 'total_ms']);
    const avgRenderDur = this.averageByKey(renderSliceRows, ['dur_ms', 'total_ms']);

    return {
      janky_frame_count: this.extractNumber(summary, ['janky_frame_count', 'jankyFrameCount']),
      total_frame_count: this.extractNumber(summary, ['total_frame_count', 'totalFrameCount']),
      avg_jank_duration_ms: this.extractNumber(summary, ['avg_jank_duration_ms', 'avgJankDurationMs']),
      max_jank_duration_ms: this.extractNumber(summary, ['max_jank_duration_ms', 'maxJankDurationMs']),
      // Frame breakdown by cause
      main_thread_jank_count: this.extractNumber(summary, ['main_thread_jank_count', 'mainThreadJankCount']),
      render_thread_jank_count: this.extractNumber(summary, ['render_thread_jank_count', 'renderThreadJankCount']),
      gpu_jank_count: this.extractNumber(summary, ['gpu_jank_count', 'gpuJankCount']),
      sf_jank_count: this.extractNumber(summary, ['sf_jank_count', 'sfJankCount']),
      // Decision tree compatibility fields
      app_deadline_missed_ratio: appDeadlineMissed ? 1 : 0,
      sf_stuffing_ratio: sfStuffing ? 1 : 0,
      has_binder_block: binderBlocking,
      avg_do_frame_time: avgMainDur,
      avg_render_time: avgRenderDur,
    };
  }

  private findRowsByStepId(
    result: Record<string, any>,
    stepIds: string[]
  ): Array<Record<string, any>> {
    for (const stepId of stepIds) {
      const direct = this.normalizeRowArray((result as any)[stepId]);
      if (direct.length > 0) return direct;

      const listRows = this.normalizeRowArray((result as any)[`list_${stepId}`]);
      if (listRows.length > 0) return listRows;
    }

    const deep = result.layers?.deep;
    if (deep && typeof deep === 'object') {
      for (const session of Object.values(deep as Record<string, any>)) {
        if (!session || typeof session !== 'object') continue;
        for (const stepId of stepIds) {
          const step = (session as any)[stepId];
          if (!step) continue;
          const rows = this.normalizeRowArray((step as any).data ?? step);
          if (rows.length > 0) return rows;
        }
      }
    }

    return [];
  }

  private findFirstRowByStepId(
    result: Record<string, any>,
    stepIds: string[]
  ): Record<string, any> {
    const rows = this.findRowsByStepId(result, stepIds);
    return rows.length > 0 ? rows[0] : {};
  }

  private averageByKey(
    rows: Array<Record<string, any>>,
    keys: string[]
  ): number {
    if (!rows || rows.length === 0) return 0;
    let sum = 0;
    let count = 0;
    for (const row of rows) {
      const value = this.extractNumber(row, keys);
      if (value > 0) {
        sum += value;
        count += 1;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  /**
   * Transform CPU analysis result
   */
  private transformCpuResult(result: Record<string, any>): Record<string, any> {
    const summary = result.cpu_summary?.data || result.cpu_summary || {};

    return {
      avg_cpu_usage: this.extractNumber(summary, ['avg_cpu_usage', 'avgCpuUsage']),
      max_cpu_usage: this.extractNumber(summary, ['max_cpu_usage', 'maxCpuUsage']),
      main_thread_cpu_usage: this.extractNumber(summary, ['main_thread_cpu_usage', 'mainThreadCpuUsage']),
      render_thread_cpu_usage: this.extractNumber(summary, ['render_thread_cpu_usage', 'renderThreadCpuUsage']),
      avg_runnable_time: this.extractNumber(summary, ['avg_runnable_time', 'avgRunnableTime', 'avg_runnable_ms', 'runnable_avg_ms']),
    };
  }

  /**
   * Transform Binder analysis result
   */
  private transformBinderResult(result: Record<string, any>): Record<string, any> {
    const summary = result.binder_summary?.data || result.binder_summary || {};

    return {
      total_binder_calls: this.extractNumber(summary, ['total_binder_calls', 'totalBinderCalls']),
      avg_binder_duration_ms: this.extractNumber(summary, ['avg_binder_duration_ms', 'avgBinderDurationMs']),
      max_binder_duration_ms: this.extractNumber(summary, ['max_binder_duration_ms', 'maxBinderDurationMs']),
      blocking_binder_count: this.extractNumber(summary, ['blocking_binder_count', 'blockingBinderCount']),
    };
  }

  /**
   * Extract a number from an object with multiple possible key names
   */
  private extractNumber(obj: any, keys: string[]): number {
    if (!obj) return 0;

    for (const key of keys) {
      if (key in obj) {
        const value = obj[key];
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) return parsed;
        }
      }
    }

    return 0;
  }

  /**
   * Build a cache key for skill results
   */
  private buildCacheKey(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): string {
    return `${context.traceId}:${skillId}:${JSON.stringify(params)}`;
  }

  /**
   * Clear the result cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Create a skill executor adapter instance
 */
export function createSkillExecutorAdapter(
  options?: { enableCache?: boolean }
): SkillExecutorAdapter {
  return new SkillExecutorAdapter(options);
}

export default SkillExecutorAdapter;