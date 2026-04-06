// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Scrolling Analysis Decision Tree
 *
 * 实现专家级滑动卡顿分析的决策逻辑：
 * 1. 先看整体 FPS，确认确实有问题
 * 2. 判断是 FPS 整体偏低还是有突刺/掉帧
 * 3. 根据不同情况分别深入分析
 * 4. 最终定位到 App 问题还是系统问题，以及具体组件
 *
 * 基于 INTELLIGENT_AGENT_DESIGN.md 中的专家决策树
 */

import { getScrollingDecisionThresholds } from '../../config/decisionThresholdManifest';
import { DecisionTree, DecisionContext } from '../types';

const SCROLLING_THRESHOLDS = getScrollingDecisionThresholds();

function ratioToPercentage(ratio: number): string {
  const percent = ratio * 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/**
 * 滑动分析决策树
 */
export const scrollingDecisionTree: DecisionTree = {
  id: 'scrolling_analysis_v1',
  name: '滑动卡顿分析决策树',
  description: '专家级滑动性能分析，自动定位问题根因',
  analysisType: 'scrolling',
  entryNode: 'get_fps_overview',

  nodes: [
    // ===== 阶段 1: 获取整体 FPS 数据 =====
    {
      id: 'get_fps_overview',
      type: 'ACTION',
      name: '获取 FPS 概览',
      action: {
        description: '执行滑动分析获取 FPS 数据',
        skill: 'scrolling_analysis',
        params: {},
        resultKey: 'fps_data',
      },
      next: {
        default: 'check_has_problem',
      },
    },

    // ===== 阶段 2: 检查是否确实有问题 =====
    {
      id: 'check_has_problem',
      type: 'CHECK',
      name: '检查是否有卡顿问题',
      check: {
        description: `FPS >= ${SCROLLING_THRESHOLDS.noProblem.minAvgFps} 且卡顿率 < ${ratioToPercentage(
          SCROLLING_THRESHOLDS.noProblem.maxJankRate
        )}？`,
        useResultFrom: 'fps_data',
        evaluate: (data, _context) => {
          const avgFps = extractAvgFps(data);
          const jankRate = extractJankRate(data);
          // 如果 FPS 达标且卡顿率低，认为流畅
          return avgFps >= SCROLLING_THRESHOLDS.noProblem.minAvgFps
            && jankRate < SCROLLING_THRESHOLDS.noProblem.maxJankRate;
        },
      },
      next: {
        true: 'conclude_no_problem',
        false: 'check_fps_pattern',
      },
    },

    // ===== 阶段 2.1: 流畅结论 =====
    {
      id: 'conclude_no_problem',
      type: 'CONCLUDE',
      name: '结论：流畅',
      conclusion: {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: '滑动性能正常，平均 FPS 达标，卡顿率在可接受范围内',
        confidence: 0.9,
        suggestedNextSteps: [],
      },
    },

    // ===== 阶段 3: 判断 FPS 模式 =====
    {
      id: 'check_fps_pattern',
      type: 'CHECK',
      name: '判断 FPS 下降模式',
      check: {
        description: 'FPS 是持续偏低还是有突刺？',
        useResultFrom: 'fps_data',
        evaluate: (data, _context) => {
          const avgFps = extractAvgFps(data);
          const minFps = extractMinFps(data);
          // 如果平均 FPS 和最低 FPS 差距大，说明有突刺
          // 如果差距小但整体偏低，说明持续慢
          const variance = avgFps - minFps;
          // 持续偏低：方差小，但整体低
          return variance < SCROLLING_THRESHOLDS.continuousLowPattern.maxFpsVariance
            && avgFps < SCROLLING_THRESHOLDS.continuousLowPattern.maxAvgFps;
        },
      },
      next: {
        true: 'analyze_continuous_low', // 持续偏低
        false: 'analyze_spike_jank',     // 有突刺/掉帧
      },
    },

    // ===== 分支 A: 持续偏低分析 =====
    {
      id: 'analyze_continuous_low',
      type: 'ACTION',
      name: '分析 SurfaceFlinger 状态',
      action: {
        description: '检查 SurfaceFlinger 合成是否正常',
        skill: 'surfaceflinger_analysis',
        params: {},
        resultKey: 'sf_data',
      },
      next: {
        default: 'check_sf_normal',
      },
    },

    {
      id: 'check_sf_normal',
      type: 'CHECK',
      name: '检查 SF 是否正常',
      check: {
        description: `SF 合成耗时 < ${SCROLLING_THRESHOLDS.surfaceFlinger.maxAvgCompositionMs}ms？`,
        useResultFrom: 'sf_data',
        evaluate: (data, _context) => {
          const sfAvgDuration = extractSfAvgDuration(data);
          return sfAvgDuration < SCROLLING_THRESHOLDS.surfaceFlinger.maxAvgCompositionMs;
        },
      },
      next: {
        true: 'analyze_app_render',  // SF 正常，看 App
        false: 'conclude_sf_issue',   // SF 异常
      },
    },

    {
      id: 'conclude_sf_issue',
      type: 'CONCLUDE',
      name: '结论：SurfaceFlinger 问题',
      conclusion: {
        category: 'SYSTEM',
        component: 'SURFACE_FLINGER',
        summaryTemplate: 'SurfaceFlinger 合成耗时过长，这是系统层面的问题，可能影响所有应用',
        confidence: 0.85,
        suggestedNextSteps: [
          '检查其他应用是否也有卡顿',
          '检查 HWC 状态',
          '检查 GPU 负载',
        ],
      },
    },

    // ===== 分支 A2: App 渲染分析 =====
    {
      id: 'analyze_app_render',
      type: 'ACTION',
      name: '分析 App 渲染',
      action: {
        description: '获取 RenderThread 详细数据',
        skill: 'jank_frame_detail',
        params: {},
        resultKey: 'render_data',
      },
      next: {
        default: 'check_render_thread',
      },
    },

    {
      id: 'check_render_thread',
      type: 'CHECK',
      name: '检查 RenderThread 耗时',
      check: {
        description: `RenderThread 平均耗时 > ${SCROLLING_THRESHOLDS.renderThread.minAvgRenderMs}ms？`,
        useResultFrom: 'render_data',
        evaluate: (data, _context) => {
          const avgRenderTime = extractAvgRenderTime(data);
          return avgRenderTime > SCROLLING_THRESHOLDS.renderThread.minAvgRenderMs;
        },
      },
      next: {
        true: 'conclude_render_thread_issue',
        false: 'check_main_thread',
      },
    },

    {
      id: 'conclude_render_thread_issue',
      type: 'CONCLUDE',
      name: '结论：RenderThread 耗时过长',
      conclusion: {
        category: 'APP',
        component: 'RENDER_THREAD',
        summaryTemplate: `App 的 RenderThread 耗时过长（> ${SCROLLING_THRESHOLDS.renderThread.minAvgRenderMs}ms），可能是绘制复杂度高或 GPU 负载过重`,
        confidence: 0.85,
        suggestedNextSteps: [
          '检查 DrawFrame 内部的耗时分布',
          '检查是否有过度绘制',
          '检查 GPU 渲染情况',
        ],
      },
    },

    {
      id: 'check_main_thread',
      type: 'CHECK',
      name: '检查主线程',
      check: {
        description: '主线程 doFrame 耗时是否过长？',
        useResultFrom: 'render_data',
        evaluate: (data, _context) => {
          const avgDoFrameTime = extractAvgDoFrameTime(data);
          return avgDoFrameTime > SCROLLING_THRESHOLDS.mainThread.minAvgDoFrameMs;
        },
      },
      next: {
        true: 'conclude_main_thread_issue',
        false: 'analyze_scheduling',
      },
    },

    {
      id: 'conclude_main_thread_issue',
      type: 'CONCLUDE',
      name: '结论：主线程问题',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: 'App 主线程的 doFrame 耗时过长，可能有复杂的布局计算或耗时操作',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 measure/layout/draw 各阶段耗时',
          '检查是否有 Binder 调用阻塞',
          '检查是否有 GC 暂停',
        ],
      },
    },

    // ===== 分支 A3: 调度分析 =====
    {
      id: 'analyze_scheduling',
      type: 'ACTION',
      name: '分析 CPU 调度',
      action: {
        description: '检查 CPU 调度和频率',
        skill: 'cpu_analysis',
        params: {},
        resultKey: 'cpu_data',
      },
      next: {
        default: 'check_scheduling',
      },
    },

    {
      id: 'check_scheduling',
      type: 'CHECK',
      name: '检查调度延迟',
      check: {
        description: `Runnable 时间 > ${SCROLLING_THRESHOLDS.cpuScheduling.minAvgRunnableMs}ms？`,
        useResultFrom: 'cpu_data',
        evaluate: (data, _context) => {
          const avgRunnable = extractAvgRunnableTime(data);
          return avgRunnable > SCROLLING_THRESHOLDS.cpuScheduling.minAvgRunnableMs;
        },
      },
      next: {
        true: 'conclude_scheduling_issue',
        false: 'conclude_unknown',
      },
    },

    {
      id: 'conclude_scheduling_issue',
      type: 'CONCLUDE',
      name: '结论：调度问题',
      conclusion: {
        category: 'SYSTEM',
        component: 'CPU_SCHEDULING',
        summaryTemplate: 'CPU 调度延迟过高，关键线程等待 CPU 时间过长，可能是系统负载高或调度策略问题',
        confidence: 0.75,
        suggestedNextSteps: [
          '检查 CPU 频率是否被限制',
          '检查是否有后台任务抢占',
          '检查线程优先级设置',
        ],
      },
    },

    {
      id: 'conclude_unknown',
      type: 'CONCLUDE',
      name: '结论：需要进一步分析',
      conclusion: {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: '当前数据无法确定根因，需要更详细的分析',
        confidence: 0.5,
        suggestedNextSteps: [
          '检查是否有 IO 阻塞',
          '检查内存压力',
          '使用 Simpleperf 进行函数级分析',
        ],
      },
    },

    // ===== 分支 B: 突刺/掉帧分析 =====
    {
      id: 'analyze_spike_jank',
      type: 'ACTION',
      name: '分析卡顿帧',
      action: {
        description: '定位具体的卡顿帧',
        skill: 'jank_frame_detail',
        params: {},
        resultKey: 'jank_frames',
      },
      next: {
        default: 'classify_jank_frames',
      },
    },

    {
      id: 'classify_jank_frames',
      type: 'BRANCH',
      name: '分类卡顿帧类型',
      branches: [
        {
          condition: {
            description: '大部分是 App Deadline Missed？',
            useResultFrom: 'jank_frames',
            evaluate: (data, _context) => {
              const appMissedRatio = extractAppDeadlineMissedRatio(data);
              return appMissedRatio > SCROLLING_THRESHOLDS.jankClassification.appDeadlineMissedMinRatio;
            },
          },
          next: 'conclude_app_deadline_missed',
        },
        {
          condition: {
            description: '大部分是 SF Stuffing？',
            useResultFrom: 'jank_frames',
            evaluate: (data, _context) => {
              const sfStuffingRatio = extractSfStuffingRatio(data);
              return sfStuffingRatio > SCROLLING_THRESHOLDS.jankClassification.sfStuffingMinRatio;
            },
          },
          next: 'conclude_sf_stuffing',
        },
        {
          condition: {
            description: '有 Binder 阻塞？',
            useResultFrom: 'jank_frames',
            evaluate: (data, _context) => {
              const hasBinderBlock = checkBinderBlock(data);
              return hasBinderBlock;
            },
          },
          next: 'conclude_binder_issue',
        },
      ],
      next: {
        default: 'conclude_mixed_jank',
      },
    },

    {
      id: 'conclude_app_deadline_missed',
      type: 'CONCLUDE',
      name: '结论：App 帧超时',
      conclusion: {
        category: 'APP',
        component: 'RENDER_THREAD',
        summaryTemplate: '卡顿主要由 App 帧超时导致（App Deadline Missed），App 的渲染耗时超过了一帧的时间预算',
        confidence: 0.85,
        suggestedNextSteps: [
          '分析具体哪些帧超时最严重',
          '检查 RenderThread 内部耗时分布',
        ],
      },
    },

    {
      id: 'conclude_sf_stuffing',
      type: 'CONCLUDE',
      name: '结论：SF Stuffing',
      conclusion: {
        category: 'MIXED',
        component: 'SURFACE_FLINGER',
        summaryTemplate: '卡顿主要由 SF Stuffing 导致，App 产生帧的速度超过了显示刷新率',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查是否有 Triple Buffering 问题',
          '检查 VSYNC 信号',
        ],
      },
    },

    {
      id: 'conclude_binder_issue',
      type: 'CONCLUDE',
      name: '结论：Binder 阻塞',
      conclusion: {
        category: 'MIXED',
        component: 'BINDER',
        summaryTemplate: '卡顿帧存在 Binder 调用阻塞，跨进程通信耗时过长',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 Binder 调用的目标进程',
          '检查 system_server 负载',
        ],
      },
    },

    {
      id: 'conclude_mixed_jank',
      type: 'CONCLUDE',
      name: '结论：混合问题',
      conclusion: {
        category: 'MIXED',
        component: 'UNKNOWN',
        summaryTemplate: '卡顿由多种原因混合导致，没有单一主因',
        confidence: 0.6,
        suggestedNextSteps: [
          '逐帧分析卡顿原因',
          '检查是否有系统级干扰',
        ],
      },
    },
  ],
};

