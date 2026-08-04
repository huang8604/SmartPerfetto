// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type EvidenceContractVersion = 'evidence_contract@1';
export type TraceTimestampNs = string | number;

export type EvidenceProducerKind =
  | 'execute_sql'
  | 'execute_sql_on'
  | 'invoke_skill'
  | 'compare_skill'
  | 'fetch_artifact'
  | 'analysis_snapshot'
  | 'manual';

export type EvidenceTraceSide = 'current' | 'reference' | 'unknown';
export type EvidencePaneSide = 'left' | 'right' | 'top' | 'bottom';

export type EvidenceIdentityRole =
  | 'app_main'
  | 'render_thread'
  | 'binder_thread'
  | 'producer'
  | 'surfaceflinger'
  | 'hwc'
  | 'unknown';

export type EvidenceSupportLevel = 'verified' | 'partial' | 'inference' | 'unsupported';

export type ClaimKindV1 =
  | 'numeric'
  | 'categorical'
  | 'identity'
  | 'time_range'
  | 'causal'
  | 'comparison'
  | 'inference'
  | 'recommendation';

export interface EvidenceContextV1 {
  traceId: string;
  traceSide?: EvidenceTraceSide;
  paneSide?: EvidencePaneSide;
  toolCallId?: string;
  sourceToolCallId?: string;
  producerKind: EvidenceProducerKind;
  skillId?: string;
  stepId?: string;
  queryHash?: string;
  queryReviewId?: string;
  sqlTextRef?: string;
  paramsHash?: string;
  /** Canonical artifact id used by Evidence Contract consumers. */
  artifactId?: string;
  /** Compatibility alias from existing artifact rows; normalize to artifactId. */
  sourceArtifactId?: string;
  planPhaseId?: string;
}

export interface EvidenceTimeRangeV1 {
  startTs: TraceTimestampNs;
  endTs: TraceTimestampNs;
  unit: 'ns';
  source: 'row' | 'params' | 'selection' | 'derived';
}

export interface EvidenceIdentityV1 {
  packageName?: string;
  processName?: string;
  threadName?: string;
  upid?: number;
  utid?: number;
  pid?: number;
  tid?: number;
  role?: EvidenceIdentityRole;
  identityRefId?: string;
  confidence?: number;
  status?: 'verified' | 'ambiguous' | 'weak' | 'missing' | 'not_required' | 'error';
  warnings?: string[];
}

export interface EvidenceCellV1 {
  sourceRef?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column: string;
  /** Expected value stated by the claim reference, when the claim is value-bearing. */
  value?: string | number | boolean;
  /** Actual primitive value read from the cited evidence row. */
  actualValue?: string | number | boolean;
  isSqlNull?: boolean;
  displayValue?: string;
  unit?: string;
}

export interface EvidenceAnchorV1 {
  anchorId: string;
  version: EvidenceContractVersion;
  evidenceRefId: string;
  context: EvidenceContextV1;
  cells?: EvidenceCellV1[];
  timeRange?: EvidenceTimeRangeV1;
  identity?: EvidenceIdentityV1;
  confidence?: number;
  missing?: boolean;
  missingReason?: string;
}

export interface EvidenceRelationV1 {
  id: string;
  kind:
    | 'overlap'
    | 'wakeup'
    | 'blocking_state'
    | 'binder_peer'
    | 'lock_owner'
    | 'comparison_delta'
    | 'derived';
  subjectAnchorId: string;
  objectAnchorId?: string;
  relationAnchorId?: string;
  metricColumn?: string;
  value?: string | number | boolean;
  isSqlNull?: boolean;
  unit?: string;
  supportLevel: EvidenceSupportLevel;
  reason?: string;
}

export interface ClaimSupportV1 {
  claimId: string;
  kind: ClaimKindV1;
  text: string;
  anchors: EvidenceAnchorV1[];
  relations?: EvidenceRelationV1[];
  supportLevel: EvidenceSupportLevel;
  inferenceReason?: string;
}

export interface EvidenceContractV1 {
  schemaVersion: EvidenceContractVersion;
  anchors: EvidenceAnchorV1[];
  relations: EvidenceRelationV1[];
  claimSupport: ClaimSupportV1[];
  identityRefIds: string[];
  warnings: string[];
}
