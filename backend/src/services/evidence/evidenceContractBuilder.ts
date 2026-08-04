// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type {
  ConclusionClaimKind,
  ConclusionContract,
  ConclusionContractClaimItem,
  ConclusionContractClaimReference,
} from '../../agent/core/conclusionContract';
import type { ComparisonReportSection } from '../../agentv3/sessionStateSnapshot';
import type { DataEnvelope, DataPayload, DataEnvelopeTraceSide } from '../../types/dataContract';
import type {
  ClaimKindV1,
  EvidencePaneSide,
  ClaimSupportV1,
  EvidenceAnchorV1,
  EvidenceCellV1,
  EvidenceContractV1,
  EvidenceIdentityV1,
  EvidenceProducerKind,
  EvidenceSupportLevel,
  EvidenceTimeRangeV1,
  TraceTimestampNs,
} from '../../types/evidenceContract';
import { evidenceValuesMatch } from './valueComparison';

export interface BuildEvidenceContractInput {
  conclusionContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
  comparisonReportSection?: ComparisonReportSection;
}

interface EnvelopeMatch {
  envelope: DataEnvelope;
  row?: Record<string, unknown>;
  rowIndex?: number;
  missingReason?: string;
}

function stableHash(value: unknown): string {
  return crypto
    .createHash('sha1')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

function sanitizeIdPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 80);
}

function inferClaimKind(
  claim: ConclusionContractClaimItem,
  references: ConclusionContractClaimReference[],
): ClaimKindV1 {
  if (claim.kind && !(claim.kind === 'inference' && references.length > 0)) return claim.kind;
  if (references.some(ref => typeof ref.value === 'number')) return 'numeric';
  if (references.some(ref => {
    const column = String(ref.column || '').toLowerCase();
    return column === 'ts' || column.endsWith('_ts') || column.includes('timestamp') || column.includes('dur');
  })) return 'time_range';
  if (references.some(ref => {
    const column = String(ref.column || '').toLowerCase();
    return column.includes('process') || column.includes('thread') || column === 'upid' || column === 'utid' || column === 'pid' || column === 'tid';
  })) return 'identity';
  return references.length > 0 ? 'categorical' : 'inference';
}

function rowsAsObjects(envelope: DataEnvelope): Record<string, unknown>[] {
  const data = envelope.data as DataPayload | undefined;
  if (!data || !Array.isArray(data.rows)) return [];
  const columns = Array.isArray(data.columns)
    ? data.columns.map(col => String(col))
    : [];
  return data.rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      columns.forEach((col, index) => {
        record[col] = row[index];
      });
    }
    return record;
  });
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function valuesMatch(expected: unknown, actual: unknown): boolean {
  return evidenceValuesMatch(expected, actual);
}

function evidenceCellCheckStatus(cell: EvidenceCellV1): 'matched' | 'mismatch' | 'not_checked' {
  if (cell.value === undefined) return 'not_checked';
  const actual = cell.actualValue !== undefined ? cell.actualValue : cell.displayValue;
  return valuesMatch(cell.value, actual) ? 'matched' : 'mismatch';
}

function rowMatchesSelector(row: Record<string, unknown>, selector: Record<string, string | number | boolean>): boolean {
  return Object.entries(selector).every(([key, expected]) => scalarEquals(row[key], expected));
}

function normalizeSourceRef(value: string): string {
  const text = String(value || '').trim();
  const chinese = text.match(/^(?:数据)?(表|摘要|指标|图|图表|文本|时间线)\s*([0-9]+)$/);
  if (chinese) {
    const prefixMap: Record<string, string> = {
      表: 'table',
      摘要: 'summary',
      指标: 'metric',
      图: 'chart',
      图表: 'chart',
      文本: 'text',
      时间线: 'timeline',
    };
    return `${prefixMap[chinese[1]]}:${Number(chinese[2])}`;
  }
  const english = text.match(/^(?:data\s*)?(table|summary|metric|chart|figure|text|timeline)\s*([0-9]+)$/i);
  if (english) {
    const kind = english[1].toLowerCase() === 'figure' ? 'chart' : english[1].toLowerCase();
    return `${kind}:${Number(english[2])}`;
  }
  return text.toLowerCase();
}

