// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  type AgentRuntimeAnalysisResult,
  type Hypothesis,
  type IOrchestrator,
  type StreamingUpdate,
} from '../../agent';
import { createAgentOrchestrator } from '../../agentRuntime';
import { getProviderService } from '../../services/providerManager';
import { resolveProviderRuntimeSnapshot } from '../../services/providerManager/providerSnapshot';
import type { AgentRuntimeKind, ProviderScope } from '../../services/providerManager';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import {
  getSnapshotRuntimeKind,
  getSnapshotRuntimeProviderId,
  getSnapshotRuntimeProviderSnapshotHash,
  type ProviderContinuityBreak,
  type SessionLineage,
  type ComparisonReportSection,
  type ComparisonSourceKind,
} from '../../agentv3/sessionStateSnapshot';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import {
  type EnhancedSessionContext,
  sessionContextManager as defaultSessionContextManager,
} from '../../agent/context/enhancedSessionContext';
import type { ClaimSupportV1 } from '../../types/evidenceContract';
import type { ClaimVerificationResult } from '../../types/claimVerification';
import type { IdentityResolutionV1 } from '../../types/identityContract';
import { type SessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {
  AssistantApplicationService,
  type ManagedAssistantSession,
} from './assistantApplicationService';

export interface AnalyzeSessionConversationStep {
  eventId: string;
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp: number;
  sourceEventType?: string;
}

export interface AnalyzeSessionAgentDialogueItem {
  agentId: string;
  type: 'task' | 'response' | 'question';
  content: any;
  timestamp: number;
}

export interface AnalyzeSessionAgentResponseItem {
  taskId: string;
  agentId: string;
  response: any;
  timestamp: number;
}

export interface AnalyzeSessionRunContext {
  runId: string;
  requestId: string;
  sequence: number;
  query: string;
  startedAt: number;
  completedAt?: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded';
  error?: string;
}

export interface AnalyzeManagedSession extends ManagedAssistantSession {
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  traceId: string;
  query: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  /** Provider Manager profile used for this SDK session. null means env/default fallback is pinned. */
  providerId?: string | null;
  /** Non-secret ProviderSnapshot hash used to decide whether SDK session state can be reused. */
  providerSnapshotHash?: string | null;
  providerSnapshotChanged?: boolean;
  providerSnapshotChangeReason?: string;
  /** Original user query plus internal continuity preamble for the runtime only. */
  agentQuery?: string;
  /** Append-only provider/runtime continuity breaks that forced fresh SDK context. */
  continuityBreaks?: ProviderContinuityBreak[];
  /** Backend-session ancestry when a user-visible session bridged to a fresh backend session. */
  lineage?: SessionLineage;
  /** Reference trace ID for raw dual-trace comparison sessions. */
  referenceTraceId?: string;
  /** Comparison source model used by this session. */
  comparisonSource?: ComparisonSourceKind;
  /** Shared deterministic comparison section for report generation. */
  comparisonReportSection?: ComparisonReportSection;
  logger: SessionLogger;
  result?: AgentRuntimeAnalysisResult;
  hypotheses: Hypothesis[];
  agentDialogue: AnalyzeSessionAgentDialogueItem[];
  dataEnvelopes: any[];
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
  agentResponses: AnalyzeSessionAgentResponseItem[];
  conversationOrdinal: number;
  conversationSteps: AnalyzeSessionConversationStep[];
  runSequence?: number;
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
  /** Cross-turn query history — appended on each turn, never overwritten */
  queryHistory?: Array<{ turn: number; query: string; timestamp: number }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory?: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }>;
}

interface SessionContextManagerLike {
  set(sessionId: string, traceId: string, context: EnhancedSessionContext): void;
}

interface AgentAnalyzeSessionServiceDeps<TSession extends AnalyzeManagedSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  createSessionLogger: (sessionId: string) => SessionLogger;
  sessionPersistenceService: SessionPersistenceService;
  /** Defaults to the module-level `sessionContextManager` singleton. Callers
   *  (HTTP route, CLI) no longer need to import it just to satisfy the deps. */
  sessionContextManager?: SessionContextManagerLike;
  buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;
}

