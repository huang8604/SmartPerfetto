// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI Analyze Facade.
 *
 * Wraps agentv3's service layer into a single `runTurn()` call with no
 * Express dependency. This is the CLI's only touch-point with the agentv3
 * internals — everything else (commands, REPL, IO) depends on this facade.
 *
 * Compared to HTTP route's `runAgentDrivenAnalysis()`, this omits:
 *   - SSE broadcasting (no HTTP response)
 *   - conversation_step derivation (frontend-only concern)
 *   - scene reconstruction payload (deferred to PR-future)
 *   - LLM telemetry logging subscription (best-effort, not critical for CLI)
 *
 * It keeps:
 *   - prepareSession / analyze / conclusion capture
 *   - HTML report generation (written to CLI's session folder, not /api/reports)
 *   - sdkSessionId surfacing for subsequent resume
 */

import * as fs from 'fs';
import { AssistantApplicationService } from '../../assistant/application/assistantApplicationService';
import {
  AgentAnalyzeSessionService,
  buildAgentQueryWithContinuityNotice,
  type AnalyzeManagedSession,
} from '../../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import { createSessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import { getHTMLReportGenerator } from '../../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../../services/agentReportData';
import { normalizeResultForReport } from '../../services/agentResultNormalizer';
import { persistAgentTurn } from '../../services/persistAgentSession';
import { applyFinalResultQualityGate } from '../../services/finalResultQualityGate';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { backendLogPath } from '../../runtimePaths';
import { RagStore } from '../../services/ragStore';
import { SymbolResolver, type ResolvedSymbolCandidate } from '../../services/symbol/symbolResolver';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { installTraceProcessorPrebuilt } from './traceProcessorInstaller';
import {
  resolveAgentRuntimeSelection,
  type BackendAgentRuntimeKind,
} from '../../agentRuntime/runtimeSelection';
import { isProductionAgentRuntimeKind } from '../../agentRuntime/runtimeKinds';
import {
  getSnapshotRuntimeKind,
  getSnapshotRuntimeProviderId,
  getSnapshotRuntimeProviderSnapshotHash,
  type SessionStateSnapshot,
} from '../../agentv3/sessionStateSnapshot';
import type { StreamingUpdate } from '../../agent/types';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { QueryResult } from '../../services/traceProcessorService';
import type { CodeAwareMode } from '../../services/codebase/codeAwareFeature';
import { validateDataEnvelope, type DataEnvelope } from '../../types/dataContract';
import type { CliAnalysisMode, CliSessionLineage } from '../types';

export interface RunTurnInput {
  tracePath?: string;
  traceId?: string;
  referenceTraceId?: string;
  query: string;
  sessionId?: string;
  analysisMode?: CliAnalysisMode;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  /** Backend-session ancestry for CLI Level-3 degraded resume bridges. */
  lineage?: CliSessionLineage;
  /** Receives every StreamingUpdate from the orchestrator in real time. */
  onEvent: (update: StreamingUpdate) => void;
  /**
   * Fires once after `prepareSession` resolves, before `analyze()` starts
   * streaming events. Lets callers create the session folder + switch to
   * direct disk writes instead of buffering events in memory.
   */
  onSessionReady?: (sessionId: string) => void;
}

export interface RunTurnOutput {
  sessionId: string;
  traceId: string;
  sdkSessionId?: string;
  result: AnalysisResult;
  /** Absolute path to the generated HTML report, or undefined if generation failed. */
  reportHtml?: string;
  reportError?: string;
  model?: string;
  providerId?: string | null;
  agentRuntimeKind?: BackendAgentRuntimeKind;
  providerSnapshotHash?: string | null;
}

export function envelopesFromStreamingUpdate(update: StreamingUpdate): DataEnvelope[] {
  if (update.type !== 'data') return [];
  const raw = Array.isArray(update.content) ? update.content : [update.content];
  return raw.filter((item): item is DataEnvelope =>
    Boolean(item && typeof item === 'object' && validateDataEnvelope(item).length === 0));
}

export function shouldExposeLiveStreamingUpdate(update: StreamingUpdate): boolean {
  return update.type !== 'conclusion' && update.type !== 'answer_token';
}

/**
 * Singleton per CLI process.
 * - Own `AssistantApplicationService` — no HTTP routes touch it, so the 30-min
 *   idle cleanup (only scheduled from agentRoutes.ts) never runs.
 * - `SessionPersistenceService` writes to `backend/data/sessions/sessions.db`
 *   (the same DB the HTTP server uses — intentional, so REPL sessions are
 *   visible to the web UI and vice versa).
 */
export class CliAnalyzeService {
  private static checkedTraceProcessorPath: string | null = null;
  private static traceProcessorInstallPromise: Promise<void> | null = null;

  // Independent AssistantApplicationService instance — intentionally separate
  // from the HTTP route's instance. The 30-min idle cleanup timer is registered
  // *only* from agentRoutes.ts at server startup, not from this constructor,
  // so a CLI-owned AppService is never subject to abandonment cleanup. This
  // matters because CLI sessions have no SSE clients (AppService's signal for
  // "abandoned"), so a shared instance would prematurely cull them.
  // ⚠ If a future change moves the cleanup timer into AssistantApplicationService's
  // constructor, this design breaks silently — pass `enableIdleCleanup: false` then.
  private readonly appService = new AssistantApplicationService<AnalyzeManagedSession>();
  private readonly persistence: SessionPersistenceService;
  private readonly analyzeService: AgentAnalyzeSessionService<AnalyzeManagedSession>;

  constructor() {
    this.persistence = SessionPersistenceService.getInstance();
    this.analyzeService = new AgentAnalyzeSessionService<AnalyzeManagedSession>({
      assistantAppService: this.appService,
      createSessionLogger,
      sessionPersistenceService: this.persistence,
      // sessionContextManager omitted — AgentAnalyzeSessionService defaults to
      // the module-level singleton internally.
      // Only invoked on resume; PR1 covers fresh analyze only. Returning null
      // lets prepareSession fall through to a new session rather than throw.
      buildRecoveredResultFromContext: () => null,
    });
  }

  async loadTrace(tracePath: string): Promise<string> {
    await this.ensureTraceProcessorAvailable();
    return getTraceProcessorService().loadTraceFromFilePath(tracePath);
  }

  /**
   * Resume-only path: try to reload an existing trace by its original id,
   * preserving identity so the persisted session's `traceId` still matches.
   * Returns true on success, false if the trace file has been evicted from
   * `uploads/traces/` (caller should then degrade to a fresh load).
   */
  async reloadTraceById(traceId: string): Promise<boolean> {
    await this.ensureTraceProcessorAvailable();
    const info = await getTraceProcessorService().getOrLoadTrace(traceId);
    return info !== undefined;
  }

  async queryTrace(traceId: string, sql: string): Promise<QueryResult> {
    await this.ensureTraceProcessorAvailable();
    return getTraceProcessorService().query(traceId, sql);
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
    // Resolve traceId: either passed in (we assume caller already loaded), or load now.
    let traceId = input.traceId;
    if (!traceId) {
      if (!input.tracePath) {
        throw new Error('runTurn requires either tracePath or traceId');
      }
      traceId = await this.loadTrace(input.tracePath);
    }

    if (isCliE2eFakeMode()) {
      return runCliE2eFakeTurn(input, traceId);
    }

    const { sessionId, session } = this.analyzeService.prepareSession({
      traceId,
      query: input.query,
      requestedSessionId: input.sessionId,
      referenceTraceId: input.referenceTraceId,
    });
    if (input.lineage) {
      session.lineage = input.lineage;
    }
    const effectiveReferenceTraceId = input.referenceTraceId ?? session.referenceTraceId;

    // Bump runSequence for this turn. HTTP route gets the incremented value
    // from an externally-constructed runContext; CLI increments inline so the
    // turn index used by appendMessages (msg-<session>-turn<N>-role) is unique
    // across turns rather than colliding with prior turns of the same session.
    session.runSequence = (session.runSequence || 0) + 1;

    // Surface sessionId to the caller now, before analyze() starts emitting
    // events. Without this, callers must buffer events until runTurn resolves,
    // which accumulates the entire analyze run's output in memory.
    input.onSessionReady?.(sessionId);

    const orchestrator = session.orchestrator;

    // Subscribe to live updates. Wrap in off()-on-finally to avoid handler leaks
    // if runTurn is called multiple times within one CLI process (REPL path).
    const handler = (update: StreamingUpdate) => {
      const envelopes = envelopesFromStreamingUpdate(update);
      if (envelopes.length > 0) {
        session.dataEnvelopes.push(...envelopes);
      }
      if (!shouldExposeLiveStreamingUpdate(update)) return;
      try {
        input.onEvent(update);
      } catch (err) {
        // Don't let a renderer bug kill the analysis — log and continue.
        console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
      }
    };
    orchestrator.on('update', handler);

    let result: AnalysisResult;
    const agentQuery = session.agentQuery && session.query === input.query
      ? session.agentQuery
      : buildAgentQueryWithContinuityNotice(input.query, session.continuityBreaks);
    try {
      result = await orchestrator.analyze(agentQuery, sessionId, traceId, {
        providerId: session.providerId,
        referenceTraceId: effectiveReferenceTraceId,
        analysisMode: input.analysisMode,
        codeAwareMode: input.codeAwareMode,
        codebaseIds: input.codebaseIds,
      });
    } finally {
      orchestrator.off('update', handler);
    }
    (session as unknown as {codeAwareMode?: CodeAwareMode; codebaseIds?: string[]}).codeAwareMode = input.codeAwareMode;
    (session as unknown as {codeAwareMode?: CodeAwareMode; codebaseIds?: string[]}).codebaseIds = input.codebaseIds;
    const normalized = normalizeResultForReport(result, {
      dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
    });
    result.conclusion = normalized.conclusion;
    if (normalized.conclusionContract) {
      result.conclusionContract = normalized.conclusionContract;
    }
    const qualityArtifacts = runClaimVerification({
      conclusionContract: normalized.conclusionContract,
      dataEnvelopes: session.dataEnvelopes as any,
      comparisonReportSection: session.comparisonReportSection,
      policy: 'record_only',
    });
    result.claimSupport = qualityArtifacts.claimSupport;
    result.claimVerificationResult = qualityArtifacts.claimVerificationResult;
    result.identityResolutions = qualityArtifacts.identityResolutions;
    session.claimSupport = qualityArtifacts.claimSupport;
    session.claimVerificationResult = qualityArtifacts.claimVerificationResult;
    session.identityResolutions = qualityArtifacts.identityResolutions;
    const finalQualityIssue = applyFinalResultQualityGate({ result, query: input.query });
    if (finalQualityIssue) {
      try {
        input.onEvent({
          type: 'degraded',
          content: {
            module: 'cliAnalyzeService',
            fallback: 'final_result_quality_gate',
            code: finalQualityIssue.code,
            partial: true,
            message: result.terminationMessage || finalQualityIssue.message,
          },
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
      }
    }
    session.result = result;
    sessionContextManager.get(sessionId, traceId)?.annotateLatestCompletedTurn({
      success: result.success,
      findings: result.findings,
      message: result.conclusion,
      confidence: result.confidence,
      partial: result.partial,
      terminationReason: result.terminationReason,
      terminationMessage: result.terminationMessage,
      conclusionContract: normalized.conclusionContract,
      claimSupport: qualityArtifacts.claimSupport,
      claimVerificationResult: qualityArtifacts.claimVerificationResult,
      identityResolutions: qualityArtifacts.identityResolutions,
    });

    // Persist to SQLite BEFORE building the report — the snapshot is stashed on
    // the session as `_lastSnapshot` and read by the HTML generator. Routes
    // through the same shared helper the HTTP layer uses, so any future schema
    // change applies to both paths automatically.
    persistAgentTurn({
      session,
      sessionId,
      traceId,
      query: input.query,
      result: { conclusion: result.conclusion, totalDurationMs: result.totalDurationMs },
    });

    const persistedSnapshot = (session as unknown as {
      _lastSnapshot?: SessionStateSnapshot;
    })._lastSnapshot;
    const persistedRuntimeKind = getSnapshotRuntimeKind(persistedSnapshot);
    const persistedProviderId = getSnapshotRuntimeProviderId(persistedSnapshot);
    const persistedProviderSnapshotHash = getSnapshotRuntimeProviderSnapshotHash(persistedSnapshot);
    const runtimeSelection = persistedRuntimeKind
      ? null
      : resolveAgentRuntimeSelection(session.providerId ?? null);
    const resolvedRuntimeKind = persistedRuntimeKind ?? runtimeSelection?.kind;
    const publicRuntimeKind = isProductionAgentRuntimeKind(resolvedRuntimeKind)
      ? resolvedRuntimeKind
      : undefined;

    // SDK/session id is runtime-specific and exposed only through the orchestrator hook.
    const sdkSessionId =
      typeof orchestrator.getSdkSessionId === 'function'
        ? orchestrator.getSdkSessionId(sessionId, effectiveReferenceTraceId)
        : undefined;

    const reportOutput = this.buildReportHtml(session, result);

    return {
      sessionId,
      traceId,
      sdkSessionId,
      result,
      reportHtml: reportOutput.html,
      reportError: reportOutput.error,
      // The Claude model name is stored on ClaudeRuntime's config; not trivially
      // exposed via IOrchestrator. Left undefined for PR1; fills in PR2 via
      // CLAUDE_MODEL env read if needed for config.json provenance.
      model: process.env.CLAUDE_MODEL,
      providerId: persistedProviderId !== undefined ? persistedProviderId : session.providerId ?? null,
      agentRuntimeKind: publicRuntimeKind,
      providerSnapshotHash: persistedProviderSnapshotHash !== undefined
        ? persistedProviderSnapshotHash
        : session.providerSnapshotHash ?? null,
    };
  }

  /**
   * Build the HTML report for a completed turn. Routes through the shared
   * `normalizeResultForReport` + `buildAgentDrivenReportData` pipeline the
   * HTTP path uses, so CLI and web UI emit identical reports for the same
   * session (same sanitized conclusion text, same derived conclusionContract).
   */
  private buildReportHtml(
    session: AnalyzeManagedSession,
    result: AnalysisResult,
  ): { html?: string; error?: string } {
    try {
      const normalized = normalizeResultForReport(result, {
        dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
      });
      const reportData = buildAgentDrivenReportData({
        session,
        result: {
          sessionId: session.sessionId,
          success: normalized.success,
          findings: normalized.findings,
          hypotheses: normalized.hypotheses,
          conclusion: normalized.conclusion,
          conclusionContract: normalized.conclusionContract,
          claimSupport: normalized.claimSupport ?? result.claimSupport,
          claimVerificationResult: normalized.claimVerificationResult ?? result.claimVerificationResult,
          identityResolutions: normalized.identityResolutions ?? result.identityResolutions,
          confidence: normalized.confidence,
          rounds: normalized.rounds,
          totalDurationMs: normalized.totalDurationMs,
          partial: normalized.partial,
          terminationReason: normalized.terminationReason,
          terminationMessage: normalized.terminationMessage,
        },
      });
      const html = getHTMLReportGenerator().generateAgentDrivenHTML(reportData);
      return { html };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async ensureTraceProcessorAvailable(): Promise<void> {
    const traceProcessorPath = getTraceProcessorPath();
    if (CliAnalyzeService.checkedTraceProcessorPath === traceProcessorPath) return;

    if (!fs.existsSync(traceProcessorPath)) {
      if (process.env.TRACE_PROCESSOR_PATH) {
        throw new Error(
          [
            `trace_processor_shell binary not found at TRACE_PROCESSOR_PATH: ${traceProcessorPath}`,
            '',
            'Fix TRACE_PROCESSOR_PATH or unset it to let SmartPerfetto download the pinned binary automatically.',
          ].join('\n'),
        );
      }

      await this.installTraceProcessor(traceProcessorPath);
    }

    try {
      fs.accessSync(traceProcessorPath, fs.constants.X_OK);
    } catch {
      throw new Error(
        [
          `trace_processor_shell is not executable: ${traceProcessorPath}`,
          '',
          `Run \`chmod +x ${traceProcessorPath}\`, or set TRACE_PROCESSOR_PATH to an executable binary.`,
        ].join('\n'),
      );
    }

    CliAnalyzeService.checkedTraceProcessorPath = traceProcessorPath;
  }

  private async installTraceProcessor(traceProcessorPath: string): Promise<void> {
    if (!CliAnalyzeService.traceProcessorInstallPromise) {
      console.error(`trace_processor_shell not found. Downloading pinned Perfetto binary to ${traceProcessorPath}...`);
      CliAnalyzeService.traceProcessorInstallPromise = installTraceProcessorPrebuilt(traceProcessorPath)
        .finally(() => {
          CliAnalyzeService.traceProcessorInstallPromise = null;
        });
    }
    await CliAnalyzeService.traceProcessorInstallPromise;
  }

  /**
   * Best-effort teardown. Called by CLI on process exit to stop the
   * trace_processor_shell subprocess — otherwise Node waits on it.
   */
  async shutdown(): Promise<void> {
    try {
      await getTraceProcessorService().cleanup();
    } catch {
      /* ignore — already cleaned or never started */
    }
  }
}

function isCliE2eFakeMode(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.SMARTPERFETTO_CLI_E2E_FAKE === '1';
}

async function runCliE2eFakeTurn(input: RunTurnInput, traceId: string): Promise<RunTurnOutput> {
  const sessionId = input.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  input.onSessionReady?.(sessionId);

  const startedAt = Date.now();
  const timestamp = Date.now();
  const codeAware = buildCliE2eFakeCodeAwareContext(input);
  const baseConclusion = process.env.SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE?.trim() || [
    'CLI E2E fake analysis completed.',
    `Question: ${input.query}`,
    `Trace: ${traceId}`,
    ...(input.referenceTraceId ? [`Reference trace: ${input.referenceTraceId}`] : []),
  ].join('\n');
  const fakeConclusion = codeAware.codeReferences.length > 0
    ? [
        baseConclusion,
        '',
        'Code-aware source references:',
        ...codeAware.codeReferences.map(ref => {
          const lineRange = ref.lineRange ? `:${ref.lineRange.start}-${ref.lineRange.end}` : '';
          const symbol = ref.symbol ? `${ref.symbol} ` : '';
          return `- CodeRef ${symbol}${ref.filePath}${lineRange} (chunkId=${ref.chunkId}, codebaseId=${ref.codebaseId})`;
        }),
      ].join('\n')
    : baseConclusion;

  input.onEvent({
    type: 'progress',
    content: {
      phase: 'cli-e2e-fake',
      message: 'running deterministic fake CLI analysis',
    },
    timestamp,
  });
  input.onEvent({
    type: 'thought',
    content: {
      thought: codeAware.codeReferences.length > 0
        ? 'Using SMARTPERFETTO_CLI_E2E_FAKE with deterministic code-aware symbol lookup to exercise source-level report rendering without a live LLM.'
        : 'Using SMARTPERFETTO_CLI_E2E_FAKE to exercise CLI persistence and rendering without a live LLM.',
    },
    timestamp,
  });
  input.onEvent({
    type: 'conclusion',
    content: {
      conclusion: fakeConclusion,
    },
    timestamp,
  });

  const totalDurationMs = Math.max(1, Date.now() - startedAt);
  const conclusionContract = codeAware.codeReferences.length > 0
    ? {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{
          rank: 1,
          statement: 'Deterministic code-aware CLI E2E conclusion references source-level CodeRefs.',
          confidencePercent: 100,
        }],
        clusters: [],
        evidenceChain: [{
          conclusionId: 'cli-e2e-code-aware',
          text: 'CodeRef metadata was resolved from the registered local codebase RAG store.',
        }],
        claims: [],
        uncertainties: [],
        nextSteps: [],
        metadata: {
          confidencePercent: 100,
          rounds: 1,
        },
        codeReferences: codeAware.codeReferences,
      } as AnalysisResult['conclusionContract'] & {codeReferences: CliE2eFakeCodeReference[]}
    : undefined;
  const claimSupport: NonNullable<AnalysisResult['claimSupport']> = [];
  const claimVerificationResult: NonNullable<AnalysisResult['claimVerificationResult']> = {
    schemaVersion: 'claim_verifier@1',
    status: 'not_checked',
    policy: 'record_only',
    notCheckedReason: 'CLI E2E fake mode does not emit structured claims',
    passed: false,
    checkedClaimCount: 0,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
  };
  return {
    sessionId,
    traceId,
    sdkSessionId: `cli-e2e-fake-${sessionId}`,
    model: 'cli-e2e-fake',
    providerId: null,
    agentRuntimeKind: 'openai-agents-sdk',
    providerSnapshotHash: null,
    reportHtml: buildCliE2eFakeReportHtml({
      sessionId,
      traceId,
      referenceTraceId: input.referenceTraceId,
      query: input.query,
      conclusion: fakeConclusion,
      conclusionContract,
      claimSupport,
      claimVerificationResult,
      identityResolutions: [],
      totalDurationMs,
    }),
    result: {
      sessionId,
      success: true,
      findings: [
        {
          id: 'cli-e2e-fake-finding',
          severity: 'info',
          title: 'CLI E2E fake finding',
          description: 'Deterministic finding emitted by the CLI E2E fake runtime.',
          confidence: 1,
          source: 'cli-e2e',
        },
      ],
      hypotheses: [],
      conclusion: fakeConclusion,
      ...(conclusionContract ? { conclusionContract } : {}),
      claimSupport,
      claimVerificationResult,
      identityResolutions: [],
      confidence: 1,
      rounds: 1,
      totalDurationMs,
    },
  };
}

interface CliE2eFakeCodeReference {
  chunkId: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
}

function buildCliE2eFakeCodeAwareContext(input: RunTurnInput): {codeReferences: CliE2eFakeCodeReference[]} {
  if (!input.codeAwareMode || input.codeAwareMode === 'off' || !input.codebaseIds?.length) {
    return {codeReferences: []};
  }

  const store = new RagStore(backendLogPath('rag_store.json'));
  const resolver = new SymbolResolver(store);
  const symbols = [
    'MainActivity',
    'onActivityCreate',
    'LoadSimulator',
    'simulateAsyncNetworkLoad',
    'runChaosLoop',
    'LaunchConfig',
    'LoadConfig',
  ];
  const refs = new Map<string, CliE2eFakeCodeReference>();

  for (const codebaseId of input.codebaseIds) {
    for (const symbol of symbols) {
      const resolved = resolver.resolveApp({symbol, codebaseId, topK: 2});
      for (const candidate of resolved.candidates) {
        const ref = candidateToCodeReference(candidate, codebaseId);
        if (ref) refs.set(ref.chunkId, ref);
      }
    }
  }

  return {codeReferences: Array.from(refs.values()).slice(0, 8)};
}

function candidateToCodeReference(
  candidate: ResolvedSymbolCandidate,
  fallbackCodebaseId: string,
): CliE2eFakeCodeReference | undefined {
  if (!candidate.chunkId || !candidate.filePath) return undefined;
  return {
    chunkId: candidate.chunkId,
    codebaseId: candidate.codebaseId ?? fallbackCodebaseId,
    filePath: candidate.filePath,
    ...(candidate.lineRange ? {lineRange: candidate.lineRange} : {}),
    ...(candidate.symbol ? {symbol: candidate.symbol} : {}),
  };
}

function buildCliE2eFakeReportHtml(input: {
  sessionId: string;
  traceId: string;
  referenceTraceId?: string;
  query: string;
  conclusion: string;
  conclusionContract?: unknown;
  claimSupport?: AnalysisResult['claimSupport'];
  claimVerificationResult?: AnalysisResult['claimVerificationResult'];
  identityResolutions?: AnalysisResult['identityResolutions'];
  totalDurationMs: number;
}): string {
  return getHTMLReportGenerator().generateAgentDrivenHTML({
    traceId: input.traceId,
    query: input.query,
    result: {
      sessionId: input.sessionId,
      success: true,
      findings: [
        {
          id: 'cli-e2e-fake-finding',
          severity: 'info',
          title: 'CLI E2E fake finding',
          description: 'Deterministic finding emitted by the CLI E2E fake runtime.',
          confidence: 1,
          source: 'cli-e2e',
        },
      ],
      hypotheses: [],
      conclusion: input.conclusion,
      ...(input.conclusionContract ? {conclusionContract: input.conclusionContract} : {}),
      claimSupport: input.claimSupport,
      claimVerificationResult: input.claimVerificationResult,
      identityResolutions: input.identityResolutions,
      confidence: 1,
      rounds: 1,
      totalDurationMs: input.totalDurationMs,
    },
    hypotheses: [],
    dialogue: [],
    timestamp: Date.now(),
  });
}
