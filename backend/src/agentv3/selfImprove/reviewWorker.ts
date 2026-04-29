// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Background worker that drains the review outbox.
 *
 * Loop: every `pollIntervalMs` (default 30s)
 *   1. Recycle leases whose owners died mid-flight.
 *   2. If under concurrency cap and daily budget, lease the next pending job.
 *   3. Run the injected `executeReview` callback (SDK call lives in
 *      `reviewAgentSdk.ts`; injection keeps the worker testable without
 *      mocking Claude itself).
 *   4. Validate the agent emission and persist via skillNotesWriter, or
 *      markFailed with a reason.
 *
 * Resource limits enforced here:
 *   - concurrency cap (default 1, env override capped at 2)
 *   - daily-budget cap (default 100 jobs/day)
 *   - per-(skillId,failureModeHash) cooldown (default 5 min, in-memory)
 *
 * Feature flag: env SELF_IMPROVE_REVIEW_ENABLED defaults to false. When the
 * flag is unset, `start()` is a no-op so deploys are safe by default.
 *
 * See docs/architecture/self-improving-design.md §10 (Worker Resource Limits).
 */

import type { ReviewOutboxHandle, ReviewJob } from './reviewOutbox';
import { writeSkillNote, type WriteOutcome } from './skillNotesWriter';

export interface ReviewJobPayload {
  skillId: string;
  failureModeHash?: string;
  /** Free-form payload forwarded to the SDK call. */
  context: unknown;
}

/** Result of one review attempt. The worker uses this to decide done/failed. */
export type ReviewExecutionResult =
  | { ok: true; emission: unknown }
  | { ok: false; reason: 'sdk_error' | 'sdk_timeout' | 'sdk_invalid'; details: string };

export type ReviewExecutor = (payload: ReviewJobPayload) => Promise<ReviewExecutionResult>;

export interface ReviewWorkerOptions {
  outbox: ReviewOutboxHandle;
  /** Injected SDK call. Pure function so the worker can be unit-tested without Claude. */
  executeReview: ReviewExecutor;
  pollIntervalMs?: number;
  concurrency?: number;
  dailyBudget?: number;
  perSkillCooldownMs?: number;
  workerOwner?: string;
  /** Override `Date.now()` for deterministic tests. */
  clock?: () => number;
  /** Override notes directory passed to skillNotesWriter (tests). */
  notesDir?: string;
  /** Optional registry of valid tool/skill IDs for emission validation. */
  toolRegistry?: ReadonlySet<string>;
}

