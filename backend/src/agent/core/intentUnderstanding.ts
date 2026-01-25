/**
 * Intent Understanding Module (Multi-turn Enhanced)
 *
 * Parses user queries into structured Intent objects via LLM.
 * Now supports multi-turn dialogue by:
 * - Injecting conversation history context
 * - Detecting follow-up query types (drill_down, clarify, extend, compare)
 * - Extracting referenced entities from user query
 * - Providing extractedParams for skill invocation
 *
 * Falls back to a sensible default if LLM parsing fails.
 */

import { Intent, ReferencedEntity } from '../types';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';
import { EnhancedSessionContext } from '../context/enhancedSessionContext';

/**
 * Understand user intent from a natural language query.
 * Uses LLM to extract primaryGoal, aspects, output type, complexity,
 * and for follow-up queries: followUpType, referencedEntities, extractedParams.
 *
 * @param query - User's natural language query
 * @param sessionContext - Optional session context for multi-turn support
 * @param modelRouter - Model router for LLM calls
 * @param emitter - Progress emitter for logging
 */
export async function understandIntent(
  query: string,
  sessionContext: EnhancedSessionContext | null,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter
): Promise<Intent> {
  // Generate history context if we have prior turns
  const historyContext = sessionContext?.generatePromptContext(800) || '';
  const isFollowUp = sessionContext && sessionContext.getAllTurns().length > 0;

  // Get referenceable entities for LLM reference
  const referenceableEntities = sessionContext
    ? sessionContext.extractReferenceableEntities()
    : [];

  const prompt = buildMultiTurnIntentPrompt(
    query,
    historyContext,
    isFollowUp,
    referenceableEntities
  );

  try {
    const response = await modelRouter.callWithFallback(prompt, 'intent_understanding');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Intent;

      // Validate and normalize followUpType
      if (parsed.followUpType && !isValidFollowUpType(parsed.followUpType)) {
        parsed.followUpType = isFollowUp ? 'drill_down' : 'initial';
      }

      // Ensure extractedParams is an object
      if (parsed.extractedParams && typeof parsed.extractedParams !== 'object') {
        parsed.extractedParams = {};
      }

      emitter.log(`Intent understood: ${parsed.primaryGoal} (followUp: ${parsed.followUpType || 'initial'})`);

      return parsed;
    }
  } catch (error) {
    emitter.log(`Failed to parse intent: ${error}`);
    emitter.emitUpdate('degraded', { module: 'intentUnderstanding', fallback: 'rule-based default' });
  }

  // Fallback: simple heuristic-based intent
  return buildFallbackIntent(query, isFollowUp);
}

/**
 * Build the multi-turn aware intent prompt for LLM.
 */
function buildMultiTurnIntentPrompt(
  query: string,
  historyContext: string,
  isFollowUp: boolean | null,
  referenceableEntities: ReferencedEntity[]
): string {
  const followUpInstructions = isFollowUp
    ? `这是多轮对话的后续问题，请特别注意识别用户是否在引用之前发现的实体（如帧ID、会话ID等）。`
    : '';

  const entitiesSection = referenceableEntities.length > 0
    ? `## 可引用的实体（来自之前的分析）
${referenceableEntities.slice(0, 20).map(e => `- ${e.type}: ${e.id}`).join('\n')}
`
    : '';

  return `分析以下用户查询，提取分析意图。${followUpInstructions}

${historyContext ? `${historyContext}\n` : ''}
${entitiesSection}
用户查询: "${query}"

请以 JSON 格式返回：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex",
  "followUpType": "${isFollowUp ? 'drill_down | clarify | extend | compare' : 'initial'}",
  "referencedEntities": [
    // 用户查询中引用的实体（如果有），例如:
    // { "type": "frame", "id": 456 }
    // { "type": "session", "id": 2 }
  ],
  "extractedParams": {
    // 可传递给 Skill 的参数（如果有），例如:
    // { "frame_id": 456, "session_id": 2 }
  }
}

## Follow-up 类型说明
- initial: 首次分析查询，没有历史上下文
- drill_down: 深入分析某个具体发现（如 "详细分析帧456"、"看一下 session 2"）
- clarify: 澄清或解释之前的发现（如 "什么是四象限分析"、"解释一下这个问题"）
- extend: 扩展分析范围（如 "还有哪些帧有类似问题"、"看看其他会话"）
- compare: 比较不同发现（如 "帧456和帧789有什么区别"）

## 实体提取规则
- 如果用户提到 "帧123"、"frame 123"、"第123帧"，提取为 { "type": "frame", "id": 123 }
- 如果用户提到 "会话2"、"session 2"、"第2个滑动会话"，提取为 { "type": "session", "id": 2 }
- 如果用户提到具体进程名如 "com.example.app"，提取为 { "type": "process", "id": "com.example.app" }
- 如果用户提到时间范围如 "从1.2秒到1.5秒"，提取为 { "type": "time_range", "value": { "start": "1.2s", "end": "1.5s" } }

## extractedParams 规则
- 将 referencedEntities 中的 id 转换为 skill 可用的参数
- frame 实体 → frame_id 参数
- session 实体 → session_id 参数
- process 实体 → process_name 参数`;
}

const DRILL_DOWN_PATTERNS = [
  /详细分析/, /看一下/, /分析[一下]?帧/, /分析[一下]?frame/,
  /frame\s*\d+/i, /帧\s*\d+/, /session\s*\d+/i, /会话\s*\d+/,
];

function buildFallbackIntent(query: string, isFollowUp: boolean | null): Intent {
  const isDrillDown = DRILL_DOWN_PATTERNS.some(p => p.test(query));

  const frameIdMatch = query.match(/(?:帧|frame)\s*(\d+)/i);
  const sessionIdMatch = query.match(/(?:会话|session)\s*(\d+)/i);

  const extractedParams: Record<string, any> = {};
  const referencedEntities: ReferencedEntity[] = [];

  if (frameIdMatch) {
    const id = parseInt(frameIdMatch[1], 10);
    extractedParams.frame_id = id;
    referencedEntities.push({ type: 'frame', id });
  }
  if (sessionIdMatch) {
    const id = parseInt(sessionIdMatch[1], 10);
    extractedParams.session_id = id;
    referencedEntities.push({ type: 'session', id });
  }

  return {
    primaryGoal: query,
    aspects: ['general'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: isDrillDown ? 'drill_down' : (isFollowUp ? 'extend' : 'initial'),
    referencedEntities: referencedEntities.length > 0 ? referencedEntities : undefined,
    extractedParams: Object.keys(extractedParams).length > 0 ? extractedParams : undefined,
  };
}

/**
 * Validate follow-up type value
 */
function isValidFollowUpType(type: string): boolean {
  return ['initial', 'drill_down', 'clarify', 'extend', 'compare'].includes(type);
}