interface PrepareAnalyzeSessionInput {
  traceId: string;
  query: string;
  requestedSessionId?: string;
  referenceTraceId?: string;
  providerId?: string | null;
  providerScope?: ProviderScope;
  options?: any;
}

export interface PrepareAnalyzeSessionResult<TSession extends AnalyzeManagedSession> {
  sessionId: string;
  session: TSession;
  isNewSession: boolean;
}

export class AnalyzeSessionPreparationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly hint?: string;

  constructor(message: string, options: { code: string; httpStatus: number; hint?: string }) {
    super(message);
    this.name = 'AnalyzeSessionPreparationError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.hint = options.hint;
  }
}

function normalizeReferenceTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function comparisonSourceForReference(referenceTraceId?: string): ComparisonSourceKind | undefined {
  return referenceTraceId ? 'raw_trace_pair' : undefined;
}

function isProviderContinuityBreak(value: unknown): value is ProviderContinuityBreak {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ProviderContinuityBreak>;
  return typeof candidate.at === 'number'
    && Number.isFinite(candidate.at)
    && typeof candidate.previousProviderHash === 'string'
    && candidate.previousProviderHash.length > 0
    && candidate.reason === 'provider_snapshot_hash_mismatch';
}

function normalizeContinuityBreaks(value: unknown): ProviderContinuityBreak[] {
  return Array.isArray(value) ? value.filter(isProviderContinuityBreak) : [];
}

function appendProviderContinuityBreak(
  existing: unknown,
  previousProviderHash: string,
): ProviderContinuityBreak[] {
  return [
    ...normalizeContinuityBreaks(existing),
    {
      at: Date.now(),
      previousProviderHash,
      reason: 'provider_snapshot_hash_mismatch',
    },
  ];
}

export function buildAgentQueryWithContinuityNotice(
  query: string,
  continuityBreaks: readonly ProviderContinuityBreak[] | undefined,
): string {
  if (!continuityBreaks || continuityBreaks.length === 0) return query;
  const template = loadPromptTemplate('prompt-session-continuity-break');
  if (!template) return query;
  const latestBreak = continuityBreaks[continuityBreaks.length - 1];
  return renderTemplate(template, {
    breakCount: continuityBreaks.length,
    previousProviderHash: latestBreak.previousProviderHash,
    reason: latestBreak.reason,
    query,
  });
}

function readPersistedReferenceTraceId(
  stateSnapshot: { referenceTraceId?: string } | null | undefined,
  metadata: { referenceTraceId?: unknown } | undefined,
): string | undefined {
  return normalizeReferenceTraceId(stateSnapshot?.referenceTraceId)
    ?? normalizeReferenceTraceId(metadata?.referenceTraceId);
}

function assertReferenceTraceCompatible(input: {
  requestedSessionId: string;
  existingReferenceTraceId?: string;
  requestedReferenceTraceId?: string;
}): void {
  const existingReferenceTraceId = normalizeReferenceTraceId(input.existingReferenceTraceId);
  const requestedReferenceTraceId = normalizeReferenceTraceId(input.requestedReferenceTraceId);

  if (existingReferenceTraceId && requestedReferenceTraceId && existingReferenceTraceId !== requestedReferenceTraceId) {
    throw new AnalyzeSessionPreparationError('referenceTraceId mismatch for requested session', {
      code: 'REFERENCE_TRACE_ID_MISMATCH',
      httpStatus: 400,
      hint: `This comparison session uses referenceTraceId=${existingReferenceTraceId}. Start a new chat to compare against a different reference trace.`,
    });
  }

  if (!existingReferenceTraceId && requestedReferenceTraceId) {
    throw new AnalyzeSessionPreparationError('referenceTraceId mismatch for requested session', {
      code: 'REFERENCE_TRACE_ID_MISMATCH',
      httpStatus: 400,
      hint: 'This session was created for single-trace analysis. Start a new chat to run raw trace comparison.',
    });
  }
}

export class AgentAnalyzeSessionService<TSession extends AnalyzeManagedSession> {
  private readonly assistantAppService: AssistantApplicationService<TSession>;
  private readonly createSessionLogger: (sessionId: string) => SessionLogger;
  private readonly sessionPersistenceService: SessionPersistenceService;
  private readonly sessionContextManager: SessionContextManagerLike;
  private readonly buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;