interface ReviewWorkerStats {
  attempted: number;
  succeeded: number;
  rejected: number; // schema/scan/capacity drop
  failedTransient: number; // SDK error / timeout — went back to pending
  failedPermanent: number; // attempts cap exhausted
  cooldownSkipped: number;
  budgetExhausted: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 2;
const DEFAULT_DAILY_BUDGET = 100;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export class ReviewWorker {
  private timer: NodeJS.Timeout | null = null;
  private inflight = 0;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly opts: Required<Omit<ReviewWorkerOptions, 'notesDir' | 'toolRegistry'>> & Pick<ReviewWorkerOptions, 'notesDir' | 'toolRegistry'>;
  readonly stats: ReviewWorkerStats = {
    attempted: 0,
    succeeded: 0,
    rejected: 0,
    failedTransient: 0,
    failedPermanent: 0,
    cooldownSkipped: 0,
    budgetExhausted: 0,
  };

  constructor(opts: ReviewWorkerOptions) {
    const concurrency = clamp(opts.concurrency ?? DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
    this.opts = {
      outbox: opts.outbox,
      executeReview: opts.executeReview,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      concurrency,
      dailyBudget: opts.dailyBudget ?? DEFAULT_DAILY_BUDGET,
      perSkillCooldownMs: opts.perSkillCooldownMs ?? DEFAULT_COOLDOWN_MS,
      workerOwner: opts.workerOwner ?? `worker-${process.pid}`,
      clock: opts.clock ?? Date.now,
      notesDir: opts.notesDir,
      toolRegistry: opts.toolRegistry,
    };
  }

  /**
   * Start the poll loop. No-op if `SELF_IMPROVE_REVIEW_ENABLED` is not set
   * to a truthy value. Returns true if the worker actually started.
   */
  start(): boolean {
    if (this.timer) return true;
    if (!isReviewEnabled()) {
      console.log('[ReviewWorker] disabled by env (SELF_IMPROVE_REVIEW_ENABLED unset)');
      return false;
    }
    this.timer = setInterval(() => {
      // Background tick — swallow errors so a single failure doesn't kill
      // the interval timer. Stats are still updated by the inner methods.
      this.tick().catch(err =>
        console.warn('[ReviewWorker] tick failed:', (err as Error).message),
      );
    }, this.opts.pollIntervalMs);
    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Single iteration of the loop. Exposed for tests so we don't have to
   * twiddle `setInterval` timing.
   */
  async tick(): Promise<void> {
    this.opts.outbox.expireStaleLeases(this.opts.clock());
    /** Local skip-set so the same cooldown-blocked job isn't picked twice in a tick. */
    const seenInTick = new Set<string>();
    while (this.inflight < this.opts.concurrency) {
      if (this.opts.outbox.dailyJobCount(this.opts.clock()) >= this.opts.dailyBudget) {
        this.stats.budgetExhausted += 1;
        return;
      }
      const job = this.opts.outbox.leaseNext({
        workerOwner: this.opts.workerOwner,
        leaseDurationMs: this.opts.pollIntervalMs * 10,
      });
      if (!job) return;
      if (seenInTick.has(job.id)) {
        // Outbox handed back the same job — release and bail to avoid spin.
        this.opts.outbox.releaseLease(job.id);
        return;
      }

      const cooldownReason = this.checkCooldown(job);
      if (cooldownReason) {
        this.stats.cooldownSkipped += 1;
        this.opts.outbox.releaseLease(job.id);
        seenInTick.add(job.id);
        continue;
      }

      this.inflight += 1;
      this.stats.attempted += 1;
      // Fire-and-forget — concurrency is gated by `inflight` rather than awaiting.
      this.processJob(job).finally(() => {
        this.inflight -= 1;
      });
    }
  }

  private checkCooldown(job: ReviewJob): string | null {
    const payload = job.payload as Partial<ReviewJobPayload> | undefined;
    if (!payload?.skillId || !payload.failureModeHash) return null;
    const key = `${payload.skillId}::${payload.failureModeHash}`;
    const until = this.cooldownUntil.get(key);
    if (until && this.opts.clock() < until) {
      return `cooldown active for ${key} until ${new Date(until).toISOString()}`;
    }
    return null;
  }

  private async processJob(job: ReviewJob): Promise<void> {
    try {
      const result = await this.opts.executeReview(job.payload as ReviewJobPayload);
      if (!result.ok) {
        this.stats.failedTransient += 1;
        this.opts.outbox.markFailed(job.id, `${result.reason}: ${result.details}`);
        return;
      }
      const writeOutcome = writeSkillNote(result.emission, {
        notesDir: this.opts.notesDir,
        now: this.opts.clock(),
        toolRegistry: this.opts.toolRegistry,
      });
      this.recordWriteOutcome(job, writeOutcome);
    } catch (err) {
      this.stats.failedTransient += 1;
      this.opts.outbox.markFailed(job.id, `unhandled: ${(err as Error).message}`);
    }
  }

  private recordWriteOutcome(job: ReviewJob, outcome: WriteOutcome): void {
    if (outcome.ok) {
      this.stats.succeeded += 1;
      this.opts.outbox.markDone(job.id);
      const payload = job.payload as Partial<ReviewJobPayload> | undefined;
      if (payload?.skillId && payload.failureModeHash) {
        this.cooldownUntil.set(
          `${payload.skillId}::${payload.failureModeHash}`,
          this.opts.clock() + this.opts.perSkillCooldownMs,
        );
      }
      return;
    }
    if (outcome.reason === 'io_error') {
      // Transient — retry next tick.
      this.stats.failedTransient += 1;
      this.opts.outbox.markFailed(job.id, `io_error: ${outcome.details}`);
      return;
    }
    // Schema/scan/capacity rejections are the agent's fault; don't keep
    // retrying — mark permanently failed by exceeding the attempts cap.
    this.stats.rejected += 1;
    this.opts.outbox.markFailed(job.id, `${outcome.reason}: ${outcome.details}`, 1);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function isReviewEnabled(): boolean {
  const v = process.env.SELF_IMPROVE_REVIEW_ENABLED;
  return v === '1' || v === 'true' || v === 'yes';
}

export const __testing = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_COOLDOWN_MS,
};
