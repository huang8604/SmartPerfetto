// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  UiActionKind,
  UiActionProposalSource,
  UiActionProposalV1,
  UiNavigateRangePayload,
  UiNavigateTimelinePayload,
  UiOpenEvidenceTablePayload,
  UiPinEvidencePayload,
} from '../types/dataContract';
import { VALID_UI_ACTION_KINDS } from '../types/dataContract';

export const DEFAULT_MAX_UI_ACTION_PROPOSALS = 5;

const UI_ACTION_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const NON_NEGATIVE_INTEGER_RE = /^(?:0|[1-9]\d{0,30})$/;

export interface SanitizeUiActionProposalOptions {
  currentTraceId?: string;
  maxProposals?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function readOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return readString(value, maxLength);
}

function isUiActionKind(value: unknown): value is UiActionKind {
  return typeof value === 'string' && VALID_UI_ACTION_KINDS.includes(value as UiActionKind);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every(key => allowed.has(key));
}

function readNsString(value: unknown): string | undefined {
  const text = readString(value, 31);
  if (!text || !NON_NEGATIVE_INTEGER_RE.test(text)) return undefined;
  return text;
}

function traceMatches(traceId: string | undefined, currentTraceId: string | undefined): boolean {
  return !traceId || !currentTraceId || traceId === currentTraceId;
}

function sanitizeSource(value: unknown): UiActionProposalSource {
  if (!isRecord(value)) return {};
  const source: UiActionProposalSource = {};
  const evidenceRefId = readOptionalString(value.evidenceRefId, 240);
  if (evidenceRefId) source.evidenceRefId = evidenceRefId;
  const artifactId = readOptionalString(value.artifactId, 160);
  if (artifactId) source.artifactId = artifactId;
  const skillId = readOptionalString(value.skillId, 120);
  if (skillId) source.skillId = skillId;
  const sourceToolCallId = readOptionalString(value.sourceToolCallId, 160);
  if (sourceToolCallId) source.sourceToolCallId = sourceToolCallId;
  const reportSection = readOptionalString(value.reportSection, 120);
  if (reportSection) source.reportSection = reportSection;
  return source;
}

function sanitizeTimelinePayload(
  value: unknown,
  options: SanitizeUiActionProposalOptions,
): UiNavigateTimelinePayload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['ts', 'traceId'])) return undefined;
  const ts = readNsString(value.ts);
  if (!ts) return undefined;
  const traceId = readOptionalString(value.traceId, 160);
  if (!traceMatches(traceId, options.currentTraceId)) return undefined;
  return traceId ? { ts, traceId } : { ts };
}

function sanitizeRangePayload(
  value: unknown,
  options: SanitizeUiActionProposalOptions,
): UiNavigateRangePayload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['startNs', 'endNs', 'traceId'])) return undefined;
  const startNs = readNsString(value.startNs);
  const endNs = readNsString(value.endNs);
  if (!startNs || !endNs || BigInt(endNs) <= BigInt(startNs)) return undefined;
  const traceId = readOptionalString(value.traceId, 160);
  if (!traceMatches(traceId, options.currentTraceId)) return undefined;
  return traceId ? { startNs, endNs, traceId } : { startNs, endNs };
}

function sanitizeOpenTablePayload(value: unknown): UiOpenEvidenceTablePayload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['artifactId', 'evidenceRefId'])) return undefined;
  const artifactId = readString(value.artifactId, 160);
  if (!artifactId) return undefined;
  const evidenceRefId = readOptionalString(value.evidenceRefId, 240);
  return evidenceRefId ? { artifactId, evidenceRefId } : { artifactId };
}

function sanitizePinPayload(value: unknown): UiPinEvidencePayload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['evidenceRefId'])) return undefined;
  const evidenceRefId = readString(value.evidenceRefId, 240);
  return evidenceRefId ? { evidenceRefId } : undefined;
}

function sanitizeOneProposal(
  value: unknown,
  options: SanitizeUiActionProposalOptions,
): UiActionProposalV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.requiresConfirmation !== true) return undefined;
  const id = readString(value.id, 160);
  if (!id || !UI_ACTION_ID_RE.test(id)) return undefined;
  const kind = isUiActionKind(value.kind) ? value.kind : undefined;
  if (!kind) return undefined;
  const title = readString(value.title, 80);
  const reason = readString(value.reason, 180);
  if (!title || !reason) return undefined;
  const source = sanitizeSource(value.source);

  switch (kind) {
    case 'navigate_timeline': {
      const payload = sanitizeTimelinePayload(value.payload, options);
      return payload ? {
        schemaVersion: 1,
        id,
        kind,
        title,
        reason,
        source,
        payload,
        requiresConfirmation: true,
      } : undefined;
    }
    case 'navigate_range': {
      const payload = sanitizeRangePayload(value.payload, options);
      return payload ? {
        schemaVersion: 1,
        id,
        kind,
        title,
        reason,
        source,
        payload,
        requiresConfirmation: true,
      } : undefined;
    }
    case 'open_evidence_table': {
      const payload = sanitizeOpenTablePayload(value.payload);
      return payload ? {
        schemaVersion: 1,
        id,
        kind,
        title,
        reason,
        source,
        payload,
        requiresConfirmation: true,
      } : undefined;
    }
    case 'pin_evidence': {
      const payload = sanitizePinPayload(value.payload);
      return payload ? {
        schemaVersion: 1,
        id,
        kind,
        title,
        reason,
        source,
        payload,
        requiresConfirmation: true,
      } : undefined;
    }
    default:
      return undefined;
  }
}

function proposalDedupeKey(proposal: UiActionProposalV1): string {
  return `${proposal.kind}:${JSON.stringify(proposal.payload)}`;
}

export function sanitizeUiActionProposals(
  value: unknown,
  options: SanitizeUiActionProposalOptions = {},
): UiActionProposalV1[] {
  if (!Array.isArray(value)) return [];
  const maxProposals = Math.max(0, Math.min(
    options.maxProposals ?? DEFAULT_MAX_UI_ACTION_PROPOSALS,
    DEFAULT_MAX_UI_ACTION_PROPOSALS,
  ));
  const proposals: UiActionProposalV1[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (proposals.length >= maxProposals) break;
    const proposal = sanitizeOneProposal(item, options);
    if (!proposal) continue;
    const key = proposalDedupeKey(proposal);
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(proposal);
  }

  return proposals;
}
