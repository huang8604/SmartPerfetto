// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session Persistence Schema
 * Stores chat sessions and analysis results for long-term persistence
 */

export interface StoredSession {
  id: string;
  traceId: string;
  traceName: string;
  question: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  metadata?: SessionMetadata;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sqlResult?: StoredSqlResult;
}

export type StoredSqlResult = SqlQueryResult | SqlResultMessageBundle;

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
}

export interface SqlResultMessageBundle {
  schemaVersion: 'sql_result_message_v1';
  resultCount: number;
  results: SqlResultMessageEntry[];
}

export interface SqlResultMessageEntry {
  title?: string;
  evidenceRefId?: string;
  sourceToolCallId?: string;
  queryHash?: string;
  traceId?: string;
  traceSide?: string;
  sql?: string;
  data: unknown;
  display?: unknown;
  truncated?: boolean;
  originalBytes?: number;
  maxBytes?: number;
}

export interface SessionMetadata {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  ownerUserId?: string;
  /** Raw dual-trace comparison identity, duplicated from sessionStateSnapshot for fast guards. */
  referenceTraceId?: string;
  /** Comparison source model used by the persisted session. */
  comparisonSource?: import('../agentv3/sessionStateSnapshot').ComparisonSourceKind;

  totalIterations?: number;
  sqlQueriesCount?: number;
  totalDuration?: number;
  traceSize?: number;

  /**
   * Serialized EntityStore snapshot for cross-restart persistence.
   * Contains cached frames, sessions, and other entities discovered during analysis.
   * @see EntityStoreSnapshot in backend/src/agent/context/entityStore.ts
   */
  entityStoreSnapshot?: import('../agent/context/entityStore').EntityStoreSnapshot;

  /**
   * Serialized EnhancedSessionContext for full multi-turn state restoration.
   * Includes conversation history, findings, and entity references.
   */
  sessionContextSnapshot?: string;

  /**
   * Serialized FocusStore snapshot for restoring user focus across restarts.
   * Includes weighted focus targets (entity/timeRange/question).
   */
  focusStoreSnapshot?: import('../agent/context/focusStore').FocusStoreSnapshot;

  /**
   * Trace-scoped goal-driven agent state snapshot (v1).
   * Single-source-of-truth state for hypotheses/evidence/experiments (iteratively built).
   */
  traceAgentStateSnapshot?: import('../agent/state/traceAgentState').TraceAgentState;

  /**
   * Cached architecture detection result for cross-restart restoration.
   * Prevents re-detection failures when trace_processor has unloaded the trace.
   */
  architectureSnapshot?: import('../agent/detectors/types').ArchitectureInfo;

  /**
   * Unified session state snapshot — single source of truth for persistence,
   * report generation, and session restoration. Written atomically.
   * @see SessionStateSnapshot in backend/src/agentv3/sessionStateSnapshot.ts
   */
  sessionStateSnapshot?: import('../agentv3/sessionStateSnapshot').SessionStateSnapshot;

  /**
   * Backend-session ancestry when a user-visible session had to bridge to a
   * fresh backend session. Duplicated from sessionStateSnapshot for catalog
   * visibility.
   */
  lineage?: import('../agentv3/sessionStateSnapshot').SessionLineage;

  /**
   * @deprecated Use sessionStateSnapshot instead. Kept for backward-compatible reads of old sessions.
   * New writes always populate both (dual-write).
   *
   * R4: Runtime arrays snapshot for cross-restart report continuity.
   * Stores conversationSteps (timeline) and dataEnvelopes (skill tables)
   * that would otherwise be lost on backend restart.
   */
  runtimeArraysSnapshot?: {
    conversationSteps?: any[];
    dataEnvelopes?: any[];
    hypotheses?: any[];
    queryHistory?: any[];
    conclusionHistory?: any[];
    /** P1-1/P1-3: Persist agentv3-specific state for cross-restart report/context continuity */
    analysisNotes?: any[];
    analysisPlan?: any;
    planHistory?: any[];
    uncertaintyFlags?: any[];
  };
}

export interface SessionFilter {
  traceId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}

export interface SessionListResponse {
  sessions: StoredSession[];
  totalCount: number;
  hasMore: boolean;
}
