// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Feedback Synthesizer
 *
 * Synthesizes findings from multiple agent responses using LLM.
 * Deduplicates findings, correlates evidence, updates hypotheses,
 * and identifies remaining information gaps.
 */

import { Finding } from '../types';
import {
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
} from '../types/agentProtocol';
import { AgentMessageBus } from '../communication';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';
import type { EnhancedSessionContext } from '../context/enhancedSessionContext';
import { isPlainObject, isStringArray, LlmJsonSchema, stripOuterMarkdownCodeFence, tryParseLlmJson } from '../../utils/llmJson';

const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{12}$/;
const EVIDENCE_ID_GLOBAL_PATTERN = /\bev_[0-9a-f]{12}\b/g;

type FeedbackSynthesisJsonPayload = {
  correlatedFindings?: string[];
  contradictions?: string[];
  hypothesisUpdates?: Array<{
    hypothesisId: string;
    action: 'support' | 'weaken' | 'reject';
    confidence_delta?: number;
    reason?: string;
  }>;
  informationGaps?: string[];
};

type FeedbackHypothesisUpdate = NonNullable<FeedbackSynthesisJsonPayload['hypothesisUpdates']>[number];

function makeEmptyFeedbackSynthesisPayload(informationGaps: string[] = []): FeedbackSynthesisJsonPayload {
  return {
    correlatedFindings: [],
    contradictions: [],
    hypothesisUpdates: [],
    informationGaps,
  };
}

const FEEDBACK_SYNTHESIS_JSON_SCHEMA: LlmJsonSchema<FeedbackSynthesisJsonPayload> = {
  name: 'feedback_synthesis_json@1.0.0',
  validate: (value: unknown): value is FeedbackSynthesisJsonPayload => {
    if (!isPlainObject(value)) return false;

    const optionalStringArray = (field: unknown): boolean =>
      field === undefined || field === null || isStringArray(field);

    if (!optionalStringArray(value.correlatedFindings)) return false;
    if (!optionalStringArray(value.contradictions)) return false;
    if (!optionalStringArray(value.informationGaps)) return false;

    const hasAtLeastOneSignalField =
      Object.prototype.hasOwnProperty.call(value, 'correlatedFindings')
      || Object.prototype.hasOwnProperty.call(value, 'contradictions')
      || Object.prototype.hasOwnProperty.call(value, 'hypothesisUpdates')
      || Object.prototype.hasOwnProperty.call(value, 'informationGaps');
    if (!hasAtLeastOneSignalField) return false;

    const hypothesisUpdates = value.hypothesisUpdates;
    if (hypothesisUpdates !== undefined && hypothesisUpdates !== null) {
      if (!Array.isArray(hypothesisUpdates)) return false;

      for (const item of hypothesisUpdates) {
        if (!isPlainObject(item)) return false;
        if (typeof item.hypothesisId !== 'string') return false;
        if (item.action !== 'support' && item.action !== 'weaken' && item.action !== 'reject') return false;

        const delta = item.confidence_delta;
        if (delta !== undefined && delta !== null && typeof delta !== 'number') return false;

        const reason = item.reason;
        if (reason !== undefined && reason !== null && typeof reason !== 'string') return false;
      }
    }

    return true;
  },
};

const PAYLOAD_WRAPPER_KEYS = ['result', 'data', 'output', 'payload', 'response'];

const CORRELATED_KEYS = ['correlatedFindings', 'correlated_findings', 'correlations', 'supportingFindings'];
const CONTRADICTIONS_KEYS = ['contradictions', 'conflicts', 'inconsistencies'];
const HYPOTHESIS_UPDATES_KEYS = ['hypothesisUpdates', 'hypothesis_updates', 'updates', 'hypothesisChanges'];
const INFORMATION_GAPS_KEYS = ['informationGaps', 'information_gaps', 'gaps', 'missingData', 'missing_data'];

