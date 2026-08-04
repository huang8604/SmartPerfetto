// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import { localize, parseOutputLanguage, type OutputLanguage } from '../../agentv3/outputLanguage';
import type {
  AnalysisResultSnapshot,
  SimilarityHintBand,
  SimilarityHintV1,
  SimilarityMatchReason,
  TraceSimilaritySignatureV1,
} from '../../types/multiTraceComparison';
import { buildTraceSimilaritySignature } from './traceSimilaritySignature';

const MINIMUM_SIMILARITY_SCORE = 0.12;
const DEFAULT_HINT_LIMIT = 5;
const MAX_HINT_LIMIT = 20;
const EXACT_FEATURE_SIGNAL_KEYS = new Set([
  'sceneType',
  'appPackage',
  'processName',
  'deviceModel',
  'androidVersion',
  'buildFingerprintPrefix',
]);

export interface SnapshotSimilarityCandidate {
  snapshot: AnalysisResultSnapshot;
  signature?: TraceSimilaritySignatureV1;
}

export interface RankSnapshotSimilarityHintsInput {
  currentSnapshot: AnalysisResultSnapshot;
  currentSignature?: TraceSimilaritySignatureV1;
  candidates: SnapshotSimilarityCandidate[];
  limit?: number;
  outputLanguage?: OutputLanguage;
}

export function rankSnapshotSimilarityHints(
  input: RankSnapshotSimilarityHintsInput,
): SimilarityHintV1[] {
  const currentSignature = input.currentSignature
    ?? buildTraceSimilaritySignature(input.currentSnapshot);
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const hints: SimilarityHintV1[] = [];
  for (const candidate of input.candidates) {
    if (candidate.snapshot.id === input.currentSnapshot.id) continue;
    const candidateSignature = candidate.signature
      ?? buildTraceSimilaritySignature(candidate.snapshot);
    const hint = scoreSnapshotCandidate({
      currentSnapshotId: input.currentSnapshot.id,
      candidateSnapshotId: candidate.snapshot.id,
      currentSignature,
      candidateSignature,
      outputLanguage,
    });
    if (hint.score >= MINIMUM_SIMILARITY_SCORE) hints.push(hint);
  }
  hints.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
  return hints.slice(0, boundedSimilarityLimit(input.limit));
}

export function boundedSimilarityLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HINT_LIMIT;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_HINT_LIMIT;
  return Math.min(value, MAX_HINT_LIMIT);
}

function scoreSnapshotCandidate(input: {
  currentSnapshotId: string;
  candidateSnapshotId: string;
  currentSignature: TraceSimilaritySignatureV1;
  candidateSignature: TraceSimilaritySignatureV1;
  outputLanguage: OutputLanguage;
}): SimilarityHintV1 {
  const reasons: SimilarityMatchReason[] = [];
  addExactReason(reasons, 'sceneType', input.currentSignature.sceneType, input.candidateSignature.sceneType, 0.20);
  addExactReason(reasons, 'appPackage', input.currentSignature.appPackage, input.candidateSignature.appPackage, 0.14);
  addExactReason(reasons, 'processName', input.currentSignature.processName, input.candidateSignature.processName, 0.08);
  addExactReason(reasons, 'deviceModel', input.currentSignature.deviceModel, input.candidateSignature.deviceModel, 0.08);
  addExactReason(reasons, 'androidVersion', input.currentSignature.androidVersion, input.candidateSignature.androidVersion, 0.05);
  addExactReason(reasons, 'buildFingerprintPrefix', input.currentSignature.buildFingerprintPrefix, input.candidateSignature.buildFingerprintPrefix, 0.05);
  addNumericClosenessReason(reasons, 'traceDurationMs', input.currentSignature.traceDurationMs, input.candidateSignature.traceDurationMs, 0.04);
  addNumericClosenessReason(reasons, 'traceSizeBytes', input.currentSignature.traceSizeBytes, input.candidateSignature.traceSizeBytes, 0.03);
  addMetricReasons(reasons, input.currentSignature, input.candidateSignature);
  addCategoricalReasons(reasons, input.currentSignature, input.candidateSignature);

  const score = clampScore(reasons.reduce((sum, reason) => sum + reason.weight, 0));
  return {
    schemaVersion: 1,
    id: similarityHintId(input.currentSnapshotId, input.candidateSnapshotId),
    source: 'analysis_result_snapshot',
    sourceId: input.candidateSnapshotId,
    score,
    band: bandForScore(score, reasons.length),
    matchReasons: reasons,
    limitations: buildSnapshotLimitations(input.currentSignature, reasons, score, input.outputLanguage),
    allowedUse: 'navigation_hint_only',
  };
}

