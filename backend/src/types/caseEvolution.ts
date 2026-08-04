// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract } from '../agent/core/conclusionContract';
import type { AnalysisResult } from '../agent/core/orchestratorTypes';
import type {
  CaseEvidenceSignature,
  CaseKnowledgeFinding,
  CaseKnowledgeRecommendation,
  CaseKnowledgeRelations,
  CaseKnowledgeResponsibility,
  CaseKnowledgeSeverity,
} from './caseKnowledge';
import type { ClaimVerificationResult } from './claimVerification';
import type { DataEnvelope } from './dataContract';
import type { KnowledgeScope } from '../services/scopedKnowledgeStore';

export type CaseCandidateState = 'pending_review' | 'reviewed' | 'rejected' | 'archived';
export const CASE_CANDIDATE_SCHEMA_VERSION = 'case_candidate@2' as const;
export const CASE_CANDIDATE_REVIEW_SCHEMA_VERSION = 'case_candidate_review@1' as const;
export const CONFIDENCE_HIGH_THRESHOLD = 0.8;

export type CaseEvolutionEngine = 'claude' | 'openai' | 'opencode' | 'pi' | (string & {});
export type CaseEvolutionConfidenceBucket = 'high' | 'medium' | 'low';

export interface CaseCandidate {
  candidateId: string;
  schemaVersion: typeof CASE_CANDIDATE_SCHEMA_VERSION;
  provenance: {
    sourceSessionId: string;
    sourceAnalysisRunId: string;
    sourceTurnIndex: number;
    traceContentHash: string;
    capturedAt: number;
    engine: CaseEvolutionEngine;
    sceneType: string;
    architectureType: string;
    originScope: {
      tenantId: string;
      workspaceId: string;
    };
  };
  cluster: {
    scene: string;
    domainPack: 'scrolling.v1';
    rootCause: string;
    responsibility: CaseKnowledgeResponsibility;
    severity: CaseKnowledgeSeverity;
    frameCount: number;
    percentage: number;
    representativeFrame?: {
      frameId: string;
      durMs: number;
      vsyncMissed: number;
    };
    evidenceSignatures: Record<string, unknown>;
  };
  evidenceHandle: {
    analysisRunId: string;
    clusterIndex: number;
    evidenceRefIds: string[];
    snapshotPath: string;
  };
  verification: {
    claimSupportSummary: string;
    verifierStatus: ClaimVerificationResult['status'];
    verifierIssueSeverities: Array<'error' | 'warning'>;
    verifierErrorCount: number;
    verifierWarningCount: number;
    confidenceNumeric: number;
    confidenceBucket: CaseEvolutionConfidenceBucket;
  };
}

export interface CaseCandidateReview {
  schemaVersion: typeof CASE_CANDIDATE_REVIEW_SCHEMA_VERSION;
  candidateId: string;
  decision: 'promote' | 'reject' | 'needs_more_evidence';
  confidence: CaseEvolutionConfidenceBucket;
  proposed: {
    title: string;
    primaryRootCause: string;
    secondaryRootCauses: string[];
    responsibility: CaseKnowledgeResponsibility;
    severity: CaseKnowledgeSeverity;
    evidenceSignatures: {
      required: CaseEvidenceSignature[];
      supportive: CaseEvidenceSignature[];
    };
    findings: CaseKnowledgeFinding[];
    recommendations: {
      app: CaseKnowledgeRecommendation[];
      oem: CaseKnowledgeRecommendation[];
    };
    relations: CaseKnowledgeRelations;
  };
  evidenceSummary: string;
  risks: string[];
}

export interface CaseCandidateCaptureInput {
  result: AnalysisResult;
  conclusionContract?: ConclusionContract;
  claimVerificationResult?: ClaimVerificationResult;
  dataEnvelopes: DataEnvelope[];
  sceneType: string;
  architectureType?: string;
  knowledgeScope?: KnowledgeScope;
  snapshotPath: string;
  provenance: {
    sessionId: string;
    runId: string;
    turnIndex: number;
    engine: CaseEvolutionEngine;
    traceContentHash: string | null;
  };
}

export interface CaseEvolutionConfig {
  captureEnabled: boolean;
  reviewEnabled: boolean;
  notesWriteEnabled: boolean;
  ingestEnabled: boolean;
  retrieveEnabled: boolean;
  promptInjectEnabled: boolean;
  includeDrafts: boolean;
  workerConcurrency: number;
  queueMax: number;
  cooldownMs: number;
  dailyBudget: number;
  leaseMs: number;
  maxAttempts: number;
  pollIntervalMs: number;
}