const HYPOTHESIS_ACTION_SYNONYMS: Record<'support' | 'weaken' | 'reject', readonly string[]> = {
  support: ['support', 'supported', 'strengthen', 'increase', 'confirm', 'confirmed', 'up', '支持', '确认'],
  weaken: ['weaken', 'weak', 'decrease', 'lower', 'down', 'question', 'uncertain', '减弱', '降低', '质疑'],
  reject: ['reject', 'rejected', 'deny', 'denied', '排除', '否定'],
};

function dedupePreservingOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  return values.filter(value => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function isValidEvidenceId(value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_ID_PATTERN.test(value.trim());
}

function getFindingDetails(finding: Finding): Record<string, unknown> {
  if (!isPlainObject(finding.details)) return {};
  return finding.details as Record<string, unknown>;
}

function pickFirstField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeTextLike(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!isPlainObject(value)) return '';

  const candidate =
    value.text ??
    value.statement ??
    value.description ??
    value.reason ??
    value.explanation ??
    value.title ??
    value.summary ??
    value.message;

  if (typeof candidate === 'string') return candidate.trim();
  if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
  return '';
}

function normalizeStringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  const out: string[] = [];
  const pushLine = (line: string): void => {
    const text = String(line || '').replace(/^\s*[-*]\s*/, '').trim();
    if (!text) return;
    if (!out.includes(text)) out.push(text);
  };

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return [];
    const chunks = normalized.split(/[\n;；]+/);
    for (const chunk of chunks) pushLine(chunk);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeTextLike(item);
      if (!text && isPlainObject(item)) {
        const fallback = normalizeTextLike((item as Record<string, unknown>).value);
        if (fallback) pushLine(fallback);
      } else if (text) {
        pushLine(text);
      }
    }
    return out;
  }

  if (isPlainObject(value)) {
    const text = normalizeTextLike(value);
    if (text) pushLine(text);
    return out;
  }

  return [];
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeHypothesisAction(
  actionRaw: unknown,
  confidenceDelta?: number
): 'support' | 'weaken' | 'reject' | null {
  const action = String(actionRaw ?? '').trim().toLowerCase();

  if (HYPOTHESIS_ACTION_SYNONYMS.support.includes(action)) {
    return 'support';
  }
  if (HYPOTHESIS_ACTION_SYNONYMS.weaken.includes(action)) {
    return 'weaken';
  }
  if (HYPOTHESIS_ACTION_SYNONYMS.reject.includes(action)) {
    return 'reject';
  }

  if (confidenceDelta !== undefined) {
    if (confidenceDelta > 0) return 'support';
    if (confidenceDelta < 0) return 'weaken';
  }

  return null;
}

function normalizeHypothesisUpdates(value: unknown): FeedbackHypothesisUpdate[] {
  const updates: FeedbackHypothesisUpdate[] = [];
  const appendUpdate = (item: unknown, fallbackId?: string): void => {
    if (!isPlainObject(item)) return;

    const hypothesisIdRaw =
      item.hypothesisId ??
      item.hypothesis_id ??
      item.id ??
      item.hypothesis ??
      fallbackId;
    const hypothesisId = typeof hypothesisIdRaw === 'string' ? hypothesisIdRaw.trim() : '';
    if (!hypothesisId) return;

    const confidenceDelta = parseOptionalNumber(
      item.confidence_delta ?? item.confidenceDelta ?? item.delta
    );
    const action = normalizeHypothesisAction(item.action ?? item.status ?? item.update, confidenceDelta);
    if (!action) return;

    const reason = normalizeTextLike(item.reason ?? item.explanation ?? item.rationale);

    updates.push({
      hypothesisId,
      action,
      ...(confidenceDelta !== undefined && { confidence_delta: confidenceDelta }),
      ...(reason && { reason }),
    });
  };

  if (Array.isArray(value)) {
    for (const item of value) appendUpdate(item);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      appendUpdate(item, key);
    }
  }

  if (updates.length === 0) return [];

  const deduped = new Map<string, FeedbackHypothesisUpdate>();
  for (const item of updates) {
    const dedupeKey = `${item.hypothesisId}|${item.action}`;
    if (!deduped.has(dedupeKey)) deduped.set(dedupeKey, item);
  }
  return Array.from(deduped.values());
}