function sourceRefAliases(envelope: DataEnvelope, ordinal: number): Array<string | undefined> {
  const format = envelope.display?.format;
  const kind = format === 'summary'
    ? 'summary'
    : format === 'metric'
      ? 'metric'
      : format === 'chart'
        ? 'chart'
        : format === 'text'
          ? 'text'
          : format === 'timeline'
            ? 'timeline'
            : 'table';
  const zhPrefix: Record<string, string[]> = {
    table: ['表', '数据表'],
    summary: ['摘要'],
    metric: ['指标'],
    chart: ['图', '图表'],
    text: ['文本'],
    timeline: ['时间线'],
  };
  const enPrefix: Record<string, string[]> = {
    table: ['Table', 'Data Table'],
    summary: ['Summary'],
    metric: ['Metric'],
    chart: ['Chart', 'Figure'],
    text: ['Text'],
    timeline: ['Timeline'],
  };
  return [
    ...(zhPrefix[kind] || []).map(prefix => `${prefix} ${ordinal}`),
    ...(enPrefix[kind] || []).map(prefix => `${prefix} ${ordinal}`),
    envelope.display?.title,
    envelope.meta?.source,
    envelope.meta?.skillId,
    envelope.meta?.stepId,
  ];
}

function evidenceRefIdAliases(value: string | undefined): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const aliases = new Set<string>([raw]);
  const artifactMatch = raw.match(/^data:(art-\d+)$/i);
  if (artifactMatch) aliases.add(artifactMatch[1]);
  const evidenceArtifactMatch = raw.match(/^ev_(art-\d+)$/i);
  if (evidenceArtifactMatch) aliases.add(evidenceArtifactMatch[1]);
  return Array.from(aliases);
}

function refEvidenceIdMatchesEnvelope(env: DataEnvelope, ref: ConclusionContractClaimReference): boolean {
  if (!ref.evidenceRefId) return false;
  const meta = env.meta || {};
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  const aliases = evidenceRefIdAliases(ref.evidenceRefId);
  return aliases.includes(String(meta.evidenceRefId || ''))
    || aliases.includes(String(metaArtifactId || ''))
    || aliases.includes(String(metaSourceArtifactId || ''));
}

function refMatchesSourceRef(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  if (!ref.sourceRef) return false;
  const target = normalizeSourceRef(ref.sourceRef);
  return sourceRefAliases(env, ordinal)
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    .some(alias => normalizeSourceRef(alias) === target);
}

function refMatchesAnyEnvelopeIdentifier(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  const meta = env.meta || {};
  if (refEvidenceIdMatchesEnvelope(env, ref)) return true;
  if (ref.sourceToolCallId && meta.sourceToolCallId === ref.sourceToolCallId) return true;
  if (refMatchesSourceRef(env, ref, ordinal)) return true;
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  if (ref.artifactId && (metaArtifactId === ref.artifactId || metaSourceArtifactId === ref.artifactId)) return true;
  if (ref.sourceArtifactId && (metaSourceArtifactId === ref.sourceArtifactId || metaArtifactId === ref.sourceArtifactId)) return true;
  return false;
}

function refMatchesAllProvidedEnvelopeIdentifiers(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  const meta = env.meta || {};
  if (ref.evidenceRefId && !refEvidenceIdMatchesEnvelope(env, ref)) return false;
  if (ref.sourceToolCallId && meta.sourceToolCallId !== ref.sourceToolCallId) return false;
  if (ref.sourceRef && !refMatchesSourceRef(env, ref, ordinal)) return false;
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  if (ref.artifactId && metaArtifactId !== ref.artifactId && metaSourceArtifactId !== ref.artifactId) return false;
  if (ref.sourceArtifactId && metaSourceArtifactId !== ref.sourceArtifactId && metaArtifactId !== ref.sourceArtifactId) return false;
  return true;
}

function resolveRowAndCell(envelope: DataEnvelope, ref: ConclusionContractClaimReference): Omit<EnvelopeMatch, 'envelope'> {
  const rows = rowsAsObjects(envelope);
  let row: Record<string, unknown> | undefined;
  let rowIndex: number | undefined;
  let missingReason: string | undefined;
  if (typeof ref.rowIndex === 'number') {
    if (!Number.isInteger(ref.rowIndex) || ref.rowIndex < 0) {
      missingReason = `rowIndex ${ref.rowIndex} is invalid`;
    } else {
      rowIndex = ref.rowIndex;
      row = rows[ref.rowIndex];
      if (!row) missingReason = `rowIndex ${ref.rowIndex} is outside evidence row range`;
    }
  } else if (ref.rowSelector) {
    rowIndex = rows.findIndex(candidate => rowMatchesSelector(candidate, ref.rowSelector!));
    row = rowIndex >= 0 ? rows[rowIndex] : undefined;
    if (!row) missingReason = 'rowSelector did not match any evidence row';
  } else if (rows.length === 1) {
    rowIndex = 0;
    row = rows[0];
  } else if (ref.column) {
    missingReason = rows.length === 0
      ? 'referenced evidence has no rows'
      : 'rowIndex or rowSelector is required when citing a column from multi-row evidence';
  }

  if (row && ref.column && !(ref.column in row)) {
    missingReason = `column "${ref.column}" was not found in the referenced evidence row`;
  }

  return {
    ...(row ? { row } : {}),
    ...(rowIndex !== undefined ? { rowIndex } : {}),
    ...(missingReason ? { missingReason } : {}),
  };
}