// ===== 辅助函数：从 Skill 结果中提取数据 =====

function toNumber(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeRows(value: any): Array<Record<string, any>> {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, any> =>
      !!row && typeof row === 'object' && !Array.isArray(row)
    );
  }
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray((value as any).data)) {
    return normalizeRows((value as any).data);
  }
  const columns = Array.isArray((value as any).columns) ? (value as any).columns : [];
  const rows = Array.isArray((value as any).rows) ? (value as any).rows : [];
  if (columns.length > 0 && rows.length > 0) {
    return rows
      .filter((row: any) => Array.isArray(row))
      .map((row: any[]) => {
        const mapped: Record<string, any> = {};
        for (let i = 0; i < columns.length; i++) {
          mapped[columns[i]] = row[i];
        }
        return mapped;
      });
  }
  return [];
}

function getOverviewRow(data: any, stepIds: string[]): Record<string, any> {
  if (!data) return {};
  for (const stepId of stepIds) {
    const direct = normalizeRows((data as any)[stepId]);
    if (direct.length > 0) return direct[0];
    const fromLayers = normalizeRows(data.layers?.overview?.[stepId]);
    if (fromLayers.length > 0) return fromLayers[0];
  }
  return {};
}

function getListRows(data: any, stepIds: string[]): Array<Record<string, any>> {
  if (!data) return [];
  for (const stepId of stepIds) {
    const direct = normalizeRows((data as any)[`list_${stepId}`]);
    if (direct.length > 0) return direct;
    const alt = normalizeRows((data as any)[stepId]);
    if (alt.length > 0) return alt;
    const fromLayers = normalizeRows(data.layers?.list?.[stepId]);
    if (fromLayers.length > 0) return fromLayers;
  }
  return [];
}

