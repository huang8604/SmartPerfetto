// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Failure taxonomy — a single shared vocabulary for all three learning artifacts.
 *
 * Without this, the negative-pattern memory, the verifier's learned-misdiagnosis
 * store, and the future skill notes would each describe the same failure mode
 * with different strings ("vsync误报", "误判 VSync 卡顿", "VRR 帧时长被错误归因")
 * and never recognize each other. The hash here is computed from stable enum
 * fields only — no LLM-generated wording — so the same root cause always lands
 * in the same bucket.
 *
 * `FailureCategory` is a closed enum: review agents may *select* but not
 * invent. Unknown failure modes default to `unknown` and never trigger
 * supersede actions in PR9.
 *
 * See docs/architecture/self-improving-design.md §3 (Failure Taxonomy).
 */

import { createHash } from 'crypto';

export const FAILURE_CATEGORIES = [
  'misdiagnosis_vsync_vrr',
  'misdiagnosis_buffer_stuffing',
  'sql_missing_table',
  'sql_missing_column',
  'skill_empty_result',
  'tool_repeated_failure',
  'phase_missing_deep_drill',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_CATEGORY_DESCRIPTIONS: Readonly<Record<FailureCategory, string>> = {
  misdiagnosis_vsync_vrr: 'False jank attribution from VSync/VRR boundary effects',
  misdiagnosis_buffer_stuffing: 'False jank attribution from BufferQueue stuffing patterns',
  sql_missing_table: 'SQL referenced a table not present in the loaded trace',
  sql_missing_column: 'SQL referenced a column not present in the loaded table',
  skill_empty_result: 'Skill executed cleanly but returned zero rows',
  tool_repeated_failure: 'Same tool failed multiple times within one analysis',
  phase_missing_deep_drill: 'Required deep-drill phase was skipped or empty',
  unknown: 'Unclassified failure (excluded from supersede)',
};

export interface FailureModeInput {
  /** Scene classifier output (e.g. "scrolling", "startup"). Always lower-cased. */
  sceneType: string;
  /** Architecture detector output (e.g. "FLUTTER_SURFACEVIEW"). Always upper-cased. */
  archType: string;
  /** Closed-enum category. */
  category: FailureCategory;
  /** Optional skill or tool ID this failure is bound to. */
  toolOrSkillId?: string;
  /** Optional fine-grained error class within a category (e.g. SQL error code). */
  errorClass?: string;
}

/**
 * Stable, deterministic 16-char hex hash of a failure-mode key.
 *
 * Inputs are normalized (lower/upper-case, trimmed) so semantically identical
 * keys always produce the same hash. The hash uses sha256 truncated to 16 hex
 * chars (~64 bits of entropy) — collision risk for tens of thousands of
 * patterns is well below floating-point noise; the hash is identifier, not
 * cryptographic protection.
 */
export function computeFailureModeHash(input: FailureModeInput): string {
  const parts = [
    (input.sceneType || '').trim().toLowerCase(),
    (input.archType || '').trim().toUpperCase(),
    input.category,
    (input.toolOrSkillId || '').trim().toLowerCase(),
    (input.errorClass || '').trim().toLowerCase(),
  ];
  const joined = parts.join('::');
  return createHash('sha256').update(joined).digest('hex').substring(0, 16);
}

/** Type guard / runtime check for the closed enum. */
export function isKnownCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && (FAILURE_CATEGORIES as ReadonlyArray<string>).includes(value);
}

/**
 * Best-effort heuristic to derive a category from existing free-form text fields
 * (FailedApproach.reason, verification message, etc.). Used by the PR migration
 * to backfill `failureModeHash` on historical entries — never by the live path,
 * which receives the category explicitly from the review agent.
 *
 * Returns `unknown` when no heuristic matches, which by design means the entry
 * will never trigger supersede actions.
 */
export function inferCategoryFromText(text: string | undefined): FailureCategory {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (/\bno such table\b/.test(t)) return 'sql_missing_table';
  if (/\bno such column\b/.test(t)) return 'sql_missing_column';
  if (/(vsync|vrr).*(误判|误报|misdiagnos|false)/.test(t) || /(误判|误报).*(vsync|vrr)/.test(t)) {
    return 'misdiagnosis_vsync_vrr';
  }
  if (/(buffer.*stuff|stuff.*buffer)/.test(t)) return 'misdiagnosis_buffer_stuffing';
  if (/(empty result|0 rows|no rows|空结果)/.test(t)) return 'skill_empty_result';
  if (/(repeated|repeat).*(fail|error)/.test(t) || /(连续|多次).*(失败|错误)/.test(t)) {
    return 'tool_repeated_failure';
  }
  if (/(phase|阶段).*(missing|skipped|跳过|缺失|未执行)/.test(t)) return 'phase_missing_deep_drill';
  return 'unknown';
}
