// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

type HypothesesJsonPayload = {
  hypotheses: Array<{
    description: string;
    confidence?: number;
    relevantAgents?: string[];
  }>;
};

const HYPOTHESES_JSON_SCHEMA: LlmJsonSchema<HypothesesJsonPayload> = {
  name: 'hypotheses_json@1.0.0',
  validate: (value: unknown): value is HypothesesJsonPayload => {
    if (!isPlainObject(value)) return false;
    if (!Array.isArray((value as any).hypotheses)) return false;

    for (const item of (value as any).hypotheses) {
      if (!isPlainObject(item)) return false;
      if (typeof (item as any).description !== 'string') return false;
      const confidence = (item as any).confidence;
      if (confidence !== undefined && confidence !== null && typeof confidence !== 'number') return false;
      const relevantAgents = (item as any).relevantAgents;
      if (relevantAgents !== undefined && relevantAgents !== null && !isStringArray(relevantAgents)) return false;
    }

    return true;
  },
};

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
    const response = await modelRouter.callWithFallback(prompt, 'planning', {
      sessionId: sessionContext?.getSessionId(),
      traceId: sessionContext?.getTraceId(),
      jsonMode: true,
      promptId: 'agent.hypothesisGenerator',
      promptVersion: '1.0.0',
      contractVersion: 'hypotheses_json@1.0.0',
    });
    const parsed = parseLlmJson<HypothesesJsonPayload>(response.response, HYPOTHESES_JSON_SCHEMA);
    return (parsed.hypotheses || []).map((h) => createHypothesis(
      h.description,
      typeof h.confidence === 'number' ? Math.max(0, Math.min(1, h.confidence)) : 0.5,
      h.relevantAgents
    ));
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

/**
 * Guidelines for initial hypothesis generation.
 * Covers all major performance issue categories for Android.
 */
const INITIAL_GUIDELINES = `注意：对于滑动/卡顿类问题，请务必覆盖以下关键假设方向：

## App 层面
- App 自身运行时间过长（主线程/RenderThread 耗时操作，如布局计算、绘制、业务逻辑）
- 帧率不稳定或掉帧（连续掉帧、不规则掉帧）

## CPU 层面
- CPU 调度不合理（被调度到小核、等待调度时间过长、频繁迁移）
- CPU 负载过高（后台任务争抢、密集计算）
- CPU 限频/降频（温控、功耗管理导致性能下降）

## GPU 层面
- GPU 渲染瓶颈（Shader 编译、纹理上传、复杂绘制）
- GPU Fence 等待（帧缓冲交换延迟）
- 过度绘制（Overdraw）

## 内存层面
- 内存压力（频繁 GC、LMK 杀进程）
- 内存分配热点（帧期间大量对象创建）

## IO 层面
- IO 阻塞（主线程磁盘读写、数据库操作）
- Page Fault（内存页面错误、缺页中断）

## 系统层面
- SurfaceFlinger 合成延迟
- Binder IPC 阻塞（同步调用超时、服务端响应慢）
- 锁竞争（Monitor Contention）

每个假设需要：
- 明确描述问题假设
- 指定相关的 Agent（frame_agent/cpu_agent/memory_agent/binder_agent）
- 给出初始置信度（0.3-0.8）`;

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
 * Covers all major performance issue categories comprehensively.
 */
export function generateDefaultHypotheses(query: string): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];
  const queryLower = query.toLowerCase();

  // Jank/Stutter detection
  if (queryLower.includes('卡顿') || queryLower.includes('jank') || queryLower.includes('掉帧')) {
    hypotheses.push(
      createHypothesis('帧渲染超时导致卡顿（主线程或 RenderThread 耗时操作）', 0.7, ['frame_agent', 'cpu_agent']),
      createHypothesis('GPU 渲染瓶颈或 Fence 等待导致掉帧', 0.5, ['frame_agent']),
    );
  }

  // Scrolling performance
  if (queryLower.includes('滑动') || queryLower.includes('scroll') || queryLower.includes('列表')) {
    hypotheses.push(
      createHypothesis('滑动过程中存在帧率不稳定或掉帧现象', 0.7, ['frame_agent']),
      createHypothesis('App 自身运行时间过长（主线程或 RenderThread 耗时操作导致帧超时）', 0.75, ['frame_agent', 'cpu_agent']),
      createHypothesis('CPU 调度不合理（小核运行或等待调度时间长）', 0.5, ['cpu_agent']),
    );
  }

  // CPU-related
  if (queryLower.includes('cpu') || queryLower.includes('调度') || queryLower.includes('频率')) {
    hypotheses.push(
      createHypothesis('CPU 负载过高导致性能问题', 0.6, ['cpu_agent']),
      createHypothesis('CPU 限频/降频影响性能（温控或功耗管理）', 0.5, ['cpu_agent']),
    );
  }

  // Memory-related
  if (queryLower.includes('内存') || queryLower.includes('memory') || queryLower.includes('gc')) {
    hypotheses.push(
      createHypothesis('内存压力导致性能问题（频繁 GC 或 LMK）', 0.6, ['memory_agent']),
      createHypothesis('帧期间存在大量对象分配触发 GC', 0.5, ['memory_agent', 'frame_agent']),
    );
  }

  // Binder/IPC
  if (queryLower.includes('binder') || queryLower.includes('ipc') || queryLower.includes('锁')) {
    hypotheses.push(
      createHypothesis('Binder IPC 调用阻塞导致延迟', 0.6, ['binder_agent']),
      createHypothesis('锁竞争导致线程阻塞', 0.5, ['binder_agent', 'cpu_agent']),
    );
  }

  // IO-related
  if (queryLower.includes('io') || queryLower.includes('磁盘') || queryLower.includes('文件')) {
    hypotheses.push(
      createHypothesis('IO 阻塞导致主线程卡顿', 0.6, ['cpu_agent', 'binder_agent']),
    );
  }

  // GPU-related
  if (queryLower.includes('gpu') || queryLower.includes('渲染') || queryLower.includes('绘制')) {
    hypotheses.push(
      createHypothesis('GPU 渲染耗时过长或存在 Shader 编译延迟', 0.6, ['frame_agent']),
    );
  }

  // Default fallback - comprehensive hypothesis set
  if (hypotheses.length === 0) {
    hypotheses.push(
      createHypothesis('存在性能问题需要诊断', 0.5, ['frame_agent']),
      createHypothesis('可能存在帧渲染或调度问题', 0.4, ['frame_agent', 'cpu_agent']),
    );
  }

  return hypotheses;
}