// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { requireRequestContext } from '../middleware/auth';
import { isOwnedByContext, sendResourceNotFound } from '../services/resourceOwnership';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  privateAnalysisQueryMessage,
  projectPrivateConclusion,
  projectPrivateStructuredValue,
  projectPrivateTerminationMessage,
  projectPrivateTerminationReason,
  sessionUsesPrivateKnowledge,
} from '../services/security/privateAnalysisProjection';

interface AgentReportRoutesDeps {
  getSession: (sessionId: string) => any;
  recoverResultForSessionIfNeeded: (sessionId: string, session: any) => any;
  normalizeNarrativeForClient: (narrative: string) => string;
  buildClientFindings: (findings: any[], scenes: any[]) => any[];
  buildSessionResultContract: (session: any, clientFindings: any[]) => unknown;
  getCompletedPayload?: (session: any) => any;
}

export function registerAgentReportRoutes(
  router: express.Router,
  deps: AgentReportRoutesDeps
): void {
  router.get('/:sessionId/report', (req, res) => {
    const { sessionId } = req.params;

    const session = deps.getSession(sessionId);
    if (!session || !isOwnedByContext(session, requireRequestContext(req))) {
      return sendResourceNotFound(res, 'Session not found');
    }

    if (session.status !== 'completed' && session.status !== 'quota_exceeded') {
      return res.status(400).json({
        success: false,
        error: 'Session is not completed yet',
        status: session.status,
      });
    }

    const result = deps.recoverResultForSessionIfNeeded(sessionId, session);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'No completed turn result available for this session',
        hint: `Use /api/agent/v1/${sessionId}/turns to inspect historical turns`,
      });
    }

    const completedPayload = deps.getCompletedPayload?.(session);
    const rawConclusion = completedPayload?.normalizedConclusion
      || deps.normalizeNarrativeForClient(result.conclusion);
    const privateKnowledge = sessionUsesPrivateKnowledge(session);
    const outputLanguage = session.outputLanguage
      ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const conclusion = privateKnowledge
      ? projectPrivateConclusion({
          sessionId,
          conclusion: rawConclusion,
          success: result.success === true,
          language: outputLanguage,
        })
      : rawConclusion;
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const rawClientFindings = deps.buildClientFindings(findings, session.scenes || []);
    const clientFindings = privateKnowledge
      ? projectPrivateStructuredValue(sessionId, rawClientFindings)
      : rawClientFindings;
    const rawResultContract = deps.buildSessionResultContract(session, rawClientFindings);
    const resultContract = privateKnowledge
      ? projectPrivateStructuredValue(sessionId, rawResultContract)
      : rawResultContract;
    const rawHypotheses = Array.isArray(result.hypotheses) ? result.hypotheses : [];
    const hypotheses = privateKnowledge
      ? projectPrivateStructuredValue(sessionId, rawHypotheses)
      : rawHypotheses;
    const conversationTimeline = Array.isArray(session.conversationSteps)
      ? session.conversationSteps
      : [];

    // Use snapshot as single source of truth for agentv3-specific state.
    // Falls back to live getters for active sessions where snapshot hasn't been taken yet.
    const snapshot = privateKnowledge
      ? undefined
      : SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId);
    const analysisNotes = privateKnowledge ? [] : snapshot?.analysisNotes
      ?? (typeof session.orchestrator?.getSessionNotes === 'function'
        ? session.orchestrator.getSessionNotes(sessionId) : []);
    const analysisPlan = privateKnowledge ? null : snapshot?.analysisPlan
      ?? (typeof session.orchestrator?.getSessionPlan === 'function'
        ? session.orchestrator.getSessionPlan(sessionId) : null);
    const uncertaintyFlags = privateKnowledge ? [] : snapshot?.uncertaintyFlags
      ?? (typeof session.orchestrator?.getSessionUncertaintyFlags === 'function'
        ? session.orchestrator.getSessionUncertaintyFlags(sessionId) : []);
    const rawClaimSupport = completedPayload?.qualityArtifacts?.claimSupport || result.claimSupport;
    const rawClaimVerification = completedPayload?.qualityArtifacts?.claimVerificationResult
      || result.claimVerificationResult;
    const rawIdentityResolutions = completedPayload?.qualityArtifacts?.identityResolutions
      || result.identityResolutions;
    const rawConclusionContract = completedPayload?.normalizedConclusionContract
      || result.conclusionContract;
    const rawUiActionProposals = completedPayload?.uiActionProposals || result.uiActionProposals || [];

    const report = {
      sessionId,
      traceId: session.traceId,
      query: privateKnowledge ? privateAnalysisQueryMessage(outputLanguage) : session.query,
      createdAt: session.createdAt,
      completedAt: Date.now(),
      summary: {
        conclusion,
        confidence: result.confidence,
        totalDurationMs: result.totalDurationMs,
        rounds: result.rounds,
        partial: result.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(result.terminationReason)
          : result.terminationReason,
        terminationMessage: privateKnowledge
          ? projectPrivateTerminationMessage(result.terminationMessage, outputLanguage)
          : result.terminationMessage,
      },
      reportUrl: completedPayload?.finalArtifacts?.reportUrl,
      reportError: privateKnowledge ? undefined : completedPayload?.finalArtifacts?.reportError,
      resultSnapshotId: completedPayload?.finalArtifacts?.resultSnapshotId,
      conclusionContract: privateKnowledge
        ? projectPrivateStructuredValue(sessionId, rawConclusionContract)
        : rawConclusionContract,
      claimSupport: privateKnowledge
        ? projectPrivateStructuredValue(sessionId, rawClaimSupport)
        : rawClaimSupport,
      claimVerificationResult: privateKnowledge
        ? projectPrivateStructuredValue(sessionId, rawClaimVerification)
        : rawClaimVerification,
      identityResolutions: privateKnowledge
        ? projectPrivateStructuredValue(sessionId, rawIdentityResolutions)
        : rawIdentityResolutions,
      uiActionProposals: privateKnowledge
        ? projectPrivateStructuredValue(sessionId, rawUiActionProposals)
        : rawUiActionProposals,
      findings: clientFindings.map((f: any) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
      })),
      hypotheses: hypotheses.map((h: any) => ({
        id: h.id,
        description: h.description,
        status: h.status,
        confidence: h.confidence,
      })),
      conversationTimeline: (privateKnowledge ? [] : conversationTimeline).map((step: any) => ({
        eventId: step.eventId,
        ordinal: step.ordinal,
        phase: step.phase,
        role: step.role,
        text: step.text,
        timestamp: step.timestamp,
        sourceEventType: step.sourceEventType,
      })),
      queryHistory: privateKnowledge ? [] : session.queryHistory || [],
      conclusionHistory: privateKnowledge ? [] : session.conclusionHistory || [],
      analysisNotes,
      analysisPlan,
      uncertaintyFlags,
      resultContract,
      logFile: privateKnowledge ? undefined : session.logger.getLogFilePath(),
    };

    return res.json({
      success: true,
      report,
    });
  });
}
