// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { StreamingUpdate } from '../agent/types';
import type { ConclusionContract } from '../agent/core/conclusionContract';
import type { AnalysisOptions } from '../agent/core/orchestratorTypes';
import {
  QUICK_REFERENCE_HEADING,
  QUICK_TRIAGE_HEADING,
  QUICK_TRIAGE_MAX_CLAIMS,
  QUICK_TRIAGE_MAX_FACT_BULLETS,
  QUICK_TRIAGE_MAX_STATEMENT_CHARS,
} from '../agentv3/quickAnswerContract';
import {
  detectFocusApps,
  focusAppTimeRangeFromSelection,
  type FocusAppDetectionResult,
} from '../agentv3/focusAppDetector';
import { localize, type OutputLanguage } from '../agentv3/outputLanguage';
import type { TraceProcessorService } from '../services/traceProcessorService';
import { buildFocusAppEvidencePayload } from './focusAppEvidence';
import {
  buildQuickFocusAppDirectAnswer,
  type QuickFocusAppDirectAnswer,
} from './quickFocusAppDirectAnswer';
import { buildQuickProcessIdentityDirectAnswer } from './quickProcessIdentityDirectAnswer';
import {
  buildQuickProcessIdentityEvidence,
  createQuickProcessIdentitySkillExecutor,
  shouldUseEvidenceOnlyQuickAnalysis,
} from './quickProcessIdentityEvidence';
import type { QuickProcessIdentityDirectAnswer } from './quickProcessIdentityDirectAnswer';
import { buildQuickTraceFactDirectAnswer } from './quickTraceFactDirectAnswer';
import type { QuickTraceFactDirectAnswer } from './quickTraceFactDirectAnswer';
import {
  buildQuickScrollingTriageDirectAnswer,
  buildQuickScrollingTriageEvidence,
  type QuickScrollingTriageDirectAnswer,
} from './quickScrollingTriageDirectAnswer';
import {
  buildQuickTraceFactEvidence,
  shouldSkipFocusDetectionForQuickTraceFactEvidence,
  shouldUseTraceFactEvidenceOnlyQuickAnalysis,
} from './quickTraceFactEvidence';

export type RuntimeQuickEvidenceDirectAnswer =
  QuickFocusAppDirectAnswer |
  QuickProcessIdentityDirectAnswer |
  QuickTraceFactDirectAnswer |
  QuickScrollingTriageDirectAnswer;

export interface RuntimeQuickEvidenceCounts {
  currentRunDataEnvelopes: number;
  citedEvidenceRefs: number;
}

export function countRuntimeQuickEvidenceCitedRefs(answer: RuntimeQuickEvidenceDirectAnswer): number {
  const refs = new Set<string>();
  for (const claim of answer.conclusionContract.claims ?? []) {
    for (const ref of claim.references) {
      if (ref.evidenceRefId) refs.add(ref.evidenceRefId);
    }
  }
  return refs.size;
}

function truncateQuickText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildCombinedConclusion(input: {
  answers: RuntimeQuickEvidenceDirectAnswer[];
  outputLanguage: OutputLanguage;
}): string {
  const statements = input.answers
    .flatMap(answer => answer.conclusionContract.conclusions)
    .map(conclusion => conclusion.statement.trim())
    .filter(Boolean)
    .slice(0, QUICK_TRIAGE_MAX_FACT_BULLETS)
    .map(statement => truncateQuickText(statement, QUICK_TRIAGE_MAX_STATEMENT_CHARS));
  const claims = input.answers
    .flatMap(answer => answer.conclusionContract.claims ?? [])
    .filter(claim => claim.text.trim())
    .slice(0, QUICK_TRIAGE_MAX_CLAIMS);

  const claimLines = claims.map((claim, index) => {
    const first = claim.references[0];
    const parts = [
      first?.evidenceRefId ? `evidence_ref_id=\`${first.evidenceRefId}\`` : undefined,
    ].filter(Boolean);
    return `- Q${index + 1}: ${parts.join('; ')}`;
  });

  const summaryLines = statements.map(statement => `- ${statement}`).join('\n');
  return localize(
    input.outputLanguage,
    `${QUICK_TRIAGE_HEADING}\n${summaryLines}\n\n${QUICK_REFERENCE_HEADING}\n${claimLines.join('\n')}`,
    `## Quick Triage\n${summaryLines}\n\n## Sentence-Level Data References\n${claimLines.join('\n')}`,
  );
}