function unwrapPayloadCandidate(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;

  const hasDirectSignal =
    pickFirstField(value, CORRELATED_KEYS) !== undefined ||
    pickFirstField(value, CONTRADICTIONS_KEYS) !== undefined ||
    pickFirstField(value, HYPOTHESIS_UPDATES_KEYS) !== undefined ||
    pickFirstField(value, INFORMATION_GAPS_KEYS) !== undefined;

  if (hasDirectSignal) return value;

  for (const key of PAYLOAD_WRAPPER_KEYS) {
    const child = value[key];
    if (isPlainObject(child)) {
      const nested = unwrapPayloadCandidate(child);
      if (nested) return nested;
    }
  }

  return value;
}

function normalizeFeedbackSynthesisPayload(raw: unknown): FeedbackSynthesisJsonPayload {
  const candidate = unwrapPayloadCandidate(raw);
  if (!candidate) {
    if (Array.isArray(raw)) {
      return makeEmptyFeedbackSynthesisPayload(normalizeStringList(raw));
    }
    return makeEmptyFeedbackSynthesisPayload();
  }

  return {
    correlatedFindings: normalizeStringList(pickFirstField(candidate, CORRELATED_KEYS)),
    contradictions: normalizeStringList(pickFirstField(candidate, CONTRADICTIONS_KEYS)),
    hypothesisUpdates: normalizeHypothesisUpdates(pickFirstField(candidate, HYPOTHESIS_UPDATES_KEYS)),
    informationGaps: normalizeStringList(pickFirstField(candidate, INFORMATION_GAPS_KEYS)),
  };
}

function parseFeedbackSynthesisPayload(
  llmResponse: string,
  emitter: ProgressEmitter
): FeedbackSynthesisJsonPayload {
  const strictParsed = tryParseLlmJson<FeedbackSynthesisJsonPayload>(llmResponse, FEEDBACK_SYNTHESIS_JSON_SCHEMA);
  if (strictParsed.ok) {
    return strictParsed.value;
  }

  const relaxedParsed = tryParseLlmJson<unknown>(llmResponse);
  if (!relaxedParsed.ok) {
    const textRecovered = parseFeedbackSynthesisFromFreeText(llmResponse);
    if (textRecovered) {
      emitter.log(`[feedbackSynthesizer] Recovered synthesis payload via free-text repair: ${strictParsed.error.message}`);
      return textRecovered;
    }
    throw strictParsed.error;
  }

  const normalized = normalizeFeedbackSynthesisPayload(relaxedParsed.value);
  if (!FEEDBACK_SYNTHESIS_JSON_SCHEMA.validate(normalized)) {
    throw strictParsed.error;
  }

  emitter.log(`[feedbackSynthesizer] Recovered synthesis payload via schema repair: ${strictParsed.error.message}`);
  return normalized;
}