function addMetricReasons(
  reasons: SimilarityMatchReason[],
  current: TraceSimilaritySignatureV1,
  candidate: TraceSimilaritySignatureV1,
): void {
  let metricWeight = 0;
  for (const [key, currentValue] of Object.entries(current.metrics)) {
    if (metricWeight >= 0.24) return;
    const candidateValue = candidate.metrics[key];
    const weight = numericClosenessWeight(currentValue, candidateValue, 0.08);
    if (weight === 0 || candidateValue === undefined) continue;
    reasons.push({
      feature: `metric:${key}`,
      currentValue,
      matchedValue: candidateValue,
      weight,
    });
    metricWeight += weight;
  }
}

function addCategoricalReasons(
  reasons: SimilarityMatchReason[],
  current: TraceSimilaritySignatureV1,
  candidate: TraceSimilaritySignatureV1,
): void {
  let signalWeight = 0;
  const entries = Object.entries(current.categoricalSignals)
    .filter(([key]) => !EXACT_FEATURE_SIGNAL_KEYS.has(key))
    .sort(([left], [right]) => categoricalReasonPriority(left) - categoricalReasonPriority(right));
  for (const [key, currentValue] of entries) {
    if (signalWeight >= 0.20) return;
    const candidateValue = candidate.categoricalSignals[key];
    if (candidateValue !== currentValue) continue;
    const weight = typeof currentValue === 'boolean' ? 0.03 : 0.05;
    reasons.push({
      feature: `signal:${key}`,
      currentValue,
      matchedValue: candidateValue,
      weight,
    });
    signalWeight += weight;
  }
}

function categoricalReasonPriority(key: string): number {
  if (key === 'rootCause') return 0;
  if (key.startsWith('evidenceType:')) return 1;
  if (key.startsWith('skill:')) return 2;
  if (key.startsWith('step:')) return 3;
  if (key.startsWith('metricGroup:')) return 4;
  return 5;
}

function addExactReason(
  reasons: SimilarityMatchReason[],
  feature: string,
  currentValue: string | number | boolean | undefined,
  candidateValue: string | number | boolean | undefined,
  weight: number,
): void {
  if (currentValue === undefined || candidateValue === undefined || currentValue !== candidateValue) return;
  reasons.push({
    feature,
    currentValue,
    matchedValue: candidateValue,
    weight,
  });
}

function addNumericClosenessReason(
  reasons: SimilarityMatchReason[],
  feature: string,
  currentValue: number | undefined,
  candidateValue: number | undefined,
  maxWeight: number,
): void {
  const weight = numericClosenessWeight(currentValue, candidateValue, maxWeight);
  if (weight === 0 || currentValue === undefined || candidateValue === undefined) return;
  reasons.push({
    feature,
    currentValue,
    matchedValue: candidateValue,
    weight,
  });
}

function numericClosenessWeight(
  currentValue: number | undefined,
  candidateValue: number | undefined,
  maxWeight: number,
): number {
  if (currentValue === undefined || candidateValue === undefined) return 0;
  if (!Number.isFinite(currentValue) || !Number.isFinite(candidateValue)) return 0;
  const baseline = Math.max(Math.abs(currentValue), Math.abs(candidateValue), 1);
  const relativeDelta = Math.abs(currentValue - candidateValue) / baseline;
  if (relativeDelta <= 0.10) return maxWeight;
  if (relativeDelta <= 0.25) return maxWeight * 0.6;
  return 0;
}

function bandForScore(score: number, reasonCount: number): SimilarityHintBand {
  if (score >= 0.55 && reasonCount >= 3) return 'strong';
  if (score >= 0.30 && reasonCount >= 2) return 'partial';
  return 'background';
}

function buildSnapshotLimitations(
  currentSignature: TraceSimilaritySignatureV1,
  reasons: SimilarityMatchReason[],
  score: number,
  outputLanguage: OutputLanguage,
): string[] {
  const limitations = [localize(
    outputLanguage,
    '相似性只是导航提示，不是诊断证据。',
    'Similarity is a navigation hint only and not diagnostic evidence.',
  )];
  if (!currentSignature.appPackage) limitations.push(localize(
    outputLanguage,
    '当前 snapshot 缺少 app package 元数据。',
    'Current snapshot lacks app package metadata.',
  ));
  if (!currentSignature.caseQuery?.rootCause) limitations.push(localize(
    outputLanguage,
    '没有可用的结构化根因签名。',
    'No structured root-cause signature was available.',
  ));
  if (score < 0.30 || reasons.length < 2) limitations.push(localize(
    outputLanguage,
    '特征重合度较低，仅用于探索。',
    'Low feature overlap; use only for exploration.',
  ));
  return limitations;
}

function similarityHintId(currentSnapshotId: string, candidateSnapshotId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${currentSnapshotId}\0${candidateSnapshotId}`)
    .digest('hex')
    .slice(0, 16);
  return `similarity:snapshot:${digest}`;
}

function clampScore(score: number): number {
  return Math.min(1, Number(score.toFixed(3)));
}
