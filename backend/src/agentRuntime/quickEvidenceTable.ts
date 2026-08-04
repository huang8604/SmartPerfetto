// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';

import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import type { DataEnvelope, DataEnvelopeTraceSide } from '../types/dataContract';

export function stableQuickEvidenceHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

export function runtimeSkillSourceToolCallId(skillId: string, queryHash: string): string {
  return `runtime-skill:${skillId}:${queryHash}`;
}

export function withQuickEvidenceProvenance(
  envelope: DataEnvelope,
  input: {
    skillId: string;
    traceId: string;
    traceSide: DataEnvelopeTraceSide;
    queryHash: string;
    sourceToolCallId: string;
    index: number;
    planPhaseGoal: string;
    toolNarration: string;
    producerReason: string;
    intent: string;
    outputLanguage?: OutputLanguage;
  },
): DataEnvelope {
  const stepId = envelope.meta.stepId ?? `result_${input.index}`;
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  return {
    ...envelope,
    meta: {
      ...envelope.meta,
      evidenceRefId: `data:skill:${input.skillId}:${input.traceSide}:${input.queryHash}:${stepId}`,
      traceSide: input.traceSide,
      traceId: input.traceId,
      queryHash: input.queryHash,
      sourceToolCallId: input.sourceToolCallId,
      paramsHash: input.queryHash,
      planPhaseId: 'quick',
      planPhaseTitle: localize(outputLanguage, '快速回答', 'Quick answer'),
      planPhaseGoal: input.planPhaseGoal,
      planPhaseAttribution: 'active',
      toolNarration: input.toolNarration,
      producerReason: input.producerReason,
      intent: input.intent,
    },
  };
}

export function columnIndex(columns: string[]): Map<string, number> {
  return new Map(columns.map((column, index) => [column, index]));
}

export function rowValue(
  row: unknown[],
  index: Map<string, number>,
  column: string,
): unknown {
  const columnIndexValue = index.get(column);
  return columnIndexValue === undefined ? undefined : row[columnIndexValue];
}

export function numericValue(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function primitiveValue(value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

export function cellText(value: unknown): string {
  const text = String(value ?? '-').replace(/\s+/g, ' ').trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 119)}...`;
}

export function findFirstTableEnvelope(envelopes: DataEnvelope[]): DataEnvelope | undefined {
  return envelopes.find(envelope =>
    Array.isArray(envelope.data.columns) &&
    Array.isArray(envelope.data.rows) &&
    envelope.data.rows.length > 0);
}

export function envelopeRows(envelope: DataEnvelope): unknown[][] {
  return Array.isArray(envelope.data.rows) ? envelope.data.rows : [];
}