function parseFeedbackSynthesisFromFreeText(rawText: string): FeedbackSynthesisJsonPayload | null {
  const text = stripOuterMarkdownCodeFence(String(rawText || '')).trim();
  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*]\s*/, '').trim());

  if (lines.length === 0) return null;

  const correlatedFindings: string[] = [];
  const contradictions: string[] = [];
  const informationGaps: string[] = [];
  const hypothesisUpdates: FeedbackHypothesisUpdate[] = [];

  const dedupePush = (arr: string[], value: string): void => {
    const line = String(value || '').trim();
    if (!line) return;
    if (!arr.includes(line)) arr.push(line);
  };

  let section: 'correlated' | 'contradictions' | 'gaps' | 'updates' | 'unknown' = 'unknown';

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^(correlated findings?|correlations?|相互印证|印证关系|支持证据)\s*[:：]?$/.test(lower)) {
      section = 'correlated';
      continue;
    }
    if (/^(contradictions?|conflicts?|inconsistencies?|矛盾|冲突|不一致)\s*[:：]?$/.test(lower)) {
      section = 'contradictions';
      continue;
    }
    if (/^(information gaps?|gaps?|missing data|信息缺口|不确定性|待确认)\s*[:：]?$/.test(lower)) {
      section = 'gaps';
      continue;
    }
    if (/^(hypothesis updates?|updates?|假设更新|假设变更)\s*[:：]?$/.test(lower)) {
      section = 'updates';
      continue;
    }

    const explicitHypothesisMatch = line.match(/(?:hypothesis(?:id)?|假设(?:id)?)\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
    if (explicitHypothesisMatch) {
      const hypothesisId = explicitHypothesisMatch[1];
      const deltaMatch = line.match(/(?:confidence[_\s-]*delta|delta|置信度变化|置信度调整)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
      const delta = deltaMatch ? Number(deltaMatch[1]) : undefined;
      const action = normalizeHypothesisAction(
        (line.match(/\b(support|weaken|reject|strengthen|increase|decrease|确认|支持|减弱|否定)\b/i) || [])[1],
        delta
      );
      if (action) {
        hypothesisUpdates.push({
          hypothesisId,
          action,
          ...(delta !== undefined && Number.isFinite(delta) && { confidence_delta: delta }),
          reason: line,
        });
        continue;
      }
    }

    if (section === 'correlated') {
      dedupePush(correlatedFindings, line);
      continue;
    }
    if (section === 'contradictions') {
      dedupePush(contradictions, line);
      continue;
    }
    if (section === 'gaps') {
      dedupePush(informationGaps, line);
      continue;
    }

    if (/矛盾|冲突|不一致|conflict|contradiction|inconsistent/i.test(line)) {
      dedupePush(contradictions, line);
      continue;
    }
    if (/缺少|缺失|待确认|需要补充|缺口|gap|missing|uncertain/i.test(line)) {
      dedupePush(informationGaps, line);
      continue;
    }
    if (/印证|支持|correlat|support/i.test(line)) {
      dedupePush(correlatedFindings, line);
    }
  }

  if (
    correlatedFindings.length === 0 &&
    contradictions.length === 0 &&
    informationGaps.length === 0 &&
    hypothesisUpdates.length === 0
  ) {
    return null;
  }

  return {
    correlatedFindings,
    contradictions,
    hypothesisUpdates,
    informationGaps,
  };
}

/**
 * Format a finding briefly with key metrics for synthesis prompt.
 * Output: "title (metric1=val1, metric2=val2)"
 */
function formatFindingBrief(f: Finding): string {
  const evIds = extractEvidenceIdsFromFinding(f);
  const evStr = evIds.length > 0 ? evIds.slice(0, 2).join('|') : '';

  const details = getFindingDetails(f);
  if (Object.keys(details).length === 0) {
    return evStr ? `${f.title} (ev=${evStr})` : f.title;
  }
  const entries = Object.entries(details).slice(0, 4);
  const metrics = entries.map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : String(v);
    return `${k}=${val}`;
  }).join(', ');
  return `${f.title} (${metrics}${evStr ? `, ev=${evStr}` : ''})`;
}

function extractEvidenceIdsFromFinding(f: Finding): string[] {
  const evidence = (f as Finding & { evidence?: unknown }).evidence;
  const entries = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  const ids: string[] = [];

  for (const entry of entries) {
    if (isValidEvidenceId(entry)) {
      ids.push(entry.trim());
      continue;
    }

    if (!isPlainObject(entry)) continue;

    const idCandidate = entry.evidenceId ?? entry.evidence_id;
    if (isValidEvidenceId(idCandidate)) {
      ids.push(idCandidate.trim());
    }
  }

  return dedupePreservingOrder(ids);
}

