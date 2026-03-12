/**
 * Launch Analysis Decision Tree
 *
 * 实现专家级启动性能分析的决策逻辑：
 * 1. 获取启动各阶段耗时
 * 2. 定位最慢的阶段
 * 3. 深入分析该阶段的具体问题
 * 4. 给出根因结论
 */

import { getLaunchDecisionThresholds } from '../../config/decisionThresholdManifest';
import { DecisionTree, DecisionContext } from '../types';

const LAUNCH_THRESHOLDS = getLaunchDecisionThresholds();

/**
 * 启动分析决策树
 */
export const launchDecisionTree: DecisionTree = {
  id: 'launch_analysis_v1',
  name: '启动性能分析决策树',
  description: '专家级启动性能分析，定位启动慢的阶段和根因',
  analysisType: 'launch',
  entryNode: 'get_launch_overview',

  nodes: [
    // ===== 阶段 1: 获取启动概览 =====
    {
      id: 'get_launch_overview',
      type: 'ACTION',
      name: '获取启动概览',
      action: {
        description: '执行启动分析获取各阶段耗时',
        skill: 'startup_analysis',
        params: {},
        resultKey: 'launch_data',
      },
      next: {
        default: 'check_launch_type',
      },
    },

    // ===== 阶段 2: 判断启动类型 =====
    {
      id: 'check_launch_type',
      type: 'BRANCH',
      name: '判断启动类型',
      branches: [
        {
          condition: {
            description: '冷启动？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return extractLaunchType(data, context) === 'cold';
            },
          },
          next: 'analyze_cold_launch',
        },
        {
          condition: {
            description: '温启动？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return extractLaunchType(data, context) === 'warm';
            },
          },
          next: 'analyze_warm_launch',
        },
      ],
      next: {
        default: 'analyze_hot_launch',
      },
    },

    // ===== 分支 A: 冷启动分析 =====
    {
      id: 'analyze_cold_launch',
      type: 'CHECK',
      name: '检查冷启动总耗时',
      check: {
        description: `TTID < ${LAUNCH_THRESHOLDS.coldLaunch.maxTtidMs}ms？`,
        useResultFrom: 'launch_data',
        evaluate: (data, context) => {
          const ttid = extractTTID(data, context);
          return ttid < LAUNCH_THRESHOLDS.coldLaunch.maxTtidMs;
        },
      },
      next: {
        true: 'conclude_launch_ok',
        false: 'find_slowest_phase',
      },
    },

    {
      id: 'conclude_launch_ok',
      type: 'CONCLUDE',
      name: '结论：启动正常',
      conclusion: {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: '启动性能正常，TTID 在可接受范围内',
        confidence: 0.9,
        suggestedNextSteps: [],
      },
    },

    // ===== 定位最慢阶段 =====
    {
      id: 'find_slowest_phase',
      type: 'BRANCH',
      name: '定位最慢阶段',
      branches: [
        {
          condition: {
            description: '进程创建耗时最长？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return getSlowestPhase(data, context) === 'process_start';
            },
          },
          next: 'analyze_process_start',
        },
        {
          condition: {
            description: 'Application 初始化最长？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return getSlowestPhase(data, context) === 'application_init';
            },
          },
          next: 'conclude_app_init_slow',
        },
        {
          condition: {
            description: 'Activity 创建最长？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return getSlowestPhase(data, context) === 'activity_create';
            },
          },
          next: 'analyze_activity_create',
        },
        {
          condition: {
            description: '首帧渲染最长？',
            useResultFrom: 'launch_data',
            evaluate: (data, context) => {
              return getSlowestPhase(data, context) === 'first_frame';
            },
          },
          next: 'conclude_first_frame_slow',
        },
      ],
      next: {
        default: 'conclude_launch_slow_mixed',
      },
    },

    // ===== 进程启动分析 =====
    {
      id: 'analyze_process_start',
      type: 'CHECK',
      name: '检查进程启动细节',
      check: {
        description: `Zygote fork 耗时 > ${LAUNCH_THRESHOLDS.processStart.minZygoteForkMs}ms？`,
        useResultFrom: 'launch_data',
        evaluate: (data, context) => {
          const forkTime = extractZygoteForkTime(data, context);
          return forkTime > LAUNCH_THRESHOLDS.processStart.minZygoteForkMs;
        },
      },
      next: {
        true: 'conclude_zygote_slow',
        false: 'conclude_bind_application_slow',
      },
    },

    {
      id: 'conclude_zygote_slow',
      type: 'CONCLUDE',
      name: '结论：Zygote fork 慢',
      conclusion: {
        category: 'SYSTEM',
        component: 'UNKNOWN',
        summaryTemplate: 'Zygote fork 进程耗时过长，可能是系统负载高或内存压力大',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查系统内存使用情况',
          '检查是否有大量进程在运行',
          '检查 IO 压力',
        ],
      },
    },

    {
      id: 'conclude_bind_application_slow',
      type: 'CONCLUDE',
      name: '结论：bindApplication 慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: '进程绑定 Application 耗时长，可能是 App 有大量静态初始化',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 Application.onCreate 内容',
          '检查静态代码块',
          '检查 ContentProvider 初始化',
        ],
      },
    },

    // ===== Application 初始化分析 =====
    {
      id: 'conclude_app_init_slow',
      type: 'CONCLUDE',
      name: '结论：Application 初始化慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: 'Application.onCreate 耗时过长，App 在初始化阶段做了过多工作',
        confidence: 0.85,
        suggestedNextSteps: [
          '将非必要初始化延迟到首屏显示后',
          '使用懒加载',
          '检查第三方 SDK 初始化',
        ],
      },
    },

    // ===== Activity 创建分析 =====
    {
      id: 'analyze_activity_create',
      type: 'CHECK',
      name: '检查 Activity 创建细节',
      check: {
        description: `布局加载耗时 > ${LAUNCH_THRESHOLDS.activityCreate.minLayoutInflateMs}ms？`,
        useResultFrom: 'launch_data',
        evaluate: (data, context) => {
          const inflateTime = extractLayoutInflateTime(data, context);
          return inflateTime > LAUNCH_THRESHOLDS.activityCreate.minLayoutInflateMs;
        },
      },
      next: {
        true: 'conclude_layout_inflate_slow',
        false: 'conclude_activity_lifecycle_slow',
      },
    },

    {
      id: 'conclude_layout_inflate_slow',
      type: 'CONCLUDE',
      name: '结论：布局加载慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: '布局加载 (inflate) 耗时过长，布局可能过于复杂',
        confidence: 0.85,
        suggestedNextSteps: [
          '减少布局层级',
          '使用 ViewStub 延迟加载',
          '检查自定义 View 的初始化',
        ],
      },
    },

    {
      id: 'conclude_activity_lifecycle_slow',
      type: 'CONCLUDE',
      name: '结论：Activity 生命周期慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: 'Activity 生命周期回调 (onCreate/onStart/onResume) 耗时过长',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 onCreate 中的耗时操作',
          '将数据加载移到后台线程',
          '使用异步初始化',
        ],
      },
    },

    // ===== 首帧渲染分析 =====
    {
      id: 'conclude_first_frame_slow',
      type: 'CONCLUDE',
      name: '结论：首帧渲染慢',
      conclusion: {
        category: 'APP',
        component: 'RENDER_THREAD',
        summaryTemplate: '首帧渲染耗时过长，可能是首屏内容复杂或有 GPU 编译',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查首屏布局复杂度',
          '检查是否有大量图片加载',
          '检查 GPU Shader 编译',
        ],
      },
    },

    // ===== 混合问题 =====
    {
      id: 'conclude_launch_slow_mixed',
      type: 'CONCLUDE',
      name: '结论：多阶段都慢',
      conclusion: {
        category: 'MIXED',
        component: 'UNKNOWN',
        summaryTemplate: '启动慢由多个阶段共同导致，没有单一瓶颈',
        confidence: 0.6,
        suggestedNextSteps: [
          '逐阶段优化',
          '优先优化耗时最长的阶段',
        ],
      },
    },

    // ===== 分支 B: 温启动分析 =====
    {
      id: 'analyze_warm_launch',
      type: 'CHECK',
      name: '检查温启动耗时',
      check: {
        description: `温启动 < ${LAUNCH_THRESHOLDS.warmLaunch.maxDurationMs}ms？`,
        useResultFrom: 'launch_data',
        evaluate: (data, context) => {
          const warmTime = extractWarmLaunchTime(data, context);
          return warmTime < LAUNCH_THRESHOLDS.warmLaunch.maxDurationMs;
        },
      },
      next: {
        true: 'conclude_launch_ok',
        false: 'conclude_warm_launch_slow',
      },
    },

    {
      id: 'conclude_warm_launch_slow',
      type: 'CONCLUDE',
      name: '结论：温启动慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: '温启动耗时过长，Activity 重建过程有瓶颈',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 onRestart/onStart/onResume 耗时',
          '检查 View 状态恢复',
        ],
      },
    },

    // ===== 分支 C: 热启动分析 =====
    {
      id: 'analyze_hot_launch',
      type: 'CHECK',
      name: '检查热启动耗时',
      check: {
        description: `热启动 < ${LAUNCH_THRESHOLDS.hotLaunch.maxDurationMs}ms？`,
        useResultFrom: 'launch_data',
        evaluate: (data, context) => {
          const hotTime = extractHotLaunchTime(data, context);
          return hotTime < LAUNCH_THRESHOLDS.hotLaunch.maxDurationMs;
        },
      },
      next: {
        true: 'conclude_launch_ok',
        false: 'conclude_hot_launch_slow',
      },
    },

    {
      id: 'conclude_hot_launch_slow',
      type: 'CONCLUDE',
      name: '结论：热启动慢',
      conclusion: {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: '热启动耗时过长，onResume 可能有耗时操作',
        confidence: 0.8,
        suggestedNextSteps: [
          '检查 onResume 中的操作',
          '检查是否有同步的数据刷新',
        ],
      },
    },
  ],
};

