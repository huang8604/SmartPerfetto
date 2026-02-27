import express from 'express';

export type AssistantSessionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed';

export interface ManagedAssistantSession {
  sessionId: string;
  status: AssistantSessionStatus;
  createdAt: number;
  lastActivityAt: number;
  sseClients: express.Response[];
  error?: string;
}

export interface SessionCleanupOptions<T extends ManagedAssistantSession> {
  terminalMaxIdleMs: number;
  nonTerminalMaxIdleMs: number;
  now?: number;
  onCleanup?: (sessionId: string, session: T) => void;
}

/**
 * Thin application service for assistant session lifecycle and in-memory state.
 * Routes/controllers should avoid direct Map manipulation.
 */
export class AssistantApplicationService<T extends ManagedAssistantSession> {
  private readonly sessions = new Map<string, T>();

  getSession(sessionId: string): T | undefined {
    return this.sessions.get(sessionId);
  }

  setSession(sessionId: string, session: T): void {
    this.sessions.set(sessionId, session);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  entries(): IterableIterator<[string, T]> {
    return this.sessions.entries();
  }

  touchSession(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastActivityAt = Date.now();
    return session;
  }

  addSseClient(sessionId: string, client: express.Response): T | undefined {
    const session = this.touchSession(sessionId);
    if (!session) return undefined;
    session.sseClients.push(client);
    return session;
  }

  removeSseClient(sessionId: string, client: express.Response): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const idx = session.sseClients.indexOf(client);
    if (idx !== -1) {
      session.sseClients.splice(idx, 1);
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  markSessionFailed(sessionId: string, errorMessage: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'failed';
    session.error = errorMessage;
    session.lastActivityAt = Date.now();
    return session;
  }

  cleanupIdleSessions(options: SessionCleanupOptions<T>): string[] {
    const now = options.now ?? Date.now();
    const removed: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const idle = now - (session.lastActivityAt || session.createdAt);
      const isTerminal = session.status === 'completed' || session.status === 'failed';
      const isAbandonedNonTerminal =
        (session.status === 'pending' || session.status === 'running') &&
        session.sseClients.length === 0;

      if (
        (isTerminal && idle > options.terminalMaxIdleMs) ||
        (isAbandonedNonTerminal && idle > options.nonTerminalMaxIdleMs)
      ) {
        options.onCleanup?.(sessionId, session);
        this.sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }

    return removed;
  }
}