function extractSessionIdsFromFinding(f: Finding): number[] {
  const out = new Set<number>();
  const details = getFindingDetails(f);
  const scope = isPlainObject(details.scope) ? details.scope : {};
  const sourceWindow = isPlainObject(details.sourceWindow) ? details.sourceWindow : {};

  const addMaybeNumber = (value: unknown): void => {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) out.add(num);
  };

  addMaybeNumber(details.session_id);
  addMaybeNumber(details.sessionId);
  addMaybeNumber(scope.session_id);
  addMaybeNumber(scope.sessionId);

  const sessionIdArrays = [
    sourceWindow.sessionIds,
    sourceWindow.session_ids,
    scope.sessionIds,
    scope.session_ids,
  ];
  for (const arr of sessionIdArrays) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) addMaybeNumber(v);
  }

  const samples = Array.isArray(details.sample) ? details.sample : [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    addMaybeNumber(s.session_id);
    addMaybeNumber(s.sessionId);
  }

  const title = String(f.title || '');
  const titleMatch = title.match(/区间\s*(\d+)/);
  if (titleMatch) addMaybeNumber(titleMatch[1]);

  return Array.from(out);
}

function extractIntervalIdsFromText(text: string): number[] {
  const out = new Set<number>();
  const re = /(?:滑动)?区间\s*(\d+)/g;
  const input = String(text || '');
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return Array.from(out);
}

function extractFrameCountsFromText(text: string): number[] {
  const out = new Set<number>();
  const re = /(\d+)\s*帧/g;
  const input = String(text || '');
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return Array.from(out);
}

function buildFrameCountIntervalHints(findings: Finding[]): Map<number, Set<number>> {
  const hints = new Map<number, Set<number>>();

  for (const finding of findings) {
    const title = String(finding.title || '');
    if (!title) continue;

    const intervalIds = extractIntervalIdsFromText(title);
    const frameCounts = extractFrameCountsFromText(title);
    if (intervalIds.length === 0 || frameCounts.length === 0) continue;

    for (const frameCount of frameCounts) {
      const slot = hints.get(frameCount) || new Set<number>();
      for (const intervalId of intervalIds) slot.add(intervalId);
      hints.set(frameCount, slot);
    }
  }

  return hints;
}

function contradictionLooksCrossInterval(
  contradiction: string,
  frameCountIntervalHints: Map<number, Set<number>>
): boolean {
  const intervalIdsInText = extractIntervalIdsFromText(contradiction);
  if (new Set(intervalIdsInText).size >= 2) {
    return true;
  }

  if (frameCountIntervalHints.size === 0) return false;

  const frameCounts = extractFrameCountsFromText(contradiction);
  if (frameCounts.length < 2) return false;

  const inferredIntervals = new Set<number>();
  for (const frameCount of frameCounts) {
    const mapped = frameCountIntervalHints.get(frameCount);
    if (!mapped) continue;
    for (const intervalId of mapped) inferredIntervals.add(intervalId);
  }

  return inferredIntervals.size >= 2;
}