function findEnvelopeForRef(envelopes: DataEnvelope[], ref: ConclusionContractClaimReference): EnvelopeMatch | undefined {
  const indexed = envelopes.map((envelope, index) => ({ envelope, ordinal: index + 1 }));
  const candidates = indexed.filter(candidate => refMatchesAnyEnvelopeIdentifier(candidate.envelope, ref, candidate.ordinal));
  const matches = candidates.filter(candidate => refMatchesAllProvidedEnvelopeIdentifiers(candidate.envelope, ref, candidate.ordinal));
  if (matches.length === 0 && candidates.length > 0) {
    return {
      envelope: candidates[0].envelope,
      missingReason: 'referenced evidence identifiers did not resolve to the same DataEnvelope',
    };
  }
  if (matches.length === 0) return undefined;

  const resolved = matches.map(match => ({
    envelope: match.envelope,
    ...resolveRowAndCell(match.envelope, ref),
  }));
  const valid = resolved.filter(match => !match.missingReason);
  if (valid.length === 1) return valid[0];
  if (valid.length > 1) {
    return {
      envelope: valid[0].envelope,
      missingReason: 'claim reference is ambiguous across multiple DataEnvelope outputs; use evidenceRefId or artifactId',
    };
  }
  return resolved[0];
}

function inferProducerKind(envelope: DataEnvelope, ref: ConclusionContractClaimReference): EvidenceProducerKind {
  const source = String(envelope.meta?.source || '');
  const tool = ref.sourceToolCallId || envelope.meta?.sourceToolCallId || '';
  if (tool.startsWith('execute_sql_on')) return 'execute_sql_on';
  if (tool.startsWith('execute_sql')) return 'execute_sql';
  if (tool.startsWith('invoke_skill')) return 'invoke_skill';
  if (tool.startsWith('compare_skill')) return 'compare_skill';
  if (ref.artifactId || ref.sourceArtifactId || (envelope.meta as any)?.artifactId) return 'fetch_artifact';
  if (source.includes('snapshot')) return 'analysis_snapshot';
  if (envelope.meta?.skillId) return 'invoke_skill';
  return 'manual';
}

function normalizeTraceSide(value: DataEnvelopeTraceSide | undefined): 'current' | 'reference' | 'unknown' {
  return value === 'current' || value === 'reference' ? value : 'unknown';
}

function normalizePaneSide(value: unknown): EvidencePaneSide | undefined {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toTimestamp(value: unknown): TraceTimestampNs | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim();
  return s ? s : undefined;
}

function deriveTimeRange(row: Record<string, unknown> | undefined): EvidenceTimeRangeV1 | undefined {
  if (!row) return undefined;
  const start = toTimestamp(row.ts ?? row.start_ts ?? row.startTs);
  const end = toTimestamp(row.end_ts ?? row.endTs);
  const dur = toTimestamp(row.dur ?? row.duration_ns ?? row.durationNs);
  if (start !== undefined && end !== undefined) {
    return { startTs: start, endTs: end, unit: 'ns', source: 'row' };
  }
  if (start !== undefined && dur !== undefined) {
    const startNum = toNumber(start);
    const durNum = toNumber(dur);
    const computedEnd = startNum !== undefined && durNum !== undefined
      ? startNum + durNum
      : `${start}+${dur}`;
    return { startTs: start, endTs: computedEnd, unit: 'ns', source: 'row' };
  }
  return undefined;
}

