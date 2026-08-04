// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseKnowledgeResponsibility } from '../../types/caseKnowledge';
import type {
  AnalysisResultSceneType,
  AnalysisResultSnapshot,
  TraceSimilarityCaseQuery,
  TraceSimilaritySignatureV1,
} from '../../types/multiTraceComparison';

const MAX_SIGNAL_COUNT = 80;
const MAX_SIGNATURE_KEY_COUNT = 80;
const MAX_METRIC_COUNT = 64;
const MAX_STRING_LENGTH = 96;
const BUILD_FINGERPRINT_PREFIX_LENGTH = 24;

const STRUCTURED_ROOT_CAUSE_KEYS = [
  'rootCause',
  'primaryRootCause',
  'reasonCode',
  'reason_code',
  'primary_root_cause',
] as const;

const STRUCTURED_SECONDARY_ROOT_CAUSE_KEYS = [
  'secondaryRootCauses',
  'secondary_root_causes',
] as const;

const VALID_RESPONSIBILITIES = new Set<CaseKnowledgeResponsibility>([
  'app',
  'oem',
  'mixed',
  'unknown',
]);

type Scalar = string | number | boolean;

export function buildTraceSimilaritySignature(
  snapshot: AnalysisResultSnapshot,
): TraceSimilaritySignatureV1 {
  const signature: TraceSimilaritySignatureV1 = {
    schemaVersion: 1,
    sceneType: snapshot.sceneType,
    metrics: {},
    categoricalSignals: {},
    caseEvidenceSignatures: {},
  };

  applyTraceMetadata(signature, snapshot);
  addCategoricalSignal(signature, 'sceneType', snapshot.sceneType);
  addCategoricalSignal(signature, 'status', snapshot.status);
  addSignatureValue(signature, 'scene', snapshot.sceneType);
  addSignatureValue(signature, 'domain_pack', domainPackForScene(snapshot.sceneType));

  const metricKeys: string[] = [];
  const metricGroups = new Set<string>();
  const skillIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const metric of snapshot.metrics) {
    if (typeof metric.value === 'number' && Number.isFinite(metric.value)
      && Object.keys(signature.metrics).length < MAX_METRIC_COUNT) {
      signature.metrics[metric.key] = metric.value;
      addSignatureValue(signature, metric.key, metric.value);
    }
    metricKeys.push(metric.key);
    if (metric.group) metricGroups.add(metric.group);
    if (metric.source.skillId) skillIds.add(metric.source.skillId);
    if (metric.source.stepId) stepIds.add(metric.source.stepId);
  }
  addStringArraySignature(signature, 'metric_keys', metricKeys);
  addStringArraySignature(signature, 'metric_groups', [...metricGroups]);

  const evidenceTypes = new Set<string>();
  const evidenceSkillIds = new Set<string>();
  const evidenceStepIds = new Set<string>();
  for (const evidence of snapshot.evidenceRefs) {
    evidenceTypes.add(evidence.type);
    addCategoricalSignal(signature, `evidenceType:${evidence.type}`, true);
    const metadata = toRecord(evidence.metadata);
    const skillId = readString(metadata?.skillId);
    const stepId = readString(metadata?.stepId);
    if (skillId) evidenceSkillIds.add(skillId);
    if (stepId) evidenceStepIds.add(stepId);
    mergeStructuredEvidenceMetadata(signature, metadata);
  }
  addStringArraySignature(signature, 'evidence_ref_types', [...evidenceTypes]);
  addStringArraySignature(signature, 'skill_ids', [...skillIds, ...evidenceSkillIds]);
  addStringArraySignature(signature, 'step_ids', [...stepIds, ...evidenceStepIds]);

  for (const group of metricGroups) {
    addCategoricalSignal(signature, `metricGroup:${group}`, true);
  }
  for (const skillId of new Set([...skillIds, ...evidenceSkillIds])) {
    addCategoricalSignal(signature, `skill:${skillId}`, true);
  }
  for (const stepId of new Set([...stepIds, ...evidenceStepIds])) {
    addCategoricalSignal(signature, `step:${stepId}`, true);
  }

  const rootCause = findRootCause(snapshot, signature);
  if (rootCause) {
    addCategoricalSignal(signature, 'rootCause', rootCause);
    addSignatureValue(signature, 'root_cause', rootCause);
    addSignatureValue(signature, 'reason_code', rootCause);
    signature.caseQuery = buildCaseQuery(snapshot, rootCause);
  }

  return signature;
}

