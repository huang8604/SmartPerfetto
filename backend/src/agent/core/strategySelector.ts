/**
 * LLM-Driven Strategy Selector
 *
 * Replaces hardcoded keyword matching with semantic understanding via LLM.
 * This enables:
 * 1. Understanding variant expressions ("列表滚动很卡" vs "RecyclerView 有问题")
 * 2. Contextual strategy selection based on trace metadata
 * 3. Confidence-based ranking of strategy candidates
 * 4. Graceful fallback when no strategy matches
 *
 * Design principles:
 * - LLM provides semantic understanding, not execution
 * - Strategy descriptions are injected into the prompt
 * - Trace context (available tables, time range) aids selection
 * - Falls back to hypothesis-driven analysis when confidence is low
 */

import { ModelRouter } from './modelRouter';
import type { StagedAnalysisStrategy } from '../strategies/types';
import type { Intent } from '../types';
import { parseLlmJson, isPlainObject } from '../../utils/llmJson';

// =============================================================================
// Types
// =============================================================================

/**
 * Trace context provided to help LLM understand what data is available
 */
export interface TraceContext {
  /** Available Perfetto tables in this trace */
  availableTables: string[];
  /** Trace time range in nanoseconds */
  timeRange?: { start: string; end: string };
  /** Process names found in trace */
  processes: string[];
  /** Whether the trace contains frame/scrolling data */
  hasFrameData: boolean;
  /** Whether the trace contains CPU scheduling data */
  hasCpuData: boolean;
  /** Whether the trace contains memory/GC data */
  hasMemoryData: boolean;
  /** Whether the trace contains Binder/IPC data */
  hasBinderData: boolean;
}

/**
 * Strategy candidate with confidence score
 */
export interface StrategyCandidate {
  /** Strategy identifier */
  strategyId: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** LLM's reasoning for this selection */
  reasoning: string;
  /** Required capabilities (tables/data) for this strategy */
  requiredCapabilities: string[];
}

/**
 * Result of LLM strategy selection
 */
export interface StrategySelectionResult {
  /** Top candidate (null if no good match) */
  selected: StrategyCandidate | null;
  /** All evaluated candidates, sorted by confidence */
  candidates: StrategyCandidate[];
  /** Whether to fall back to hypothesis-driven analysis */
  shouldFallback: boolean;
  /** Reason for fallback (if applicable) */
  fallbackReason?: string;
}

/**
 * Strategy definition for LLM prompt injection
 */
export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  requiredCapabilities: string[];
}

// =============================================================================
// LLM JSON Schema
// =============================================================================

interface StrategySelectionPayload {
  candidates?: Array<{
    strategyId?: string;
    confidence?: number;
    reasoning?: string;
    requiredCapabilities?: string[];
  }>;
  shouldFallback?: boolean;
  fallbackReason?: string;
}

const STRATEGY_SELECTION_SCHEMA = {
  name: 'strategy_selection@1.0.0',
  validate: (value: unknown): value is StrategySelectionPayload => {
    if (!isPlainObject(value)) return false;
    const v = value as any;
    if (v.candidates !== undefined && !Array.isArray(v.candidates)) return false;
    if (v.shouldFallback !== undefined && typeof v.shouldFallback !== 'boolean') return false;
    if (v.fallbackReason !== undefined && typeof v.fallbackReason !== 'string') return false;
    return true;
  },
};

// =============================================================================
// Configuration
// =============================================================================

/** Minimum confidence to select a strategy (below this, fall back to hypothesis-driven) */
const MIN_SELECTION_CONFIDENCE = 0.6;

/** Maximum candidates to return */
const MAX_CANDIDATES = 3;

// =============================================================================
// LLM Strategy Selector
// =============================================================================

/**
 * LLM-driven strategy selector that uses semantic understanding
 * to match user queries to analysis strategies.
 */
export class LLMStrategySelector {
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * Select the best strategy for a given query using LLM semantic understanding.
   *
   * @param query - User's natural language query
   * @param intent - Parsed intent from intent understanding phase
   * @param availableStrategies - List of registered strategies
   * @param traceContext - Metadata about the loaded trace
   * @returns Selection result with ranked candidates
   */
  async selectStrategy(
    query: string,
    intent: Intent,
    availableStrategies: StrategyDefinition[],
    traceContext: TraceContext
  ): Promise<StrategySelectionResult> {
    // Build prompt for LLM
    const prompt = this.buildSelectionPrompt(query, intent, availableStrategies, traceContext);

    try {
      const response = await this.modelRouter.callWithFallback(
        prompt,
        'planning',
        {
          jsonMode: true,
          promptId: 'strategy_selector.select',
          promptVersion: '1.0.0',
          contractVersion: STRATEGY_SELECTION_SCHEMA.name,
        }
      );

      const parsed = parseLlmJson<StrategySelectionPayload>(
        response.response,
        STRATEGY_SELECTION_SCHEMA
      );

      return this.processLLMResponse(parsed, availableStrategies);
    } catch (error: any) {
      console.warn(`[LLMStrategySelector] LLM call failed: ${error.message}`);
      // Fall back to hypothesis-driven analysis on LLM failure
      return {
        selected: null,
        candidates: [],
        shouldFallback: true,
        fallbackReason: `LLM strategy selection failed: ${error.message}`,
      };
    }
  }

