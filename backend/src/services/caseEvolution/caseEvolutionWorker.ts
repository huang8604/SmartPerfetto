// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseEvolutionConfig } from '../../types/caseEvolution';
import { backendLogPath } from '../../runtimePaths';
import { CaseGraph } from '../caseGraph';
import { CaseLibrary } from '../caseLibrary';
import { RagStore } from '../ragStore';
import type { LeasedCaseCandidate, CaseCandidateOutboxHandle } from './caseCandidateOutbox';
import { anonymizeCaseReview } from './caseAnonymizer';
import { loadCaseEvolutionConfig } from './caseEvolutionConfig';
import { validateCaseEvolutionConfig } from './caseEvolutionConfig';
import {
  validateCaseCandidateReview,
  type CaseCandidateReviewValidatorDeps,
} from './caseCandidateReviewValidator';
import {
  writeCaseCandidateSidecar,
  type WriteCaseCandidateSidecarResult,
} from './caseCandidateSidecar';
import {
  executeCaseCandidateReviewViaSdk,
  type CaseCandidateReviewExecutionResult,
} from './caseCandidateReviewAgentSdk';
import {
  ingestReviewedCaseCandidate,
  type IngestReviewedCaseCandidateOptions,
  type IngestReviewedCaseCandidateResult,
} from './caseCandidateIngester';
import {
  recordCaseEvolutionWorkerPoll,
  recordCaseEvolutionWorkerRunning,
} from './caseEvolutionRuntimeMetrics';

export type CaseCandidateReviewExecutor =
  (candidate: LeasedCaseCandidate['candidate']) => Promise<CaseCandidateReviewExecutionResult>;

export interface CaseEvolutionWorkerOptions {
  outbox: CaseCandidateOutboxHandle;
  executeReview?: CaseCandidateReviewExecutor;
  ingestReviewedCandidate?: (input: IngestReviewedCaseCandidateOptions) => IngestReviewedCaseCandidateResult;
  config?: Partial<CaseEvolutionConfig>;
  validatorDeps?: CaseCandidateReviewValidatorDeps;
  notesDir?: string;
  workerOwner?: string;
  clock?: () => number;
}

export interface CaseEvolutionWorkerStats {
  attempted: number;
  reviewed: number;
  rejected: number;
  failedTransient: number;
  failedPermanent: number;
  budgetExhausted: number;
  staleLeasesExpired: number;
  lastPollAt?: number;
}

export interface CaseEvolutionWorkerSnapshot extends CaseEvolutionWorkerStats {
  running: boolean;
  concurrency: number;
}

const MAX_CONCURRENCY = 2;