function applyTraceMetadata(
  signature: TraceSimilaritySignatureV1,
  snapshot: AnalysisResultSnapshot,
): void {
  const metadata = snapshot.traceMetadata;
  const appPackage = readString(metadata.appPackage);
  const processName = readString(metadata.processName);
  const deviceModel = readString(metadata.deviceModel);
  const androidVersion = readString(metadata.androidVersion);
  const buildFingerprint = readString(metadata.buildFingerprint);
  const traceDurationMs = readFiniteNumber(metadata.traceDurationMs);
  const traceSizeBytes = readFiniteNumber(metadata.traceSizeBytes);

  if (appPackage) {
    signature.appPackage = appPackage;
    addCategoricalSignal(signature, 'appPackage', appPackage);
    addSignatureValue(signature, 'app_package', appPackage);
  }
  if (processName) {
    signature.processName = processName;
    addCategoricalSignal(signature, 'processName', processName);
    addSignatureValue(signature, 'process_name', processName);
  }
  if (deviceModel) {
    signature.deviceModel = deviceModel;
    addCategoricalSignal(signature, 'deviceModel', deviceModel);
    addSignatureValue(signature, 'device_model', deviceModel);
  }
  if (androidVersion) {
    signature.androidVersion = androidVersion;
    addCategoricalSignal(signature, 'androidVersion', androidVersion);
    addSignatureValue(signature, 'android_version', androidMajor(androidVersion) ?? androidVersion);
  }
  if (buildFingerprint) {
    signature.buildFingerprintPrefix = buildFingerprint.slice(0, BUILD_FINGERPRINT_PREFIX_LENGTH);
    addCategoricalSignal(signature, 'buildFingerprintPrefix', signature.buildFingerprintPrefix);
  }
  if (traceDurationMs !== undefined) {
    signature.traceDurationMs = traceDurationMs;
    signature.metrics['trace.duration_ms'] = traceDurationMs;
    addSignatureValue(signature, 'trace.duration_ms', traceDurationMs);
  }
  if (traceSizeBytes !== undefined) {
    signature.traceSizeBytes = traceSizeBytes;
    signature.metrics['trace.size_bytes'] = traceSizeBytes;
    addSignatureValue(signature, 'trace.size_bytes', traceSizeBytes);
  }

  mergeStructuredEvidenceMetadata(signature, metadata);
}

function buildCaseQuery(
  snapshot: AnalysisResultSnapshot,
  rootCause: string,
): TraceSimilarityCaseQuery {
  const metadata = snapshot.traceMetadata;
  const secondaryRootCauses = firstStringArrayFromKeys(metadata, STRUCTURED_SECONDARY_ROOT_CAUSE_KEYS);
  const responsibility = readResponsibility(metadata.responsibility)
    ?? readResponsibility(metadata.owner)
    ?? readResponsibility(metadata.responsibleSide);
  const audiences: Array<'app' | 'oem'> = responsibility === 'oem'
    ? ['oem']
    : responsibility === 'mixed'
      ? ['app', 'oem']
      : ['app'];
  return {
    scene: snapshot.sceneType,
    domainPack: domainPackForScene(snapshot.sceneType),
    rootCause,
    ...(secondaryRootCauses.length > 0 ? { secondaryRootCauses } : {}),
    ...(responsibility ? { responsibility } : {}),
    audiences,
  };
}

function findRootCause(
  snapshot: AnalysisResultSnapshot,
  signature: TraceSimilaritySignatureV1,
): string | undefined {
  const fromTraceMetadata = firstStringFromKeys(snapshot.traceMetadata, STRUCTURED_ROOT_CAUSE_KEYS);
  if (fromTraceMetadata) return fromTraceMetadata;
  const fromCaseSignature = readString(signature.caseEvidenceSignatures.reason_code)
    ?? readString(signature.caseEvidenceSignatures.root_cause);
  if (fromCaseSignature) return fromCaseSignature;
  for (const evidence of snapshot.evidenceRefs) {
    const metadata = toRecord(evidence.metadata);
    const value = firstStringFromKeys(metadata, STRUCTURED_ROOT_CAUSE_KEYS);
    if (value) return value;
  }
  return undefined;
}

