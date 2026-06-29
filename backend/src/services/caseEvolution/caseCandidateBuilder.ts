// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import {
  CASE_CANDIDATE_SCHEMA_VERSION,
  CONFIDENCE_HIGH_THRESHOLD,
  type CaseCandidate,
  type CaseCandidateCaptureInput,
  type CaseEvolutionConfidenceBucket,
} from '../../types/caseEvolution';
import {
  projectScrollingCandidateClusters,
  type CaseCandidateCluster,
} from './scrollingCandidateProjector';

export { projectScrollingCandidateClusters };
export type { CaseCandidateCluster };

export interface BuildCaseCandidatesDeps {
  existingPublishedCaseKeys?: Set<string>;
  /**
   * Dedupe set of `${scene}::${rootCause}` already covered by published cases
   * (curated or learned). Unlike `existingPublishedCaseKeys`, this does NOT
   * depend on a traceContentHash (which published cases do not persist), so it
   * catches the §1.2 flooding case where a recurring trace matches a root cause
   * the library already publishes guidance for. Wired from the live CaseLibrary
   * at capture time by the production capture seam.
   */
  existingPublishedSceneRootCauses?: Set<string>;
}

export function buildCaseCandidatesFromRun(
  input: CaseCandidateCaptureInput,
  deps: BuildCaseCandidatesDeps = {},
): CaseCandidate[] {
  const verification = input.claimVerificationResult;
  if (input.result.confidence < CONFIDENCE_HIGH_THRESHOLD) return [];
  if (!verification || verification.status !== 'passed') return [];
  if (verification.issues.some(issue => issue.severity === 'error')) return [];
  if (input.result.rounds <= 1) return [];
  if (!input.provenance.traceContentHash) return [];

  const clusters = projectScrollingCandidateClusters(input.dataEnvelopes);
  const candidates: CaseCandidate[] = [];
  clusters.forEach((cluster, clusterIndex) => {
    const dedupeKey = caseCandidateDedupeKeyFromParts(
      input.provenance.traceContentHash!,
      input.sceneType,
      cluster.rootCause,
    );
    if (deps.existingPublishedCaseKeys?.has(dedupeKey)) return;
    // Scene+rootCause dedupe against the live published library. This is the
    // primary production dedupe (traceContentHash is not persisted on
    // published cases, so existingPublishedCaseKeys alone cannot match them).
    if (deps.existingPublishedSceneRootCauses?.has(`${cluster.scene}::${cluster.rootCause}`)) return;
    candidates.push({
      candidateId: buildCandidateId(input.provenance.traceContentHash!, input.sceneType, cluster.rootCause, input.provenance.runId),
      schemaVersion: CASE_CANDIDATE_SCHEMA_VERSION,
      provenance: {
        sourceSessionId: input.provenance.sessionId,
        sourceAnalysisRunId: input.provenance.runId,
        sourceTurnIndex: input.provenance.turnIndex,
        traceContentHash: input.provenance.traceContentHash!,
        capturedAt: Date.now(),
        engine: input.provenance.engine,
        sceneType: input.sceneType,
        architectureType: input.architectureType || 'unknown',
      },
      cluster: {
        scene: cluster.scene,
        domainPack: cluster.domainPack,
        rootCause: cluster.rootCause,
        responsibility: cluster.responsibility,
        severity: cluster.severity,
        frameCount: cluster.frameCount,
        percentage: cluster.percentage,
        representativeFrame: cluster.representativeFrame,
        evidenceSignatures: cluster.evidenceSignatures,
      },
      evidenceHandle: {
        analysisRunId: input.provenance.runId,
        clusterIndex,
        evidenceRefIds: cluster.evidenceRefIds,
        snapshotPath: input.snapshotPath,
      },
      verification: {
        claimSupportSummary: summarizeClaimSupport(verification.checkedClaimCount, verification.unsupportedClaimCount),
        verifierStatus: verification.status,
        verifierIssueSeverities: verification.issues.map(issue => issue.severity),
        verifierErrorCount: verification.issues.filter(issue => issue.severity === 'error').length,
        verifierWarningCount: verification.issues.filter(issue => issue.severity === 'warning').length,
        confidenceNumeric: input.result.confidence,
        confidenceBucket: confidenceBucket(input.result.confidence),
      },
    });
  });
  return candidates;
}

export function caseCandidateDedupeKey(candidate: CaseCandidate): string {
  return caseCandidateDedupeKeyFromParts(
    candidate.provenance.traceContentHash,
    candidate.provenance.sceneType,
    candidate.cluster.rootCause,
  );
}

export function caseCandidateDedupeKeyFromParts(
  traceContentHash: string,
  sceneType: string,
  primaryRootCause: string,
): string {
  return `${traceContentHash}::${sceneType}::${primaryRootCause}`;
}

function buildCandidateId(
  traceContentHash: string,
  sceneType: string,
  primaryRootCause: string,
  runId: string,
): string {
  const digest = crypto.createHash('sha256')
    .update(`${traceContentHash}:${sceneType}:${primaryRootCause}:${runId}`)
    .digest('hex')
    .slice(0, 16);
  return `casecand-${sanitizeIdPart(runId)}-${digest}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function summarizeClaimSupport(checkedClaimCount: number, unsupportedClaimCount: number): string {
  return `checked=${checkedClaimCount}; unsupported=${unsupportedClaimCount}`;
}

function confidenceBucket(confidence: number): CaseEvolutionConfidenceBucket {
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}