function deriveIdentity(envelope: DataEnvelope, row: Record<string, unknown> | undefined): EvidenceIdentityV1 | undefined {
  const meta = envelope.meta as Record<string, any>;
  const source = row || {};
  const status = ['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error'].includes(meta.identityStatus)
    ? meta.identityStatus as EvidenceIdentityV1['status']
    : undefined;
  const identity: EvidenceIdentityV1 = {
    packageName: typeof source.package_name === 'string' ? source.package_name : undefined,
    processName: typeof source.process_name === 'string' ? source.process_name : undefined,
    threadName: typeof source.thread_name === 'string' ? source.thread_name : undefined,
    upid: toNumber(source.upid),
    utid: toNumber(source.utid),
    pid: toNumber(source.pid),
    tid: toNumber(source.tid),
    identityRefId: typeof meta.identityRefId === 'string' ? meta.identityRefId : undefined,
    status: status || (typeof meta.processIdentityWarning === 'string' ? 'weak' : undefined),
    warnings: [
      ...(Array.isArray(meta.identityWarnings) ? meta.identityWarnings.map(String) : []),
      ...(typeof meta.processIdentityWarning === 'string' ? [meta.processIdentityWarning] : []),
    ],
  };
  if (identity.warnings?.length === 0) delete identity.warnings;
  return Object.values(identity).some(value => value !== undefined) ? identity : undefined;
}

function buildCell(ref: ConclusionContractClaimReference, row: Record<string, unknown> | undefined): EvidenceCellV1 | undefined {
  if (!ref.column) return undefined;
  const rawValue = row ? row[ref.column] : undefined;
  const hasActualValue = rawValue !== undefined;
  return {
    ...(ref.sourceRef ? { sourceRef: ref.sourceRef } : {}),
    ...(typeof ref.rowIndex === 'number' ? { rowIndex: ref.rowIndex } : {}),
    ...(ref.rowSelector ? { rowSelector: ref.rowSelector } : {}),
    column: ref.column,
    ...(rawValue === null ? { isSqlNull: true } : {}),
    ...(ref.value !== undefined && ['string', 'number', 'boolean'].includes(typeof ref.value)
      ? { value: ref.value as string | number | boolean }
      : {}),
    ...(hasActualValue && rawValue !== null && ['string', 'number', 'boolean'].includes(typeof rawValue)
      ? { actualValue: rawValue as string | number | boolean }
      : {}),
    ...(hasActualValue ? { displayValue: String(rawValue) } : {}),
  };
}

function buildAnchor(
  claimId: string,
  ref: ConclusionContractClaimReference,
  match: EnvelopeMatch | undefined,
): EvidenceAnchorV1 {
  const evidenceRefId = ref.evidenceRefId || ref.artifactId || ref.sourceArtifactId || ref.sourceToolCallId || ref.sourceRef || `missing:${claimId}`;
  const anchorId = `anchor:${stableHash({
    claimId,
    evidenceRefId,
    rowIndex: ref.rowIndex ?? match?.rowIndex,
    rowSelector: ref.rowSelector,
    column: ref.column,
  })}`;

  if (!match) {
    return {
      anchorId,
      version: 'evidence_contract@1',
      evidenceRefId,
      context: {
        traceId: 'unknown',
        traceSide: 'unknown',
        producerKind: ref.artifactId || ref.sourceArtifactId ? 'fetch_artifact' : 'manual',
        ...(ref.sourceToolCallId ? { sourceToolCallId: ref.sourceToolCallId } : {}),
        ...(ref.artifactId ? { artifactId: ref.artifactId } : {}),
        ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId, artifactId: ref.artifactId || ref.sourceArtifactId } : {}),
      },
      missing: true,
      missingReason: 'referenced evidence was not found in captured DataEnvelope outputs',
      ...(ref.column ? { cells: [buildCell(ref, undefined)!] } : {}),
      confidence: 0,
    };
  }

  const { envelope, row } = match;
  const meta = envelope.meta || {};
  const artifactId = ref.artifactId || ref.sourceArtifactId || (meta as any).artifactId || (meta as any).sourceArtifactId;
  const cell = buildCell(ref, row);
  if (match.missingReason) {
    return {
      anchorId,
      version: 'evidence_contract@1',
      evidenceRefId,
      context: {
        traceId: meta.traceId || 'unknown',
        traceSide: normalizeTraceSide(meta.traceSide),
        paneSide: normalizePaneSide(meta.paneSide),
        sourceToolCallId: meta.sourceToolCallId,
        toolCallId: meta.sourceToolCallId,
        producerKind: inferProducerKind(envelope, ref),
        skillId: meta.skillId,
        stepId: meta.stepId,
        queryHash: meta.queryHash,
        queryReviewId: meta.queryReview?.id,
        paramsHash: meta.paramsHash,
        planPhaseId: meta.planPhaseId,
        ...(artifactId ? { artifactId: String(artifactId) } : {}),
        ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId } : {}),
      },
      missing: true,
      missingReason: match.missingReason,
      ...(cell ? { cells: [cell] } : {}),
      confidence: 0,
    };
  }
  return {
    anchorId,
    version: 'evidence_contract@1',
    evidenceRefId: meta.evidenceRefId || evidenceRefId,
    context: {
      traceId: meta.traceId || 'unknown',
      traceSide: normalizeTraceSide(meta.traceSide),
      paneSide: normalizePaneSide(meta.paneSide),
      sourceToolCallId: meta.sourceToolCallId,
      toolCallId: meta.sourceToolCallId,
      producerKind: inferProducerKind(envelope, ref),
      skillId: meta.skillId,
      stepId: meta.stepId,
      queryHash: meta.queryHash,
      queryReviewId: meta.queryReview?.id,
      paramsHash: meta.paramsHash,
      planPhaseId: meta.planPhaseId,
      ...(artifactId ? { artifactId: String(artifactId) } : {}),
      ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId } : {}),
    },
    ...(cell ? { cells: [cell] } : {}),
    ...(deriveTimeRange(row) ? { timeRange: deriveTimeRange(row) } : {}),
    ...(deriveIdentity(envelope, row) ? { identity: deriveIdentity(envelope, row) } : {}),
    confidence: 1,
  };
}

