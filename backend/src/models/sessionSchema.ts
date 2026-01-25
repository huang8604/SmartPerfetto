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
  sqlResult?: SqlQueryResult;
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
}

export interface SessionMetadata {
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