function getDeepRows(data: any, stepIds: string[]): Array<Record<string, any>> {
  if (!data?.layers?.deep || typeof data.layers.deep !== 'object') return [];
  const deep = data.layers.deep as Record<string, any>;
  for (const stepId of stepIds) {
    const legacy = normalizeRows(deep[stepId]);
    if (legacy.length > 0) return legacy;
  }
  for (const session of Object.values(deep)) {
    if (!session || typeof session !== 'object') continue;
    for (const stepId of stepIds) {
      const rows = normalizeRows((session as any)[stepId]);
      if (rows.length > 0) return rows;
    }
  }
  return [];
}

function extractAvgFps(data: any): number {
  if (!data) return 0;
  if (toNumber(data.transformed?.avg_fps) > 0) return toNumber(data.transformed.avg_fps);
  const summary = getOverviewRow(data, ['performance_summary', 'scroll_sessions_summary', 'scrolling_summary']);
  const avg = toNumber(summary.actual_fps) || toNumber(summary.avg_fps);
  if (avg > 0) return avg;
  if (data.avg_fps !== undefined) return data.avg_fps;
  if (data.summary?.avg_fps !== undefined) return data.summary.avg_fps;
  return 0;
}

function extractMinFps(data: any): number {
  if (!data) return 0;
  if (toNumber(data.transformed?.min_fps) > 0) return toNumber(data.transformed.min_fps);
  const summary = getOverviewRow(data, ['performance_summary', 'scroll_sessions_summary', 'scrolling_summary']);
  const fromSummary = toNumber(summary.min_fps);
  if (fromSummary > 0) return fromSummary;
  const sessions = getListRows(data, ['scroll_sessions']);
  const fpsList = sessions
    .map((s) => toNumber(s.session_fps) || toNumber(s.avg_fps))
    .filter((v) => v > 0);
  if (fpsList.length > 0) return Math.min(...fpsList);
  if (data.min_fps !== undefined) return data.min_fps;
  if (data.summary?.min_fps !== undefined) return data.summary.min_fps;
  return 0;
}

