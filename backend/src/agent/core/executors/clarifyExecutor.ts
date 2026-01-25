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
      const result = await this.services.modelRouter.callWithFallback(prompt, 'synthesis');

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
    parts.push('1. 直接回答用户的问题');
    parts.push('2. 如果是技术概念解释，给出清晰定义和影响');
    parts.push('3. 如果是关于特定帧/会话的问题，结合上述数据分析原因');
    parts.push('4. 使用中文回答，保持专业但易懂');
    parts.push('5. 如果信息不足，说明还需要什么信息');
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
 * Get a brief explanation for common jank types.
 */
function getJankTypeExplanation(jankType: string): string {
  const explanations: Record<string, string> = {
    'App Deadline Missed': '应用在规定时间内未能完成帧的渲染，通常是主线程或渲染线程工作过重导致',
    'Buffer Stuffing': '应用产生帧的速度超过了显示刷新率，导致帧在队列中堆积',
    'SurfaceFlinger Deadline Missed': 'SurfaceFlinger 未能及时合成帧，可能是系统负载过高',
    'Unknown Deadline Missed': '帧未按时完成，但具体原因未知',
    'No Jank': '该帧正常渲染，没有卡顿',
    'Dropped Frame': '帧被丢弃，未能显示到屏幕上',
  };

  return explanations[jankType] || `该卡顿类型 (${jankType}) 需要进一步分析具体原因`;
}
