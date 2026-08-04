// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract, ConclusionContractClaimReference } from '../agent/core/conclusionContract';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import type { DataEnvelope } from '../types/dataContract';
import {
  hasVerifiedProcessIdentityEvidence,
  type QuickProcessIdentityEvidencePayload,
} from './quickProcessIdentityEvidence';
import type { QuickStructuredDirectAnswer } from './quickDirectAnswerContract';

export interface QuickProcessIdentityDirectAnswer extends QuickStructuredDirectAnswer {}

function columnIndex(columns: string[]): Map<string, number> {
  return new Map(columns.map((column, index) => [column, index]));
}

function rowValue(
  row: unknown[],
  index: Map<string, number>,
  column: string,
): unknown {
  const columnIndexValue = index.get(column);
  return columnIndexValue === undefined ? undefined : row[columnIndexValue];
}

function numericValue(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function hasKnownCellText(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text !== '' && text !== '-' && text !== '<unknown>' && text !== 'unknown';
}

function cellText(value: unknown): string {
  const text = String(value ?? '-').replace(/\s+/g, ' ').trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 119)}...`;
}

function findTableEnvelope(envelopes: DataEnvelope[]): DataEnvelope | undefined {
  return envelopes.find(envelope =>
    Array.isArray(envelope.data.columns)
    && Array.isArray(envelope.data.rows)
    && envelope.data.rows.length > 0);
}

function directClaimReference(input: {
  envelope: DataEnvelope;
  column: string;
  value: string | number | boolean;
}): ConclusionContractClaimReference {
  return {
    evidenceRefId: input.envelope.meta.evidenceRefId,
    sourceToolCallId: input.envelope.meta.sourceToolCallId,
    sourceRef: input.envelope.display?.title,
    rowIndex: 0,
    column: input.column,
    value: input.value,
  };
}

function buildDirectConclusionContract(input: {
  statement: string;
  evidenceText: string;
  references: ConclusionContractClaimReference[];
}): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [{
      rank: 1,
      statement: input.statement,
      confidencePercent: 100,
    }],
    clusters: [],
    evidenceChain: [{
      conclusionId: 'qpi-1',
      text: input.evidenceText,
    }],
    claims: [{
      id: 'quick-process-identity',
      conclusionId: 'qpi-1',
      text: input.statement,
      kind: 'categorical',
      references: input.references,
    }],
    uncertainties: [],
    nextSteps: [],
    metadata: {
      confidencePercent: 100,
      rounds: 0,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

function buildDirectConclusion(input: {
  statement: string;
  evidenceRefId: string;
  sourceRef: string;
  rows: string[];
  outputLanguage: OutputLanguage;
}): string {
  const evidenceLines = input.rows.map(row => `  - ${row}`).join('\n');
  return localize(
    input.outputLanguage,
    `${input.statement}\n\n## 逐句数据引用（结构化来源）\n- Q1: ${input.statement}\n  - evidence_ref_id=\`${input.evidenceRefId}\`; source_ref=${input.sourceRef}\n${evidenceLines}`,
    `${input.statement}\n\n## Sentence-Level Data References\n- Q1: ${input.statement}\n  - evidence_ref_id=\`${input.evidenceRefId}\`; source_ref=${input.sourceRef}\n${evidenceLines}`,
  );
}

function buildIdentityStatement(input: {
  canonicalPackageName: string;
  recommendedProcessName: string;
  processText: string;
  upid: number;
  pid?: number;
  identityStatus: string;
  confidenceScore: number;
  outputLanguage: OutputLanguage;
}): string {
  const pidClause = input.pid && input.pid > 0
    ? localize(input.outputLanguage, `，PID=${input.pid}`, `, PID=${input.pid}`)
    : '';
  if (
    input.canonicalPackageName === input.recommendedProcessName
    && input.recommendedProcessName === input.processText
  ) {
    return localize(
      input.outputLanguage,
      `当前 trace 的包名、推荐进程参数和首选进程均为 ${input.canonicalPackageName}；UPID=${input.upid}${pidClause}，status=${input.identityStatus}，confidence=${input.confidenceScore}。`,
      `The package, recommended process parameter, and top process are all ${input.canonicalPackageName}; UPID=${input.upid}${pidClause}, status=${input.identityStatus}, confidence=${input.confidenceScore}.`,
    );
  }
  return localize(
    input.outputLanguage,
    `当前 trace 的包名为 ${input.canonicalPackageName}，推荐进程参数为 ${input.recommendedProcessName}；首选进程 ${input.processText}，UPID=${input.upid}${pidClause}，status=${input.identityStatus}，confidence=${input.confidenceScore}。`,
    `The package is ${input.canonicalPackageName}, the recommended process parameter is ${input.recommendedProcessName}; top process ${input.processText}, UPID=${input.upid}${pidClause}, status=${input.identityStatus}, confidence=${input.confidenceScore}.`,
  );
}

