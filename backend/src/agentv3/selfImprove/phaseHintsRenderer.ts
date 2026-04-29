// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Render a phase_hints YAML entry from a review agent's strict-JSON proposal.
 *
 * The LLM never writes YAML. It selects a closed `failureCategoryEnum`,
 * supplies evidence + candidate fields, and the backend deterministically
 * renders the entry from a per-category template. Same input → same output;
 * the patchFingerprint can be relied on across re-renders.
 *
 * Schema validation runs first and bails on:
 *   - unknown failureCategoryEnum (closed enum from PR4)
 *   - candidateKeywords length / per-token length violation
 *   - candidateConstraints over the per-template content scan or length cap
 *   - candidateCriticalTools that aren't in the supplied registry (when one
 *     is provided)
 *
 * See docs/architecture/self-improving-design.md §13 (Phase Hints Template-Driven Patching).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  FAILURE_CATEGORIES,
  isKnownCategory,
  type FailureCategory,
} from './failureTaxonomy';
import { scanContent, formatThreats } from './contentScanner';
import { computeHintFingerprint } from './hintFingerprint';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', 'strategies', 'phase_hint_templates');

const MAX_KEYWORDS = 6;
const MAX_KEYWORD_CHARS = 40;
const MAX_CONSTRAINTS_CHARS = 400;
const MAX_TOOLS = 6;
const MAX_TOOL_CHARS = 80;
const MAX_EVIDENCE_CHARS = 600;

export interface PhaseHintProposal {
  failureCategoryEnum: FailureCategory;
  evidenceSummary: string;
  candidateKeywords: string[];
  candidateConstraints: string;
  candidateCriticalTools: string[];
  /** Optional override for the timestamp baked into the rendered entry. */
  appliedAt?: number;
}

export type RenderRejectReason =
  | 'unknown_category'
  | 'no_template'
  | 'invalid_payload'
  | 'tool_not_in_registry'
  | 'security_scan';

export type RenderResult =
  | { ok: true; yaml: string; patchFingerprint: string; phaseHintId: string }
  | { ok: false; reason: RenderRejectReason; details: string };

export interface RenderOptions {
  templatesDir?: string;
  toolRegistry?: ReadonlySet<string>;
}

/**
 * Validate a proposal and emit a stable patch fingerprint without rendering.
 * Useful when the caller needs to detect a duplicate proposal before the
 * (more expensive) template substitution.
 */
export function validateProposal(
  raw: unknown,
  toolRegistry?: ReadonlySet<string>,
): { ok: true; value: PhaseHintProposal } | { ok: false; reason: RenderRejectReason; details: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_payload', details: 'proposal must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;

  if (!isKnownCategory(r.failureCategoryEnum)) {
    return {
      ok: false,
      reason: 'unknown_category',
      details: `failureCategoryEnum must be one of: ${FAILURE_CATEGORIES.join(', ')}`,
    };
  }

  if (typeof r.evidenceSummary !== 'string' || r.evidenceSummary.trim().length === 0) {
    return { ok: false, reason: 'invalid_payload', details: 'evidenceSummary must be a non-empty string' };
  }

  const keywords = normalizeStringArray(r.candidateKeywords, MAX_KEYWORDS, MAX_KEYWORD_CHARS);
  if (keywords === 'invalid') {
    return { ok: false, reason: 'invalid_payload', details: 'candidateKeywords must be string[]' };
  }

  const constraints = typeof r.candidateConstraints === 'string'
    ? r.candidateConstraints.substring(0, MAX_CONSTRAINTS_CHARS)
    : '';

  const tools = normalizeStringArray(r.candidateCriticalTools, MAX_TOOLS, MAX_TOOL_CHARS);
  if (tools === 'invalid') {
    return { ok: false, reason: 'invalid_payload', details: 'candidateCriticalTools must be string[]' };
  }
  if (toolRegistry && tools.length > 0) {
    const missing = tools.find(t => !toolRegistry.has(t));
    if (missing) {
      return { ok: false, reason: 'tool_not_in_registry', details: `unknown tool/skill: ${missing}` };
    }
  }

  // Security scan across every free-form surface the agent could pollute.
  for (const text of [r.evidenceSummary as string, constraints, ...keywords, ...tools]) {
    const matches = scanContent(text);
    if (matches.length > 0) {
      return { ok: false, reason: 'security_scan', details: formatThreats(matches) };
    }
  }

  const value: PhaseHintProposal = {
    failureCategoryEnum: r.failureCategoryEnum,
    evidenceSummary: (r.evidenceSummary as string).substring(0, MAX_EVIDENCE_CHARS),
    candidateKeywords: keywords,
    candidateConstraints: constraints,
    candidateCriticalTools: tools,
    appliedAt: typeof r.appliedAt === 'number' ? r.appliedAt : undefined,
  };
  return { ok: true, value };
}

/**
 * Render a phase_hints entry. Returns a yaml string that callers append
 * verbatim to the target strategy file's `phase_hints:` block.
 */
export function renderPhaseHint(
  raw: unknown,
  opts: RenderOptions = {},
): RenderResult {
  const validation = validateProposal(raw, opts.toolRegistry);
  if (!validation.ok) return validation;
  const proposal = validation.value;

  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR;
  const templatePath = path.join(templatesDir, `${proposal.failureCategoryEnum}.template.yaml`);
  if (!fs.existsSync(templatePath)) {
    return {
      ok: false,
      reason: 'no_template',
      details: `no template at ${templatePath} — no auto-patch for this category yet`,
    };
  }

  const fingerprint = computePatchFingerprint(proposal);
  const phaseHintId = `auto_${proposal.failureCategoryEnum.replace(/_/g, '-')}_${fingerprint.substring(0, 8)}`;

  const obj: Record<string, unknown> = {
    id: phaseHintId,
    keywords: [...proposal.candidateKeywords].sort(),
    constraints: proposal.candidateConstraints,
    critical_tools: [...proposal.candidateCriticalTools].sort(),
    critical: false,
    auto_generated: true,
    applied_at: proposal.appliedAt ?? Date.now(),
    evidence: proposal.evidenceSummary,
  };

  // Wrap in a one-element array so the result drops cleanly into the
  // existing `phase_hints:` block under a strategy file's frontmatter.
  const rendered = yaml.dump([obj], {
    noRefs: true,
    sortKeys: false,
    lineWidth: 100,
  });

  return { ok: true, yaml: rendered, patchFingerprint: fingerprint, phaseHintId };
}

function computePatchFingerprint(proposal: PhaseHintProposal): string {
  // Phase 0.1 of v2.1 — share canonical form with `strategyFingerprint` so
  // a freshly-rendered auto-patch's fingerprint matches what `detectDrift`
  // computes off the on-disk hint. The renderer always emits
  // `critical: false`, so the canonical input fixes that here.
  return computeHintFingerprint({
    keywords: proposal.candidateKeywords,
    constraints: proposal.candidateConstraints,
    criticalTools: proposal.candidateCriticalTools,
    critical: false,
  });
}

function normalizeStringArray(input: unknown, maxLen: number, maxItemChars: number): string[] | 'invalid' {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return 'invalid';
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return 'invalid';
    out.push(item.substring(0, maxItemChars));
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Useful for tests + the patch orchestration layer. */
export const __testing = {
  TEMPLATES_DIR,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_CONSTRAINTS_CHARS,
  MAX_TOOLS,
  MAX_TOOL_CHARS,
  computePatchFingerprint,
};