function extractJankRate(data: any): number {
  if (!data) return 0;
  const transformed = toNumber(data.transformed?.janky_rate) || toNumber(data.transformed?.jank_rate);
  if (transformed > 0) return transformed > 1 ? transformed / 100 : transformed;
  const summary = getOverviewRow(data, ['performance_summary', 'scroll_sessions_summary', 'scrolling_summary']);
  const rawRate = toNumber(summary.jank_rate) || toNumber(summary.janky_rate);
  if (rawRate > 0) return rawRate > 1 ? rawRate / 100 : rawRate;
  const total = toNumber(summary.total_frames) || 1;
  const jank = toNumber(summary.janky_frames);
  if (jank > 0) return jank / total;
  if (data.jank_rate !== undefined) return data.jank_rate > 1 ? data.jank_rate / 100 : data.jank_rate;
  if (data.summary?.jank_rate !== undefined) return data.summary.jank_rate;
  return 0;
}

function extractSfAvgDuration(data: any): number {
  if (!data) return 0;
  const transformed = toNumber(data.transformed?.avg_composition_ms) || toNumber(data.transformed?.sf_avg_duration);
  if (transformed > 0) return transformed;
  const composition = getOverviewRow(data, ['composition_overview']);
  if (toNumber(composition.avg_composition_ms) > 0) return toNumber(composition.avg_composition_ms);
  if (toNumber(composition.avg_composition_dur) > 0) return toNumber(composition.avg_composition_dur) / 1e6;
  if (data.sf_avg_duration !== undefined) return data.sf_avg_duration;
  if (data.summary?.sf_composition_avg_ms !== undefined) {
    return data.summary.sf_composition_avg_ms;
  }
  return 0;
}