function parseTsNs(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function extractTimeRangeFromFinding(f: Finding): { start?: bigint; end?: bigint } {
  const details = getFindingDetails(f);
  const sourceWindow = isPlainObject(details.sourceWindow) ? details.sourceWindow : {};

  let start = parseTsNs(details.start_ts)
    || parseTsNs(details.startTs)
    || parseTsNs(sourceWindow.startTsNs)
    || parseTsNs(sourceWindow.start_ts);
  let end = parseTsNs(details.end_ts)
    || parseTsNs(details.endTs)
    || parseTsNs(sourceWindow.endTsNs)
    || parseTsNs(sourceWindow.end_ts);

  const samples = Array.isArray(details.sample) ? details.sample : [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const sStart = parseTsNs(s.start_ts) || parseTsNs(s.startTs);
    const sEnd = parseTsNs(s.end_ts) || parseTsNs(s.endTs);
    if (sStart && (!start || sStart < start)) start = sStart;
    if (sEnd && (!end || sEnd > end)) end = sEnd;
  }

  return {
    ...(start && { start }),
    ...(end && { end }),
  };
}

function findingsAreDifferentScope(a: Finding, b: Finding): boolean {
  const aSessions = extractSessionIdsFromFinding(a);
  const bSessions = extractSessionIdsFromFinding(b);
  if (aSessions.length > 0 && bSessions.length > 0) {
    const bSet = new Set(bSessions);
    const hasIntersection = aSessions.some(id => bSet.has(id));
    if (!hasIntersection) return true;
  }

  const aRange = extractTimeRangeFromFinding(a);
  const bRange = extractTimeRangeFromFinding(b);
  if (aRange.start !== undefined && aRange.end !== undefined &&
      bRange.start !== undefined && bRange.end !== undefined) {
    const overlap = aRange.start <= bRange.end && bRange.start <= aRange.end;
    if (!overlap) return true;
  }

  return false;
}

function buildEvidenceIdFindingIndex(findings: Finding[]): Map<string, Finding> {
  const index = new Map<string, Finding>();
  for (const f of findings) {
    for (const id of extractEvidenceIdsFromFinding(f)) {
      if (!index.has(id)) index.set(id, f);
    }
  }
  return index;
}

function extractEvidenceIdsFromText(value: string): string[] {
  return dedupePreservingOrder(String(value || '').match(EVIDENCE_ID_GLOBAL_PATTERN) || []);
}

function filterScopeIncompatibleContradictions(
  contradictions: string[],
  findings: Finding[],
  emitter: ProgressEmitter
): string[] {
  if (!Array.isArray(contradictions) || contradictions.length === 0) return [];

  const evidenceIndex = buildEvidenceIdFindingIndex(findings);
  const frameCountIntervalHints = buildFrameCountIntervalHints(findings);
  const filtered: string[] = [];

  for (const contradiction of contradictions) {
    const ids = extractEvidenceIdsFromText(contradiction);
    if (ids.length < 2) {
      if (contradictionLooksCrossInterval(contradiction, frameCountIntervalHints)) {
        emitter.log(`[feedbackSynthesizer] Skip contradiction (likely cross-interval): ${contradiction}`);
        continue;
      }
      filtered.push(contradiction);
      continue;
    }

    const related: Finding[] = [];
    for (const id of ids) {
      const f = evidenceIndex.get(id);
      if (f && !related.includes(f)) related.push(f);
    }

    if (related.length < 2) {
      filtered.push(contradiction);
      continue;
    }

    let scopeIncompatible = false;
    for (let i = 0; i < related.length; i += 1) {
      for (let j = i + 1; j < related.length; j += 1) {
        if (findingsAreDifferentScope(related[i], related[j])) {
          scopeIncompatible = true;
          break;
        }
      }
      if (scopeIncompatible) break;
    }

    if (scopeIncompatible) {
      emitter.log(`[feedbackSynthesizer] Skip contradiction (different scope): ${contradiction}`);
      continue;
    }

    filtered.push(contradiction);
  }

  return filtered;
}

function contradictionMentionsFinding(contradiction: string, finding: Finding): boolean {
  const lower = String(contradiction || '').toLowerCase();
  const title = String(finding.title || '').toLowerCase();
  if (title && lower.includes(title)) return true;

  const evIds = extractEvidenceIdsFromFinding(finding);
  return evIds.some(id => lower.includes(id.toLowerCase()));
}

export interface SynthesisResult {
  newFindings: Finding[];
  confirmedFindings: Finding[];
  updatedHypotheses: Hypothesis[];
  informationGaps: string[];
}

/**
 * Synthesize feedback from multiple agent responses.
 * Uses LLM to correlate findings and update hypothesis confidence.
 *
 * Hypothesis updates are routed through messageBus to ensure
 * broadcast events fire and other agents get notified.
 */
export async function synthesizeFeedback(
  responses: AgentResponse[],
  sharedContext: SharedAgentContext,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter,
  messageBus?: AgentMessageBus,
  sessionContext?: EnhancedSessionContext
): Promise<SynthesisResult> {
  const allFindings: Finding[] = [];
  const newFindings: Finding[] = [];

  // Collect all findings from responses
  for (const response of responses) {
    allFindings.push(...response.findings);
  }

  // Semantic deduplication: group by category + severity, merge similar findings
  // This is more robust than simple title matching as it handles:
  // 1. Same issue reported with different wording
  // 2. Multiple agents supporting the same conclusion (boost confidence)
  const groupedFindings = new Map<string, Finding[]>();
  for (const finding of allFindings) {
    const titleKey = String(finding.title || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    const groupKey = `${finding.category || 'unknown'}:${finding.severity}:${titleKey || 'untitled'}`;
    if (!groupedFindings.has(groupKey)) {
      groupedFindings.set(groupKey, []);
    }
    groupedFindings.get(groupKey)!.push(finding);
  }

  // For each group, keep the highest-confidence finding and merge evidence
  const seenTitles = new Set<string>();
  for (const [, group] of groupedFindings) {
    // Sort by confidence (descending)
    group.sort((a, b) => (b.confidence || 0.5) - (a.confidence || 0.5));
    const best = group[0];

    // Skip if we've already seen this exact title
    if (seenTitles.has(best.title)) {
      continue;
    }
    seenTitles.add(best.title);

    // Merge evidence from other findings in the same group
    for (let i = 1; i < group.length; i++) {
      const otherEvidence = group[i].evidence;
      if (otherEvidence && Array.isArray(otherEvidence)) {
        best.evidence = [...(best.evidence || []), ...otherEvidence];
      }
    }

    // Boost confidence when multiple agents support the same conclusion
    if (group.length > 1) {
      best.confidence = Math.min(1, (best.confidence || 0.5) + 0.1);
    }

    newFindings.push(best);
  }

  // Use LLM to synthesize correlations and gaps
  const prompt = `综合以下 Agent 反馈：

${responses.map(r => `[${r.agentId}]:
- 发现: ${r.findings.map(f => formatFindingBrief(f)).join('\n  ') || '无'}
- 置信度: ${r.confidence.toFixed(2)}
- 建议: ${r.suggestions?.join('; ') || '无'}`).join('\n\n')}

当前假设:
${Array.from(sharedContext.hypotheses.values()).map(h => `- ${h.description} (${h.status})`).join('\n')}

请基于实际发现分析：
1. 哪些发现相互印证？（引用具体数据）
2. 是否存在数据矛盾？
3. 哪些假设得到数据支持或被否定？
4. 当前数据是否存在不一致或异常？
5. 若可能，请在矛盾描述中引用 evidence id（例如 ev_123...），便于后续追溯证据链。

矛盾判定约束（必须遵守）：
- 只有“同口径 + 同时间窗/同会话 + 同进程”下的数据冲突，才可标记为矛盾
- 不同区间（例如区间1 vs 区间2）的数值差异，属于区间差异，不是矛盾
- 如果无法确认同一时间窗，优先归类为“信息缺口”而不是“矛盾”

请以 JSON 返回：
{
  "correlatedFindings": ["相互印证的发现"],
  "contradictions": ["数据中的矛盾或不一致"],
  "hypothesisUpdates": [
    {
      "hypothesisId": "假设ID",
      "action": "support/weaken/reject",
      "confidence_delta": 0.1,
      "reason": "更新原因"
    }
  ],
  "informationGaps": ["已有数据中的不一致或异常"]
}

## 假设更新规则
- support: 发现支持该假设，增加置信度（+0.05 到 +0.2）
- weaken: 发现与该假设部分矛盾，降低置信度（-0.05 到 -0.2）但不否定
- reject: 发现明确否定该假设，将置信度设为 0 并标记为 rejected`;

  let informationGaps: string[] = [];

  try {
    const response = await modelRouter.callWithFallback(prompt, 'evaluation', {
      sessionId: sharedContext.sessionId,
      traceId: sharedContext.traceId,
      jsonMode: true,
      maxTokens: 2000,
      promptId: 'agent.feedbackSynthesizer',
      promptVersion: '1.0.0',
      contractVersion: 'feedback_synthesis_json@1.0.0',
    });
    const parsed = parseFeedbackSynthesisPayload(response.response, emitter);
    informationGaps = parsed.informationGaps || [];

    // Process contradictions - mark conflicting findings with reduced confidence
    // This prevents self-contradictory conclusions like "主线程耗时" vs "主线程阻塞 90%"
    const contradictions = filterScopeIncompatibleContradictions(
      parsed.contradictions || [],
      newFindings,
      emitter
    );
    if (contradictions.length > 0) {
      emitter.log(`[feedbackSynthesizer] Detected contradictions: ${contradictions.join('; ')}`);

      // Record contradictions into durable per-trace state (best-effort).
      for (const c of contradictions) {
        const evidenceIds = extractEvidenceIdsFromText(c);
        sessionContext?.recordTraceAgentContradiction({
          description: c,
          severity: 'major',
          ...(evidenceIds.length > 0 && { evidenceIds }),
        });
      }

      // Mark contradicted findings for downstream filtering
      for (const finding of newFindings) {
        const matchedReasons = contradictions.filter(c => contradictionMentionsFinding(c, finding));
        if (matchedReasons.length === 0) continue;

        // Reduce confidence once even if multiple contradiction entries mention the same finding.
        finding.confidence = Math.max(0.3, (finding.confidence || 0.7) - 0.3);
        finding.details = {
          ...finding.details,
          _contradicted: true,
          _contradictionReason: matchedReasons.join('；'),
        };
        emitter.log(`[feedbackSynthesizer] Marked finding "${finding.title}" as contradicted`);
      }

      // Also treat contradictions as top-priority gaps to drive next experiments.
      const cxGaps = contradictions.map(c => `矛盾: ${c}`);
      informationGaps = Array.from(new Set([...cxGaps, ...informationGaps]));
    }

    // Process hypothesis updates via messageBus (ensures broadcasts fire)
    if (parsed.hypothesisUpdates) {
      for (const update of parsed.hypothesisUpdates) {
        const hypothesis = sharedContext.hypotheses.get(update.hypothesisId);
        if (hypothesis) {
          const updated: Hypothesis = {
            ...hypothesis,
            updatedAt: Date.now(),
          };

          // Determine confidence adjustment
          // LLM can specify confidence_delta, otherwise use defaults
          const delta = typeof update.confidence_delta === 'number'
            ? Math.max(-0.3, Math.min(0.3, update.confidence_delta)) // Clamp to [-0.3, 0.3]
            : (update.action === 'support' ? 0.1 : -0.1);

          if (update.action === 'support') {
            // Support: increase confidence
            updated.confidence = Math.min(1, hypothesis.confidence + Math.abs(delta));
            // If confidence exceeds 0.85, mark as confirmed
            if (updated.confidence >= 0.85) {
              updated.status = 'confirmed';
            }
          } else if (update.action === 'weaken') {
            // Weaken: decrease confidence but don't reject
            updated.confidence = Math.max(0.1, hypothesis.confidence - Math.abs(delta));
            // Keep status as proposed or investigating
            if (updated.status === 'confirmed' && updated.confidence < 0.7) {
              updated.status = 'investigating';
            }
          } else if (update.action === 'reject') {
            // Reject: set confidence to 0 and mark as rejected
            updated.status = 'rejected';
            updated.confidence = 0;
          }

          if (messageBus) {
            messageBus.updateHypothesis(updated);
          } else {
            // Fallback: direct mutation (legacy callers without messageBus)
            sharedContext.hypotheses.set(updated.id, updated);
          }
        }
      }
    }
  } catch (error) {
    emitter.log(`Failed to synthesize feedback: ${error}`);
    emitter.emitUpdate('degraded', { module: 'feedbackSynthesizer', fallback: 'passthrough findings' });
  }

  return {
    newFindings,
    confirmedFindings: sharedContext.confirmedFindings,
    updatedHypotheses: Array.from(sharedContext.hypotheses.values()),
    informationGaps,
  };
}