function buildCombinedConclusionContract(input: {
  answers: RuntimeQuickEvidenceDirectAnswer[];
}): ConclusionContract {
  const conclusions = input.answers
    .flatMap(answer => answer.conclusionContract.conclusions)
    .slice(0, QUICK_TRIAGE_MAX_FACT_BULLETS);
  const claims = input.answers
    .flatMap(answer => answer.conclusionContract.claims ?? [])
    .slice(0, QUICK_TRIAGE_MAX_CLAIMS);
  const confidencePercent = Math.min(
    ...input.answers.map(answer => answer.conclusionContract.metadata?.confidencePercent ?? 100),
  );
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: conclusions
      .map((conclusion, index) => ({
        ...conclusion,
        rank: index + 1,
      })),
    clusters: [],
    evidenceChain: input.answers.flatMap(answer => answer.conclusionContract.evidenceChain),
    claims,
    uncertainties: input.answers.flatMap(answer => answer.conclusionContract.uncertainties),
    nextSteps: input.answers.flatMap(answer => answer.conclusionContract.nextSteps),
    metadata: {
      confidencePercent,
      rounds: 0,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

export function combineRuntimeQuickEvidenceDirectAnswers(input: {
  focusAppAnswer?: QuickFocusAppDirectAnswer;
  processIdentityAnswer?: QuickProcessIdentityDirectAnswer;
  traceFactAnswer?: QuickTraceFactDirectAnswer;
  scrollingTriageAnswer?: QuickScrollingTriageDirectAnswer;
  outputLanguage: OutputLanguage;
}): RuntimeQuickEvidenceDirectAnswer | undefined {
  const answers = [
    input.focusAppAnswer,
    input.processIdentityAnswer,
    input.traceFactAnswer,
    input.scrollingTriageAnswer,
  ].filter((answer): answer is RuntimeQuickEvidenceDirectAnswer => Boolean(answer));
  if (answers.length === 0) return undefined;
  if (answers.length === 1) return answers[0];

  const conclusionContract = buildCombinedConclusionContract({ answers });
  return {
    conclusion: buildCombinedConclusion({ answers, outputLanguage: input.outputLanguage }),
    conclusionContract,
    confidence: Math.min(...answers.map(answer => answer.confidence)),
  };
}

export async function buildRuntimeQuickEvidenceDirectAnswer(input: {
  query: string;
  traceId: string;
  packageName?: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  traceProcessorService: TraceProcessorService;
  outputLanguage: OutputLanguage;
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
  focusResult?: FocusAppDetectionResult;
  emitUpdate: (update: StreamingUpdate) => void;
}): Promise<{
  directAnswer: RuntimeQuickEvidenceDirectAnswer;
  effectivePackageName?: string;
  evidenceCounts: RuntimeQuickEvidenceCounts;
} | undefined> {
  if (
    !input.quickFocusAppPreEvidence &&
    !input.quickProcessIdentityPreEvidence &&
    !input.quickTraceFactPreEvidence &&
    !input.quickScrollingTriagePreEvidence
  ) {
    return undefined;
  }

  const hasExplicitPackageName = !!input.packageName;
  const selectionTimeRange = focusAppTimeRangeFromSelection(input.selectionContext);
  const needsFocusForScrolling = input.quickScrollingTriagePreEvidence && !hasExplicitPackageName;
  const skipFocusEvidence = !input.quickFocusAppPreEvidence && !needsFocusForScrolling && (hasExplicitPackageName || (
    input.quickTraceFactPreEvidence
    && !input.quickProcessIdentityPreEvidence
    && shouldSkipFocusDetectionForQuickTraceFactEvidence(input.query)
  ));
  const focusResult = input.focusResult ?? (skipFocusEvidence
    ? { apps: [], primaryApp: undefined, method: 'none' as const }
    : await detectFocusApps(input.traceProcessorService, input.traceId, {
        timeRange: selectionTimeRange,
      }));
  const effectivePackageName = input.packageName || focusResult.primaryApp;
  const focusEvidencePayload = skipFocusEvidence
    ? undefined
    : buildFocusAppEvidencePayload(focusResult, input.traceId, 'current', input.outputLanguage);
  const promptFocusResult = focusEvidencePayload?.focusResult ?? focusResult;
  const processIdentityEvidencePromise = input.quickProcessIdentityPreEvidence
    ? buildQuickProcessIdentityEvidence({
        skillExecutor: createQuickProcessIdentitySkillExecutor(input.traceProcessorService),
        traceId: input.traceId,
        focusResult: promptFocusResult,
        packageName: effectivePackageName,
        outputLanguage: input.outputLanguage,
      })
    : Promise.resolve(undefined);
  const traceFactEvidencePromise = input.quickTraceFactPreEvidence
    ? buildQuickTraceFactEvidence({
        traceProcessor: input.traceProcessorService,
        traceId: input.traceId,
        query: input.query,
        focusResult: promptFocusResult,
        packageName: effectivePackageName,
        timeRange: selectionTimeRange,
        outputLanguage: input.outputLanguage,
    })
    : Promise.resolve(undefined);
  const scrollingTriageEvidencePromise = input.quickScrollingTriagePreEvidence
    ? buildQuickScrollingTriageEvidence({
        traceProcessorService: input.traceProcessorService,
        traceId: input.traceId,
        packageName: effectivePackageName,
        focusResult: promptFocusResult,
        selectionContext: input.selectionContext,
        outputLanguage: input.outputLanguage,
      })
    : Promise.resolve(undefined);
  const [processIdentityEvidence, traceFactEvidence, scrollingTriageEvidence] = await Promise.all([
    processIdentityEvidencePromise,
    traceFactEvidencePromise,
    scrollingTriageEvidencePromise,
  ]);

  const processIdentityEvidenceOnly = shouldUseEvidenceOnlyQuickAnalysis({
    skipQuickTracePreflightDetection: input.quickProcessIdentityPreEvidence,
    processIdentityEvidence,
  });
  const traceFactEvidenceOnly = shouldUseTraceFactEvidenceOnlyQuickAnalysis({
    quickTraceFactPreEvidence: input.quickTraceFactPreEvidence,
    traceFactEvidence,
  });
  const directProcessIdentityAnswer = input.quickProcessIdentityPreEvidence
    ? buildQuickProcessIdentityDirectAnswer({
        evidence: processIdentityEvidence,
        outputLanguage: input.outputLanguage,
      })
    : undefined;
  const directTraceFactAnswer = input.quickTraceFactPreEvidence
    ? buildQuickTraceFactDirectAnswer({
        evidence: traceFactEvidence,
        outputLanguage: input.outputLanguage,
      })
    : undefined;
  const directFocusAppAnswer = input.quickFocusAppPreEvidence
    ? buildQuickFocusAppDirectAnswer({
        query: input.query,
        evidence: focusEvidencePayload,
        selectionContext: input.selectionContext,
        outputLanguage: input.outputLanguage,
      })
    : undefined;
  const directScrollingTriageAnswer = input.quickScrollingTriagePreEvidence
    ? buildQuickScrollingTriageDirectAnswer({
        evidence: scrollingTriageEvidence,
        outputLanguage: input.outputLanguage,
      })
    : undefined;
  const directAnswer = combineRuntimeQuickEvidenceDirectAnswers({
    focusAppAnswer: directFocusAppAnswer,
    processIdentityAnswer: directProcessIdentityAnswer,
    traceFactAnswer: directTraceFactAnswer,
    scrollingTriageAnswer: directScrollingTriageAnswer,
    outputLanguage: input.outputLanguage,
  });
  const hasRequiredEvidence =
    (!input.quickFocusAppPreEvidence || Boolean(directFocusAppAnswer)) &&
    (!input.quickProcessIdentityPreEvidence || processIdentityEvidenceOnly) &&
    (!input.quickTraceFactPreEvidence || traceFactEvidenceOnly) &&
    (!input.quickScrollingTriagePreEvidence || Boolean(directScrollingTriageAnswer));
  if (!directAnswer || !hasRequiredEvidence) return undefined;

  const currentRunDataEnvelopes =
    (focusEvidencePayload?.envelope ? 1 : 0) +
    (processIdentityEvidence?.envelopes.length ?? 0) +
    (traceFactEvidence?.envelopes.length ?? 0) +
    (scrollingTriageEvidence?.envelopes.length ?? 0);

  if (focusEvidencePayload?.envelope) {
    input.emitUpdate({
      type: 'data',
      content: [focusEvidencePayload.envelope],
      timestamp: Date.now(),
    });
  }
  if (processIdentityEvidence?.envelopes.length) {
    input.emitUpdate({
      type: 'data',
      content: processIdentityEvidence.envelopes,
      timestamp: Date.now(),
    });
  }
  if (traceFactEvidence?.envelopes.length) {
    input.emitUpdate({
      type: 'data',
      content: traceFactEvidence.envelopes,
      timestamp: Date.now(),
    });
  }
  if (scrollingTriageEvidence?.envelopes.length) {
    input.emitUpdate({
      type: 'data',
      content: scrollingTriageEvidence.envelopes,
      timestamp: Date.now(),
    });
  }

  return {
    directAnswer,
    effectivePackageName,
    evidenceCounts: {
      currentRunDataEnvelopes,
      citedEvidenceRefs: countRuntimeQuickEvidenceCitedRefs(directAnswer),
    },
  };
}
