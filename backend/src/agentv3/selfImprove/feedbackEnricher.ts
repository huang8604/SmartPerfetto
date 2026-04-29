// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Feedback validation + reverse-lookup helper.
 *
 * Pure functions so the logic can be unit-tested without HTTP plumbing.
 * Persisted entries are versioned via `schemaVersion` so consumers can evolve
 * the structure without breaking older JSONL lines.
 *
 * See docs/architecture/self-improving-design.md §15 (Provenance) for the full schema.
 */

const MAX_COMMENT_CHARS = 500;
const MAX_TRACE_ID_CHARS = 200;
const MAX_SCENE_TYPE_CHARS = 50;
const MAX_ARCHITECTURE_CHARS = 50;
const MAX_PACKAGE_NAME_CHARS = 200;
const MAX_PATTERN_ID_CHARS = 100;
const MAX_FINDING_ID_CHARS = 100;
const MAX_FINDING_IDS_LENGTH = 20;
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Schema accepted at POST /api/agent/v1/:sessionId/feedback.
 *
 * Backward-compatible: original clients (rating/comment/turnIndex only) keep working.
 * New clients may attach metadata that the backend would otherwise have to reverse-look up.
 */
export interface FeedbackInputSchema {
  rating: 'positive' | 'negative';
  comment?: string;
  turnIndex?: number;
  traceId?: string;
  sceneType?: string;
  architecture?: string;
  packageName?: string;
  findingIds?: string[];
  patternId?: string;
  schemaVersion?: number;
}

/**
 * Subset of in-memory session state needed for reverse lookup.
 *
 * Decoupled from `AnalysisSession` so the enricher stays pure and so future
 * lookup sources (SessionStateSnapshot, persistence layer) can satisfy the same
 * shape without dragging in their full type surface.
 */
export interface SessionLookup {
  traceId?: string;
  referenceTraceId?: string;
}

export interface EnrichedFeedbackEntry {
  schemaVersion: 1;
  sessionId: string;
  rating: 'positive' | 'negative';
  comment?: string;
  turnIndex?: number;
  traceId?: string;
  referenceTraceId?: string;
  sceneType?: string;
  architecture?: string;
  packageName?: string;
  findingIds?: string[];
  patternId?: string;
  timestamp: string;
  /** True when at least one field was filled by reverse lookup rather than the client body. */
  enrichedFromSession: boolean;
}

export type ValidationResult =
  | { ok: true; value: FeedbackInputSchema }
  | { ok: false; error: string };

type StringFieldKey = 'comment' | 'traceId' | 'sceneType' | 'architecture' | 'packageName' | 'patternId';

const STRING_FIELDS: ReadonlyArray<{ key: StringFieldKey; max: number }> = [
  { key: 'comment', max: MAX_COMMENT_CHARS },
  { key: 'traceId', max: MAX_TRACE_ID_CHARS },
  { key: 'sceneType', max: MAX_SCENE_TYPE_CHARS },
  { key: 'architecture', max: MAX_ARCHITECTURE_CHARS },
  { key: 'packageName', max: MAX_PACKAGE_NAME_CHARS },
  { key: 'patternId', max: MAX_PATTERN_ID_CHARS },
];

/**
 * Validate the raw HTTP body and produce a sanitized FeedbackInputSchema.
 *
 * Truncates over-long string fields rather than rejecting — matches the
 * existing `comment.substring(0, 500)` convention in agentRoutes.ts. Hard-rejects
 * only for type errors and unknown rating / schemaVersion values.
 */
export function validateFeedbackInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;

  if (raw.schemaVersion !== undefined) {
    if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `unsupported schemaVersion (got ${String(raw.schemaVersion)}, expected ${SUPPORTED_SCHEMA_VERSION})`,
      };
    }
  }

  if (raw.rating !== 'positive' && raw.rating !== 'negative') {
    return { ok: false, error: 'rating must be "positive" or "negative"' };
  }

  const value: FeedbackInputSchema = { rating: raw.rating };

  for (const { key, max } of STRING_FIELDS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return { ok: false, error: `${key} must be a string` };
    }
    value[key] = v.substring(0, max);
  }

  if (raw.turnIndex !== undefined) {
    if (typeof raw.turnIndex !== 'number' || !Number.isFinite(raw.turnIndex) || raw.turnIndex < 0) {
      return { ok: false, error: 'turnIndex must be a non-negative finite number' };
    }
    value.turnIndex = Math.floor(raw.turnIndex);
  }

  if (raw.findingIds !== undefined) {
    if (!Array.isArray(raw.findingIds)) {
      return { ok: false, error: 'findingIds must be an array' };
    }
    const cleaned: string[] = [];
    for (const id of raw.findingIds) {
      if (typeof id !== 'string') {
        return { ok: false, error: 'findingIds entries must be strings' };
      }
      cleaned.push(id.substring(0, MAX_FINDING_ID_CHARS));
      if (cleaned.length >= MAX_FINDING_IDS_LENGTH) break;
    }
    value.findingIds = cleaned;
  }

  return { ok: true, value };
}

/**
 * Combine validated client input with best-effort reverse lookup from in-memory
 * session state. When the session has been cleaned up (after 30 min idle) the
 * lookup fields stay undefined — callers can later supplement from durable
 * snapshots if needed.
 */
export function enrichFeedbackEntry(
  sessionId: string,
  input: FeedbackInputSchema,
  session: SessionLookup | null,
  now: Date = new Date(),
): EnrichedFeedbackEntry {
  let enrichedFromSession = false;

  let traceId = input.traceId;
  if (!traceId && session?.traceId) {
    traceId = session.traceId.substring(0, MAX_TRACE_ID_CHARS);
    enrichedFromSession = true;
  }

  let referenceTraceId: string | undefined;
  if (session?.referenceTraceId) {
    referenceTraceId = session.referenceTraceId.substring(0, MAX_TRACE_ID_CHARS);
    enrichedFromSession = true;
  }

  const entry: EnrichedFeedbackEntry = {
    schemaVersion: 1,
    sessionId,
    rating: input.rating,
    timestamp: now.toISOString(),
    enrichedFromSession,
  };

  if (input.comment !== undefined) entry.comment = input.comment;
  if (input.turnIndex !== undefined) entry.turnIndex = input.turnIndex;
  if (traceId) entry.traceId = traceId;
  if (referenceTraceId) entry.referenceTraceId = referenceTraceId;
  if (input.sceneType) entry.sceneType = input.sceneType;
  if (input.architecture) entry.architecture = input.architecture;
  if (input.packageName) entry.packageName = input.packageName;
  if (input.findingIds && input.findingIds.length > 0) entry.findingIds = input.findingIds;
  if (input.patternId) entry.patternId = input.patternId;

  return entry;
}
