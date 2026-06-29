// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

interface RuntimeMetricState {
  dayKey: string;
  retrieverQueries: number;
  retrieverStrongHits: number;
  retrieverPruned: number;
  retrieverLatencyTotalMs: number;
  promptSegmentsBuilt: number;
  promptDroppedForBudget: number;
}

interface WorkerMetricState {
  running: boolean;
  lastPollAt: number | null;
}

export interface CaseEvolutionRuntimeMetricsSnapshot {
  retriever: {
    todayQueries: number;
    todayStrongHits: number;
    todayPruned: number;
    avgLatencyMs: number;
  };
  prompt: {
    todaySegmentsBuilt: number;
    todayDroppedForBudget: number;
  };
  worker: WorkerMetricState;
}

let state: RuntimeMetricState = emptyState(Date.now());
let workerState: WorkerMetricState = emptyWorkerState();

export function recordCaseEvolutionRetrieverQuery(input: {
  latencyMs: number;
  strongHits: number;
}, now = Date.now()): void {
  const current = currentState(now);
  current.retrieverQueries += 1;
  current.retrieverStrongHits += Math.max(0, Math.floor(input.strongHits));
  current.retrieverLatencyTotalMs += Math.max(0, input.latencyMs);
}

export function recordCaseEvolutionCaseHitsPruned(count: number, now = Date.now()): void {
  if (count <= 0) return;
  currentState(now).retrieverPruned += Math.floor(count);
}

export function recordCaseEvolutionPromptSegmentBuilt(now = Date.now()): void {
  currentState(now).promptSegmentsBuilt += 1;
}

export function recordCaseEvolutionPromptDroppedForBudget(now = Date.now()): void {
  currentState(now).promptDroppedForBudget += 1;
}

export function recordCaseEvolutionWorkerRunning(running: boolean): void {
  workerState = {
    ...workerState,
    running,
  };
}

export function recordCaseEvolutionWorkerPoll(now = Date.now()): void {
  workerState = {
    ...workerState,
    lastPollAt: now,
  };
}

export function getCaseEvolutionRuntimeMetrics(now = Date.now()): CaseEvolutionRuntimeMetricsSnapshot {
  const current = currentState(now);
  return {
    retriever: {
      todayQueries: current.retrieverQueries,
      todayStrongHits: current.retrieverStrongHits,
      todayPruned: current.retrieverPruned,
      avgLatencyMs: current.retrieverQueries > 0
        ? Math.round(current.retrieverLatencyTotalMs / current.retrieverQueries)
        : 0,
    },
    prompt: {
      todaySegmentsBuilt: current.promptSegmentsBuilt,
      todayDroppedForBudget: current.promptDroppedForBudget,
    },
    worker: {...workerState},
  };
}

function currentState(now: number): RuntimeMetricState {
  const dayKey = toDayKey(now);
  if (state.dayKey !== dayKey) state = emptyState(now);
  return state;
}

function emptyState(now: number): RuntimeMetricState {
  return {
    dayKey: toDayKey(now),
    retrieverQueries: 0,
    retrieverStrongHits: 0,
    retrieverPruned: 0,
    retrieverLatencyTotalMs: 0,
    promptSegmentsBuilt: 0,
    promptDroppedForBudget: 0,
  };
}

function emptyWorkerState(): WorkerMetricState {
  return {
    running: false,
    lastPollAt: null,
  };
}

function toDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const __testing = {
  resetCaseEvolutionRuntimeMetrics(now = Date.now()): void {
    state = emptyState(now);
    workerState = emptyWorkerState();
  },
};
