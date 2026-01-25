/**
 * Hypothesis Generator (Multi-turn Enhanced)
 *
 * Generates initial hypotheses about performance issues based on user query and intent.
 * Now supports multi-turn dialogue by:
 * - Considering previous findings to generate more targeted hypotheses
 * - Generating drill-down hypotheses for follow-up queries
 * - Avoiding redundant hypotheses based on conversation history
 *
 * Uses LLM for intelligent hypothesis generation, with keyword-based fallback.
 */

import { Intent } from '../types';
import {
  Hypothesis,
  createHypothesisId,
} from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { DomainAgentRegistry } from '../agents/domain';
import { ProgressEmitter } from './orchestratorTypes';
import { EnhancedSessionContext } from '../context/enhancedSessionContext';

/**
 * Create a hypothesis with standard fields.
 */
export function createHypothesis(
  description: string,
  confidence: number,
  relevantAgents?: string[]
): Hypothesis {
  const now = Date.now();
  return {
    id: createHypothesisId(),
    description,
    confidence,
    status: 'proposed',
    supportingEvidence: [],
    contradictingEvidence: [],
    proposedBy: 'master_orchestrator',
    createdAt: now,
    updatedAt: now,
    ...(relevantAgents && { relevantAgents }),
  };
}

/**
 * Generate initial hypotheses using LLM reasoning.
 * Falls back to keyword-based defaults if LLM fails.
 *
 * For follow-up queries, generates targeted hypotheses based on:
 * - The type of follow-up (drill_down, extend, compare, clarify)
 * - Previous findings from conversation history
 * - Referenced entities from the intent
 *
 * @param query - User's query
 * @param intent - Understood intent (may include follow-up info)
 * @param sessionContext - Optional session context for multi-turn support
 * @param modelRouter - Model router for LLM calls
 * @param agentRegistry - Registry of domain agents
 * @param emitter - Progress emitter
 */
export async function generateInitialHypotheses(
  query: string,
  intent: Intent,
  sessionContext: EnhancedSessionContext | null,
  modelRouter: ModelRouter,
  agentRegistry: DomainAgentRegistry,
  emitter: ProgressEmitter
): Promise<Hypothesis[]> {
  // Build context-aware prompt
  const historyContext = sessionContext?.generatePromptContext(500) || '';
  const isFollowUp = intent.followUpType && intent.followUpType !== 'initial';

  const followUpContext = isFollowUp ? buildFollowUpHypothesisContext(intent) : '';

  const prompt = `基于以下用户查询，生成可能的性能问题假设：

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
分析方面: ${intent.aspects.join(', ')}
${isFollowUp ? `\n查询类型: ${translateFollowUpType(intent.followUpType!)}` : ''}
${historyContext ? `\n${historyContext}` : ''}
${followUpContext ? `\n${followUpContext}` : ''}

请以 JSON 格式返回假设列表：
{
  "hypotheses": [
    {
      "description": "假设描述",
      "confidence": 0.5,
      "relevantAgents": ["frame_agent", "cpu_agent"]
    }
  ]
}

${getHypothesisGuidelines(intent.followUpType)}

可用的 Agent:
${agentRegistry.getAgentDescriptionsForLLM()}`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'planning');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return (parsed.hypotheses || []).map((h: any) => createHypothesis(
        h.description,
        h.confidence || 0.5,
        h.relevantAgents
      ));
    }
  } catch (error) {
    emitter.log(`Failed to generate hypotheses: ${error}`);
    emitter.emitUpdate('degraded', { module: 'hypothesisGenerator', fallback: 'keyword-based defaults' });
  }

  // Fallback: generate appropriate defaults based on query type
  return isFollowUp
    ? generateFollowUpDefaultHypotheses(query, intent)
    : generateDefaultHypotheses(query);
}

const FOLLOW_UP_TYPE_LABELS: Record<string, string> = {
  drill_down: '深入分析',
  extend: '扩展分析',
  compare: '比较分析',
  clarify: '澄清解释',
  initial: '初始分析',
};

const INITIAL_GUIDELINES = `注意：对于滑动/卡顿类问题，请务必包含以下关键假设方向：
- App 自身运行时间过长（主线程/RenderThread 耗时操作，如布局计算、绘制、业务逻辑）
- 帧率不稳定或掉帧
- CPU 调度不合理（被调度到小核、等待调度时间过长）
- 系统级问题（SurfaceFlinger、GPU、Binder IPC）`;