  /**
   * Build the LLM prompt for strategy selection.
   */
  private buildSelectionPrompt(
    query: string,
    intent: Intent,
    strategies: StrategyDefinition[],
    traceContext: TraceContext
  ): string {
    const strategiesText = strategies.map(s => `
- **${s.id}** (${s.name}):
  描述: ${s.description}
  触发模式: ${s.triggerPatterns.join(', ')}
  所需能力: ${s.requiredCapabilities.join(', ')}`
    ).join('\n');

    const traceCapabilities: string[] = [];
    if (traceContext.hasFrameData) traceCapabilities.push('frame/scrolling data');
    if (traceContext.hasCpuData) traceCapabilities.push('CPU scheduling data');
    if (traceContext.hasMemoryData) traceCapabilities.push('memory/GC data');
    if (traceContext.hasBinderData) traceCapabilities.push('Binder/IPC data');

    return `你是 Perfetto trace 分析专家。根据用户查询和 trace 上下文，选择最合适的分析策略。

## 用户查询
"${query}"

## 意图分析
- 主要目标: ${intent.primaryGoal}
- 分析方面: ${intent.aspects.join(', ')}
- 预期输出: ${intent.expectedOutputType}
- 复杂度: ${intent.complexity}

## 可用策略
${strategiesText}

## Trace 上下文
- 可用数据: ${traceCapabilities.length > 0 ? traceCapabilities.join(', ') : '未知'}
- 可用表: ${traceContext.availableTables.slice(0, 20).join(', ')}${traceContext.availableTables.length > 20 ? '...' : ''}
- 进程列表: ${traceContext.processes.slice(0, 10).join(', ')}${traceContext.processes.length > 10 ? '...' : ''}

## 任务
分析用户查询的语义，选择最匹配的策略。考虑：
1. 查询的核心意图是否与策略的目的匹配
2. Trace 中是否有策略所需的数据
3. 策略的触发模式是否语义上与查询相关（不要求完全匹配关键词）

如果没有策略能很好地匹配（置信度 < 0.6），建议使用假设驱动的通用分析。

请以 JSON 格式返回：
{
  "candidates": [
    {
      "strategyId": "策略ID",
      "confidence": 0.0-1.0,
      "reasoning": "选择这个策略的原因",
      "requiredCapabilities": ["所需能力"]
    }
  ],
  "shouldFallback": true/false,
  "fallbackReason": "如果建议回退，说明原因"
}

注意：
- 最多返回 ${MAX_CANDIDATES} 个候选策略
- 按置信度从高到低排序
- 如果所有策略的置信度都低于 0.6，设置 shouldFallback: true`;
  }

