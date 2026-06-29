// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { backendDataPath } from '../../runtimePaths';
import type { CaseCandidate, CaseCandidateReview, CaseCandidateState } from '../../types/caseEvolution';

export interface CaseCandidateOutboxOptions {
  dbPath?: string;
}

export interface EnqueueCaseCandidateOptions {
  dedupeKey: string;
  priority?: number;
  queueMax?: number;
}

export interface EnqueueCaseCandidateResult {
  enqueued: boolean;
  candidateId?: string;
  latencyMs: number;
  reason?: 'duplicate_active' | 'queue_full' | 'error';
}

export interface LeasedCaseCandidate {
  candidateId: string;
  state: CaseCandidateState;
  dedupeKey: string;
  priority: number;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
  supportingEvidence: number;
  contradictingEvidence: number;
  maintainerPromoted: number;
  supported: number;
  learnedCaseId: string | null;
  candidate: CaseCandidate;
  review: CaseCandidateReview | null;
  notePath: string | null;
  lastError: string | null;
}

export interface AddCandidateFeedbackInput {
  sourceSessionId: string;
  sourceAnalysisRunId?: string;
  rating: 'positive' | 'negative';
  receivedAt?: number;
  receivedWithinSeconds?: number;
  withinTimeWindow?: 'mis_tap' | 'short' | 'long' | 'audit_only';
  metadata?: Record<string, unknown>;
}

export interface AddCandidateFeedbackResult {
  added: boolean;
  reason?: 'duplicate' | 'error';
}

const SCHEMA_VERSION_LATEST = 1;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function defaultDbPath(): string {
  return backendDataPath('self_improve', 'case_evolution.db');
}

export function openCaseCandidateOutbox(opts: CaseCandidateOutboxOptions = {}): CaseCandidateOutboxHandle {
  const dbPath = opts.dbPath || defaultDbPath();
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initializeMigrationsTable(db);
  applyPendingMigrations(db);

  return new CaseCandidateOutboxHandle(db);
}

function initializeMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function applyPendingMigrations(db: Database.Database): void {
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{version: number}>;
  const applied = new Set(appliedRows.map(row => row.version));
  if (applied.has(SCHEMA_VERSION_LATEST)) return;

  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE case_candidates (
        candidate_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('pending_review','reviewed','rejected','archived')) DEFAULT 'pending_review',
        dedupe_key TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        supporting_evidence INTEGER NOT NULL DEFAULT 0,
        contradicting_evidence INTEGER NOT NULL DEFAULT 0,
        maintainer_promoted INTEGER NOT NULL DEFAULT 0,
        supported INTEGER GENERATED ALWAYS AS
          (CASE WHEN (maintainer_promoted = 1 OR supporting_evidence >= 3)
                    AND state = 'reviewed'
                THEN 1 ELSE 0 END) STORED,
        learned_case_id TEXT,
        payload_json TEXT NOT NULL,
        review_json TEXT,
        note_path TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_candidates_state_priority
        ON case_candidates(state, priority DESC, created_at);
      CREATE INDEX idx_candidates_supported
        ON case_candidates(supported) WHERE supported = 1;
      CREATE UNIQUE INDEX idx_candidates_dedupe_active
        ON case_candidates(dedupe_key)
        WHERE state IN ('pending_review','reviewed');

      CREATE TABLE candidate_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_analysis_run_id TEXT,
        rating TEXT NOT NULL CHECK(rating IN ('positive','negative')),
        received_at INTEGER NOT NULL,
        received_within_seconds INTEGER,
        within_time_window TEXT NOT NULL CHECK(within_time_window IN ('mis_tap','short','long','audit_only')),
        metadata_json TEXT,
        FOREIGN KEY (candidate_id) REFERENCES case_candidates(candidate_id)
          ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_feedback_dedupe
        ON candidate_feedback(candidate_id, source_session_id);
      CREATE INDEX idx_feedback_candidate ON candidate_feedback(candidate_id);
    `);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION_LATEST,
      Date.now(),
    );
  });
  tx();
}

function rowToCandidate(row: Record<string, unknown>): LeasedCaseCandidate {
  return {
    candidateId: String(row.candidate_id),
    state: row.state as CaseCandidateState,
    dedupeKey: String(row.dedupe_key),
    priority: Number(row.priority || 0),
    attempts: Number(row.attempts || 0),
    leaseOwner: row.lease_owner as string | null,
    leaseUntil: row.lease_until as number | null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    supportingEvidence: Number(row.supporting_evidence || 0),
    contradictingEvidence: Number(row.contradicting_evidence || 0),
    maintainerPromoted: Number(row.maintainer_promoted || 0),
    supported: Number(row.supported || 0),
    learnedCaseId: row.learned_case_id as string | null,
    candidate: JSON.parse(String(row.payload_json)) as CaseCandidate,
    review: row.review_json ? JSON.parse(String(row.review_json)) as CaseCandidateReview : null,
    notePath: row.note_path as string | null,
    lastError: row.last_error as string | null,
  };
}

function truncateError(reason: string): string {
  return reason.length > 1000 ? reason.slice(0, 1000) : reason;
}

export class CaseCandidateOutboxHandle {
  constructor(private readonly db: Database.Database) {}

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {version: number | null};
    return row.version || 0;
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.pragma('foreign_keys', {simple: true}) as number;
    return row === 1;
  }

  enqueue(candidate: CaseCandidate, opts: EnqueueCaseCandidateOptions): EnqueueCaseCandidateResult {
    const start = Date.now();
    try {
      if (opts.queueMax !== undefined && this.pendingCount() >= opts.queueMax) {
        return {enqueued: false, reason: 'queue_full', latencyMs: Date.now() - start};
      }
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO case_candidates (
          candidate_id, state, dedupe_key, priority, attempts, created_at, updated_at, payload_json
        ) VALUES (?, 'pending_review', ?, ?, 0, ?, ?, ?)
      `).run(
        candidate.candidateId,
        opts.dedupeKey,
        opts.priority ?? 0,
        now,
        now,
        JSON.stringify(candidate),
      );
      return {enqueued: true, candidateId: candidate.candidateId, latencyMs: Date.now() - start};
    } catch (err) {
      if ((err as {code?: string}).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return {enqueued: false, reason: 'duplicate_active', latencyMs: Date.now() - start};
      }
      console.error('[CaseCandidateOutbox] enqueue failed:', (err as Error).message);
      return {enqueued: false, reason: 'error', latencyMs: Date.now() - start};
    }
  }

  leaseNext(input: {workerOwner: string; leaseDurationMs?: number; maxAttempts?: number}): LeasedCaseCandidate | null {
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const now = Date.now();
    const leaseUntil = now + leaseDurationMs;

    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT candidate_id FROM case_candidates
        WHERE state = 'pending_review'
          AND lease_owner IS NULL
          AND attempts < ?
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `).get(maxAttempts) as {candidate_id: string} | undefined;
      if (!row) return null;
      // Claim the row atomically. The `WHERE ... AND lease_owner IS NULL`
      // guard makes this correct under concurrency even though better-sqlite3
      // serializes transactions in WAL mode: if a competing worker already
      // claimed the row between our SELECT and UPDATE (or the row transitioned
      // out of pending_review), `changes` is 0 and we must NOT return the row
      // — it is now owned by someone else. Returning it anyway would let two
      // workers process the same candidate.
      const claim = this.db.prepare(`
        UPDATE case_candidates
        SET lease_owner = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE candidate_id = ? AND state = 'pending_review' AND lease_owner IS NULL
      `).run(input.workerOwner, leaseUntil, now, row.candidate_id);
      if (claim.changes !== 1) return null;
      return this.db.prepare('SELECT * FROM case_candidates WHERE candidate_id = ?').get(row.candidate_id) as Record<string, unknown>;
    });

    const row = tx();
    if (!row) return null;
    try {
      return rowToCandidate(row);
    } catch (err) {
      const candidateId = String(row.candidate_id);
      this.markRejected(candidateId, `invalid payload_json: ${(err as Error).message}`);
      return null;
    }
  }

  markReviewed(candidateId: string, input: {review: CaseCandidateReview; notePath?: string | null}): void {
    this.db.prepare(`
      UPDATE case_candidates
      SET state = 'reviewed',
          review_json = ?,
          note_path = ?,
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?,
          last_error = NULL
      WHERE candidate_id = ?
    `).run(JSON.stringify(input.review), input.notePath ?? null, Date.now(), candidateId);
  }

  setLearnedCaseId(candidateId: string, learnedCaseId: string | null): void {
    this.db.prepare(`
      UPDATE case_candidates
      SET learned_case_id = ?, updated_at = ?
      WHERE candidate_id = ?
    `).run(learnedCaseId, Date.now(), candidateId);
  }

  markRejected(candidateId: string, reason: string): void {
    this.db.prepare(`
      UPDATE case_candidates
      SET state = 'rejected',
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?,
          last_error = ?
      WHERE candidate_id = ?
    `).run(Date.now(), truncateError(reason), candidateId);
  }

  markFailed(candidateId: string, reason: string, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): void {
    const row = this.db.prepare('SELECT attempts FROM case_candidates WHERE candidate_id = ?').get(candidateId) as {attempts: number} | undefined;
    const nextState: CaseCandidateState = row && row.attempts >= maxAttempts ? 'rejected' : 'pending_review';
    this.db.prepare(`
      UPDATE case_candidates
      SET state = ?,
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?,
          last_error = ?
      WHERE candidate_id = ?
    `).run(nextState, Date.now(), truncateError(reason), candidateId);
  }

  releaseLease(candidateId: string): void {
    this.db.prepare(`
      UPDATE case_candidates
      SET lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE candidate_id = ?
    `).run(Date.now(), candidateId);
  }

  expireStaleLeases(now: number = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE case_candidates
      SET lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE state = 'pending_review' AND lease_owner IS NOT NULL AND lease_until <= ?
    `).run(now, now);
    return result.changes;
  }

  addFeedback(candidateId: string, input: AddCandidateFeedbackInput): AddCandidateFeedbackResult {
    const tx = this.db.transaction(() => {
      const effectiveWindow = input.withinTimeWindow ?? 'short';
      this.db.prepare(`
        INSERT INTO candidate_feedback (
          candidate_id,
          source_session_id,
          source_analysis_run_id,
          rating,
          received_at,
          received_within_seconds,
          within_time_window,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidateId,
        input.sourceSessionId,
        input.sourceAnalysisRunId ?? null,
        input.rating,
        input.receivedAt ?? Date.now(),
        input.receivedWithinSeconds ?? null,
        effectiveWindow,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
      if (effectiveWindow === 'short') {
        const column = input.rating === 'positive' ? 'supporting_evidence' : 'contradicting_evidence';
        this.db.prepare(`
          UPDATE case_candidates SET ${column} = ${column} + 1, updated_at = ? WHERE candidate_id = ?
        `).run(Date.now(), candidateId);
      }
    });
    try {
      tx();
      return {added: true};
    } catch (err) {
      if ((err as {code?: string}).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return {added: false, reason: 'duplicate'};
      }
      console.error('[CaseCandidateOutbox] addFeedback failed:', (err as Error).message);
      return {added: false, reason: 'error'};
    }
  }

  getCandidate(candidateId: string): LeasedCaseCandidate | null {
    const row = this.db.prepare('SELECT * FROM case_candidates WHERE candidate_id = ?').get(candidateId) as Record<string, unknown> | undefined;
    return row ? rowToCandidate(row) : null;
  }

  listCandidates(opts: {states?: CaseCandidateState[]} = {}): LeasedCaseCandidate[] {
    const states = opts.states;
    const rows = states && states.length > 0
      ? this.db.prepare(`
          SELECT * FROM case_candidates
          WHERE state IN (${states.map(() => '?').join(',')})
          ORDER BY candidate_id
        `).all(...states) as Array<Record<string, unknown>>
      : this.db.prepare('SELECT * FROM case_candidates ORDER BY candidate_id').all() as Array<Record<string, unknown>>;
    return rows.map(rowToCandidate);
  }

  countCandidatesByState(): Record<CaseCandidateState, number> {
    const counts: Record<CaseCandidateState, number> = {
      pending_review: 0,
      reviewed: 0,
      rejected: 0,
      archived: 0,
    };
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM case_candidates GROUP BY state').all() as Array<{state: CaseCandidateState; count: number}>;
    for (const row of rows) counts[row.state] = row.count;
    return counts;
  }

  countSupported(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM case_candidates WHERE supported = 1').get() as {count: number};
    return row.count;
  }

  dailyCounts(now: number = Date.now()): {todayEnqueued: number; todayReviewed: number; todayIngested: number; todayFailed: number} {
    const since = now - 24 * 60 * 60 * 1000;
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS todayEnqueued,
        SUM(CASE WHEN state = 'reviewed' AND updated_at >= ? THEN 1 ELSE 0 END) AS todayReviewed,
        SUM(CASE WHEN learned_case_id IS NOT NULL AND updated_at >= ? THEN 1 ELSE 0 END) AS todayIngested,
        SUM(CASE WHEN state = 'rejected' AND updated_at >= ? THEN 1 ELSE 0 END) AS todayFailed
      FROM case_candidates
    `).get(since, since, since, since) as {todayEnqueued: number | null; todayReviewed: number | null; todayIngested: number | null; todayFailed: number | null};
    return {
      todayEnqueued: row.todayEnqueued || 0,
      todayReviewed: row.todayReviewed || 0,
      todayIngested: row.todayIngested || 0,
      todayFailed: row.todayFailed || 0,
    };
  }

  workerHealth(): {pending: number; leased: number; attemptsHistogram: Record<number, number>} {
    const attemptsHistogram: Record<number, number> = {};
    const rows = this.db.prepare('SELECT attempts, COUNT(*) AS count FROM case_candidates GROUP BY attempts').all() as Array<{attempts: number; count: number}>;
    for (const row of rows) attemptsHistogram[row.attempts] = row.count;
    const leased = this.db.prepare(`
      SELECT COUNT(*) AS count FROM case_candidates
      WHERE state = 'pending_review' AND lease_owner IS NOT NULL
    `).get() as {count: number};
    return {
      pending: this.pendingCount(),
      leased: leased.count,
      attemptsHistogram,
    };
  }

  feedbackStats(): {totalPositive: number; totalNegative: number; distinctSessions: number} {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS totalPositive,
        SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS totalNegative,
        COUNT(DISTINCT source_session_id) AS distinctSessions
      FROM candidate_feedback
    `).get() as {totalPositive: number | null; totalNegative: number | null; distinctSessions: number | null};
    return {
      totalPositive: row.totalPositive || 0,
      totalNegative: row.totalNegative || 0,
      distinctSessions: row.distinctSessions || 0,
    };
  }

  close(): void {
    this.db.close();
  }

  private pendingCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM case_candidates
      WHERE state = 'pending_review' AND lease_owner IS NULL
    `).get() as {count: number};
    return row.count;
  }
}

export const __testing = {
  SCHEMA_VERSION_LATEST,
};