// ===== 辅助函数 =====

type LaunchSampleSelectionMode = 'latest' | 'slowest' | 'specified_startup_id';

interface LaunchSampleSelection {
  mode: LaunchSampleSelectionMode;
  startupId?: number;
}

function toNumber(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBigInt(value: any): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
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

function parseSelectionMode(raw: any): LaunchSampleSelectionMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'latest' || normalized === 'slowest' || normalized === 'specified_startup_id') {
    return normalized;
  }
  if (normalized === 'specified' || normalized === 'startup_id' || normalized === 'specified_startup') {
    return 'specified_startup_id';
  }
  return undefined;
}

function parseStartupId(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized >= 0 ? normalized : undefined;
}

function parseSelectionFromQuery(query?: string): LaunchSampleSelection {
  const q = (query || '').toLowerCase();
  const idMatch = q.match(/(?:startup[\s_-]?id|启动\s*id|启动事件)\s*[:=：#]?\s*(\d+)/i);
  if (idMatch) {
    return {
      mode: 'specified_startup_id',
      startupId: parseStartupId(idMatch[1]),
    };
  }
  if (q.includes('最慢') || q.includes('耗时最长') || q.includes('slowest')) {
    return { mode: 'slowest' };
  }
  if (q.includes('最近') || q.includes('最新') || q.includes('最后一次') || q.includes('latest') || q.includes('newest')) {
    return { mode: 'latest' };
  }
  return { mode: 'latest' };
}

function resolveSelection(context?: DecisionContext): LaunchSampleSelection {
  const params = context?.analysisParams || {};
  const mode = parseSelectionMode(
    (params as any).launchSampleSelection ??
    (params as any).launch_sample_selection ??
    (params as any).startupSelectionMode ??
    (params as any).startup_selection_mode
  );
  const startupId = parseStartupId(
    (params as any).startupId ??
    (params as any).startup_id ??
    (params as any).targetStartupId ??
    (params as any).target_startup_id
  );

  if (mode) {
    if (mode === 'specified_startup_id') {
      return { mode, startupId };
    }
    return { mode, startupId };
  }

  if (startupId !== undefined) {
    return {
      mode: 'specified_startup_id',
      startupId,
    };
  }

  return parseSelectionFromQuery(context?.query);
}

function getStartupRows(data: any): Array<Record<string, any>> {
  if (!data) return [];
  const candidates = [
    data.startups,
    data.get_startups,
    data.list_get_startups,
    data.sections?.startups,
    data.sections?.get_startups,
    data.layers?.overview?.get_startups,
    data.layers?.list?.get_startups,
  ];
  for (const candidate of candidates) {
    const rows = normalizeRows(candidate);
    if (rows.length > 0) return rows;
  }
  return [];
}

function extractStartupTimestamp(row: Record<string, any>): bigint | null {
  const candidates = [
    row.start_ts,
    row.ts,
    row.perfetto_start,
    row.end_ts,
    row.perfetto_end,
  ];
  for (const value of candidates) {
    const parsed = toBigInt(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickLatestStartup(rows: Array<Record<string, any>>): Record<string, any> {
  return rows.reduce((best, row) => {
    const bestTs = extractStartupTimestamp(best);
    const rowTs = extractStartupTimestamp(row);
    if (bestTs === null && rowTs !== null) return row;
    if (bestTs !== null && rowTs !== null && rowTs > bestTs) return row;
    return best;
  }, rows[0]);
}

function pickSlowestStartup(rows: Array<Record<string, any>>): Record<string, any> {
  return rows.reduce((best, row) => {
    const bestDur = toNumber(best.dur_ms) || toNumber(best.duration_ms) || toNumber(best.dur);
    const rowDur = toNumber(row.dur_ms) || toNumber(row.duration_ms) || toNumber(row.dur);
    return rowDur > bestDur ? row : best;
  }, rows[0]);
}

function pickStartupRow(data: any, context?: DecisionContext): Record<string, any> {
  const rows = getStartupRows(data);
  if (rows.length === 0) return {};

  const selection = resolveSelection(context);
  if (selection.mode === 'specified_startup_id' && selection.startupId !== undefined) {
    const matched = rows.find((row) => parseStartupId(row.startup_id) === selection.startupId);
    if (matched) return matched;
  }

  if (selection.mode === 'slowest') {
    return pickSlowestStartup(rows);
  }

  return pickLatestStartup(rows);
}

function getSelectedStartupSource(data: any, context?: DecisionContext): Record<string, any> {
  const selected = pickStartupRow(data, context);
  if (Object.keys(selected).length > 0) return selected;
  return data?.transformed || data || {};
}

function extractLaunchType(data: any, context?: DecisionContext): 'cold' | 'warm' | 'hot' {
  if (!data) return 'cold';
  const source = getSelectedStartupSource(data, context);
  const startupType = source.startup_type || source.launch_type || data.transformed?.startup_type || data.transformed?.launch_type;
  if (startupType === 'cold' || startupType === 'warm' || startupType === 'hot') {
    return startupType;
  }
  // Heuristic fallback: bindApplication → cold (aligned with startup_events_in_range.skill.yaml)
  if (source.has_bind_app || source.has_bind_application) return 'cold';
  // performCreate without bindApplication → warm
  if (source.has_perform_create || source.has_activity_restart) return 'warm';
  // Legacy fallback: has_process_start (backward compat)
  if (source.has_process_start || source.process_start_time > 0) return 'cold';
  return 'hot';
}

function extractTTID(data: any, context?: DecisionContext): number {
  if (!data) return 0;
  const source = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;
  return (
    toNumber(source.ttid_ms) ||
    toNumber(source.ttid) ||
    toNumber(source.time_to_initial_display) ||
    toNumber(source.total_time) ||
    toNumber(fallback.ttid) ||
    toNumber(fallback.ttid_ms) ||
    toNumber(fallback.time_to_initial_display) ||
    toNumber(fallback.total_time) ||
    0
  );
}

/**
 * Identify the slowest startup phase.
 *
 * NOTE: Phase-level breakdown (process_start_time, application_init_time, etc.)
 * is NOT currently output by startup_analysis or startup_detail skills.
 * This function will return 'unknown' until those skills are extended to include
 * phase-level timing. When that happens, the adapter in skillExecutorAdapter.ts
 * will automatically propagate the values via transformStartupResult().
 */
function getSlowestPhase(data: any, context?: DecisionContext): string {
  if (!data) return 'unknown';

  const src = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;

  const phases: { name: string; time: number }[] = [
    {
      name: 'process_start',
      time: toNumber(src.process_start_time) || toNumber(fallback.process_start_time),
    },
    {
      name: 'application_init',
      time: toNumber(src.application_init_time) || toNumber(fallback.application_init_time),
    },
    {
      name: 'activity_create',
      time: toNumber(src.activity_create_time) || toNumber(fallback.activity_create_time),
    },
    {
      name: 'first_frame',
      time: toNumber(src.first_frame_time) || toNumber(fallback.first_frame_time),
    },
  ];

  const slowest = phases.reduce((a, b) => (a.time > b.time ? a : b));
  return slowest.time > 0 ? slowest.name : 'unknown';
}

function extractZygoteForkTime(data: any, context?: DecisionContext): number {
  if (!data) return 0;
  const src = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;
  return (
    toNumber(src.zygote_fork_time) ||
    toNumber(src.fork_time) ||
    toNumber(fallback.zygote_fork_time) ||
    toNumber(fallback.fork_time) ||
    0
  );
}

function extractLayoutInflateTime(data: any, context?: DecisionContext): number {
  if (!data) return 0;
  const src = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;
  return (
    toNumber(src.layout_inflate_time) ||
    toNumber(src.inflate_time) ||
    toNumber(fallback.layout_inflate_time) ||
    toNumber(fallback.inflate_time) ||
    0
  );
}

function extractWarmLaunchTime(data: any, context?: DecisionContext): number {
  if (!data) return 0;
  const src = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;
  // dur_ms from startup_analysis is the total startup time
  return (
    toNumber(src.warm_launch_time) ||
    toNumber(src.restart_time) ||
    toNumber(src.dur_ms) ||
    toNumber(fallback.warm_launch_time) ||
    toNumber(fallback.restart_time) ||
    toNumber(fallback.dur_ms) ||
    0
  );
}

function extractHotLaunchTime(data: any, context?: DecisionContext): number {
  if (!data) return 0;
  const src = getSelectedStartupSource(data, context);
  const fallback = data.transformed || data;
  return (
    toNumber(src.hot_launch_time) ||
    toNumber(src.resume_time) ||
    toNumber(src.dur_ms) ||
    toNumber(fallback.hot_launch_time) ||
    toNumber(fallback.resume_time) ||
    toNumber(fallback.dur_ms) ||
    0
  );
}

export default launchDecisionTree;
