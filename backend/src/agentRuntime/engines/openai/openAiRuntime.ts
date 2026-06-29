// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import {
  Agent,
  MaxTurnsExceededError,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type AgentInputItem,
  type RunStreamEvent,
} from '@openai/agents';
import OpenAI from 'openai';

import type { TraceProcessorService } from '../../../services/traceProcessorService';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import { getSkillAnalysisAdapter } from '../../../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../../../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../../../agent/types/agentProtocol';
import type {
  AnalysisOptions,
  AnalysisResult,
  AnalysisTerminationReason,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
  MIN_PHASE_SUMMARY_CHARS,
} from '../../../agentv3/claudeMcpServer';
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../../../agentv3/claudeSystemPrompt';
import { loadPromptTemplate } from '../../../agentv3/strategyLoader';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { detectFocusApps } from '../../../agentv3/focusAppDetector';
import { classifyScene, type SceneType } from '../../../agentv3/sceneClassifier';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  ComplexityClassifierInput,
  Hypothesis,
  PlanPhase,
  TraceCompleteness,
  UncertaintyFlag,
} from '../../../agentv3/types';
import { expectedToolNames } from '../../../agentv3/types';
import {
  formatPlanEvidenceGap,
  recordPlanToolCall,
  type PlanEvidenceGap,
} from '../../../agentv3/planToolCallRecorder';
import {
  getAnalysisPlanCompletionStatus,
  hasAdequateClosedPhaseSummary as hasAdequateClosedPhaseSummaryWithMin,
  type AnalysisPlanCompletionStatus,
} from '../../../agentv3/planCompletionStatus';
import { isConclusionLikePlanPhase } from '../../../agentv3/planPhaseSemantics';
import { classifyQueryComplexityLocal } from '../../../agentv3/queryComplexityClassifier';
import { buildComplexityClassifierInput } from '../../../agentv3/queryComplexityContext';
import { classifyQueryWithOpenAILightModel } from './openAiComplexityClassifier';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {
  createOpenAISnapshotEngineState,
  getOpenAISnapshotEngineState,
  type SessionFieldsForSnapshot,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import {
  extractTraceFeatures,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../../../agentv3/analysisPatternMemory';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from '../../../agentv3/outputLanguage';
import {sanitizeCodeAwareText} from '../../../services/security/codeAwareOutputRegistry';
import { formatToolCallNarration } from '../../../agentv3/toolNarration';
import { loadOpenAIConfig, type OpenAIAgentConfig } from './openAiConfig';
import {
  createMimoReasoningContentFetch,
  shouldUseMimoReasoningContentCompat,
} from './mimoReasoningCompat';
import { createOpenAIToolsFromMcpDefinitions } from './openAiToolAdapter';
import {
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
  looksLikePhaseSummaryFallback,
} from '../../../services/finalResultQualityGate';
import { verifyConclusion } from '../claude/claudeVerifier';
import { assessFinalReportContractCompleteness } from '../../../services/finalReportContractGate';
import {
  SDK_SESSION_FRESHNESS_MS,
  buildEntityContext,
  buildQuickConversationContext,
  buildRuntimeSessionMapKey,
  captureSkillDisplayEntities,
  collectRecentFindings,
  createRuntimeSkillNotesBudget,
  getLruCacheEntry,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  isTruncationVerificationIssue,
  repairTruncatedFinalReport,
  setLruCacheEntry,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createAnalysisRunSpec,
  type AnalysisRunSpec,
} from '../../analysisRunSpec';
import type { RuntimeSelection } from '../../runtimeSelection';

interface OpenAISessionEntry {
  history?: AgentInputItem[];
  lastResponseId?: string;
  runState?: string;
  updatedAt: number;
}

interface RuntimeAbortHandle {
  abort(): void;
}

const OPENAI_SESSION_FRESHNESS_MS = SDK_SESSION_FRESHNESS_MS;
const OPENAI_MAX_PLAN_CONTINUATIONS = 3;
const OPENAI_MAX_FINAL_REPORT_CONTINUATIONS = 4;
const OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS = 8_000;

type PlanCompletionStatus = AnalysisPlanCompletionStatus;

function hasAdequateClosedPhaseSummary(phase: PlanPhase): boolean {
  return hasAdequateClosedPhaseSummaryWithMin(phase, MIN_PHASE_SUMMARY_CHARS);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function isAbortLikeError(error: unknown): boolean {
  const maybe = error as { name?: unknown; constructor?: { name?: string }; message?: unknown };
  const name = typeof maybe?.name === 'string' ? maybe.name : '';
  const constructorName = maybe?.constructor?.name || '';
  const message = typeof maybe?.message === 'string' ? maybe.message.toLowerCase() : '';
  return name === 'AbortError'
    || name === 'APIUserAbortError'
    || constructorName === 'APIUserAbortError'
    || message.includes('aborted')
    || message.includes('abort');
}

function isRecoverableOpenAIStreamTermination(error: unknown): boolean {
  const message = formatOpenAIError(error).trim().toLowerCase();
  if (!message) return false;
  return message === 'terminated'
    || message.includes('stream terminated')
    || message.includes('response terminated')
    || message.includes('connection terminated')
    || message.includes('socket hang up')
    || message.includes('econnreset');
}

function formatOpenAIError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function compactProviderErrorMessage(error: unknown): string {
  const message = formatOpenAIError(error).trim();
  if (!/<html[\s>]|<\/html>|<body[\s>]|<\/body>|<h1[\s>]/i.test(message)) {
    return message;
  }

  const status = message.match(/\b([45]\d{2})\b/)?.[1];
  const heading = message.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || message.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || 'Provider returned an HTML error page';
  const text = heading
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return status ? `provider HTTP ${status}: ${text}` : `provider error: ${text}`;
}

function isMissingOpenAIPreviousResponseError(error: unknown, previousResponseId?: string): boolean {
  if (!previousResponseId) return false;
  const message = formatOpenAIError(error);
  const mentionsPreviousResponse = /previous[_\s-]?response|previousResponseId|previous_response_id|lastResponseId/i.test(message);
  const mentionsResponse = /response/i.test(message);
  const mentionsId = message.includes(previousResponseId);
  const isMissing = /not found|no .*found|does not exist|could not find|missing|expired|gone|404/i.test(message);

  return isMissing && (mentionsPreviousResponse || (mentionsResponse && mentionsId));
}

function readCompletedStreamFinalOutput(
  stream: { finalOutput: unknown },
  state: { streamCompleted: boolean; completedByPlanIdle: boolean; timedOut: boolean },
): unknown | undefined {
  if (!state.streamCompleted || state.completedByPlanIdle || state.timedOut) {
    return undefined;
  }
  return stream.finalOutput;
}

function readPlanEligibleStreamFinalOutput(
  stream: { finalOutput: unknown },
  state: {
    streamCompleted: boolean;
    completedByPlanIdle: boolean;
    timedOut: boolean;
    quickMode: boolean;
    planComplete: boolean;
  },
): unknown | undefined {
  const finalOutput = readCompletedStreamFinalOutput(stream, state);
  if (finalOutput === undefined) return undefined;
  return state.quickMode || state.planComplete ? finalOutput : undefined;
}

function stripOpenAiReasoningArtifacts(text: string, options: { preserveWhitespace?: boolean } = {}): string {
  const stripped = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '');
  if (options.preserveWhitespace) return stripped;
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

interface OpenAiReasoningFilterState {
  insideThink: boolean;
  pendingTagPrefix: string;
}

function createOpenAiReasoningFilterState(): OpenAiReasoningFilterState {
  return {
    insideThink: false,
    pendingTagPrefix: '',
  };
}

function isReasoningTagPrefix(value: string): boolean {
  const lower = value.toLowerCase();
  return '<think>'.startsWith(lower) || '</think>'.startsWith(lower);
}

function filterOpenAiVisibleAnswerDelta(delta: string, state: OpenAiReasoningFilterState): string {
  const input = `${state.pendingTagPrefix}${delta}`;
  state.pendingTagPrefix = '';
  let output = '';
  let index = 0;

  while (index < input.length) {
    const remaining = input.slice(index);
    const lower = remaining.toLowerCase();
    if (lower.startsWith('<think>')) {
      state.insideThink = true;
      index += '<think>'.length;
      continue;
    }
    if (lower.startsWith('</think>')) {
      state.insideThink = false;
      index += '</think>'.length;
      continue;
    }
    if (remaining[0] === '<' && isReasoningTagPrefix(remaining)) {
      state.pendingTagPrefix = remaining;
      break;
    }
    if (!state.insideThink) {
      output += remaining[0];
    }
    index += 1;
  }

  return output;
}

function looksLikeProcessNarrationParagraph(paragraph: string): boolean {
  const compact = paragraph.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|首先[，,]?.*提交|调用\s*`?[\w-]+`?|记录关键发现|数据量充足|非常丰富的数据|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(compact)
    || /现在进入\s*Phase|Phase\s*\d+(?:\.\d+)?.*返回|关键概览|阶段状态更新|执行剩余阶段|继续执行剩余阶段|update_plan_phase|submit_plan|resolve_hypothesis|provider 未主动结束 stream|plan 未完成|plan 已完成/i.test(compact);
}

function hasReportMarkers(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,3}\s+\S/.test(text)
    || /(^|\n)\s{0,3}\*\*[^*\n]{2,80}\*\*/.test(text)
    || /(^|\n)\s{0,3}\|/.test(text);
}

function normalizeConclusionForComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isSameConclusionText(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeConclusionForComparison(a || '');
  const normalizedB = normalizeConclusionForComparison(b || '');
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

function cleanPlanSummaryForFinalReport(summary: string): string {
  return summary
    .trim()
    .replace(/^(?:完成综合结论输出|完整结构化报告已(?:输出|生成))[。:：\s]*/i, '')
    .replace(/^核心发现[：:\s]*/i, '')
    .replace(/^所有关键artifact已在Phase\s*\d+(?:\.\d+)?中获取完毕[：:。\s]*/i, '')
    .trim();
}

function isSubstantialReportText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200 || !hasDeliverableFinalReportHeading(trimmed)) return false;
  if (looksLikeProcessNarrationParagraph(trimmed)) return false;
  return !looksLikeProcessNarrationParagraph(trimmed.split(/\n{2,}/)[0] || '');
}

function isRicherReportCandidate(candidate: string, baseline: string): boolean {
  const candidateTrimmed = candidate.trim();
  const baselineTrimmed = baseline.trim();
  if (!isSubstantialReportText(candidateTrimmed)) return false;
  if (!baselineTrimmed || !isSubstantialReportText(baselineTrimmed)) return true;
  return candidateTrimmed.length > Math.max(200, baselineTrimmed.length * 1.25);
}

function selectOpenAiRecoveryAnswer(input: {
  runAnswer: string;
  accumulatedAnswer: string;
}): string {
  return input.runAnswer.trim() ? input.runAnswer : input.accumulatedAnswer;
}

function findEmbeddedFinalReportStart(text: string): number {
  const match = /#{1,3}\s*(?:[\w\u4e00-\u9fff` .:：_-]{0,40})?(?:分析报告|综合结论|最终结论|最终报告|Final Report|Analysis Report)(?=\s|$|[：:。.!！?\n])/i.exec(text);
  return match?.index ?? -1;
}

function looksLikeProcessNarrationPrefix(prefix: string): boolean {
  const compact = prefix.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /(?:我需要|我将|我会|让我|接下来|下一步|根据\s*Phase|Phase\s*\d+(?:\.\d+)?\s*要求|更新计划|执行深钻|提交分析计划|调用\s*`?[\w-]+`?|update_plan_phase|submit_plan|plan\s*(?:未完成|已完成|phase))/i
    .test(compact);
}

function sanitizeOpenAiConclusionText(
  conclusion: string,
  options: {
    completedByPlanIdle?: boolean;
    planComplete?: boolean;
    fallbackConclusion?: string;
  } = {},
): string {
  const trimmed = stripOpenAiReasoningArtifacts(conclusion);
  const fallback = options.fallbackConclusion
    ? stripOpenAiReasoningArtifacts(options.fallbackConclusion)
    : undefined;
  if (!trimmed) return fallback || '';

  const embeddedReportStart = findEmbeddedFinalReportStart(trimmed);
  if (embeddedReportStart > 0) {
    const prefix = trimmed.slice(0, embeddedReportStart);
    const report = trimmed.slice(embeddedReportStart).trim();
    if (
      report.length >= 80 &&
      hasReportMarkers(report) &&
      looksLikeProcessNarrationPrefix(prefix)
    ) {
      return report;
    }
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  let firstReportParagraph = 0;
  while (
    firstReportParagraph < paragraphs.length &&
    looksLikeProcessNarrationParagraph(paragraphs[firstReportParagraph])
  ) {
    firstReportParagraph++;
  }

  const stripped = firstReportParagraph > 0
    ? paragraphs.slice(firstReportParagraph).join('\n\n').trim()
    : trimmed;
  const strippedStillProcess = looksLikeProcessNarrationParagraph(stripped.split(/\n{2,}/)[0] || '');
  const strippedHasProcessNarration = looksLikeProcessNarrationParagraph(stripped);
  if (firstReportParagraph > 0 && stripped.length >= 80 && !strippedStillProcess && !strippedHasProcessNarration) {
    return stripped;
  }

  if (
    fallback &&
    (options.completedByPlanIdle || options.planComplete) &&
    (firstReportParagraph > 0 || strippedStillProcess || strippedHasProcessNarration || !hasReportMarkers(trimmed))
  ) {
    return fallback;
  }

  return trimmed;
}

function chooseOpenAiConclusionText(input: {
  candidate: string;
  accumulatedAnswer: string;
  completedByPlanIdle?: boolean;
  planComplete?: boolean;
  fallbackConclusion?: string;
}): string {
  const selected = sanitizeOpenAiConclusionText(input.candidate, {
    completedByPlanIdle: input.completedByPlanIdle,
    planComplete: input.planComplete,
    fallbackConclusion: input.fallbackConclusion,
  });
  const fallback = input.fallbackConclusion?.trim();
  const accumulated = input.accumulatedAnswer.trim();
  const selectedIsFallback = fallback ? isSameConclusionText(selected, fallback) : false;
  const selectedNeedsRecovery =
    selectedIsFallback ||
    looksLikePhaseSummaryFallback(selected) ||
    !isSubstantialReportText(selected) ||
    looksLikeProcessNarrationParagraph(selected.split(/\n{2,}/)[0] || '');
  const mayRecoverAccumulated =
    accumulated.length > 0 &&
    !isSameConclusionText(accumulated, input.candidate) &&
    (input.completedByPlanIdle || (input.planComplete && selectedNeedsRecovery));
  if (!mayRecoverAccumulated) return selected;

  const recovered = sanitizeOpenAiConclusionText(accumulated, {
    completedByPlanIdle: input.completedByPlanIdle,
    planComplete: input.planComplete,
    fallbackConclusion: input.fallbackConclusion,
  });

  if (isRicherReportCandidate(recovered, selected)) {
    return recovered;
  }
  if (hasDeliverableFinalReportHeading(recovered) && recovered.length > Math.max(200, selected.length * 1.25)) {
    return recovered;
  }
  if (fallback && selectedIsFallback && hasDeliverableFinalReportHeading(recovered) && recovered.length > selected.length) {
    return recovered;
  }
  return selected;
}

interface OpenAIRunInputResolution {
  input: string | AgentInputItem[];
  effectivePrompt: string;
  previousResponseId?: string;
  shouldPersistRemoteSession: boolean;
}

function resolveOpenAIRunInput(params: {
  quickMode: boolean;
  config: OpenAIAgentConfig;
  sessionEntry?: OpenAISessionEntry;
  effectivePrompt: string;
  previousTurns: any[];
  now?: number;
}): OpenAIRunInputResolution {
  let effectivePrompt = params.effectivePrompt;
  if (params.quickMode) {
    const quickConversationContext = buildQuickConversationContext(
      params.previousTurns,
      params.config.outputLanguage,
    );
    if (quickConversationContext) {
      effectivePrompt = `${quickConversationContext}\n\n${effectivePrompt}`;
    }
    return {
      input: effectivePrompt,
      effectivePrompt,
      shouldPersistRemoteSession: false,
    };
  }

  const hasFreshSessionEntry = isFreshRuntimeEntry(
    params.sessionEntry,
    OPENAI_SESSION_FRESHNESS_MS,
    params.now ?? Date.now(),
  );
  const freshSessionEntry = hasFreshSessionEntry ? params.sessionEntry : undefined;
  const usePreviousResponse = params.config.protocol === 'responses'
    && !!freshSessionEntry?.lastResponseId;
  if (usePreviousResponse) {
    return {
      input: effectivePrompt,
      effectivePrompt,
      previousResponseId: freshSessionEntry.lastResponseId,
      shouldPersistRemoteSession: true,
    };
  }

  if (freshSessionEntry?.history) {
    return {
      input: [
        ...freshSessionEntry.history,
        { role: 'user', content: effectivePrompt } as AgentInputItem,
      ],
      effectivePrompt,
      shouldPersistRemoteSession: true,
    };
  }

  return {
    input: effectivePrompt,
    effectivePrompt,
    shouldPersistRemoteSession: true,
  };
}

export const __testing = {
  isMissingOpenAIPreviousResponseError,
  readCompletedStreamFinalOutput,
  readPlanEligibleStreamFinalOutput,
  stripOpenAiReasoningArtifacts,
  createOpenAiReasoningFilterState,
  filterOpenAiVisibleAnswerDelta,
  sanitizeOpenAiConclusionText,
  chooseOpenAiConclusionText,
  selectOpenAiRecoveryAnswer,
  resolveOpenAIRunInput,
  isRecoverableOpenAIStreamTermination,
  compactProviderErrorMessage,
};

export class OpenAIRuntime extends EventEmitter implements IOrchestrator {
  private readonly traceProcessorService: TraceProcessorService;
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly vendorCache = new Map<string, string>();
  private readonly completenessCache = new Map<string, TraceCompleteness>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionSqlErrors = new Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number; fixedSql?: string }>>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly sessionMap = new Map<string, OpenAISessionEntry>();
  private readonly activeAnalyses = new Set<string>();
  private readonly activeAbortHandles = new Map<string, Set<RuntimeAbortHandle>>();

  private readonly runtimeSelection: RuntimeSelection;

  constructor(
    traceProcessorService: TraceProcessorService,
    runtimeSelection: RuntimeSelection = { kind: 'openai-agents-sdk', source: 'default' },
  ) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.runtimeSelection = runtimeSelection;
  }

  private buildSessionMapKey(sessionId: string, referenceTraceId?: string): string {
    return buildRuntimeSessionMapKey(sessionId, referenceTraceId);
  }

  getSdkSessionId(sessionId: string, referenceTraceId?: string): string | undefined {
    const entry = this.sessionMap.get(this.buildSessionMapKey(sessionId, referenceTraceId));
    return isFreshRuntimeEntry(entry, OPENAI_SESSION_FRESHNESS_MS)
      ? entry.lastResponseId
      : undefined;
  }

  restoreSessionMapping(sessionId: string, sdkSessionId: string, referenceTraceId?: string): void {
    const sessionMapKey = this.buildSessionMapKey(sessionId, referenceTraceId);
    const existing = this.sessionMap.get(sessionMapKey);
    this.sessionMap.set(sessionMapKey, {
      ...existing,
      lastResponseId: sdkSessionId,
      updatedAt: Date.now(),
    });
  }

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  private forgetOpenAILastResponseId(sessionMapKey: string, reason: string): void {
    const existing = this.sessionMap.get(sessionMapKey);
    if (existing) {
      this.sessionMap.set(sessionMapKey, {
        ...existing,
        lastResponseId: undefined,
        runState: undefined,
        updatedAt: Date.now(),
      });
    }
    console.warn(
      `[OpenAIRuntime] Discarded stale previousResponseId for ${sessionMapKey}` +
      `${existing ? '' : ' (not present in memory)'}: ${reason}`,
    );
  }

  private async retryWithoutPreviousResponse(params: {
    query: string;
    sessionId: string;
    traceId: string;
    options: AnalysisOptions;
    sessionMapKey: string;
    errorMessage: string;
    outputLanguage: OutputLanguage;
  }): Promise<AnalysisResult> {
    this.forgetOpenAILastResponseId(params.sessionMapKey, params.errorMessage);
    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'fresh_openai_run_after_missing_previous_response',
        error: 'missing_previous_response',
        message: localize(
          params.outputLanguage,
          'OpenAI 远端 previous response 已不可用，已清理旧 response id 并使用本地持久化上下文重新发起分析...',
          'OpenAI previous response is no longer available. Retrying with persisted local context without previousResponseId...',
        ),
      },
      timestamp: Date.now(),
    });
    this.activeAnalyses.delete(params.sessionId);
    return this.analyze(params.query, params.sessionId, params.traceId, params.options);
  }

  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
  }

  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    if (this.activeAnalyses.has(sessionId)) {
      throw new Error(`Analysis already in progress for session ${sessionId}`);
    }
    this.activeAnalyses.add(sessionId);

    const startTime = Date.now();
    let accumulatedAnswer = '';
    let rounds = 0;
    const config = loadOpenAIConfig(options.providerId, providerScopeFromAnalysisOptions(options));
    const sceneType = classifyScene(query);
    const quickMode = await this.classifyModeForRequest(query, sessionId, traceId, options, sceneType, config);
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    const analysisRunSpec = createAnalysisRunSpec({
      query,
      sessionId,
      traceId,
      options,
      runtimeSelection: this.runtimeSelection,
      sceneType,
      outputLanguage: config.outputLanguage,
      previousTurns,
      resolvedMode: quickMode ? 'quick' : 'full',
      budget: {
        model: config.model,
        lightModel: config.lightModel,
        maxTurns: config.maxTurns,
        quickMaxTurns: config.quickMaxTurns,
        maxOutputTokens: config.maxOutputTokens,
        fullPathPerTurnMs: config.fullPathPerTurnMs,
        quickPathPerTurnMs: config.quickPathPerTurnMs,
        classifierTimeoutMs: config.classifierTimeoutMs,
      },
    });

    try {
      const context = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        config,
        sceneType,
        lightweight: quickMode,
        analysisRunSpec,
        sessionContext,
        previousTurns,
      });

      const promptPrefix = analysisRunSpec.traceContext.promptSection;
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n${query}` : query;
      const sessionEntry = this.sessionMap.get(context.sessionMapKey);
      const runInput = resolveOpenAIRunInput({
        quickMode,
        config,
        sessionEntry,
        effectivePrompt,
        previousTurns: context.previousTurns,
      });
      const input = runInput.input;

      setTracingDisabled(true);
      const provider = shouldUseMimoReasoningContentCompat(config)
        ? new OpenAIProvider({
            openAIClient: new OpenAI({
              apiKey: config.apiKey,
              baseURL: config.baseURL,
              fetch: createMimoReasoningContentFetch() as any,
            }),
            useResponses: false,
          })
        : new OpenAIProvider({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            useResponses: config.protocol === 'responses',
          });
      const runner = new Runner({
        modelProvider: provider,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
        workflowName: 'SmartPerfetto Analysis',
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const agent = new Agent({
        name: 'SmartPerfetto',
        instructions: context.systemPrompt,
        model: quickMode ? config.lightModel : config.model,
        tools: context.tools,
        toolUseBehavior: 'run_llm_again',
        modelSettings: {
          maxTokens: config.maxOutputTokens,
          parallelToolCalls: false,
        },
      });

      let activeController: AbortController | undefined;
      const timeoutMs = (quickMode ? config.quickPathPerTurnMs : config.fullPathPerTurnMs)
        * (quickMode ? config.quickMaxTurns : config.maxTurns);
      const deadlineAt = Date.now() + timeoutMs;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        activeController?.abort();
      }, timeoutMs);

      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'answering',
          message: localize(
            config.outputLanguage,
            `AI 分析引擎分析中 (${agent.model})...`,
            `AI analysis engine is running (${agent.model})...`,
          ),
          runtime: 'openai-agents-sdk',
          model: agent.model,
        },
        timestamp: Date.now(),
      });

      let currentPreviousResponseId = runInput.previousResponseId;
      try {
        let currentInput: string | AgentInputItem[] = input;
        let conclusion = '';
        let finalHistory: AgentInputItem[] | undefined;
        let finalLastResponseId: string | undefined;
        let finalRunState: string | undefined;
        let partial = false;
        let terminationReason: AnalysisTerminationReason | undefined;
        let terminationMessage: string | undefined;
        let finalReportContinuations = 0;
        const toolInputsByTaskId = new Map<string, { toolName: string; args: Record<string, unknown> }>();
        const markTimeoutPartial = (planStatus: PlanCompletionStatus) => {
          partial = true;
          terminationReason = 'timeout';
          terminationMessage = localize(
            config.outputLanguage,
            `OpenAI 分析超过 ${Math.round(timeoutMs / 1000)} 秒超时，结果可能不完整。`,
            `OpenAI analysis timed out after ${Math.round(timeoutMs / 1000)} seconds; the result may be incomplete.`,
          );
          conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'partial_result_after_timeout',
              partial: true,
              terminationReason,
              message: terminationMessage,
            },
            timestamp: Date.now(),
          });
        };

        for (let continuation = 0; ; continuation++) {
          if (timedOut || Date.now() >= deadlineAt) {
            timedOut = true;
            markTimeoutPartial(this.getPlanCompletionStatus(sessionId, quickMode));
            break;
          }
          const controller = new AbortController();
          activeController = controller;
          const unregisterAbortHandle = this.registerAbortHandle(sessionId, {
            abort: () => controller.abort(),
          });
          let runAnswer = '';
          let runTurns = 0;
          let completedByPlanIdle = false;
          const answerStreamFilter = createOpenAiReasoningFilterState();
          let planCompleteIdleTimer: ReturnType<typeof setTimeout> | undefined;
          const clearPlanCompleteIdleTimer = () => {
            if (planCompleteIdleTimer) {
              clearTimeout(planCompleteIdleTimer);
              planCompleteIdleTimer = undefined;
            }
          };
          const schedulePlanCompleteIdleAbort = () => {
            clearPlanCompleteIdleTimer();
            if (!this.shouldFinalizeAfterPlanComplete(sessionId, quickMode, runAnswer, accumulatedAnswer)) {
              return;
            }
            planCompleteIdleTimer = setTimeout(() => {
              completedByPlanIdle = true;
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'concluding',
                    message: localize(
                      config.outputLanguage,
                      '分析阶段已完成，正在整理最终报告。',
                      'Analysis phases are complete; preparing the final report.',
                    ),
                  },
                  timestamp: Date.now(),
                });
              controller.abort();
            }, OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS);
          };
          const stream = await runner.run(agent, currentInput, {
            stream: true,
            maxTurns: quickMode ? config.quickMaxTurns : config.maxTurns,
            context: { signal: controller.signal },
            signal: controller.signal,
            ...(currentPreviousResponseId
              ? { previousResponseId: currentPreviousResponseId }
              : {}),
          });

          let streamCompleted = false;
          try {
            try {
              for await (const event of stream) {
                clearPlanCompleteIdleTimer();
                runTurns = stream.currentTurn || runTurns;
                const delta = this.handleStreamEvent(event, config.outputLanguage, {
                  sessionId,
                  quickMode,
                  answerStreamFilter,
                  toolInputsByTaskId,
                });
                if (delta) {
                  runAnswer += delta;
                  accumulatedAnswer += delta;
                }
                schedulePlanCompleteIdleAbort();
              }
              clearPlanCompleteIdleTimer();
              await stream.completed;
              streamCompleted = true;
            } catch (error) {
              if (!(isAbortLikeError(error) && (completedByPlanIdle || timedOut))) {
                throw error;
              }
            }
          } finally {
            clearPlanCompleteIdleTimer();
            if (activeController === controller) {
              activeController = undefined;
            }
            unregisterAbortHandle();
          }

          rounds += runTurns || stream.currentTurn || 0;
          const planStatus = this.getPlanCompletionStatus(sessionId, quickMode);
          const streamFinalOutput = readPlanEligibleStreamFinalOutput(stream, {
            streamCompleted,
            completedByPlanIdle,
            timedOut,
            quickMode,
            planComplete: planStatus.complete,
          });
          const finalOutput = typeof streamFinalOutput === 'string'
            ? streamFinalOutput
            : (streamFinalOutput ? JSON.stringify(streamFinalOutput) : runAnswer);
          const fallbackConclusion = this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, config.outputLanguage);
          const recoveryAnswer = selectOpenAiRecoveryAnswer({ runAnswer, accumulatedAnswer });
          conclusion = chooseOpenAiConclusionText({
            candidate: finalOutput ||
              runAnswer ||
              accumulatedAnswer ||
              fallbackConclusion ||
              '',
            accumulatedAnswer: recoveryAnswer,
            completedByPlanIdle,
            planComplete: planStatus.complete,
            fallbackConclusion,
          });
          if (streamCompleted) {
            finalHistory = stream.history;
            finalLastResponseId = stream.lastResponseId;
            finalRunState = this.safeSerializeRunState(stream.state);
          }

          if (timedOut && !completedByPlanIdle) {
            markTimeoutPartial(planStatus);
            break;
          }
          if (planStatus.complete) {
            const streamHistory = Array.isArray(stream.history)
              ? stream.history as AgentInputItem[]
              : [];
            if (this.shouldRequestFinalReportAfterPlanComplete({
              quickMode,
              planStatus,
              conclusion,
              fallbackConclusion,
              completedByPlanIdle,
              timedOut,
              finalReportContinuations,
              query,
              sceneType,
            }) && streamHistory.length > 0) {
              finalReportContinuations++;
              this.emitUpdate({
                type: 'progress',
                content: {
                  phase: 'concluding',
                  message: this.formatPlanCompleteReportContinuationMessage(config.outputLanguage),
                },
                timestamp: Date.now(),
              });
              currentInput = [
                ...streamHistory,
                {
                  role: 'user',
                  content: this.buildFinalReportAfterPlanCompletePrompt(config.outputLanguage),
                } as AgentInputItem,
              ];
              currentPreviousResponseId = undefined;
              continue;
            }
            break;
          }

          if (continuation >= OPENAI_MAX_PLAN_CONTINUATIONS) {
            partial = true;
            terminationReason = 'plan_incomplete';
            terminationMessage = this.formatIncompletePlanMessage(planStatus, config.outputLanguage);
            conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'partial_result_after_incomplete_plan',
                partial: true,
                terminationReason,
                message: terminationMessage,
              },
              timestamp: Date.now(),
            });
            break;
          }

          this.emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: this.formatPlanContinuationMessage(planStatus, config.outputLanguage),
            },
            timestamp: Date.now(),
          });
          currentInput = [
            ...(stream.history as AgentInputItem[]),
            {
              role: 'user',
              content: this.buildPlanContinuationPrompt(planStatus, config.outputLanguage),
            } as AgentInputItem,
          ];
          currentPreviousResponseId = undefined;
        }

        clearTimeout(timeout);
        if (options.codeAwareMode && options.codeAwareMode !== 'off') {
          conclusion = sanitizeCodeAwareText(sessionId, conclusion);
        }
        const finalFallbackConclusion = this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, config.outputLanguage);
        if (
          finalFallbackConclusion &&
          (isSameConclusionText(conclusion, finalFallbackConclusion) ||
            looksLikePhaseSummaryFallback(conclusion)) &&
          !partial
        ) {
          partial = true;
            terminationMessage = localize(
              config.outputLanguage,
              '分析阶段已完成，但模型没有输出独立最终报告；已使用阶段摘要兜底，结果信息密度可能不足。',
              'Analysis phases completed, but the model did not produce an independent final report; falling back to phase summaries, which may be less informative.',
            );
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'completed_plan_summary_fallback',
              partial: true,
              message: terminationMessage,
            },
            timestamp: Date.now(),
          });
        }
        let findings = extractFindingsFromText(conclusion);
        let confidence = partial
          ? Math.min(0.55, this.estimateConfidence(findings, conclusion))
          : this.estimateConfidence(findings, conclusion);
        const result: AnalysisResult = {
          sessionId,
          success: true,
          findings,
          hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
          conclusion,
          confidence,
          rounds,
          totalDurationMs: Date.now() - startTime,
          partial: partial || undefined,
          terminationReason,
          terminationMessage,
        };
        if (!quickMode) {
          const verifyCurrentConclusion = async () => verifyConclusion(result.findings, result.conclusion, {
            emitUpdate: (update) => this.emitUpdate(update),
            enableLLM: false,
            plan: this.sessionPlans.get(sessionId)?.current ?? null,
            hypotheses: context.hypotheses,
            sceneType,
            outputLanguage: config.outputLanguage,
            query,
            emitIssueProgress: false,
          });
          let verification = await verifyCurrentConclusion();
          let verificationIssue = [
            ...verification.heuristicIssues,
            ...(verification.llmIssues || []),
          ].find(issue => issue.severity === 'error');
          if (
            verificationIssue &&
            isTruncationVerificationIssue(verificationIssue) &&
            this.getPlanCompletionStatus(sessionId, quickMode).complete
          ) {
            const repairedConclusion = repairTruncatedFinalReport({
              conclusion: result.conclusion,
              plan: this.sessionPlans.get(sessionId)?.current ?? null,
              hypotheses: context.hypotheses,
              outputLanguage: config.outputLanguage,
            });
            if (repairedConclusion) {
              result.conclusion = repairedConclusion;
              result.findings = extractFindingsFromText(repairedConclusion);
              result.confidence = this.estimateConfidence(result.findings, repairedConclusion);
              this.emitUpdate({
                type: 'progress',
                content: {
                  phase: 'concluding',
                  message: localize(
                    config.outputLanguage,
                    '最终报告输出被截断，已基于结构化证据补齐收尾并重新验证。',
                    'The final report output was truncated; it was closed from structured evidence and re-verified.',
                  ),
                },
                timestamp: Date.now(),
              });
              verification = await verifyCurrentConclusion();
              verificationIssue = [
                ...verification.heuristicIssues,
                ...(verification.llmIssues || []),
              ].find(issue => issue.severity === 'error');
            }
          }
          if (verificationIssue) {
            result.partial = true;
            result.terminationReason = result.terminationReason ?? 'plan_incomplete';
            result.terminationMessage = result.terminationMessage ?? verificationIssue.message;
            result.confidence = Math.min(0.55, result.confidence);
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'verification_failed',
                partial: true,
                terminationReason: result.terminationReason,
                message: verificationIssue.message,
              },
              timestamp: Date.now(),
            });
          }
        }
        const gateIssue = applyFinalResultQualityGate({ result, query, sceneType });
        if (gateIssue) {
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: gateIssue.code,
              partial: true,
              message: gateIssue.message,
            },
            timestamp: Date.now(),
          });
        }

        if (runInput.shouldPersistRemoteSession) {
          this.sessionMap.set(context.sessionMapKey, {
            history: finalHistory,
            lastResponseId: finalLastResponseId,
            runState: finalRunState,
            updatedAt: Date.now(),
          });
        }

        this.recordTurn({
          query,
          sessionId,
          result,
          sessionContext: context.sessionContext,
          previousTurnCount: context.previousTurns.length,
          quickMode,
        });

        this.emitUpdate({
          type: 'conclusion',
          content: { conclusion: result.conclusion, durationMs: Date.now() - startTime, turns: rounds },
          timestamp: Date.now(),
        });
        this.emitUpdate({
          type: 'answer_token',
          content: { done: true, totalChars: result.conclusion.length },
          timestamp: Date.now(),
        });

        await provider.close().catch(() => undefined);

        return result;
      } catch (error) {
        clearTimeout(timeout);
        await provider.close().catch(() => undefined);
        if (currentPreviousResponseId && isMissingOpenAIPreviousResponseError(error, currentPreviousResponseId)) {
          return await this.retryWithoutPreviousResponse({
            query,
            sessionId,
            traceId,
            options,
            sessionMapKey: context.sessionMapKey,
            errorMessage: formatOpenAIError(error),
            outputLanguage: config.outputLanguage,
          });
        } else if (error instanceof MaxTurnsExceededError) {
          return this.recordMaxTurnsPartialResult({
            error,
            query,
            sessionId,
            outputLanguage: config.outputLanguage,
            accumulatedAnswer,
            context,
            startTime,
            rounds,
            quickMode,
            maxTurns: quickMode ? config.quickMaxTurns : config.maxTurns,
            codeAwareMode: options.codeAwareMode,
          });
        }
        const recoverablePartial = this.recoverPartialResultAfterStreamTermination({
          error,
          sessionId,
          quickMode,
          outputLanguage: config.outputLanguage,
          accumulatedAnswer,
          context,
          query,
          startTime,
          rounds,
          codeAwareMode: options.codeAwareMode,
        });
        if (recoverablePartial) {
          return recoverablePartial;
        }
        throw error;
      }
    } catch (error) {
      const message = compactProviderErrorMessage(error);
      this.emitUpdate({
        type: 'error',
        content: { message: `AI analysis failed: ${message}` },
        timestamp: Date.now(),
      });
      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: localize(
          config.outputLanguage,
          `AI 分析失败：${message}`,
          `AI analysis failed: ${message}`,
        ),
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
        terminationReason: 'execution_error',
        terminationMessage: message,
      };
    } finally {
      this.activeAnalyses.delete(sessionId);
    }
  }

  reset(): void {
    this.abortAllSessions();
    this.architectureCache.clear();
    this.vendorCache.clear();
    this.completenessCache.clear();
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.sessionMap.clear();
    this.activeAnalyses.clear();
  }

  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
    this.sessionMap.delete(sessionId);
    for (const key of Array.from(this.sessionMap.keys())) {
      if (key.startsWith(`${sessionId}:ref:`)) this.sessionMap.delete(key);
    }
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
  }

  abortSession(sessionId: string): void {
    const handles = this.activeAbortHandles.get(sessionId);
    if (!handles) return;
    for (const handle of Array.from(handles)) {
      try {
        handle.abort();
      } catch (error) {
        console.warn('[OpenAIRuntime] Failed to abort SDK handle:', (error as Error).message);
      }
    }
  }

  private registerAbortHandle(sessionId: string, handle: RuntimeAbortHandle): () => void {
    let handles = this.activeAbortHandles.get(sessionId);
    if (!handles) {
      handles = new Set();
      this.activeAbortHandles.set(sessionId, handles);
    }
    handles.add(handle);
    return () => {
      const current = this.activeAbortHandles.get(sessionId);
      if (!current) return;
      current.delete(handle);
      if (current.size === 0) this.activeAbortHandles.delete(sessionId);
    };
  }

  private abortAllSessions(): void {
    for (const sessionId of Array.from(this.activeAbortHandles.keys())) {
      this.abortSession(sessionId);
    }
    this.activeAbortHandles.clear();
  }

  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const sessionEntry = this.sessionMap.get(
      this.buildSessionMapKey(sessionId, sessionFields.referenceTraceId),
    );
    const freshSessionEntry = isFreshRuntimeEntry(sessionEntry, OPENAI_SESSION_FRESHNESS_MS)
      ? sessionEntry
      : undefined;
    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...sessionFields,
      analysisNotes: this.sessionNotes.get(sessionId) || [],
      analysisPlan: planState?.current ?? null,
      planHistory: planState?.history ?? [],
      uncertaintyFlags: this.sessionUncertaintyFlags.get(sessionId) || [],
      claudeHypotheses: this.sessionHypotheses.get(sessionId) || undefined,
      architecture: this.architectureCache.get(traceId),
      engineState: createOpenAISnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        history: freshSessionEntry?.history,
        lastResponseId: freshSessionEntry?.lastResponseId,
        runState: freshSessionEntry?.runState,
      }),
      sdkSessionId: freshSessionEntry?.lastResponseId,
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      openAIHistory: freshSessionEntry?.history,
      openAILastResponseId: freshSessionEntry?.lastResponseId,
      openAIRunState: freshSessionEntry?.runState,
      artifacts: artifactStore?.serialize(),
    };
  }

  restoreFromSnapshot(sessionId: string, traceId: string, snapshot: SessionStateSnapshot): void {
    if (snapshot.analysisNotes.length > 0) {
      this.sessionNotes.set(sessionId, [...snapshot.analysisNotes]);
    }
    if (snapshot.analysisPlan || snapshot.planHistory.length > 0) {
      this.sessionPlans.set(sessionId, {
        current: snapshot.analysisPlan,
        history: snapshot.planHistory,
      });
    }
    if (snapshot.claudeHypotheses && snapshot.claudeHypotheses.length > 0) {
      this.sessionHypotheses.set(sessionId, [...snapshot.claudeHypotheses]);
    }
    if (snapshot.uncertaintyFlags.length > 0) {
      this.sessionUncertaintyFlags.set(sessionId, [...snapshot.uncertaintyFlags]);
    }
    if (snapshot.artifacts && snapshot.artifacts.length > 0) {
      this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
    }
    if (snapshot.architecture) {
      this.architectureCache.set(traceId, snapshot.architecture);
    }
    const openAIEngineState = getOpenAISnapshotEngineState(snapshot);
    if (openAIEngineState?.history || openAIEngineState?.lastResponseId || openAIEngineState?.runState) {
      this.sessionMap.set(this.buildSessionMapKey(sessionId, snapshot.referenceTraceId), {
        history: openAIEngineState.history as AgentInputItem[] | undefined,
        lastResponseId: openAIEngineState.lastResponseId,
        runState: openAIEngineState.runState,
        updatedAt: snapshot.snapshotTimestamp || Date.now(),
      });
    }
  }

  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    runtime: {
      config: OpenAIAgentConfig;
      sceneType: SceneType;
      lightweight: boolean;
      analysisRunSpec: AnalysisRunSpec;
      sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns: any[];
    },
  ) {
    const { config, sceneType, lightweight, analysisRunSpec } = runtime;
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    let effectivePackageName = options.packageName;
    const focusResult = await detectFocusApps(this.traceProcessorService, traceId);
    if (!effectivePackageName && focusResult.primaryApp) {
      effectivePackageName = focusResult.primaryApp;
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            config.outputLanguage,
            `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})`,
            `Detected focus app: ${focusResult.primaryApp} (${focusResult.method})`,
          ),
        },
        timestamp: Date.now(),
      });
    }

    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    await ensureSkillRegistryInitialized();
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    const architecture = await this.detectArchitecture(traceId, effectivePackageName);
    const detectedVendor = await this.detectVendor(traceId);
    const traceCompleteness = await this.detectCompleteness(traceId, architecture);
    const comparisonContext = options.referenceTraceId
      ? await this.buildComparisonContext(traceId, options.referenceTraceId, config.outputLanguage)
      : undefined;

    const sessionContext = runtime.sessionContext;
    const previousTurns = runtime.previousTurns;
    const previousFindings = this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0
      ? sessionContext.generatePromptContext(2000)
      : undefined;
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);

    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;

    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    const previousPlan = analysisPlan.current ?? undefined;
    analysisPlan.current = null;

    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    hypotheses.splice(0);

    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0);

    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope);
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    const skillNotesBudget = createRuntimeSkillNotesBudget(lightweight);
    const { allowedTools, toolDefinitions } = createClaudeMcpServer({
      sessionId,
      traceId,
      userQuery: query,
      traceProcessorService: this.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      emitUpdate: (update) => this.emitUpdate(update),
      onSkillResult: (result) => {
        if (result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      cachedVendor: detectedVendor,
      recentSqlErrors: sqlErrors,
      analysisPlan: lightweight ? undefined : analysisPlan,
      watchdogWarning: { current: null },
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId: options.referenceTraceId,
      comparisonContext,
      lightweight,
      skillNotesBudget,
      outputLanguage: config.outputLanguage,
      knowledgeScope,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
    });

    const tools = createOpenAIToolsFromMcpDefinitions(toolDefinitions);

    let knowledgeBaseContext: string | undefined;
    try {
      const kb = await getExtendedKnowledgeBase();
      knowledgeBaseContext = kb.getContextForAI(query, 8);
    } catch {
      // Optional context only.
    }

    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));
    const traceInfo = this.traceProcessorService.getTrace(traceId);

    const systemPrompt = lightweight
      ? buildQuickSystemPrompt({
          architecture,
          packageName: effectivePackageName,
          focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
          focusMethod: focusResult.method,
          selectionContext: options.selectionContext,
          outputLanguage: config.outputLanguage,
        })
      : buildSystemPrompt({
          query,
          architecture,
          packageName: effectivePackageName,
          focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
          focusMethod: focusResult.method,
          previousFindings,
          conversationSummary,
          knowledgeBaseContext,
          entityContext,
          sceneType,
          analysisNotes: notes.length > 0 ? notes : undefined,
          availableAgents: undefined,
          sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
          patternContext: buildPatternContextSection(traceFeatures),
          negativePatternContext: buildNegativePatternSection(traceFeatures),
          previousPlan,
          planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
          selectionContext: options.selectionContext,
          comparison: comparisonContext,
          traceCompleteness,
          traceOs: traceInfo?.traceOs,
          traceFormat: traceInfo?.traceFormat,
          outputLanguage: config.outputLanguage,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        } satisfies ClaudeAnalysisContext);

    const sessionMapKey = analysisRunSpec.identity.sessionMapKey;

    return {
      systemPrompt,
      tools,
      sessionContext,
      previousTurns,
      architecture,
      hypotheses,
      allowedTools,
      sessionMapKey,
    };
  }

  private async detectArchitecture(
    traceId: string,
    packageName?: string,
  ): Promise<ArchitectureInfo | undefined> {
    const cached = getLruCacheEntry(this.architectureCache, traceId);
    if (cached) return cached;
    try {
      const detector = createArchitectureDetector();
      const architecture = await detector.detect({
        traceId,
        traceProcessorService: this.traceProcessorService,
        packageName,
      });
      if (architecture) {
        setLruCacheEntry(this.architectureCache, traceId, architecture);
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      }
      return architecture;
    } catch (error) {
      console.warn('[OpenAIRuntime] Architecture detection failed:', (error as Error).message);
      return undefined;
    }
  }

  private async buildComparisonContext(
    traceId: string,
    referenceTraceId: string,
    outputLanguage: OutputLanguage,
  ): Promise<import('../../../agentv3/types').ComparisonContext> {
    this.emitUpdate({
      type: 'progress',
      content: {
        phase: 'starting',
        message: localize(
          outputLanguage,
          '对比模式：正在检测参考 Trace...',
          'Comparison mode: detecting the reference trace...',
        ),
      },
      timestamp: Date.now(),
    });

    const capSql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE 'android_%' OR name LIKE 'linux_%' OR name LIKE 'sched_%' OR name LIKE 'slices_%')";
    const [refFocusResult, refArchitecture, currentTables, refTables] = await Promise.all([
      detectFocusApps(this.traceProcessorService, referenceTraceId).catch(() => ({
        apps: [],
        method: 'none' as const,
        primaryApp: undefined,
      })),
      this.detectArchitecture(referenceTraceId, undefined).catch(() => undefined),
      this.traceProcessorService.query(traceId, capSql).catch((error) => {
        console.warn('[OpenAIRuntime] Capability query failed for current trace:', error.message);
        return null;
      }),
      this.traceProcessorService.query(referenceTraceId, capSql).catch((error) => {
        console.warn('[OpenAIRuntime] Capability query failed for reference trace:', error.message);
        return null;
      }),
    ]);

    let commonCapabilities: string[] = [];
    let capabilityDiff: { currentOnly: string[]; referenceOnly: string[] } | undefined;
    if (currentTables && refTables) {
      const currentSet = new Set(currentTables.rows.map((r: any[]) => r[0] as string));
      const refSet = new Set(refTables.rows.map((r: any[]) => r[0] as string));
      commonCapabilities = [...currentSet].filter(t => refSet.has(t));
      const currentOnly = [...currentSet].filter(t => !refSet.has(t));
      const referenceOnly = [...refSet].filter(t => !currentSet.has(t));
      if (currentOnly.length > 0 || referenceOnly.length > 0) {
        capabilityDiff = { currentOnly, referenceOnly };
      }
    }

    return {
      referenceTraceId,
      referencePackageName: refFocusResult.primaryApp,
      referenceFocusApps: refFocusResult.apps.length > 0 ? refFocusResult.apps : undefined,
      referenceArchitecture: refArchitecture,
      commonCapabilities,
      capabilityDiff,
    };
  }

  private async detectVendor(traceId: string): Promise<string | null> {
    const cached = getLruCacheEntry(this.vendorCache, traceId);
    if (cached) return cached;
    try {
      const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
      await adapter.ensureInitialized();
      const result = await adapter.detectVendor(traceId);
      if (result.vendor && result.vendor !== 'aosp') {
        setLruCacheEntry(this.vendorCache, traceId, result.vendor);
      }
      return result.vendor;
    } catch (error) {
      console.warn('[OpenAIRuntime] Vendor detection failed:', (error as Error).message);
      return null;
    }
  }

  private async detectCompleteness(
    traceId: string,
    architecture?: ArchitectureInfo,
  ): Promise<TraceCompleteness | undefined> {
    const cached = getLruCacheEntry(this.completenessCache, traceId);
    if (cached) return cached;
    try {
      const completeness = await probeTraceCompleteness(
        this.traceProcessorService,
        traceId,
        architecture?.type,
      );
      setLruCacheEntry(this.completenessCache, traceId, completeness);
      return completeness;
    } catch (error) {
      console.warn('[OpenAIRuntime] Trace completeness probe failed:', (error as Error).message);
      return undefined;
    }
  }

  /**
   * Decide quickMode for this request. Provider-symmetric to ClaudeRuntime:
   *   explicit fast/full → user wins; auto → keyword/hard rules first, then
   *   OpenAI light-model AI fallback. Stays provider-independent: never calls
   *   the Anthropic SDK, even when the operator hasn't installed it.
   */
  private async classifyModeForRequest(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    sceneType: SceneType,
    config: OpenAIAgentConfig,
  ): Promise<boolean> {
    const explicitMode = options.analysisMode;
    if (explicitMode === 'fast') return true;
    if (explicitMode === 'full') return false;

    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() ?? [];
    const classifierInput: ComplexityClassifierInput = buildComplexityClassifierInput({
      query,
      sceneType,
      selectionContext: options.selectionContext,
      hasReferenceTrace: !!options.referenceTraceId,
      previousTurns,
    });

    const local = classifyQueryComplexityLocal(classifierInput);
    if (local) {
      console.log(`[OpenAIRuntime] auto → ${local.complexity} (${local.source}: ${local.reason})`);
      return local.complexity === 'quick';
    }

    const ai = await classifyQueryWithOpenAILightModel(classifierInput, config);
    console.log(`[OpenAIRuntime] auto → ${ai.complexity} (ai: ${ai.reason})`);
    return ai.complexity === 'quick';
  }

  private getPlanCompletionStatus(sessionId: string, quickMode: boolean): PlanCompletionStatus {
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    return getAnalysisPlanCompletionStatus(plan, {
      quickMode,
      minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
    });
  }

  private shouldFinalizeAfterPlanComplete(
    sessionId: string,
    quickMode: boolean,
    answer: string,
    fallbackAnswer = '',
  ): boolean {
    if (quickMode) {
      return false;
    }
    const status = this.getPlanCompletionStatus(sessionId, quickMode);
    if (!status.complete) {
      return false;
    }
    return answer.trim().length > 0 ||
      fallbackAnswer.trim().length > 0 ||
      this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, DEFAULT_OUTPUT_LANGUAGE) !== undefined;
  }

  private shouldRequestFinalReportAfterPlanComplete(input: {
    quickMode: boolean;
    planStatus: PlanCompletionStatus;
    conclusion: string;
    fallbackConclusion?: string;
    completedByPlanIdle: boolean;
    timedOut: boolean;
    finalReportContinuations: number;
    query?: string;
    sceneType?: SceneType;
  }): boolean {
    if (
      input.quickMode ||
      !input.planStatus.complete ||
      input.timedOut ||
      input.finalReportContinuations >= OPENAI_MAX_FINAL_REPORT_CONTINUATIONS
    ) {
      return false;
    }

    const conclusion = input.conclusion.trim();
    const fallback = input.fallbackConclusion?.trim();
    if (!conclusion) return true;
    if (fallback && isSameConclusionText(conclusion, fallback)) return true;
    if (looksLikePhaseSummaryFallback(conclusion)) return true;
    if (!hasDeliverableFinalReportHeading(conclusion)) return true;
    if (looksLikeProcessNarrationParagraph(conclusion)) return true;
    if (assessFinalReportContractCompleteness({
      conclusion,
      query: input.query,
      sceneType: input.sceneType,
    })) {
      return true;
    }
    return looksLikeProcessNarrationParagraph(conclusion.split(/\n{2,}/)[0] || '');
  }

  private buildFinalReportAfterPlanCompletePrompt(outputLanguage: OutputLanguage): string {
    const templateName = outputLanguage === 'en'
      ? 'prompt-openai-final-report-continuation-en'
      : 'prompt-openai-final-report-continuation-zh';
    const template = loadPromptTemplate(templateName);
    if (!template) {
      throw new Error(`Missing OpenAI final-report continuation prompt template: ${templateName}`);
    }
    return template;
  }

  private formatPlanCompleteReportContinuationMessage(outputLanguage: OutputLanguage): string {
    return localize(
      outputLanguage,
      '最终报告仍需补齐，继续整理完整结论。',
      'The final report still needs completion; continuing to assemble the full conclusion.',
    );
  }

  private buildCompletedPlanFallbackConclusion(
    sessionId: string,
    quickMode: boolean,
    outputLanguage: OutputLanguage,
  ): string | undefined {
    if (quickMode) return undefined;
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    if (!plan || plan.phases.length === 0) return undefined;
    if (!this.getPlanCompletionStatus(sessionId, quickMode).complete) return undefined;

    const summaries = plan.phases
      .filter(hasAdequateClosedPhaseSummary)
      .map(phase => {
        const name = phase.name || phase.id;
        return `- ${name}: ${cleanPlanSummaryForFinalReport(phase.summary || '')}`;
      });
    if (summaries.length === 0) return undefined;

    const finalPhase = [...plan.phases]
      .reverse()
      .find(phase => hasAdequateClosedPhaseSummary(phase) &&
        isConclusionLikePlanPhase(phase));
    const finalSummary = cleanPlanSummaryForFinalReport(
      finalPhase?.summary?.trim() || summaries[summaries.length - 1]?.replace(/^-\s*[^:]+:\s*/, '') || '',
    );
    const evidenceBullets = plan.phases
      .filter(phase => hasAdequateClosedPhaseSummary(phase) && !isConclusionLikePlanPhase(phase))
      .map(phase => {
        const name = phase.name || phase.id;
        return `- ${name}: ${cleanPlanSummaryForFinalReport(phase.summary || '')}`;
      })
      .filter(line => line.trim().length > 4)
      .slice(0, 8)
      .join('\n');

    return localize(
      outputLanguage,
      [
        '## 综合结论',
        '',
        finalSummary || '分析计划已完成，以下结论基于已采集的结构化证据收敛。',
        '',
        '## 关键证据链',
        '',
        evidenceBullets || '- 已完成的计划阶段均有结构化证据支撑。',
        '',
        '## 根因拆解',
        '',
        '- 以上证据按阶段产出、关键指标、已确认假设和已排除因素归并；优化优先级以已验证且可执行的瓶颈为准。',
        '',
        '## 优化建议',
        '',
        '- 优先处理证据支持的可操作瓶颈；对已排除但风险较高的因素保留必要监控。',
        '',
        '## 置信度/限制',
        '',
        '- 结论基于已完成计划阶段的结构化证据收敛；若需要代码级 owner 定位，应结合源码符号继续分析。',
      ].join('\n'),
      [
        '## Final Conclusion',
        '',
        finalSummary || 'The analysis plan completed; this conclusion is synthesized from the collected structured evidence.',
        '',
        '## Key Evidence',
        '',
        evidenceBullets || '- Completed plan phases contain structured evidence.',
        '',
        '## Root Cause Breakdown',
        '',
        '- The evidence is grouped by phase outputs, key metrics, confirmed hypotheses, and excluded factors; optimization priority should follow verified and actionable bottlenecks.',
        '',
        '## Recommendations',
        '',
        '- Prioritize actionable bottlenecks supported by evidence; keep monitoring excluded factors that still carry residual risk.',
        '',
        '## Confidence / Limits',
        '',
        '- This conclusion is synthesized from structured evidence collected by the completed plan phases. Use source-code symbol lookup for owner-level fixes.',
      ].join('\n'),
    );
  }

  private buildPlanPhaseSummaryFallbackConclusion(
    sessionId: string,
    quickMode: boolean,
    outputLanguage: OutputLanguage,
  ): string | undefined {
    if (quickMode) return undefined;
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    if (!plan || plan.phases.length === 0) return undefined;

    const summaries = plan.phases
      .filter(hasAdequateClosedPhaseSummary)
      .map(phase => `- ${phase.id} ${phase.name || phase.id}: ${phase.summary?.trim()}`);
    if (summaries.length === 0) return undefined;

    const status = this.getPlanCompletionStatus(sessionId, quickMode);
    if (status.complete) {
      return this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, outputLanguage);
    }

    const pending = status.pendingPhases
      .map(phase => `${phase.id}:${phase.name || phase.id}`)
      .join(', ');
    return localize(
      outputLanguage,
      `OpenAI 流在计划完成前中断。以下是已完成阶段的可用摘要：\n\n${summaries.join('\n')}\n\n未完成阶段：${pending || '无'}`,
      `The OpenAI stream ended before the plan completed. Usable summaries from completed phases:\n\n${summaries.join('\n')}\n\nPending phases: ${pending || 'none'}`,
    );
  }

  private recoverPartialResultAfterStreamTermination(params: {
    error: unknown;
    sessionId: string;
    quickMode: boolean;
    outputLanguage: OutputLanguage;
    accumulatedAnswer: string;
    context: Awaited<ReturnType<OpenAIRuntime['prepareAnalysisContext']>>;
    query: string;
    startTime: number;
    rounds: number;
    codeAwareMode?: AnalysisOptions['codeAwareMode'];
  }): AnalysisResult | undefined {
    if (!isRecoverableOpenAIStreamTermination(params.error)) {
      return undefined;
    }

    const planStatus = this.getPlanCompletionStatus(params.sessionId, params.quickMode);
    const fallbackConclusion = this.buildPlanPhaseSummaryFallbackConclusion(
      params.sessionId,
      params.quickMode,
      params.outputLanguage,
    );
    const conclusionBase = chooseOpenAiConclusionText({
      candidate: params.accumulatedAnswer || fallbackConclusion || '',
      accumulatedAnswer: params.accumulatedAnswer,
      completedByPlanIdle: false,
      planComplete: planStatus.complete,
      fallbackConclusion,
    });
    if (!conclusionBase.trim()) {
      return undefined;
    }

    const message = formatOpenAIError(params.error);
    let conclusion = planStatus.complete
      ? conclusionBase
      : this.withIncompletePlanWarning(conclusionBase, planStatus, params.outputLanguage);
    if (params.codeAwareMode && params.codeAwareMode !== 'off') {
      conclusion = sanitizeCodeAwareText(params.sessionId, conclusion);
    }
    const findings = extractFindingsFromText(conclusion);
    const confidence = Math.min(0.55, this.estimateConfidence(findings, conclusion));
    const terminationReason: AnalysisTerminationReason = planStatus.complete ? 'timeout' : 'plan_incomplete';
    const terminationMessage = localize(
      params.outputLanguage,
      `OpenAI stream 在分析过程中中断：${message}。已保留已完成阶段的部分结果。`,
      `The OpenAI stream terminated during analysis: ${message}. Preserving partial results from completed phases.`,
    );

    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'partial_result_after_stream_termination',
        partial: true,
        terminationReason,
        message: terminationMessage,
      },
      timestamp: Date.now(),
    });

    this.recordTurn({
      query: params.query,
      sessionId: params.sessionId,
      result: {
        sessionId: params.sessionId,
        success: true,
        findings,
        hypotheses: params.context.hypotheses.map(h => this.toProtocolHypothesis(h)),
        conclusion,
        confidence,
        rounds: params.rounds,
        totalDurationMs: Date.now() - params.startTime,
        partial: true,
        terminationReason,
        terminationMessage,
      },
      sessionContext: params.context.sessionContext,
      previousTurnCount: params.context.previousTurns.length,
      quickMode: params.quickMode,
    });

    this.emitUpdate({
      type: 'conclusion',
      content: { conclusion, durationMs: Date.now() - params.startTime, turns: params.rounds },
      timestamp: Date.now(),
    });
    this.emitUpdate({
      type: 'answer_token',
      content: { done: true, totalChars: conclusion.length },
      timestamp: Date.now(),
    });

    return {
      sessionId: params.sessionId,
      success: true,
      findings,
      hypotheses: params.context.hypotheses.map(h => this.toProtocolHypothesis(h)),
      conclusion,
      confidence,
      rounds: params.rounds,
      totalDurationMs: Date.now() - params.startTime,
      partial: true,
      terminationReason,
      terminationMessage,
    };
  }

  private recordMaxTurnsPartialResult(params: {
    error: { message?: string };
    query: string;
    sessionId: string;
    outputLanguage: OutputLanguage;
    accumulatedAnswer: string;
    context: Pick<
      Awaited<ReturnType<OpenAIRuntime['prepareAnalysisContext']>>,
      'hypotheses' | 'sessionContext' | 'previousTurns'
    >;
    startTime: number;
    rounds: number;
    quickMode: boolean;
    maxTurns?: number;
    codeAwareMode?: AnalysisOptions['codeAwareMode'];
  }): AnalysisResult {
    const maxTurnText = Number.isFinite(params.maxTurns)
      ? localize(
          params.outputLanguage,
          `（当前上限 ${params.maxTurns} turns）`,
          ` (current limit: ${params.maxTurns} turns)`,
        )
      : '';
    let partialConclusion = params.accumulatedAnswer || localize(
      params.outputLanguage,
      `分析达到轮次上限${maxTurnText}，尚未形成完整结论。`,
      `The analysis reached the turn limit${maxTurnText} before a complete conclusion was produced.`,
    );
    if (params.codeAwareMode && params.codeAwareMode !== 'off') {
      partialConclusion = sanitizeCodeAwareText(params.sessionId, partialConclusion);
    }
    const findings = extractFindingsFromText(partialConclusion);
    const confidence = Math.min(0.55, this.estimateConfidence(findings, partialConclusion));
    const result: AnalysisResult = {
      sessionId: params.sessionId,
      success: true,
      findings,
      hypotheses: params.context.hypotheses.map(h => this.toProtocolHypothesis(h)),
      conclusion: partialConclusion,
      confidence,
      rounds: params.rounds,
      totalDurationMs: Date.now() - params.startTime,
      partial: true,
      terminationReason: 'max_turns',
      terminationMessage: params.error.message,
    };

    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'partial_result_after_max_turns',
        partial: true,
        terminationReason: 'max_turns',
        message: this.formatOpenAiMaxTurnsMessage(params.outputLanguage, params.maxTurns),
      },
      timestamp: Date.now(),
    });
    this.recordTurn({
      query: params.query,
      sessionId: params.sessionId,
      result,
      sessionContext: params.context.sessionContext,
      previousTurnCount: params.context.previousTurns.length,
      quickMode: params.quickMode,
    });
    this.emitUpdate({
      type: 'conclusion',
      content: { conclusion: result.conclusion, durationMs: Date.now() - params.startTime, turns: params.rounds },
      timestamp: Date.now(),
    });
    this.emitUpdate({
      type: 'answer_token',
      content: { done: true, totalChars: result.conclusion.length },
      timestamp: Date.now(),
    });

    return result;
  }

  private formatOpenAiMaxTurnsMessage(outputLanguage: OutputLanguage, maxTurns?: number): string {
    const maxTurnText = Number.isFinite(maxTurns)
      ? localize(outputLanguage, `（当前上限 ${maxTurns} turns）`, ` (current limit: ${maxTurns} turns)`)
      : '';
    return localize(
      outputLanguage,
      `OpenAI 分析达到轮次上限${maxTurnText}，结果可能不完整。可在 Provider Manager 提高 Max Turns，或清空该字段使用默认 100。`,
      `OpenAI analysis reached the turn limit${maxTurnText}; the result may be incomplete. Raise Max Turns in Provider Manager, or clear the field to use the default 100.`,
    );
  }

  private formatPlanContinuationMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        '继续建立分析计划并补齐必要证据...',
        'Continuing by creating the analysis plan and collecting required evidence...',
      );
    }
    if (status.evidenceGaps && status.evidenceGaps.length > 0) {
      const gaps = status.evidenceGaps
        .map(gap => formatPlanEvidenceGap(gap, outputLanguage))
        .slice(0, 3)
        .join(outputLanguage === 'en' ? '; ' : '；');
      return localize(
        outputLanguage,
        `继续补齐缺失的关键工具证据：${gaps}`,
        `Continuing the missing required tool evidence: ${gaps}`,
      );
    }
    const phaseNames = status.pendingPhases.map(p => p.name || p.id).slice(0, 3).join('、');
    return localize(
      outputLanguage,
      `继续补齐剩余分析阶段：${phaseNames}`,
      `Continuing the remaining analysis phases: ${phaseNames}`,
    );
  }

  private formatIncompletePlanMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        'OpenAI 分析没有提交 plan，结果只能作为不完整分析使用。',
        'OpenAI analysis did not submit a plan; treat the result as incomplete.',
      );
    }
    const phaseNames = status.pendingPhases.map(p => `${p.id}:${p.name}`).join(', ');
    const evidenceGapText = status.evidenceGaps?.length
      ? outputLanguage === 'en'
        ? `; missing required tool evidence: ${status.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('; ')}`
        : `；缺失关键工具证据：${status.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('；')}`
      : '';
    return localize(
      outputLanguage,
      `OpenAI 分析达到继续执行上限，但 plan 仍未完成。未完成阶段：${phaseNames}${evidenceGapText}`,
      `OpenAI analysis reached the continuation limit, but the plan is still incomplete. Pending phases: ${phaseNames}${evidenceGapText}`,
    );
  }

  private buildPlanContinuationPrompt(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const pending = status.pendingPhases.map(phase => {
      const tools = expectedToolNames(phase).length ? `；预期调用: ${expectedToolNames(phase).join(', ')}` : '';
      return `- ${phase.id} ${phase.name}: ${phase.goal}${tools}`;
    }).join('\n');
    const gapText = status.evidenceGaps?.length
      ? outputLanguage === 'en'
        ? `\n\nMissing required tool evidence:\n${status.evidenceGaps.map(gap => `- ${formatPlanEvidenceGap(gap, outputLanguage)}`).join('\n')}`
        : `\n\n缺失的关键工具证据：\n${status.evidenceGaps.map(gap => `- ${formatPlanEvidenceGap(gap, outputLanguage)}`).join('\n')}`
      : '';

    return localize(
      outputLanguage,
      status.hasPlan
        ? `系统校验：你刚才给出了阶段性回答，但当前分析 plan 还没有完成，所以那不是最终答案。请继续执行剩余阶段，不要重述已完成内容。\n\n未完成阶段：\n${pending}${gapText}\n\n要求：继续调用必要工具收集证据；完成或跳过每个阶段时必须调用 update_plan_phase；只有所有阶段 completed/skipped 后，才能输出最终结论。`
        : '系统校验：你刚才直接回答了用户，但当前是 full 分析模式，尚未调用 submit_plan。请先调用 submit_plan 建立分析计划，然后执行必要工具。只有所有计划阶段 completed/skipped 后，才能输出最终结论。',
      status.hasPlan
        ? `System check: you produced an interim answer, but the analysis plan is not complete, so that was not a final answer. Continue the remaining phases without restating completed work.\n\nPending phases:\n${pending}${gapText}\n\nRequirements: call the necessary tools to collect evidence; call update_plan_phase whenever completing or skipping each phase; only produce the final conclusion after every phase is completed or skipped.`
        : 'System check: you answered directly, but this is full analysis mode and submit_plan has not been called. Call submit_plan first, then execute the necessary tools. Only produce the final conclusion after every planned phase is completed or skipped.',
    );
  }

  private withIncompletePlanWarning(
    conclusion: string,
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const warning = this.formatIncompletePlanMessage(status, outputLanguage);
    return conclusion.trim()
      ? `${warning}\n\n${conclusion}`
      : warning;
  }

  private shouldExposeOpenAiAnswerDelta(sessionId: string, quickMode: boolean): boolean {
    return quickMode || this.getPlanCompletionStatus(sessionId, quickMode).complete;
  }

  private handleStreamEvent(
    event: RunStreamEvent,
    outputLanguage: OutputLanguage,
    streamContext: {
      sessionId: string;
      quickMode: boolean;
      answerStreamFilter: OpenAiReasoningFilterState;
      toolInputsByTaskId: Map<string, { toolName: string; args: Record<string, unknown> }>;
    },
  ): string {
    const now = Date.now();
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
        const delta = filterOpenAiVisibleAnswerDelta(data.delta, streamContext.answerStreamFilter);
        if (!this.shouldExposeOpenAiAnswerDelta(streamContext.sessionId, streamContext.quickMode)) {
          return '';
        }
        if (!delta) return '';
        this.emitUpdate({ type: 'answer_token', content: { token: delta }, timestamp: now });
        return delta;
      }
      return '';
    }

    if (event.type === 'agent_updated_stream_event') {
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `切换到 OpenAI Agent: ${event.agent.name}`,
            `Switched to OpenAI Agent: ${event.agent.name}`,
          ),
        },
        timestamp: now,
      });
      return '';
    }

    const rawItem = (event.item as any)?.rawItem;
    if (event.name === 'tool_called') {
      const args = parseJsonObject(rawItem?.arguments) || {};
      const taskIds = [rawItem?.callId, rawItem?.call_id, rawItem?.id]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      for (const taskId of taskIds) {
        streamContext.toolInputsByTaskId.set(taskId, {
          toolName: rawItem?.name || 'unknown',
          args,
        });
      }
      this.emitUpdate({
        type: 'agent_task_dispatched',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          toolName: rawItem?.name || 'unknown',
          args,
          message: formatToolCallNarration(rawItem?.name || 'unknown', args, outputLanguage),
        },
        timestamp: now,
      });
    } else if (event.name === 'tool_output') {
      const taskIds = [rawItem?.callId, rawItem?.call_id, rawItem?.id]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const cached = taskIds
        .map(taskId => streamContext.toolInputsByTaskId.get(taskId))
        .find(Boolean);
      if (cached) {
        const plan = this.sessionPlans.get(streamContext.sessionId)?.current ?? null;
        recordPlanToolCall(plan, {
          toolName: cached.toolName,
          input: cached.args,
          resultText: summarizeToolOutput(rawItem?.output),
        });
        for (const taskId of taskIds) {
          streamContext.toolInputsByTaskId.delete(taskId);
        }
      }
      this.emitUpdate({
        type: 'agent_response',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          result: summarizeToolOutput(rawItem?.output),
        },
        timestamp: now,
      });
    } else if (event.name === 'reasoning_item_created') {
      const text = Array.isArray(rawItem?.content)
        ? rawItem.content.map((c: any) => c.text).filter(Boolean).join('\n')
        : undefined;
      if (text) {
        this.emitUpdate({ type: 'thought', content: { thought: text }, timestamp: now });
      }
    }
    return '';
  }

  private safeSerializeRunState(state: unknown): string | undefined {
    try {
      const asSerializable = state as { toString?: () => string };
      const serialized = asSerializable?.toString?.();
      return serialized && serialized !== '[object Object]' ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  private estimateConfidence(findings: Finding[], conclusion: string): number {
    if (findings.length === 0) return conclusion.trim().length > 0 ? 0.55 : 0.25;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }

  private recordTurn(input: {
    query: string;
    sessionId: string;
    result: AnalysisResult;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurnCount: number;
    quickMode: boolean;
  }): void {
    input.sessionContext.addTurn(
      input.query,
      {
        primaryGoal: input.query,
        aspects: [],
        expectedOutputType: input.quickMode ? 'summary' : 'diagnosis',
        complexity: input.quickMode ? 'simple' : 'complex',
        followUpType: input.previousTurnCount > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'openai-agent',
        success: input.result.success,
        findings: input.result.findings,
        confidence: input.result.confidence,
        message: input.result.conclusion,
        partial: input.result.partial,
        terminationReason: input.result.terminationReason,
        terminationMessage: input.result.terminationMessage,
      },
      input.result.findings,
    );

    if (input.result.partial === true) return;
    input.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: input.previousTurnCount,
      query: input.query,
      conclusion: input.result.conclusion,
      confidence: input.result.confidence,
    });
  }

  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    captureSkillDisplayEntities(displayResults, entityStore, 'openai-agent');
  }

  private collectPreviousFindings(sessionContext: any, maxTurns = 3): Finding[] {
    return collectRecentFindings(sessionContext, { maxTurns, maxFindings: 5 });
  }

  private buildEntityContext(entityStore: any): string | undefined {
    return buildEntityContext(entityStore);
  }

  private toProtocolHypothesis(h: Hypothesis): ProtocolHypothesis {
    return toRuntimeProtocolHypothesis(h, 'openai');
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }
}

export function createOpenAIRuntime(
  traceProcessorService: TraceProcessorService,
  runtimeSelection?: RuntimeSelection,
): OpenAIRuntime {
  return new OpenAIRuntime(traceProcessorService, runtimeSelection);
}