  /**
   * Process LLM response into structured result.
   */
  private processLLMResponse(
    payload: StrategySelectionPayload,
    availableStrategies: StrategyDefinition[]
  ): StrategySelectionResult {
    const validStrategyIds = new Set(availableStrategies.map(s => s.id));
    const candidates: StrategyCandidate[] = [];

    // Process candidates from LLM response
    for (const c of payload.candidates || []) {
      if (!c.strategyId || !validStrategyIds.has(c.strategyId)) {
        continue; // Skip invalid strategy IDs
      }

      const confidence = typeof c.confidence === 'number'
        ? Math.max(0, Math.min(1, c.confidence))
        : 0;

      candidates.push({
        strategyId: c.strategyId,
        confidence,
        reasoning: c.reasoning || '',
        requiredCapabilities: Array.isArray(c.requiredCapabilities)
          ? c.requiredCapabilities.filter(r => typeof r === 'string')
          : [],
      });
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    // Determine if we should fall back
    const topCandidate = candidates[0] || null;
    const shouldFallback = payload.shouldFallback === true ||
      !topCandidate ||
      topCandidate.confidence < MIN_SELECTION_CONFIDENCE;

    const selected = shouldFallback ? null : topCandidate;

    return {
      selected,
      candidates: candidates.slice(0, MAX_CANDIDATES),
      shouldFallback,
      fallbackReason: shouldFallback
        ? (payload.fallbackReason || this.getDefaultFallbackReason(topCandidate))
        : undefined,
    };
  }

  /**
   * Get default fallback reason based on candidate state.
   */
  private getDefaultFallbackReason(topCandidate: StrategyCandidate | null): string {
    if (!topCandidate) {
      return '没有找到匹配的分析策略，将使用假设驱动的通用分析';
    }
    if (topCandidate.confidence < MIN_SELECTION_CONFIDENCE) {
      return `最佳匹配策略 (${topCandidate.strategyId}) 置信度过低 (${(topCandidate.confidence * 100).toFixed(0)}%)，将使用假设驱动的通用分析`;
    }
    return '使用假设驱动的通用分析';
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert StagedAnalysisStrategy to StrategyDefinition for LLM prompt.
 */
export function strategyToDefinition(strategy: StagedAnalysisStrategy): StrategyDefinition {
  // Extract trigger patterns from the strategy
  // These are hints for the LLM, not exact keywords
  const triggerPatterns = extractTriggerPatterns(strategy);

  // Determine required capabilities based on strategy stages
  const requiredCapabilities = extractRequiredCapabilities(strategy);

  return {
    id: strategy.id,
    name: strategy.name,
    description: getStrategyDescription(strategy.id),
    triggerPatterns,
    requiredCapabilities,
  };
}

/**
 * Extract trigger patterns from a strategy.
 * These are semantic hints, not exact keywords.
 */
function extractTriggerPatterns(strategy: StagedAnalysisStrategy): string[] {
  const patterns: string[] = [];

  switch (strategy.id) {
    case 'scrolling':
      patterns.push(
        '滑动', 'scroll', '列表', 'RecyclerView', 'ListView',
        '卡顿', 'jank', '掉帧', '丢帧', 'stutter', 'fps', '帧率',
        '流畅', 'smooth', '滚动'
      );
      break;
    case 'scene_reconstruction':
    case 'scene_reconstruction_quick':
      patterns.push(
        '概览', 'overview', '整体', '分析', '发生了什么',
        '场景', 'scene', '重建', '全局'
      );
      break;
    default:
      // For unknown strategies, use the name as a pattern
      patterns.push(strategy.name);
  }

  return patterns;
}

/**
 * Extract required capabilities from strategy stages.
 */
function extractRequiredCapabilities(strategy: StagedAnalysisStrategy): string[] {
  const capabilities: string[] = [];

  // Analyze strategy stages to determine required data
  for (const stage of strategy.stages) {
    for (const task of stage.tasks) {
      if (task.domain === 'frame') {
        capabilities.push('frame data', 'scrolling data');
      } else if (task.domain === 'cpu') {
        capabilities.push('CPU scheduling data');
      } else if (task.domain === 'memory') {
        capabilities.push('memory/GC data');
      } else if (task.domain === 'binder') {
        capabilities.push('Binder/IPC data');
      }
    }
  }

  return [...new Set(capabilities)];
}

/**
 * Get human-readable description for a strategy.
 */
function getStrategyDescription(strategyId: string): string {
  const descriptions: Record<string, string> = {
    scrolling: '滑动/卡顿分析策略。用于分析列表滑动性能问题，包括掉帧检测、帧耗时分析、主线程/RenderThread 瓶颈定位。适用于：滑动卡顿、列表掉帧、FPS 低、动画不流畅等问题。',
    scene_reconstruction: '场景重建策略。用于全面分析 trace 中发生的事件，重建应用行为场景。适用于：不知道问题在哪、需要整体概览、想了解发生了什么。',
    scene_reconstruction_quick: '快速场景重建策略。轻量级版本，快速获取 trace 概览。适用于：快速了解 trace 内容。',
  };

  return descriptions[strategyId] || `${strategyId} 分析策略`;
}

/**
 * Detect trace context by querying available tables.
 */
export async function detectTraceContext(
  traceProcessorService: any,
  traceId: string
): Promise<TraceContext> {
  const context: TraceContext = {
    availableTables: [],
    processes: [],
    hasFrameData: false,
    hasCpuData: false,
    hasMemoryData: false,
    hasBinderData: false,
  };

  try {
    // Get available tables
    const tablesResult = await traceProcessorService.query(
      traceId,
      "SELECT name FROM sqlite_master WHERE type='table' OR type='view'"
    );
    if (tablesResult?.rows) {
      context.availableTables = tablesResult.rows.map((r: any) => String(r[0]));
    }

    // Detect data types based on available tables
    const tables = new Set(context.availableTables);

    // Frame/scrolling data
    context.hasFrameData =
      tables.has('actual_frame_timeline_slice') ||
      tables.has('expected_frame_timeline_slice') ||
      tables.has('frame_slice');

    // CPU data
    context.hasCpuData =
      tables.has('sched_slice') ||
      tables.has('cpu_counter_track') ||
      tables.has('cpu_freq');

    // Memory data
    context.hasMemoryData =
      tables.has('heap_profile_allocation') ||
      tables.has('android_garbage_collection_events') ||
      tables.has('memory_counter');

    // Binder data
    context.hasBinderData =
      tables.has('android_binder_txns') ||
      tables.has('binder_txn');

    // Get process names
    const processResult = await traceProcessorService.query(
      traceId,
      "SELECT DISTINCT name FROM process WHERE name IS NOT NULL AND name != '' LIMIT 50"
    );
    if (processResult?.rows) {
      context.processes = processResult.rows.map((r: any) => String(r[0]));
    }

  } catch (error: any) {
    console.warn(`[detectTraceContext] Failed to detect context: ${error.message}`);
  }

  return context;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an LLM strategy selector instance.
 */
export function createLLMStrategySelector(modelRouter: ModelRouter): LLMStrategySelector {
  return new LLMStrategySelector(modelRouter);
}

export default LLMStrategySelector;
