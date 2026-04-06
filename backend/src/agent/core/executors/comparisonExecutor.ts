// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Comparison Executor
 *
 * Handles comparison queries between multiple frames or sessions.
 * Resolves entities via DrillDownResolver (cache-first), then produces
 * a comparison table and narrative diff.
 *
 * Use cases:
 * - "比较帧 1436069 和 1436070" → side-by-side frame comparison
 * - "对比会话 1 和会话 2 的卡顿率" → session metrics comparison
 * - "这几个帧有什么区别?" → multiple entity comparison
 *
 * Key characteristics:
 * - Resolves multiple entities via EntityStore cache (no re-query if cached)
 * - SQL enrichment only for uncached entities
 * - Generates comparison table + narrative explanation
 */

import { AnalysisExecutor } from './analysisExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  concludeDecision,
} from '../orchestratorTypes';
import { Finding } from '../../types';
import { resolveDrillDown, DrillDownResolved } from '../drillDownResolver';
import type { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { FrameEntity, SessionEntity } from '../../context/entityStore';
import type { FollowUpResolution } from '../followUpHandler';
import type { FocusInterval } from '../../strategies/types';

// =============================================================================
// ComparisonExecutor
// =============================================================================

export class ComparisonExecutor implements AnalysisExecutor {
  constructor(
    private sessionContext: EnhancedSessionContext,
    private services: AnalysisServices,
    private traceProcessorService?: any,
    private traceId?: string
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    emitter.log('[Comparison] Starting comparison analysis');
    emitter.emitUpdate('progress', {
      phase: 'comparing',
      message: '正在解析比较目标...',
    });

    const referencedEntities = ctx.intent.referencedEntities || [];

    // Must have at least 2 entities to compare
    if (referencedEntities.length < 2) {
      emitter.log('[Comparison] Insufficient entities for comparison');
      return this.buildInsufficientEntitiesResult();
    }

    // Determine comparison type (all entities must be same type)
    const entityTypes = new Set(referencedEntities.map(e => e.type));
    if (entityTypes.size > 1) {
      emitter.log('[Comparison] Mixed entity types not supported');
      return this.buildMixedTypesResult();
    }

    const entityType = referencedEntities[0].type as 'frame' | 'session';
    emitter.log(`[Comparison] Comparing ${referencedEntities.length} ${entityType} entities`);

    // Resolve all entities via DrillDownResolver
    emitter.emitUpdate('progress', {
      phase: 'resolving',
      message: `正在解析 ${referencedEntities.length} 个${entityType === 'frame' ? '帧' : '会话'}...`,
    });

    const followUp: FollowUpResolution = {
      isFollowUp: true,
      resolvedParams: {},
      confidence: 0.5,
    };

    const resolved = await resolveDrillDown(
      ctx.intent,
      followUp,
      this.sessionContext,
      this.traceProcessorService,
      this.traceId
    );

    if (!resolved || resolved.intervals.length < 2) {
      emitter.log('[Comparison] Failed to resolve entities');
      return this.buildResolutionFailedResult(referencedEntities.length);
    }

    // Build comparison data
    emitter.emitUpdate('progress', {
      phase: 'comparing',
      message: '正在生成比较数据...',
    });

    const comparisonData = entityType === 'frame'
      ? this.buildFrameComparison(resolved)
      : this.buildSessionComparison(resolved);

    // Generate narrative diff via LLM
    emitter.emitUpdate('progress', {
      phase: 'synthesizing',
      message: '正在生成对比分析...',
    });

    const narrative = await this.generateNarrativeDiff(
      ctx.query,
      entityType,
      comparisonData,
      emitter
    );

    // Build findings
    const findings: Finding[] = [
      {
        id: `comparison_table_${Date.now()}`,
        category: 'comparison',
        type: 'comparison_table',
        severity: 'info',
        title: `${entityType === 'frame' ? '帧' : '会话'}对比表`,
        description: this.formatComparisonTable(entityType, comparisonData),
        source: 'comparison_executor',
        confidence: 0.85,
        details: {
          entityType,
          entityCount: resolved.intervals.length,
          comparisonData,
        },
      },
      {
        id: `comparison_narrative_${Date.now()}`,
        category: 'comparison',
        type: 'comparison_narrative',
        severity: this.determineSeverity(comparisonData),
        title: '对比分析',
        description: narrative,
        source: 'comparison_executor',
        confidence: 0.8,
      },
    ];

    emitter.emitUpdate('finding', {
      round: 1,
      findings,
    });

    emitter.emitUpdate('progress', {
      phase: 'synthesis_complete',
      confirmedFindings: findings.length,
      updatedHypotheses: 0,
      message: '对比分析完成',
    });

    emitter.log('[Comparison] Comparison complete');

    return {
      findings,
      lastStrategy: concludeDecision(0.85, 'Comparison analysis complete'),
      confidence: 0.85,
      informationGaps: [],
      rounds: 1,
      stopReason: 'Comparison complete',
    };
  }

  // ===========================================================================
  // Comparison Building
  // ===========================================================================

  private buildFrameComparison(resolved: DrillDownResolved): FrameComparisonData {
    const entityStore = this.sessionContext.getEntityStore();
    const frames: FrameComparisonRow[] = [];

    for (const interval of resolved.intervals) {
      const frameId = interval.metadata?.frame_id || interval.metadata?.frameId || String(interval.id);
      const cached = entityStore.getFrame(String(frameId));
      const meta = interval.metadata || {};

      frames.push({
        frame_id: String(frameId),
        jank_type: cached?.jank_type || meta.jank_type || meta.jankType || 'Unknown',
        dur_ms: cached?.dur_ms || meta.dur_ms || meta.durMs,
        vsync_missed: cached?.vsync_missed || meta.vsync_missed || meta.vsyncMissed,
        process_name: cached?.process_name || interval.processName,
        session_id: cached?.session_id || meta.session_id || meta.sessionId,
        start_ts: cached?.start_ts || interval.startTs,
        end_ts: cached?.end_ts || interval.endTs,
      });
    }

    return { type: 'frame', rows: frames };
  }

  private buildSessionComparison(resolved: DrillDownResolved): SessionComparisonData {
    const entityStore = this.sessionContext.getEntityStore();
    const sessions: SessionComparisonRow[] = [];

    for (const interval of resolved.intervals) {
      const sessionId = interval.metadata?.session_id || interval.metadata?.sessionId || String(interval.id);
      const cached = entityStore.getSession(String(sessionId));
      const meta = interval.metadata || {};

      const frameCount = cached?.frame_count || meta.frame_count || meta.frameCount || 0;
      const jankCount = cached?.jank_count || meta.jank_count || meta.jankCount || 0;
      const jankRate = frameCount > 0 ? (Number(jankCount) / Number(frameCount)) * 100 : 0;

      sessions.push({
        session_id: String(sessionId),
        frame_count: frameCount,
        jank_count: jankCount,
        jank_rate: jankRate,
        max_vsync_missed: cached?.max_vsync_missed || meta.max_vsync_missed || meta.maxVsyncMissed,
        process_name: cached?.process_name || interval.processName,
        start_ts: cached?.start_ts || interval.startTs,
        end_ts: cached?.end_ts || interval.endTs,
      });
    }

    return { type: 'session', rows: sessions };
  }

  // ===========================================================================
  // Narrative Generation
  // ===========================================================================

  private async generateNarrativeDiff(
    query: string,
    entityType: 'frame' | 'session',
    data: FrameComparisonData | SessionComparisonData,
    emitter: ProgressEmitter
  ): Promise<string> {
    const prompt = this.buildNarrativePrompt(query, entityType, data);

    try {
      const result = await this.services.modelRouter.callWithFallback(prompt, 'synthesis', {
        sessionId: this.sessionContext.getSessionId(),
        traceId: this.sessionContext.getTraceId(),
        promptId: 'agent.comparisonExecutor',
        promptVersion: '1.0.0',
        contractVersion: 'comparison_text@1.0.0',
      });

      if (result.success && result.response) {
        return result.response;
      }
      return this.buildFallbackNarrative(entityType, data);
    } catch (error: any) {
      emitter.log(`[Comparison] LLM call failed: ${error.message}`);
      return this.buildFallbackNarrative(entityType, data);
    }
  }

  private buildNarrativePrompt(
    query: string,
    entityType: 'frame' | 'session',
    data: FrameComparisonData | SessionComparisonData
  ): string {
    const parts: string[] = [];

    parts.push('你是一个 Android 性能分析专家，正在对比分析多个实体的数据。');
    parts.push('');
    parts.push('## 用户问题');
    parts.push(query);
    parts.push('');
    parts.push('## 对比数据');

    if (entityType === 'frame') {
      const frameData = data as FrameComparisonData;
      parts.push(`正在对比 ${frameData.rows.length} 个帧：`);
      parts.push('');
      for (const frame of frameData.rows) {
        parts.push(`### 帧 ${frame.frame_id}`);
        parts.push(`- 卡顿类型: ${frame.jank_type}`);
        if (frame.dur_ms !== undefined) parts.push(`- 耗时: ${frame.dur_ms.toFixed(2)}ms`);
        if (frame.vsync_missed !== undefined) parts.push(`- 丢失 VSync: ${frame.vsync_missed}`);
        if (frame.process_name) parts.push(`- 进程: ${frame.process_name}`);
        parts.push('');
      }
    } else {
      const sessionData = data as SessionComparisonData;
      parts.push(`正在对比 ${sessionData.rows.length} 个会话：`);
      parts.push('');
      for (const session of sessionData.rows) {
        parts.push(`### 会话 ${session.session_id}`);
        parts.push(`- 总帧数: ${session.frame_count}`);
        parts.push(`- 卡顿帧: ${session.jank_count}`);
        parts.push(`- 卡顿率: ${session.jank_rate.toFixed(1)}%`);
        if (session.max_vsync_missed !== undefined) {
          parts.push(`- 最大丢失 VSync: ${session.max_vsync_missed}`);
        }
        if (session.process_name) parts.push(`- 进程: ${session.process_name}`);
        parts.push('');
      }
    }

    parts.push('## 要求');
    parts.push('1. 分析这些实体之间的关键差异：');
    parts.push('   - 量化差异（使用具体数值）');
    parts.push('   - 分类差异（卡顿类型、耗时分布）');
    parts.push('2. 明确指出：');
    parts.push('   - 表现最差的实体及其问题');
    parts.push('   - 表现最好的实体（作为基准参考）');
    parts.push('3. 如果有规律性差异，分析可能原因：');
    parts.push('   - 是否与时间顺序相关（前期/后期）');
    parts.push('   - 是否与特定操作相关');
    parts.push('   - 是否有共同瓶颈');
    parts.push('4. 给出优化建议：');
    parts.push('   - 优先解决什么问题');
    parts.push('   - 如何让差的向好的靠拢');
    parts.push('5. 使用中文回答，保持专业但易懂');
    parts.push('');
    parts.push('## 输出格式');
    parts.push('- 先给出 1-2 句话的总结');
    parts.push('- 再分点详细分析');
    parts.push('- 最后给出建议');
    parts.push('');
    parts.push('请直接给出分析，不要添加额外的格式标记。');

    return parts.join('\n');
  }

  private buildFallbackNarrative(
    entityType: 'frame' | 'session',
    data: FrameComparisonData | SessionComparisonData
  ): string {
    const parts: string[] = [];

    if (entityType === 'frame') {
      const frameData = data as FrameComparisonData;
      const rows = frameData.rows;

      // Find worst performing frame
      const worstFrame = rows.reduce((worst, curr) => {
        const worstMs = worst.dur_ms || 0;
        const currMs = curr.dur_ms || 0;
        return currMs > worstMs ? curr : worst;
      }, rows[0]);

      parts.push(`对比了 ${rows.length} 个帧：`);
      parts.push('');

      // Jank type distribution
      const jankTypes = new Map<string, number>();
      for (const frame of rows) {
        const count = jankTypes.get(frame.jank_type) || 0;
        jankTypes.set(frame.jank_type, count + 1);
      }
      parts.push('卡顿类型分布:');
      for (const [type, count] of jankTypes) {
        parts.push(`- ${type}: ${count} 帧`);
      }
      parts.push('');

      if (worstFrame.dur_ms) {
        parts.push(`表现最差: 帧 ${worstFrame.frame_id}，耗时 ${worstFrame.dur_ms.toFixed(2)}ms`);
      }
    } else {
      const sessionData = data as SessionComparisonData;
      const rows = sessionData.rows;

      // Find worst performing session
      const worstSession = rows.reduce((worst, curr) => {
        return curr.jank_rate > worst.jank_rate ? curr : worst;
      }, rows[0]);

      const bestSession = rows.reduce((best, curr) => {
        return curr.jank_rate < best.jank_rate ? curr : best;
      }, rows[0]);

      parts.push(`对比了 ${rows.length} 个会话：`);
      parts.push('');
      parts.push(`卡顿率最高: 会话 ${worstSession.session_id} (${worstSession.jank_rate.toFixed(1)}%)`);
      parts.push(`卡顿率最低: 会话 ${bestSession.session_id} (${bestSession.jank_rate.toFixed(1)}%)`);

      const rateDiff = worstSession.jank_rate - bestSession.jank_rate;
      if (rateDiff > 5) {
        parts.push(`差异显著: ${rateDiff.toFixed(1)} 个百分点`);
      }
    }

    return parts.join('\n');
  }

  // ===========================================================================
  // Formatting
  // ===========================================================================

  private formatComparisonTable(
    entityType: 'frame' | 'session',
    data: FrameComparisonData | SessionComparisonData
  ): string {
    const lines: string[] = [];

    if (entityType === 'frame') {
      const frameData = data as FrameComparisonData;
      lines.push('| 帧 ID | 卡顿类型 | 耗时(ms) | 丢失 VSync | 进程 |');
      lines.push('|-------|----------|----------|------------|------|');
      for (const row of frameData.rows) {
        const durStr = row.dur_ms !== undefined ? row.dur_ms.toFixed(2) : '-';
        const vsyncStr = row.vsync_missed !== undefined ? String(row.vsync_missed) : '-';
        lines.push(`| ${row.frame_id} | ${row.jank_type} | ${durStr} | ${vsyncStr} | ${row.process_name || '-'} |`);
      }
    } else {
      const sessionData = data as SessionComparisonData;
      lines.push('| 会话 ID | 总帧数 | 卡顿帧 | 卡顿率 | 最大丢失 VSync | 进程 |');
      lines.push('|---------|--------|--------|--------|----------------|------|');
      for (const row of sessionData.rows) {
        const vsyncStr = row.max_vsync_missed !== undefined ? String(row.max_vsync_missed) : '-';
        lines.push(`| ${row.session_id} | ${row.frame_count} | ${row.jank_count} | ${row.jank_rate.toFixed(1)}% | ${vsyncStr} | ${row.process_name || '-'} |`);
      }
    }

    return lines.join('\n');
  }

  private determineSeverity(data: FrameComparisonData | SessionComparisonData): 'critical' | 'warning' | 'info' {
    if (data.type === 'frame') {
      const frameData = data as FrameComparisonData;
      const hasCritical = frameData.rows.some(r =>
        r.jank_type === 'App Deadline Missed' ||
        (r.dur_ms && r.dur_ms > 32)
      );
      return hasCritical ? 'warning' : 'info';
    } else {
      const sessionData = data as SessionComparisonData;
      const maxJankRate = Math.max(...sessionData.rows.map(r => r.jank_rate));
      if (maxJankRate > 10) return 'critical';
      if (maxJankRate > 5) return 'warning';
      return 'info';
    }
  }

  // ===========================================================================
  // Error Results
  // ===========================================================================

  private buildInsufficientEntitiesResult(): ExecutorResult {
    return {
      findings: [{
        id: `comparison_error_${Date.now()}`,
        category: 'error',
        type: 'comparison_error',
        severity: 'warning',
        title: '比较需要至少两个实体',
        description: '请指定至少两个帧或会话进行比较。例如："比较帧 1436069 和 1436070"',
        source: 'comparison_executor',
        confidence: 1.0,
      }],
      lastStrategy: concludeDecision(0.5, 'Insufficient entities'),
      confidence: 0.5,
      informationGaps: ['需要至少两个实体进行比较'],
      rounds: 1,
      stopReason: 'Insufficient entities for comparison',
    };
  }

  private buildMixedTypesResult(): ExecutorResult {
    return {
      findings: [{
        id: `comparison_error_${Date.now()}`,
        category: 'error',
        type: 'comparison_error',
        severity: 'warning',
        title: '不支持混合类型比较',
        description: '请比较相同类型的实体（都是帧或都是会话）。',
        source: 'comparison_executor',
        confidence: 1.0,
      }],
      lastStrategy: concludeDecision(0.5, 'Mixed entity types'),
      confidence: 0.5,
      informationGaps: ['需要相同类型的实体进行比较'],
      rounds: 1,
      stopReason: 'Mixed entity types not supported',
    };
  }

  private buildResolutionFailedResult(requestedCount: number): ExecutorResult {
    return {
      findings: [{
        id: `comparison_error_${Date.now()}`,
        category: 'error',
        type: 'comparison_error',
        severity: 'warning',
        title: '实体解析失败',
        description: `无法解析指定的 ${requestedCount} 个实体。请确保这些实体存在于 trace 中，或先运行一次完整分析。`,
        source: 'comparison_executor',
        confidence: 1.0,
      }],
      lastStrategy: concludeDecision(0.3, 'Entity resolution failed'),
      confidence: 0.3,
      informationGaps: ['需要先运行完整分析以填充实体缓存'],
      rounds: 1,
      stopReason: 'Entity resolution failed',
    };
  }
}

// =============================================================================
// Types
// =============================================================================

interface FrameComparisonRow {
  frame_id: string;
  jank_type: string;
  dur_ms?: number;
  vsync_missed?: number;
  process_name?: string;
  session_id?: string;
  start_ts?: string;
  end_ts?: string;
}

interface SessionComparisonRow {
  session_id: string;
  frame_count: number;
  jank_count: number;
  jank_rate: number;
  max_vsync_missed?: number;
  process_name?: string;
  start_ts?: string;
  end_ts?: string;
}

interface FrameComparisonData {
  type: 'frame';
  rows: FrameComparisonRow[];
}

interface SessionComparisonData {
  type: 'session';
  rows: SessionComparisonRow[];
}

type ComparisonData = FrameComparisonData | SessionComparisonData;