function supportLevelForClaim(
  claim: ConclusionContractClaimItem,
  kind: ClaimKindV1,
  anchors: EvidenceAnchorV1[],
): EvidenceSupportLevel {
  if (anchors.length === 0 || anchors.every(anchor => anchor.missing)) return 'unsupported';
  if (kind === 'inference') return 'inference';
  if (kind === 'recommendation') return 'partial';
  if (anchors.some(anchor => anchor.missing)) return 'partial';
  if (kind === 'causal') return 'inference';
  const cellStatuses = anchors.flatMap(anchor => (anchor.cells || []).map(evidenceCellCheckStatus));
  if (cellStatuses.some(status => status === 'mismatch')) return 'unsupported';
  if (anchors.some(anchor => !anchor.context.traceId || anchor.context.traceId === 'unknown')) return 'partial';
  if (kind === 'identity' && anchors.some(anchor =>
    anchor.identity?.status !== 'verified' || !anchor.identity?.identityRefId
  )) {
    return 'partial';
  }
  if (cellStatuses.length === 0 || cellStatuses.some(status => status === 'not_checked')) return 'partial';
  return 'verified';
}

function artifactRefsToClaimReferences(claim: ConclusionContractClaimItem): ConclusionContractClaimReference[] {
  return (claim.artifactRefs || []).map(ref => ({
    artifactId: ref.artifactId,
    ...(typeof ref.rowIndex === 'number' ? { rowIndex: ref.rowIndex } : {}),
    ...(ref.rowSelector ? { rowSelector: parseRowSelector(ref.rowSelector) } : {}),
  }));
}

function parseRowSelector(value: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const selector: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof raw)) {
      selector[key] = raw as string | number | boolean;
    }
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function buildClaimSupport(
  claim: ConclusionContractClaimItem,
  index: number,
  envelopes: DataEnvelope[],
): ClaimSupportV1 {
  const claimId = claim.id || `claim-${index + 1}`;
  const references = [
    ...(claim.references || []),
    ...artifactRefsToClaimReferences(claim),
  ];
  const anchors = references.map(ref => buildAnchor(claimId, ref, findEnvelopeForRef(envelopes, ref)));
  const kind = inferClaimKind(claim, references);
  const supportLevel = supportLevelForClaim(claim, kind, anchors);
  return {
    claimId,
    kind,
    text: claim.text,
    anchors,
    supportLevel,
    ...(supportLevel === 'inference' && claim.kind === 'causal'
      ? { inferenceReason: 'causal claim is treated as inference until EvidenceRelationV1 relation support is emitted' }
      : {}),
  };
}

export function buildEvidenceContract(input: BuildEvidenceContractInput): EvidenceContractV1 {
  const envelopes = input.dataEnvelopes || [];
  const claims = input.conclusionContract?.claims || [];
  const claimSupport = claims.map((claim, index) => buildClaimSupport(claim, index, envelopes));
  const anchors = claimSupport.flatMap(item => item.anchors);
  const identityRefIds = Array.from(new Set(
    anchors.map(anchor => anchor.identity?.identityRefId).filter((value): value is string => Boolean(value)),
  ));
  return {
    schemaVersion: 'evidence_contract@1',
    anchors,
    relations: [],
    claimSupport,
    identityRefIds,
    warnings: [],
  };
}