export function buildQuickProcessIdentityDirectAnswer(input: {
  evidence?: QuickProcessIdentityEvidencePayload;
  outputLanguage?: OutputLanguage;
}): QuickProcessIdentityDirectAnswer | undefined {
  const evidence = input.evidence;
  if (!evidence?.promptContext || !hasVerifiedProcessIdentityEvidence(evidence)) return undefined;
  const envelope = findTableEnvelope(evidence.envelopes);
  if (!envelope?.data.columns || !envelope.data.rows?.length) return undefined;

  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const columns = envelope.data.columns;
  const index = columnIndex(columns);
  const row = envelope.data.rows[0];
  const evidenceRefId = envelope.meta.evidenceRefId;
  if (!evidenceRefId) return undefined;

  const canonicalPackageName = rowValue(row, index, 'canonical_package_name');
  const recommendedProcessName = rowValue(row, index, 'recommended_process_name_param');
  const processName = rowValue(row, index, 'process_name');
  const upid = numericValue(rowValue(row, index, 'upid'));
  const pid = numericValue(rowValue(row, index, 'pid'));
  const confidenceScore = numericValue(rowValue(row, index, 'confidence_score'));
  const identityStatus = rowValue(row, index, 'identity_status');
  if (
    typeof canonicalPackageName !== 'string'
    || typeof recommendedProcessName !== 'string'
    || typeof processName !== 'string'
    || !hasKnownCellText(processName)
    || !upid
    || upid <= 0
    || !confidenceScore
    || confidenceScore < 80
  ) {
    return undefined;
  }

  const processText = cellText(processName);
  const sourceRef = envelope.display?.title ?? envelope.meta.source ?? 'runtime process identity pre-evidence';
  const statusText = cellText(identityStatus);
  const statement = buildIdentityStatement({
    canonicalPackageName,
    recommendedProcessName,
    processText,
    upid,
    pid,
    identityStatus: statusText,
    confidenceScore,
    outputLanguage,
  });
  const references = [
    directClaimReference({ envelope, column: 'canonical_package_name', value: canonicalPackageName }),
    directClaimReference({ envelope, column: 'recommended_process_name_param', value: recommendedProcessName }),
    directClaimReference({ envelope, column: 'process_name', value: processName }),
    directClaimReference({ envelope, column: 'upid', value: upid }),
    ...(pid && pid > 0 ? [directClaimReference({ envelope, column: 'pid', value: pid })] : []),
    directClaimReference({ envelope, column: 'identity_status', value: statusText }),
    directClaimReference({ envelope, column: 'confidence_score', value: confidenceScore }),
  ];
  return {
    conclusion: buildDirectConclusion({
      statement,
      evidenceRefId,
      sourceRef,
      outputLanguage,
      rows: [
        `columns=\`canonical_package_name,recommended_process_name_param,process_name\`; values=\`${canonicalPackageName}, ${recommendedProcessName}, ${processText}\``,
        `columns=\`upid,pid,identity_status,confidence_score\`; values=\`${upid}, ${pid && pid > 0 ? pid : '-'}, ${statusText}, ${confidenceScore}\``,
      ],
    }),
    conclusionContract: buildDirectConclusionContract({
      statement,
      evidenceText: `${sourceRef}: canonical_package_name=${canonicalPackageName}, recommended_process_name_param=${recommendedProcessName}, process_name=${processText}, upid=${upid}${pid && pid > 0 ? `, pid=${pid}` : ''}, identity_status=${statusText}, confidence_score=${confidenceScore}`,
      references,
    }),
    confidence: 1,
  };
}