function mergeStructuredEvidenceMetadata(
  signature: TraceSimilaritySignatureV1,
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  for (const key of STRUCTURED_ROOT_CAUSE_KEYS) {
    const value = readString(metadata[key]);
    if (value) {
      addSignatureValue(signature, 'reason_code', value);
      addSignatureValue(signature, 'root_cause', value);
      addCategoricalSignal(signature, 'rootCause', value);
      break;
    }
  }
  for (const key of STRUCTURED_SECONDARY_ROOT_CAUSE_KEYS) {
    addStringArraySignature(signature, 'secondary_root_causes', readStringArray(metadata[key]));
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!isStructuredSignatureKey(key)) continue;
    const scalar = readScalar(value);
    if (scalar !== undefined) {
      addSignatureValue(signature, key, scalar);
      if (typeof scalar !== 'number') addCategoricalSignal(signature, key, scalar);
      continue;
    }
    addStringArraySignature(signature, key, readStringArray(value));
  }
}

function isStructuredSignatureKey(key: string): boolean {
  return [
    'reason_code',
    'root_cause',
    'domain_pack',
    'blocking_reason',
    'thread_state',
    'process_name',
    'app_package',
    'responsibility',
    'render_slices',
    'slice_names',
    'metric_groups',
    'evidence_ref_types',
  ].includes(key);
}

function addCategoricalSignal(
  signature: TraceSimilaritySignatureV1,
  key: string,
  value: string | boolean,
): void {
  if (Object.keys(signature.categoricalSignals).length >= MAX_SIGNAL_COUNT) return;
  const normalizedKey = boundedString(key, MAX_STRING_LENGTH);
  if (!normalizedKey) return;
  if (typeof value === 'string') {
    const normalizedValue = boundedString(value, MAX_STRING_LENGTH);
    if (normalizedValue) signature.categoricalSignals[normalizedKey] = normalizedValue;
    return;
  }
  signature.categoricalSignals[normalizedKey] = value;
}

function addSignatureValue(
  signature: TraceSimilaritySignatureV1,
  key: string,
  value: unknown,
): void {
  if (Object.keys(signature.caseEvidenceSignatures).length >= MAX_SIGNATURE_KEY_COUNT) return;
  const normalizedKey = boundedString(key, MAX_STRING_LENGTH);
  if (!normalizedKey) return;
  const scalar = readScalar(value);
  if (scalar !== undefined) {
    signature.caseEvidenceSignatures[normalizedKey] = scalar;
  }
}

function addStringArraySignature(
  signature: TraceSimilaritySignatureV1,
  key: string,
  values: string[],
): void {
  if (values.length === 0 || Object.keys(signature.caseEvidenceSignatures).length >= MAX_SIGNATURE_KEY_COUNT) return;
  const normalizedKey = boundedString(key, MAX_STRING_LENGTH);
  if (!normalizedKey) return;
  const uniqueValues = [...new Set(values.map(value => boundedString(value, MAX_STRING_LENGTH)).filter(isPresentString))].slice(0, 24);
  if (uniqueValues.length > 0) signature.caseEvidenceSignatures[normalizedKey] = uniqueValues;
}

function readScalar(value: unknown): Scalar | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return readString(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return boundedString(value, MAX_STRING_LENGTH);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter(isPresentString);
}

function firstStringFromKeys(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstStringArrayFromKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  for (const key of keys) {
    const value = readStringArray(record[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readResponsibility(value: unknown): CaseKnowledgeResponsibility | undefined {
  const stringValue = readString(value);
  if (!stringValue) return undefined;
  return VALID_RESPONSIBILITIES.has(stringValue as CaseKnowledgeResponsibility)
    ? stringValue as CaseKnowledgeResponsibility
    : undefined;
}

function androidMajor(value: string): string | undefined {
  const match = /^(\d+)/.exec(value.trim());
  return match?.[1];
}

function domainPackForScene(sceneType: AnalysisResultSceneType): string {
  return `${sceneType}.v1`;
}

function isPresentString(value: string | undefined): value is string {
  return Boolean(value);
}