function extractAvgRenderTime(data: any): number {
  if (!data) return 0;
  const transformed = toNumber(data.transformed?.avg_render_time);
  if (transformed > 0) return transformed;
  const renderRows = getDeepRows(data, ['render_thread_slices', 'render_slices']);
  if (renderRows.length > 0) {
    const values = renderRows.map((r) => toNumber(r.dur_ms) || toNumber(r.total_ms)).filter((v) => v > 0);
    if (values.length > 0) {
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    }
  }
  if (data.avg_render_time !== undefined) return data.avg_render_time;
  return 0;
}

function extractAvgDoFrameTime(data: any): number {
  if (!data) return 0;
  const transformed = toNumber(data.transformed?.avg_do_frame_time);
  if (transformed > 0) return transformed;
  const mainRows = getDeepRows(data, ['main_thread_slices', 'main_slices']);
  if (mainRows.length > 0) {
    const values = mainRows.map((r) => toNumber(r.dur_ms) || toNumber(r.total_ms)).filter((v) => v > 0);
    if (values.length > 0) {
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    }
  }
  if (data.avg_do_frame_time !== undefined) return data.avg_do_frame_time;
  return 0;
}

function extractAvgRunnableTime(data: any): number {
  if (!data) return 0;
  if (data.avg_runnable_time !== undefined) return data.avg_runnable_time;
  return 0;
}