export class CaseEvolutionWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly outbox: CaseCandidateOutboxHandle;
  private readonly executeReview: CaseCandidateReviewExecutor;
  private readonly ingestReviewedCandidate: (input: IngestReviewedCaseCandidateOptions) => IngestReviewedCaseCandidateResult;
  private readonly config: CaseEvolutionConfig;
  private readonly validatorDeps?: CaseCandidateReviewValidatorDeps;
  private readonly notesDir?: string;
  private readonly workerOwner: string;
  private readonly clock: () => number;
  private readonly concurrency: number;
  readonly stats: CaseEvolutionWorkerStats = {
    attempted: 0,
    reviewed: 0,
    rejected: 0,
    failedTransient: 0,
    failedPermanent: 0,
    budgetExhausted: 0,
    staleLeasesExpired: 0,
  };

  constructor(opts: CaseEvolutionWorkerOptions) {
    this.outbox = opts.outbox;
    this.executeReview = opts.executeReview ?? executeCaseCandidateReviewViaSdk;
    this.ingestReviewedCandidate = opts.ingestReviewedCandidate ?? defaultIngestReviewedCandidate;
    const config = {
      ...loadCaseEvolutionConfig(),
      ...(opts.config ?? {}),
    };
    const validation = validateCaseEvolutionConfig(config);
    for (const warning of validation.warnings) {
      console.warn(`[CaseEvolutionWorker] ${warning}`);
    }
    for (const error of validation.errors) {
      console.error(`[CaseEvolutionWorker] ${error}`);
    }
    this.config = validation.effectiveConfig;
    this.validatorDeps = opts.validatorDeps;
    this.notesDir = opts.notesDir;
    this.workerOwner = opts.workerOwner ?? `case-evolution-${process.pid}`;
    this.clock = opts.clock ?? Date.now;
    this.concurrency = clamp(this.config.workerConcurrency, 1, MAX_CONCURRENCY);
  }

  start(): boolean {
    if (this.timer) return true;
    if (!this.config.reviewEnabled) {
      recordCaseEvolutionWorkerRunning(false);
      return false;
    }
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        console.warn('[CaseEvolutionWorker] tick failed:', err instanceof Error ? err.message : String(err));
      });
    }, this.config.pollIntervalMs);
    recordCaseEvolutionWorkerRunning(true);
    return true;
  }

  stop(): void {
    if (!this.timer) {
      recordCaseEvolutionWorkerRunning(false);
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    recordCaseEvolutionWorkerRunning(false);
  }

  async tick(): Promise<void> {
    if (!this.config.reviewEnabled) return;
    const now = this.clock();
    this.stats.lastPollAt = now;
    recordCaseEvolutionWorkerPoll(now);
    this.stats.staleLeasesExpired += this.outbox.expireStaleLeases(now);

    const jobs: LeasedCaseCandidate[] = [];
    while (jobs.length < this.concurrency) {
      if (this.dailyBudgetUsed(now) >= this.config.dailyBudget) {
        this.stats.budgetExhausted += 1;
        break;
      }
      const job = this.outbox.leaseNext({
        workerOwner: this.workerOwner,
        leaseDurationMs: this.config.leaseMs,
        maxAttempts: this.config.maxAttempts,
      });
      if (!job) break;
      jobs.push(job);
    }

    await Promise.all(jobs.map(job => this.processJob(job)));
  }

  snapshot(): CaseEvolutionWorkerSnapshot {
    return {
      ...this.stats,
      running: !!this.timer,
      concurrency: this.concurrency,
    };
  }

  private dailyBudgetUsed(now: number): number {
    const daily = this.outbox.dailyCounts(now);
    return daily.todayReviewed + daily.todayFailed;
  }

  private async processJob(job: LeasedCaseCandidate): Promise<void> {
    this.stats.attempted += 1;
    try {
      const result = await this.executeReview(job.candidate);
      if (!result.ok) {
        this.markTransientFailure(job, `${result.reason}: ${result.details}`);
        return;
      }

      const validation = validateCaseCandidateReview(
        result.review,
        job.candidate,
        this.validatorDeps,
      );
      if (!validation.ok) {
        this.stats.rejected += 1;
        this.outbox.markRejected(job.candidateId, validation.errors.join('; '));
        return;
      }

      // §3.4 PII gate: anonymize the validated review BEFORE any persistence
      // (sidecar write + markReviewed both store the review). Required-field
      // PII rejects the candidate permanently; optional-field PII is redacted.
      // This runs after schema/domain validation so we only ever reject a
      // structurally-valid review on PII grounds.
      const anonymizedReview = anonymizeCaseReview(validation.review);
      if (!anonymizedReview.ok) {
        this.stats.rejected += 1;
        this.outbox.markRejected(
          job.candidateId,
          `review rejected by anonymizer: ${anonymizedReview.errors.join('; ')}`,
        );
        return;
      }
      const cleanReview = anonymizedReview.review;
      const reviewWarnings = [...validation.warnings, ...anonymizedReview.warnings];

      const notePath = this.config.notesWriteEnabled
        ? this.writeSidecar(job, cleanReview, reviewWarnings)
        : null;
      if (notePath && !notePath.ok) {
        if (notePath.reason === 'io_error') {
          this.markTransientFailure(job, `sidecar ${notePath.reason}: ${notePath.details}`);
        } else {
          this.stats.rejected += 1;
          this.outbox.markRejected(job.candidateId, `sidecar ${notePath.reason}: ${notePath.details}`);
        }
        return;
      }

      if (cleanReview.decision !== 'promote') {
        this.stats.rejected += 1;
        this.outbox.markRejected(job.candidateId, `review decision: ${cleanReview.decision}`);
        return;
      }

      let learnedCaseId: string | null = null;
      if (this.config.ingestEnabled) {
        try {
          const ingestResult = this.ingestReviewedCandidate({
            candidate: job.candidate,
            review: cleanReview,
            library: new CaseLibrary(backendLogPath('case_library.json')),
            graph: new CaseGraph(backendLogPath('case_graph.json')),
            ragStore: new RagStore(backendLogPath('rag_store.json')),
            sidecarRelativePath: notePath?.path,
          });
          learnedCaseId = ingestResult.learnedCaseId;
        } catch (err) {
          this.markTransientFailure(job, `ingest failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      this.stats.reviewed += 1;
      this.outbox.markReviewed(job.candidateId, {
        review: cleanReview,
        notePath: notePath?.path ?? null,
      });
      if (learnedCaseId) {
        this.outbox.setLearnedCaseId(job.candidateId, learnedCaseId);
      }
    } catch (err) {
      this.markTransientFailure(job, `unhandled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeSidecar(
    job: LeasedCaseCandidate,
    review: LeasedCaseCandidate['review'] & NonNullable<LeasedCaseCandidate['review']>,
    warnings: string[],
  ): WriteCaseCandidateSidecarResult {
    return writeCaseCandidateSidecar(job.candidate, review, {
      notesDir: this.notesDir,
      warnings,
      now: this.clock(),
    });
  }

  private markTransientFailure(job: LeasedCaseCandidate, reason: string): void {
    this.stats.failedTransient += 1;
    this.outbox.markFailed(job.candidateId, reason, this.config.maxAttempts);
    const row = this.outbox.getCandidate(job.candidateId);
    if (row?.state === 'rejected') this.stats.failedPermanent += 1;
  }
}

function defaultIngestReviewedCandidate(
  input: IngestReviewedCaseCandidateOptions,
): IngestReviewedCaseCandidateResult {
  return ingestReviewedCaseCandidate(input);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export const __testing = {MAX_CONCURRENCY};
