// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { createSdkEnv, getSdkBinaryOption } from '../../agentv3/claudeConfig';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import type { CaseCandidate } from '../../types/caseEvolution';
import { CASE_EVOLUTION_ALLOWED_RELATION_KINDS } from './caseCandidateReviewValidator';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TURNS = 8;
const TEMPLATE_NAME = 'case-candidate-review';

const DECISION_ENUM = 'promote | reject | needs_more_evidence';
const SCROLLING_V1_REASON_CODES = [
  'buffer_stuffing',
  'sf_composition_slow',
  'binder_sync_blocking',
  'gc_jank',
  'gc_pressure_cascade',
  'input_handling_slow',
  'small_core_placement',
  'sched_delay_in_slice',
  'shader_compile',
  'gpu_fence_wait',
  'render_thread_heavy',
  'workload_heavy',
  'thermal_throttling',
  'cpu_max_limited',
  'big_core_low_freq',
  'freq_ramp_slow',
  'cpu_saturation',
  'scheduling_delay',
  'main_thread_file_io',
  'uninterruptible_wait',
  'binder_timeout',
  'lock_binder_wait',
  'unknown',
];

export type CaseCandidateReviewExecutionResult =
  | {ok: true; review: Record<string, unknown>}
  | {ok: false; reason: 'sdk_timeout' | 'sdk_error' | 'sdk_invalid'; details: string};

export interface CaseCandidateReviewSdkOptions {
  model?: string;
  timeoutMs?: number;
}

export interface BuildCaseCandidateReviewPromptOptions {
  loadTemplate?: (name: string) => string | undefined;
  render?: (template: string, vars: Record<string, string | number | undefined>) => string;
}

export function buildCaseCandidateReviewPrompt(
  candidate: CaseCandidate,
  opts: BuildCaseCandidateReviewPromptOptions = {},
): string {
  const template = (opts.loadTemplate ?? loadPromptTemplate)(TEMPLATE_NAME);
  if (!template) {
    throw new Error(`${TEMPLATE_NAME} prompt template not found`);
  }
  return (opts.render ?? renderTemplate)(template, {
    candidate_json: JSON.stringify(candidate, null, 2),
    allowed_decisions: DECISION_ENUM,
    allowed_reason_codes: SCROLLING_V1_REASON_CODES.join(', '),
    allowed_relation_kinds: CASE_EVOLUTION_ALLOWED_RELATION_KINDS.join(' | '),
  });
}

export async function executeCaseCandidateReviewViaSdk(
  candidate: CaseCandidate,
  opts: CaseCandidateReviewSdkOptions = {},
): Promise<CaseCandidateReviewExecutionResult> {
  let prompt: string;
  try {
    prompt = buildCaseCandidateReviewPrompt(candidate);
  } catch (err) {
    return {ok: false, reason: 'sdk_invalid', details: errorMessage(err)};
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? process.env.CLAUDE_LIGHT_MODEL ?? DEFAULT_MODEL;
  const sdkEnv = createSdkEnv();
  const stream = sdkQuery({
    prompt,
    options: {
      model,
      maxTurns: MAX_TURNS,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      stderr: (data: string) => {
        console.warn(`[CaseCandidateReviewAgentSdk] SDK stderr: ${data.trimEnd()}`);
      },
      ...getSdkBinaryOption(sdkEnv),
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(`[CaseCandidateReviewAgentSdk] timed out after ${timeoutMs / 1000}s`);
    try { stream.close(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    for await (const msg of stream) {
      if (timedOut) break;
      if (msg.type === 'result' && (msg as { subtype?: string }).subtype === 'success') {
        result = (msg as { result?: string }).result || '';
      }
    }
  } catch (err) {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
    return {ok: false, reason: 'sdk_error', details: errorMessage(err)};
  } finally {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
  }

  if (timedOut) {
    return {ok: false, reason: 'sdk_timeout', details: `${timeoutMs}ms budget exhausted`};
  }

  const parsed = extractJsonObject(result);
  if (!parsed) {
    return {ok: false, reason: 'sdk_invalid', details: 'no JSON object in agent response'};
  }
  return {ok: true, review: parsed};
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  extractJsonObject,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MODEL,
  MAX_TURNS,
  TEMPLATE_NAME,
};