function extractAppDeadlineMissedRatio(data: any): number {
  if (!data) return 0;
  if (toNumber(data.transformed?.app_deadline_missed_ratio) > 0) {
    return toNumber(data.transformed.app_deadline_missed_ratio);
  }
  const root = getDeepRows(data, ['root_cause_summary', 'root_cause'])[0];
  if (root) {
    const resp = String(root.jank_responsibility || '').toUpperCase();
    const amp = String(root.amplification_path || '').toLowerCase();
    if (resp === 'APP' || amp.includes('app_deadline')) return 1;
  }
  if (data.layers?.overview?.jank_type_distribution?.data) {
    const types = data.layers.overview.jank_type_distribution.data;
    const appMissed = types.filter((t: any) => t.jank_type?.includes('App Deadline Missed'));
    const total = types.reduce((sum: number, t: any) => sum + (t.count || 0), 0);
    const missed = appMissed.reduce((sum: number, t: any) => sum + (t.count || 0), 0);
    return total > 0 ? missed / total : 0;
  }
  if (data.app_deadline_missed_ratio !== undefined) {
    return data.app_deadline_missed_ratio;
  }
  return 0;
}

function extractSfStuffingRatio(data: any): number {
  if (!data) return 0;
  if (toNumber(data.transformed?.sf_stuffing_ratio) > 0) {
    return toNumber(data.transformed.sf_stuffing_ratio);
  }
  const root = getDeepRows(data, ['root_cause_summary', 'root_cause'])[0];
  if (root) {
    const resp = String(root.jank_responsibility || '').toUpperCase();
    const amp = String(root.amplification_path || '').toLowerCase();
    if (resp === 'SF' || amp.includes('sf_consumer')) return 1;
  }
  if (data.layers?.overview?.jank_type_distribution?.data) {
    const types = data.layers.overview.jank_type_distribution.data;
    const stuffing = types.filter((t: any) =>
      t.jank_type?.includes('SurfaceFlinger Stuffing')
    );
    const total = types.reduce((sum: number, t: any) => sum + (t.count || 0), 0);
    const stuffed = stuffing.reduce((sum: number, t: any) => sum + (t.count || 0), 0);
    return total > 0 ? stuffed / total : 0;
  }
  if (data.sf_stuffing_ratio !== undefined) {
    return data.sf_stuffing_ratio;
  }
  return 0;
}

function checkBinderBlock(data: any): boolean {
  if (!data) return false;
  if (data.transformed?.has_binder_block === true) return true;
  if (data.has_binder_block !== undefined) return data.has_binder_block;
  const root = getDeepRows(data, ['root_cause_summary', 'root_cause'])[0];
  if (root && String(root.reason_code || '').toLowerCase() === 'binder_sync_blocking') {
    return true;
  }
  const binderRows = getDeepRows(data, ['binder_blocking', 'binder_blocking_data', 'binder_calls', 'binder_data']);
  const binderMinMs = SCROLLING_THRESHOLDS.jankClassification.binderBlockMinMs;
  if (binderRows.some((r: any) => (
    toNumber(r.max_block_ms) > binderMinMs
    || toNumber(r.total_block_ms) > binderMinMs
    || toNumber(r.dur_ms) > binderMinMs
  ))) {
    return true;
  }
  // 检查是否有任何帧的 Binder 耗时超过阈值
  if (data.layers?.deep?.per_frame_data?.data) {
    const frames = data.layers.deep.per_frame_data.data;
    return frames.some((f: any) => (f.binder_duration_ms || 0) > binderMinMs);
  }
  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
  const diagnosisText = diagnostics.map((d: any) => String(d?.message || d?.diagnosis || '')).join(' ').toLowerCase();
  if (diagnosisText.includes('binder')) return true;
  return false;
}

export default scrollingDecisionTree;