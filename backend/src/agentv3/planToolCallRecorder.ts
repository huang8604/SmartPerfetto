// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  expectedCallMatchesRecord,
  expectedToolNames,
  formatExpectedCall,
  isEvidenceCapableToolName,
  phaseMatchesCall,
  type AnalysisPlanV3,
  type ExpectedCall,
  type PlanPhase,
  type ToolCallRecord,
} from './types';
import { summarizeToolCallInput } from './toolCallSummary';

const MCP_NAME_PREFIX = 'mcp__smartperfetto__';
const MAX_PLAN_TOOL_CALL_LOG = 100;

export interface PlanToolCallRecorderInput {
  toolName: string;
  input?: unknown;
  resultText?: string;
  timestamp?: number;
}

export interface PlanEvidenceGap {
  phase: PlanPhase;
  matchedCalls: ToolCallRecord[];
  missingExpectedCalls: ExpectedCall[];
}

function shortToolName(toolName: string): string {
  return toolName.startsWith(MCP_NAME_PREFIX) ? toolName.slice(MCP_NAME_PREFIX.length) : toolName;
}

function parseLeadingJsonObject(text: string): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractPlanPhaseIdFromToolResult(resultText?: string): string | undefined {
  if (!resultText) return undefined;
  const candidates: string[] = [resultText];
  try {
    const parsed = JSON.parse(resultText);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
        candidates.push((entry as any).text);
      }
    }
  } catch {
    // Fall through to leading-object parsing below.
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const parsed = parseLeadingJsonObject(trimmed);
    const planPhaseId = parsed?.planPhaseId;
    if (typeof planPhaseId === 'string' && planPhaseId.trim()) return planPhaseId.trim();
  }
  return undefined;
}

export function recordPlanToolCall(
  plan: AnalysisPlanV3 | null | undefined,
  input: PlanToolCallRecorderInput,
): ToolCallRecord | undefined {
  if (!plan) return undefined;
  if (!Array.isArray(plan.toolCallLog)) {
    plan.toolCallLog = [];
  }
  const shortName = shortToolName(input.toolName);
  const canSatisfyEvidence = isEvidenceCapableToolName(shortName);
  const callSummary = summarizeToolCallInput(shortName, input.input);
  const candidate: ToolCallRecord = {
    toolName: input.toolName,
    timestamp: input.timestamp ?? Date.now(),
    ...callSummary,
  };

  const expectedGapPhase = canSatisfyEvidence ? findBestPhaseForExpectedCallGap(plan, candidate) : undefined;
  const toolReturnedPhaseId = extractPlanPhaseIdFromToolResult(input.resultText);
  let matchedPhaseId = expectedGapPhase?.id;

  if (!matchedPhaseId && canSatisfyEvidence) {
    matchedPhaseId = toolReturnedPhaseId &&
      plan.phases.some(p => p.id === toolReturnedPhaseId)
      ? toolReturnedPhaseId
      : undefined;
  }

  if (!matchedPhaseId && canSatisfyEvidence) {
    const activePhase = plan.phases.find(p => p.status === 'in_progress');
    if (activePhase && phaseMatchesCall(activePhase, candidate)) {
      matchedPhaseId = activePhase.id;
    }
  }
  if (!matchedPhaseId && canSatisfyEvidence) {
    const pendingMatch = plan.phases.find(p =>
      p.status === 'pending' && phaseMatchesCall(p, candidate),
    );
    matchedPhaseId = pendingMatch?.id;
  }

  const record = { ...candidate, matchedPhaseId };
  plan.toolCallLog.push(record);
  if (plan.toolCallLog.length > MAX_PLAN_TOOL_CALL_LOG) {
    plan.toolCallLog.splice(0, plan.toolCallLog.length - MAX_PLAN_TOOL_CALL_LOG);
  }
  return record;
}

export function findMissingExpectedCallsForPhase(
  phase: PlanPhase,
  toolCallLog: readonly ToolCallRecord[],
): ExpectedCall[] {
  const expectedCalls = phase.expectedCalls ?? [];
  if (expectedCalls.length === 0) return [];
  const matchedCalls = toolCallLog.filter(call => call.matchedPhaseId === phase.id);
  return expectedCalls
    .filter(call => !matchedCalls.some(record => expectedCallMatchesRecord(call, record)));
}

export function findBestPhaseForExpectedCallGap(
  plan: AnalysisPlanV3,
  record: ToolCallRecord,
): PlanPhase | undefined {
  const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
  const phasesWithMatchingGap = plan.phases.filter(phase => {
    if (phase.status === 'skipped') return false;
    const missingExpectedCalls = findMissingExpectedCallsForPhase(phase, toolCallLog);
    return missingExpectedCalls.some(call => expectedCallMatchesRecord(call, record));
  });
  if (phasesWithMatchingGap.length === 0) return undefined;

  const statusPriority: Record<PlanPhase['status'], number> = {
    in_progress: 0,
    completed: 1,
    pending: 2,
    skipped: 3,
  };
  return [...phasesWithMatchingGap].sort((a, b) => {
    const statusDelta = statusPriority[a.status] - statusPriority[b.status];
    if (statusDelta !== 0) return statusDelta;
    return plan.phases.indexOf(a) - plan.phases.indexOf(b);
  })[0];
}

export function findCompletedPhaseEvidenceGaps(plan: AnalysisPlanV3): PlanEvidenceGap[] {
  const gaps: PlanEvidenceGap[] = [];
  const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
  for (const phase of plan.phases) {
    if (phase.status !== 'completed') continue;
    const matchedCalls = toolCallLog.filter(call => call.matchedPhaseId === phase.id);
    const missingExpectedCalls = findMissingExpectedCallsForPhase(phase, toolCallLog);
    if (missingExpectedCalls.length > 0) {
      gaps.push({ phase, matchedCalls, missingExpectedCalls });
    }
  }
  return gaps;
}

export function formatPlanEvidenceGap(gap: PlanEvidenceGap, outputLanguage: string = 'zh-CN'): string {
  const missing = gap.missingExpectedCalls.map(formatExpectedCall).join(', ');
  const expected = expectedToolNames(gap.phase).join(', ');
  if (outputLanguage === 'en') {
    return `Phase "${gap.phase.name}" (${gap.phase.id}) is missing required structured calls: ${missing}; expected: ${expected}`;
  }
  return `阶段 "${gap.phase.name}" (${gap.phase.id}) 缺少结构化预期调用: ${missing}; 阶段预期: ${expected}`;
}