  constructor(deps: AgentAnalyzeSessionServiceDeps<TSession>) {
    this.assistantAppService = deps.assistantAppService;
    this.createSessionLogger = deps.createSessionLogger;
    this.sessionPersistenceService = deps.sessionPersistenceService;
    this.sessionContextManager = deps.sessionContextManager ?? defaultSessionContextManager;
    this.buildRecoveredResultFromContext = deps.buildRecoveredResultFromContext;
  }

  prepareSession(input: PrepareAnalyzeSessionInput): PrepareAnalyzeSessionResult<TSession> {
    const { traceId, query, requestedSessionId, options = {} } = input;
    const providerScope = input.providerScope;
    const requestedReferenceTraceId = normalizeReferenceTraceId(input.referenceTraceId ?? options.referenceTraceId);
    let inheritedReferenceTraceId: string | undefined;
    const explicitProviderId = input.providerId !== undefined
      ? input.providerId
      : options.providerId as string | null | undefined;
    const providerSvc = getProviderService();

    if (typeof explicitProviderId === 'string' && !providerSvc.getRawProvider(explicitProviderId, providerScope)) {
      throw new AnalyzeSessionPreparationError(`Provider not found: ${explicitProviderId}`, {
        code: 'PROVIDER_NOT_FOUND',
        httpStatus: 404,
      });
    }

    const activeProviderId = explicitProviderId !== undefined
      ? undefined
      : providerSvc.getRawEffectiveProvider(providerScope)?.id;
    const sessionProviderId = explicitProviderId !== undefined
      ? explicitProviderId
      : activeProviderId ?? null;
    const resolveProviderSnapshotHash = (
      providerId: string | null,
      runtimeOverride?: AgentRuntimeKind,
    ) => resolveProviderRuntimeSnapshot(providerSvc, providerId, runtimeOverride, providerScope).snapshotHash;
    const sessionProviderSnapshotHash = resolveProviderSnapshotHash(sessionProviderId);

    if (requestedSessionId) {
      const existingSession = this.assistantAppService.getSession(requestedSessionId);
      if (existingSession && existingSession.traceId === traceId) {
        assertReferenceTraceCompatible({
          requestedSessionId,
          existingReferenceTraceId: existingSession.referenceTraceId,
          requestedReferenceTraceId,
        });
        inheritedReferenceTraceId = normalizeReferenceTraceId(existingSession.referenceTraceId);
      }
      const liveSessionProviderId = existingSession && existingSession.traceId === traceId
        ? explicitProviderId !== undefined
          ? explicitProviderId
          : existingSession.providerId ?? null
        : sessionProviderId;
      const liveSessionProviderMismatch = Boolean(
        existingSession &&
        existingSession.traceId === traceId &&
        explicitProviderId !== undefined &&
        (existingSession.providerId ?? null) !== explicitProviderId,
      );
      const liveSessionProviderSnapshotHash = existingSession?.providerSnapshotHash
        ? resolveProviderSnapshotHash(liveSessionProviderId)
        : null;
      const liveSessionProviderSnapshotMismatch = Boolean(
        existingSession &&
        existingSession.traceId === traceId &&
        !liveSessionProviderMismatch &&
        existingSession.providerSnapshotHash &&
        liveSessionProviderSnapshotHash &&
        existingSession.providerSnapshotHash !== liveSessionProviderSnapshotHash,
      );
      if (existingSession && existingSession.traceId === traceId) {
        if (liveSessionProviderMismatch) {
          existingSession.logger.info('AgentRoutes', 'Provider changed; starting a new SDK session', {
            previousProviderId: existingSession.providerId,
            nextProviderId: sessionProviderId,
          });
          console.log(`[AgentRoutes] Provider changed for ${requestedSessionId}, creating a new agent session`);
        } else if (liveSessionProviderSnapshotMismatch) {
          const previousProviderSnapshotHash = existingSession.providerSnapshotHash as string;
          if (existingSession.orchestratorUpdateHandler) {
            existingSession.orchestrator.off('update', existingSession.orchestratorUpdateHandler);
            existingSession.orchestratorUpdateHandler = undefined;
          }
          if (typeof existingSession.orchestrator.abortSession === 'function') {
            void Promise.resolve(
              existingSession.orchestrator.abortSession(
                existingSession.sessionId,
                existingSession.referenceTraceId,
              ),
            ).catch((error) => {
              existingSession.logger.warn('AgentRoutes', 'Failed to abort stale provider SDK session', {
                sessionId: existingSession.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          if (typeof existingSession.orchestrator.cleanupSession === 'function') {
            void Promise.resolve(
              existingSession.orchestrator.cleanupSession(existingSession.sessionId),
            ).catch((error) => {
              existingSession.logger.warn('AgentRoutes', 'Failed to clean up stale provider SDK session', {
                sessionId: existingSession.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          existingSession.orchestrator = createAgentOrchestrator({
            traceProcessorService: getTraceProcessorService(),
            providerId: liveSessionProviderId,
            providerScope,
          });
          existingSession.providerId = liveSessionProviderId;
          existingSession.providerSnapshotHash = liveSessionProviderSnapshotHash;
          existingSession.providerSnapshotChanged = true;
          existingSession.providerSnapshotChangeReason = 'provider_snapshot_hash_mismatch';
          existingSession.continuityBreaks = appendProviderContinuityBreak(
            existingSession.continuityBreaks,
            previousProviderSnapshotHash,
          );
          existingSession.referenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
          existingSession.comparisonSource = comparisonSourceForReference(existingSession.referenceTraceId);
          existingSession.runSequence = Number.isFinite(existingSession.runSequence)
            ? Math.max(0, Math.floor(existingSession.runSequence as number))
            : 0;
          existingSession.logger.warn('AgentRoutes', 'Provider snapshot changed; starting a fresh SDK session', {
            providerId: liveSessionProviderId,
            previousProviderSnapshotHash,
            nextProviderSnapshotHash: liveSessionProviderSnapshotHash,
          });
          existingSession.query = query;
          existingSession.agentQuery = buildAgentQueryWithContinuityNotice(
            query,
            existingSession.continuityBreaks,
          );
          existingSession.status = 'pending';
          existingSession.lastActivityAt = Date.now();
          console.log(`[AgentRoutes] Provider snapshot changed for ${requestedSessionId}, refreshed SDK session`);
          return {
            sessionId: requestedSessionId,
            session: existingSession,
            isNewSession: false,
          };
        } else {
          const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
          existingSession.providerId ??= null;
          existingSession.providerSnapshotHash ??= liveSessionProviderSnapshotHash;
          existingSession.providerSnapshotChanged = false;
          existingSession.providerSnapshotChangeReason = undefined;
          existingSession.referenceTraceId = effectiveReferenceTraceId;
          existingSession.comparisonSource = comparisonSourceForReference(effectiveReferenceTraceId);
          existingSession.runSequence = Number.isFinite(existingSession.runSequence)
            ? Math.max(0, Math.floor(existingSession.runSequence as number))
            : 0;
          existingSession.logger.info('AgentRoutes', 'Continuing multi-turn dialogue', {
            turnQuery: query,
            previousQuery: existingSession.query,
          });
          existingSession.query = query;
          existingSession.agentQuery = buildAgentQueryWithContinuityNotice(
            query,
            existingSession.continuityBreaks,
          );
          existingSession.status = 'pending';
          existingSession.lastActivityAt = Date.now();
          console.log(`[AgentRoutes] Reusing agent session ${requestedSessionId} for multi-turn dialogue`);
          return {
            sessionId: requestedSessionId,
            session: existingSession,
            isNewSession: false,
          };
        }
      }

      const persistedSession = liveSessionProviderMismatch
        ? null
        : this.sessionPersistenceService.getSession(requestedSessionId);
      if (persistedSession && persistedSession.traceId !== traceId) {
        throw new AnalyzeSessionPreparationError('traceId mismatch for requested session', {
          code: 'TRACE_ID_MISMATCH',
          httpStatus: 400,
          hint: `This session belongs to traceId=${persistedSession.traceId}. Switch to that trace or start a new chat.`,
        });
      }

      if (persistedSession && persistedSession.traceId === traceId) {
        const stateSnapshot =
          this.sessionPersistenceService.loadSessionStateSnapshot(requestedSessionId);
        const persistedReferenceTraceId = readPersistedReferenceTraceId(
          stateSnapshot,
          persistedSession.metadata,
        );
        assertReferenceTraceCompatible({
          requestedSessionId,
          existingReferenceTraceId: persistedReferenceTraceId,
          requestedReferenceTraceId,
        });
        inheritedReferenceTraceId = persistedReferenceTraceId;
        const restoredContext = this.sessionPersistenceService.loadSessionContext(requestedSessionId);
        if (restoredContext) {
          this.sessionContextManager.set(requestedSessionId, traceId, restoredContext);

          const snapshotRuntimeKind = getSnapshotRuntimeKind(stateSnapshot);
          const snapshotProviderId = getSnapshotRuntimeProviderId(stateSnapshot);
          const snapshotProviderHash = getSnapshotRuntimeProviderSnapshotHash(stateSnapshot);
          const restoredProviderId = explicitProviderId !== undefined
            ? explicitProviderId
            : stateSnapshot
              ? snapshotProviderId ?? null
              : sessionProviderId;
          const snapshotProviderMismatch = Boolean(
            explicitProviderId !== undefined &&
            stateSnapshot &&
            snapshotProviderId !== explicitProviderId,
          );
          if (!snapshotProviderMismatch && typeof snapshotProviderId === 'string' && !providerSvc.getRawProvider(snapshotProviderId, providerScope)) {
            throw new AnalyzeSessionPreparationError(`Provider not found: ${snapshotProviderId}`, {
              code: 'PROVIDER_NOT_FOUND',
              httpStatus: 404,
              hint: 'This persisted session was created with a Provider Manager profile that no longer exists. Recreate the provider or start a new chat.',
            });
          }
          const restoredProviderSnapshotHash = !snapshotProviderMismatch
            ? resolveProviderSnapshotHash(
                restoredProviderId,
                restoredProviderId ? undefined : snapshotRuntimeKind,
              )
            : null;
          const snapshotProviderHashMismatch = Boolean(
            !snapshotProviderMismatch &&
            snapshotProviderHash &&
            restoredProviderSnapshotHash &&
            snapshotProviderHash !== restoredProviderSnapshotHash,
          );

          if (snapshotProviderMismatch) {
            console.log(
              `[AgentRoutes] Provider override changed for ${requestedSessionId}, creating a new agent session`
            );
          } else {
            const restoredOrchestrator: IOrchestrator = createAgentOrchestrator({
              traceProcessorService: getTraceProcessorService(),
              providerId: restoredProviderId,
              runtimeOverride: restoredProviderId ? undefined : snapshotRuntimeKind,
              providerScope,
            });

            const focusSnapshot = this.sessionPersistenceService.loadFocusStore(requestedSessionId);
            if (focusSnapshot && typeof restoredOrchestrator.getFocusStore === 'function') {
              restoredOrchestrator.getFocusStore().loadSnapshot(focusSnapshot);
              restoredOrchestrator.getFocusStore().syncWithEntityStore(restoredContext.getEntityStore());
            }

            // P0-2: Restore cached architecture to prevent re-detection failure after trace unload
            const archSnapshot = this.sessionPersistenceService.loadArchitectureSnapshot(requestedSessionId);
            if (archSnapshot && typeof restoredOrchestrator.restoreArchitectureCache === 'function') {
              restoredOrchestrator.restoreArchitectureCache(traceId, archSnapshot);
            }

            const traceAgentStateSnapshot =
              this.sessionPersistenceService.loadTraceAgentState(requestedSessionId);
            if (traceAgentStateSnapshot) {
              restoredContext.setTraceAgentState(traceAgentStateSnapshot);
            }

            // Restore SDK runtime internal maps/state from the unified snapshot.
            // Mirrors the explicit /resume endpoint so both paths recover the
            // full agent state, not just SessionContext.
            if (
              stateSnapshot &&
              !snapshotProviderHashMismatch &&
              typeof restoredOrchestrator.restoreFromSnapshot === 'function'
            ) {
              restoredOrchestrator.restoreFromSnapshot(requestedSessionId, traceId, stateSnapshot);
            } else if (snapshotProviderHashMismatch) {
              console.log(
                `[AgentRoutes] Provider snapshot changed for ${requestedSessionId}, skipping SDK session restoration`
              );
            }

            const restoredTurns = restoredContext.getAllTurns();
            const latestTurn = restoredTurns.length > 0 ? restoredTurns[restoredTurns.length - 1] : null;
            const recoveredResult = this.buildRecoveredResultFromContext(
              requestedSessionId,
              restoredContext
            );
            const restoredSequence = Math.max(0, restoredTurns.length);
            const fallbackRestoredRun = restoredSequence > 0
              ? {
                  runId: `run-${requestedSessionId}-${restoredSequence}-recovered`,
                  requestId: `recovered-${requestedSessionId}-${restoredSequence}`,
                  sequence: restoredSequence,
                  query: latestTurn?.query || persistedSession.question,
                  startedAt: latestTurn?.timestamp || persistedSession.createdAt,
                  completedAt: persistedSession.updatedAt,
                  status: 'completed' as const,
                }
              : undefined;
            const restoredRun = stateSnapshot?.lastRun || stateSnapshot?.activeRun || fallbackRestoredRun;
            const restoredContinuityBreaks = snapshotProviderHashMismatch && typeof snapshotProviderHash === 'string'
              ? appendProviderContinuityBreak(stateSnapshot?.continuityBreaks, snapshotProviderHash)
              : normalizeContinuityBreaks(stateSnapshot?.continuityBreaks);
            const restoredAgentQuery = buildAgentQueryWithContinuityNotice(query, restoredContinuityBreaks);
            const restoredLineage = stateSnapshot?.lineage ?? persistedSession.metadata?.lineage;

            const restoredLogger = this.createSessionLogger(requestedSessionId);
            restoredLogger.setMetadata({
              traceId,
              query,
              architecture: 'agent-driven',
              resumed: true,
              referenceTraceId: requestedReferenceTraceId ?? inheritedReferenceTraceId,
            });
            restoredLogger.info('AgentRoutes', 'Session restored from persistence in analyze()', {
              turnCount: restoredTurns.length,
              entityStoreStats: restoredContext.getEntityStore().getStats(),
            });
            if (snapshotProviderHashMismatch) {
              restoredLogger.warn('AgentRoutes', 'Provider snapshot changed; fresh SDK runtime will be used', {
                providerId: restoredProviderId,
                previousProviderSnapshotHash: snapshotProviderHash,
                nextProviderSnapshotHash: restoredProviderSnapshotHash,
              });
            }

            // Reconstruct query/conclusion history from persisted turns
            const restoredQueryHistory: Array<{ turn: number; query: string; timestamp: number }> = [];
            const restoredConclusionHistory: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }> = [];
            for (let i = 0; i < restoredTurns.length; i++) {
              const t = restoredTurns[i];
              if (t.query) {
                restoredQueryHistory.push({ turn: i + 1, query: t.query, timestamp: t.timestamp || persistedSession.createdAt });
              }
              if (t.result && typeof (t.result as any).conclusion === 'string') {
                restoredConclusionHistory.push({
                  turn: i + 1,
                  conclusion: (t.result as any).conclusion,
                  confidence: (t.result as any).confidence ?? 0,
                  timestamp: t.timestamp || persistedSession.createdAt,
                });
              }
            }

            // R4: Restore runtime arrays from SQLite for cross-restart report continuity
            const runtimeArrays = this.sessionPersistenceService.loadRuntimeArrays(requestedSessionId);

            // Source priority for session arrays: snapshot (newer unified format)
            // > runtimeArrays (legacy fallback) > reconstructed from turns.
            // agentDialogue + agentResponses live only in the snapshot — prior
            // code hardcoded them to [], which is what Codex flagged as lost state.
            const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
            const restoredSession = {
              orchestrator: restoredOrchestrator,
              sessionId: requestedSessionId,
              sseClients: [],
              result: recoveredResult || undefined,
              status: 'pending',
              traceId,
              query,
              tenantId: persistedSession.metadata?.tenantId,
              workspaceId: persistedSession.metadata?.workspaceId,
              userId: persistedSession.metadata?.userId,
              providerId: restoredProviderId,
              providerSnapshotHash: restoredProviderSnapshotHash ?? sessionProviderSnapshotHash,
              providerSnapshotChanged: snapshotProviderHashMismatch || undefined,
              providerSnapshotChangeReason: snapshotProviderHashMismatch
                ? 'provider_snapshot_hash_mismatch'
                : undefined,
              agentQuery: restoredAgentQuery,
              continuityBreaks: restoredContinuityBreaks.length > 0 ? restoredContinuityBreaks : undefined,
              lineage: restoredLineage,
              referenceTraceId: effectiveReferenceTraceId,
              comparisonSource:
                stateSnapshot?.comparisonSource
                ?? comparisonSourceForReference(effectiveReferenceTraceId),
              comparisonReportSection: stateSnapshot?.comparisonReportSection,
              createdAt: persistedSession.createdAt,
              lastActivityAt: Date.now(),
              logger: restoredLogger,
              hypotheses: stateSnapshot?.hypotheses || runtimeArrays?.hypotheses || [],
              agentDialogue: stateSnapshot?.agentDialogue || [],
              dataEnvelopes: stateSnapshot?.dataEnvelopes || runtimeArrays?.dataEnvelopes || [],
              claimSupport: stateSnapshot?.claimSupport,
              claimVerificationResult: stateSnapshot?.claimVerificationResult,
              identityResolutions: stateSnapshot?.identityResolutions,
              agentResponses: stateSnapshot?.agentResponses || [],
              conversationOrdinal: stateSnapshot?.conversationOrdinal || 0,
              conversationSteps:
                stateSnapshot?.conversationSteps || runtimeArrays?.conversationSteps || [],
              runSequence: stateSnapshot?.runSequence || restoredSequence,
              activeRun: stateSnapshot?.activeRun || restoredRun,
              lastRun: stateSnapshot?.lastRun || restoredRun,
              queryHistory:
                stateSnapshot?.queryHistory || runtimeArrays?.queryHistory || restoredQueryHistory,
              conclusionHistory:
                stateSnapshot?.conclusionHistory
                || runtimeArrays?.conclusionHistory
                || restoredConclusionHistory,
              sseEventSeq: 0,
              sseEventBuffer: [],
            } as unknown as TSession;

            this.assistantAppService.setSession(requestedSessionId, restoredSession);
            restoredLogger.info('AgentRoutes', 'Continuing multi-turn dialogue from persisted context', {
              turnQuery: query,
              previousQuery: latestTurn?.query || persistedSession.question,
              turnCount: restoredTurns.length,
              runtimeArraysRestored: !!runtimeArrays,
              restoredSteps: runtimeArrays?.conversationSteps?.length || 0,
              restoredEnvelopes: runtimeArrays?.dataEnvelopes?.length || 0,
            });
            console.log(
              `[AgentRoutes] Restored agent session ${requestedSessionId} from persistence for multi-turn dialogue`
            );

            return {
              sessionId: requestedSessionId,
              session: restoredSession,
              isNewSession: false,
            };
          }
        }

        console.log(
          `[AgentRoutes] Requested session ${requestedSessionId} has no persisted context, creating new session`
        );
      } else {
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found, creating new session`);
      }
    }

    const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const orchestrator: IOrchestrator = createAgentOrchestrator({
      traceProcessorService: getTraceProcessorService(),
      providerId: sessionProviderId,
      providerScope,
    });

    const logger = this.createSessionLogger(sessionId);
    logger.setMetadata({
      traceId,
      query,
      architecture: 'agent-driven',
      referenceTraceId: effectiveReferenceTraceId,
    });
    logger.info('AgentRoutes', 'Agent-driven analysis session created', { options });

    const session = {
      orchestrator,
      sessionId,
      sseClients: [],
      status: 'pending',
      traceId,
      query,
      agentQuery: query,
      providerId: sessionProviderId,
      providerSnapshotHash: sessionProviderSnapshotHash,
      providerSnapshotChanged: false,
      referenceTraceId: effectiveReferenceTraceId,
      comparisonSource: comparisonSourceForReference(effectiveReferenceTraceId),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      logger,
      hypotheses: [],
      agentDialogue: [],
      dataEnvelopes: [],
      claimSupport: [],
      identityResolutions: [],
      agentResponses: [],
      conversationOrdinal: 0,
      conversationSteps: [],
      runSequence: 0,
      queryHistory: [],
      conclusionHistory: [],
      sseEventSeq: 0,
      sseEventBuffer: [],
    } as unknown as TSession;

    this.assistantAppService.setSession(sessionId, session);

    return {
      sessionId,
      session,
      isNewSession: true,
    };
  }
}