const FOLLOW_UP_GUIDELINES: Record<string, string> = {
  drill_down: `注意：这是一个深入分析请求，请生成针对特定帧/会话的详细假设：
- 具体帧的主线程耗时分布（布局、绘制、业务逻辑）
- 具体帧的 RenderThread 耗时
- 具体帧的 CPU 调度情况（核心、等待时间）
- 具体帧的 Binder 调用阻塞
- 与系统服务的交互延迟`,
  extend: `注意：这是一个扩展分析请求，请基于之前的发现生成更广泛的假设：
- 类似问题是否在其他帧/会话中存在
- 是否存在模式性的性能问题
- 是否有系统级因素影响多个帧`,
  compare: `注意：这是一个比较分析请求，请生成比较性假设：
- 不同帧/会话之间的性能差异原因
- 共同点和差异点分析
- 模式识别`,
  clarify: `注意：这是一个澄清/解释请求，不需要生成新的调查假设，而是解释现有发现。`,
};

function buildFollowUpHypothesisContext(intent: Intent): string {
  const parts: string[] = [];

  if (intent.referencedEntities?.length) {
    parts.push('## 用户引用的实体');
    parts.push(...intent.referencedEntities.map(e => `- ${e.type}: ${e.id}`));
  }

  if (intent.extractedParams && Object.keys(intent.extractedParams).length > 0) {
    parts.push('\n## 提取的参数');
    parts.push(...Object.entries(intent.extractedParams).map(([k, v]) => `- ${k}: ${v}`));
  }

  return parts.join('\n');
}

export function translateFollowUpType(type: string): string {
  return FOLLOW_UP_TYPE_LABELS[type] || type;
}

function getHypothesisGuidelines(followUpType?: string): string {
  return (followUpType && FOLLOW_UP_GUIDELINES[followUpType]) || INITIAL_GUIDELINES;
}

/**
 * Generate default hypotheses for follow-up queries.
 */
function generateFollowUpDefaultHypotheses(query: string, intent: Intent): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  // For drill-down with frame_id
  if (intent.followUpType === 'drill_down' && intent.extractedParams?.frame_id) {
    hypotheses.push(
      createHypothesis(
        `帧 ${intent.extractedParams.frame_id} 的主线程执行时间过长导致卡顿`,
        0.7,
        ['frame_agent', 'cpu_agent']
      ),
      createHypothesis(
        `帧 ${intent.extractedParams.frame_id} 存在 Binder 调用阻塞`,
        0.5,
        ['frame_agent', 'binder_agent']
      ),
    );
  }

  // For drill-down with session_id
  if (intent.followUpType === 'drill_down' && intent.extractedParams?.session_id) {
    hypotheses.push(
      createHypothesis(
        `滑动会话 ${intent.extractedParams.session_id} 存在多帧连续卡顿`,
        0.7,
        ['frame_agent']
      ),
    );
  }

  // Fallback if no specific params
  if (hypotheses.length === 0) {
    hypotheses.push(
      createHypothesis('需要进一步分析以确定问题根因', 0.5, ['frame_agent'])
    );
  }

  return hypotheses;
}

/**
 * Generate keyword-based default hypotheses when LLM is unavailable.
 */
export function generateDefaultHypotheses(query: string): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];
  const queryLower = query.toLowerCase();

  if (queryLower.includes('卡顿') || queryLower.includes('jank')) {
    hypotheses.push(createHypothesis('帧渲染超时导致卡顿', 0.6));
  }

  if (queryLower.includes('滑动') || queryLower.includes('scroll')) {
    hypotheses.push(
      createHypothesis('滑动过程中存在帧率不稳定或掉帧现象', 0.7, ['frame_agent']),
      createHypothesis('App 自身运行时间过长（主线程或 RenderThread 耗时操作导致帧超时）', 0.75, ['frame_agent', 'cpu_agent']),
    );
  }

  if (hypotheses.length === 0) {
    hypotheses.push(createHypothesis('存在性能问题需要诊断', 0.5));
  }

  return hypotheses;
}
