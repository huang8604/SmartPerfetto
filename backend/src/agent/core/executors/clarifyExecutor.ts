// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Clarify Executor
 *
 * A read-only executor for handling clarification requests.
 * Explains previous findings without executing trace SQL queries.
 *
 * Use cases:
 * - "为什么帧 1436069 卡顿?" → explains the jank type and contributing factors
 * - "解释一下这个发现" → provides more context about a finding
 * - "什么是 App Deadline Missed?" → explains technical concepts
 *
 * Key characteristics:
 * - No trace SQL by default (pure LLM reasoning)
 * - References EntityStore and findings for context
 * - Generates explanation-style conclusions
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
import type { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { FrameEntity, SessionEntity } from '../../context/entityStore';

// =============================================================================
// ClarifyExecutor
// =============================================================================

export class ClarifyExecutor implements AnalysisExecutor {
  constructor(
    private sessionContext: EnhancedSessionContext,
    private services: AnalysisServices
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    emitter.log('[Clarify] Starting clarification (read-only mode)');
    emitter.emitUpdate('progress', {
      phase: 'clarifying',
      message: '生成解释说明 (无需查询 trace)',
    });

    // Gather context for LLM
    const context = this.buildClarificationContext(ctx);

    // Generate explanation via LLM
    const explanation = await this.generateExplanation(ctx.query, context, emitter);

    // Build a single "explanation" finding
    const findings: Finding[] = [{
      id: `clarify_${Date.now()}`,
      category: 'explanation',
      type: 'clarification',
      severity: 'info',
      title: '解释说明',
      description: explanation,
      source: 'clarify_executor',
      confidence: 0.9,
    }];

    emitter.emitUpdate('finding', {
      round: 1,
      findings,
    });

    emitter.emitUpdate('progress', {
      phase: 'synthesis_complete',
      confirmedFindings: 0,
      updatedHypotheses: 0,
      message: '解释生成完成',
    });

    emitter.log('[Clarify] Clarification complete');

    return {
      findings,
      lastStrategy: concludeDecision(0.9, 'Clarification provided'),
      confidence: 0.9,
      informationGaps: [],
      rounds: 1,
      stopReason: 'Clarification complete',
    };
  }

  /**
   * Build context for clarification from session state.
   */
  private buildClarificationContext(ctx: ExecutionContext): ClarificationContext {
    const entityStore = this.sessionContext.getEntityStore();
    const recentFindings = this.sessionContext.getAllFindings().slice(-10);
    const referencedEntities = ctx.intent.referencedEntities || [];

    // Gather referenced entity data
    const frameData: FrameEntity[] = [];
    const sessionData: SessionEntity[] = [];

    for (const ref of referencedEntities) {
      if (ref.type === 'frame') {
        const id = ref.value ?? ref.id;
        if (id !== undefined) {
          const frame = entityStore.getFrame(String(id));
          if (frame) frameData.push(frame);
        }
      } else if (ref.type === 'session') {
        const id = ref.value ?? ref.id;
        if (id !== undefined) {
          const session = entityStore.getSession(String(id));
          if (session) sessionData.push(session);
        }
      }
    }

    // Extract recent turn summaries
    const recentTurns = this.sessionContext.getRecentTurns(3);
    const turnSummaries = recentTurns.map(turn => ({
      query: turn.query,
      findingCount: turn.findings.length,
      keyFindings: turn.findings.slice(0, 3).map(f => f.title),
    }));

    return {
      recentFindings,
      frameData,
      sessionData,
      turnSummaries,
      contextSummary: this.sessionContext.generatePromptContext(300),
    };
  }

  /**
   * Generate explanation using LLM.
   */
  private async generateExplanation(
    query: string,
    context: ClarificationContext,
    emitter: ProgressEmitter
  ): Promise<string> {
    const prompt = this.buildExplanationPrompt(query, context);

    try {
      const result = await this.services.modelRouter.callWithFallback(prompt, 'synthesis', {
        sessionId: this.sessionContext.getSessionId(),
        traceId: this.sessionContext.getTraceId(),
        promptId: 'agent.clarifyExecutor',
        promptVersion: '1.0.0',
        contractVersion: 'clarify_text@1.0.0',
      });

      if (result.success && result.response) {
        return result.response;
      }
      return '无法生成解释，请尝试重新提问或提供更多上下文。';
    } catch (error: any) {
      emitter.log(`[Clarify] LLM call failed: ${error.message}`);
      return this.buildFallbackExplanation(query, context);
    }
  }

  /**
   * Build the explanation prompt for LLM.
   */
  private buildExplanationPrompt(query: string, context: ClarificationContext): string {
    const parts: string[] = [];

    parts.push('你是一个 Android 性能分析专家，正在回答用户的澄清问题。');
    parts.push('');
    parts.push('## 用户问题');
    parts.push(query);
    parts.push('');

    // Add context summary
    if (context.contextSummary) {
      parts.push('## 对话上下文');
      parts.push(context.contextSummary);
      parts.push('');
    }

    // Add frame data if relevant
    if (context.frameData.length > 0) {
      parts.push('## 相关帧数据');
      for (const frame of context.frameData) {
        parts.push(`- 帧 ${frame.frame_id}:`);
        if (frame.jank_type) parts.push(`  - 卡顿类型: ${frame.jank_type}`);
        if (frame.dur_ms) parts.push(`  - 持续时间: ${frame.dur_ms}ms`);
        if (frame.vsync_missed) parts.push(`  - 丢失 VSync: ${frame.vsync_missed}`);
        if (frame.process_name) parts.push(`  - 进程: ${frame.process_name}`);
      }
      parts.push('');
    }

    // Add session data if relevant
    if (context.sessionData.length > 0) {
      parts.push('## 相关会话数据');
      for (const session of context.sessionData) {
        parts.push(`- 会话 ${session.session_id}:`);
        if (session.frame_count) parts.push(`  - 总帧数: ${session.frame_count}`);
        if (session.jank_count) parts.push(`  - 卡顿帧数: ${session.jank_count}`);
        if (session.process_name) parts.push(`  - 进程: ${session.process_name}`);
      }
      parts.push('');
    }

    // Add recent findings
    if (context.recentFindings.length > 0) {
      parts.push('## 近期发现');
      for (const finding of context.recentFindings.slice(0, 5)) {
        parts.push(`- [${finding.severity}] ${finding.title}`);
        if (finding.description) {
          parts.push(`  ${finding.description.substring(0, 100)}${finding.description.length > 100 ? '...' : ''}`);
        }
      }
      parts.push('');
    }

    parts.push('## 要求');
    parts.push('1. 直接回答用户的问题，不要绕弯子');
    parts.push('2. 如果是技术概念解释：');
    parts.push('   - 先给出简明定义（1-2句话）');
    parts.push('   - 再解释对性能的影响');
    parts.push('   - 列出常见原因（如果适用）');
    parts.push('3. 如果是关于特定帧/会话的问题：');
    parts.push('   - 结合上述数据分析具体原因');
    parts.push('   - 引用具体数值作为依据');
    parts.push('   - 给出可能的优化方向');
    parts.push('4. 使用中文回答，保持专业但易懂');
    parts.push('5. 如果信息不足，明确说明：');
    parts.push('   - 当前已知什么');
    parts.push('   - 还需要什么信息');
    parts.push('   - 如何获取这些信息（例如"需要先运行完整分析"）');
    parts.push('');
    parts.push('## 常见卡顿类型说明');
    parts.push('- App Deadline Missed: 应用侧超时，通常是主线程或RenderThread问题');
    parts.push('- Buffer Stuffing: 帧堆积，应用产帧速度超过显示刷新率');
    parts.push('- SurfaceFlinger Deadline Missed: 系统合成层问题');
    parts.push('- Dropped Frame: 帧被丢弃，最严重的卡顿类型');
    parts.push('');
    parts.push('请直接给出解释，不要添加额外的格式标记。');

    return parts.join('\n');
  }

  /**
   * Build a fallback explanation when LLM is unavailable.
   */
  private buildFallbackExplanation(query: string, context: ClarificationContext): string {
    const parts: string[] = [];

    parts.push('基于当前上下文的解释：');
    parts.push('');

    // Try to provide some useful information based on available data
    if (context.frameData.length > 0) {
      for (const frame of context.frameData) {
        parts.push(`帧 ${frame.frame_id}：`);
        if (frame.jank_type) {
          parts.push(`- 卡顿类型为 "${frame.jank_type}"，这表示 ${getJankTypeExplanation(frame.jank_type)}`);
        }
        if (frame.dur_ms) {
          parts.push(`- 渲染耗时 ${frame.dur_ms}ms`);
        }
      }
    }

    if (context.sessionData.length > 0) {
      for (const session of context.sessionData) {
        if (session.jank_count && session.frame_count) {
          const jankRate = ((Number(session.jank_count) / Number(session.frame_count)) * 100).toFixed(1);
          parts.push(`会话 ${session.session_id} 的卡顿率为 ${jankRate}%`);
        }
      }
    }

    if (parts.length === 2) {
      parts.push('当前没有足够的上下文信息来回答这个问题。请尝试先运行一次完整的分析。');
    }

    return parts.join('\n');
  }
}

// =============================================================================
// Types
// =============================================================================

interface ClarificationContext {
  recentFindings: Finding[];
  frameData: FrameEntity[];
  sessionData: SessionEntity[];
  turnSummaries: Array<{
    query: string;
    findingCount: number;
    keyFindings: string[];
  }>;
  contextSummary: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get a comprehensive explanation for jank types.
 *
 * Provides detailed explanations including:
 * - What the jank type means
 * - Common causes
 * - Where to look for more details
 */
function getJankTypeExplanation(jankType: string): string {
  const explanations: Record<string, string> = {
    // App-side jank types
    'App Deadline Missed': `应用在规定时间内未能完成帧的渲染。

常见原因：
• 主线程耗时操作（布局计算、业务逻辑、IO）
• RenderThread 渲染耗时（复杂绘制、Shader 编译）
• Binder 同步调用阻塞
• GC 导致暂停

诊断建议：查看四象限分析和主线程/RenderThread 耗时操作`,

    'Buffer Stuffing': `应用产生帧的速度超过了显示刷新率。

这通常发生在：
• 应用连续快速提交多帧
• 前序帧延迟导致后续帧在 Buffer 中堆积
• 系统合成层处理不及时

诊断建议：检查帧间隔是否过短，以及 SF 合成延迟`,

    'SurfaceFlinger Deadline Missed': `SurfaceFlinger 未能及时完成帧合成。

常见原因：
• 系统负载过高
• 图层数量过多
• GPU 合成耗时
• HWC 硬件合成问题

诊断建议：检查系统 CPU 负载和 SF 帧处理时序`,

    'Unknown Deadline Missed': `帧未按时完成，但系统未能明确分类原因。

可能的情况：
• 多因素共同导致
• Trace 数据不完整
• 边界情况

诊断建议：查看帧的完整时间线和各阶段耗时`,

    'No Jank': '该帧正常渲染，在 VSync 周期内完成，没有卡顿问题。',

    'Dropped Frame': `帧被丢弃，未能显示到屏幕上。

这是最严重的卡顿类型，用户会明显感知。通常发生在：
• 连续多帧超时
• 系统资源严重不足
• GPU/SF 严重阻塞`,

    // Additional jank types from Android FrameTimeline
    'Display HAL': `显示硬件层面导致的延迟。

可能原因：
• 显示控制器问题
• 刷新率切换
• HDMI/DP 同步问题`,

    'GPU Composition': `GPU 合成耗时过长。

常见原因：
• 过度绘制 (Overdraw)
• 复杂的图层混合
• GPU 频率不足`,

    'Present Late': `帧在 Present 阶段延迟。

可能原因：
• GPU Fence 等待
• Display commit 延迟
• VSync 对齐问题`,
  };

  return explanations[jankType] || `该卡顿类型 (${jankType}) 需要进一步分析具体原因。建议查看帧级详细数据和四象限分析。`;
}