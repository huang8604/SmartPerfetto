// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import * as path from 'path';
import { SkillExecutor, createSkillExecutor } from '../skillEngine/skillExecutor';
import type { SkillRegistry } from '../skillEngine/skillLoader';
import { ensureSkillRegistryInitialized, skillRegistry as builtInSkillRegistry } from '../skillEngine/skillLoader';
import type { SkillDefinition } from '../skillEngine/types';
import { getTraceProcessorService, type TraceProcessorService } from '../traceProcessorService';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseMode,
  type TraceProcessorLeaseRecord,
  type TraceProcessorLeaseStore,
} from '../traceProcessorLeaseStore';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import {
  assertBatchTraceCount,
  resolveBatchTraceConcurrency,
  resolveBatchTraceLimits,
  type BatchTraceLimits,
} from './batchTraceLimits';
import { aggregateBatchTraceResults } from './batchTraceAggregator';
import { extractBatchTraceMetrics } from './batchTraceMetricExtractor';
import { retainBatchSourceEnvelope, runBatchPostProcessor } from './batchTracePostProcessor';
import {
  BATCH_TRACE_RUN_SCHEMA_VERSION,
  type BatchTraceInputV1,
  type BatchTraceResultV1,
  type BatchTraceRunV1,
  type RunBatchSkillInput,
} from './batchTraceTypes';

export interface BatchTraceRunnerDeps {
  traceProcessor?: TraceProcessorService;
  registry?: SkillRegistry;
  leaseStore?: TraceProcessorLeaseStore;
  limits?: BatchTraceLimits;
}

function inputLabel(input: BatchTraceInputV1): string {
  if (input.label?.trim()) return input.label.trim();
  if (input.tracePath) return path.basename(input.tracePath);
  if (input.traceId) return input.traceId;
  return `trace-${input.ordinal}`;
}

function markLeaseReadyIfNew(
  store: TraceProcessorLeaseStore,
  scope: EnterpriseRepositoryScope,
  lease: TraceProcessorLeaseRecord,
): TraceProcessorLeaseRecord {
  if (lease.state !== 'pending') return lease;
  const starting = store.markStarting(scope, lease.id);
  return store.markReady(scope, starting.id);
}

function unsupportedSkillError(skill: SkillDefinition): Error | null {
  if (skill.type === 'comparison' || skill.type === 'pipeline_definition') {
    return new Error(`unsupported_batch_skill_type:${skill.type}`);
  }
  return null;
}

function statusForResults(results: BatchTraceResultV1[]): BatchTraceRunV1['status'] {
  const completed = results.filter(result => result.status === 'completed').length;
  if (completed === results.length) return 'completed';
  if (completed > 0) return 'partial';
  return 'failed';
}

function diagnosticMessage(diagnostic: { diagnosis?: unknown; message?: unknown; severity?: unknown }): {
  severity: string;
  message: string;
} {
  return {
    severity: typeof diagnostic.severity === 'string' ? diagnostic.severity : 'info',
    message: typeof diagnostic.diagnosis === 'string'
      ? diagnostic.diagnosis
      : typeof diagnostic.message === 'string'
        ? diagnostic.message
        : JSON.stringify(diagnostic),
  };
}

async function resolveTraceId(
  traceProcessor: TraceProcessorService,
  input: BatchTraceInputV1,
): Promise<{ traceId: string; batchLocal: boolean }> {
  if (input.source === 'local_path') {
    if (!input.tracePath) throw new Error('local batch input missing tracePath');
    return {
      traceId: await traceProcessor.loadTraceFromFilePath(input.tracePath),
      batchLocal: true,
    };
  }
  if (!input.traceId) throw new Error('workspace batch input missing traceId');
  const trace = await traceProcessor.getOrLoadTrace(input.traceId);
  if (!trace) throw new Error(`trace_not_found:${input.traceId}`);
  return {
    traceId: input.traceId,
    batchLocal: false,
  };
}

async function runWorkers<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]);
    }
  }));
}

export async function runBatchSkill(
  input: RunBatchSkillInput,
  deps: BatchTraceRunnerDeps = {},
): Promise<BatchTraceRunV1> {
  const limits = deps.limits ?? resolveBatchTraceLimits();
  const traceLimit = input.traceLimit ?? limits.maxTraceCount;
  assertBatchTraceCount(input.traceInputs.length, traceLimit);
  const maxConcurrency = resolveBatchTraceConcurrency({
    requested: input.maxConcurrency,
    surface: input.surface,
    limits,
  });

  const traceProcessor = deps.traceProcessor ?? getTraceProcessorService();
  const registry = deps.registry ?? builtInSkillRegistry;
  if (!deps.registry) {
    await ensureSkillRegistryInitialized();
  }
  const skill = registry.getSkill(input.skillId);
  if (!skill) throw new Error(`unknown skill:${input.skillId}`);
  const unsupported = unsupportedSkillError(skill);
  if (unsupported) throw unsupported;

  const runId = input.id ?? `batch-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const startedAt = createdAt;
  const scope = input.scope;
  const leaseStore = scope ? deps.leaseStore ?? getTraceProcessorLeaseStore() : undefined;
  const executor = createSkillExecutor(traceProcessor);
  executor.setFragmentRegistry(registry.getFragmentCache());
  executor.registerSkills(registry.getAllSkills());

  const results: BatchTraceResultV1[] = [];
  const batchLocalTraceIds: string[] = [];
  const sourceEnvelopes = new Map<number, ReturnType<typeof retainBatchSourceEnvelope>>();

  const recordResult = (result: BatchTraceResultV1): void => {
    results.push(result);
    input.onTraceResult?.(result);
  };

  await runWorkers(input.traceInputs, maxConcurrency, async (traceInput) => {
    const start = Date.now();
    let lease: TraceProcessorLeaseRecord | null = null;
    let traceId: string | undefined;
    try {
      const resolvedTrace = await resolveTraceId(traceProcessor, traceInput);
      traceId = resolvedTrace.traceId;
      const resolvedTraceId = resolvedTrace.traceId;
      if (resolvedTrace.batchLocal) batchLocalTraceIds.push(resolvedTraceId);

      if (scope && leaseStore) {
        lease = leaseStore.acquireHolder(
          scope,
          resolvedTraceId,
          {
            holderType: 'batch_trace_run',
            holderRef: `batch:${runId}:${traceInput.ordinal}`,
            runId,
            metadata: {
              skillId: input.skillId,
              runId,
              ordinal: traceInput.ordinal,
              surface: input.surface,
            },
          },
          { mode: 'shared' },
        );
        lease = markLeaseReadyIfNew(leaseStore, scope, lease);
        await traceProcessor.ensureProcessorForLease(resolvedTraceId, lease.id, lease.mode as TraceProcessorLeaseMode, scope);
      }
      const skillResult = await traceProcessor.runWithLease(
        lease && scope
          ? {
            traceId: resolvedTraceId,
            leaseId: lease.id,
            mode: lease.mode,
            leaseScope: scope,
          }
          : undefined,
        () => executor.execute(input.skillId, resolvedTraceId, input.params ?? {}),
      );
      const envelopes = SkillExecutor.toDataEnvelopes(skillResult, undefined, { traceId: resolvedTraceId });
      if (skill.batch_analysis) {
        const sourceEnvelope = envelopes.find(envelope => envelope.meta.stepId === skill.batch_analysis?.source_step);
        if (sourceEnvelope) {
          sourceEnvelopes.set(traceInput.ordinal, retainBatchSourceEnvelope(
            sourceEnvelope,
            skill.batch_analysis.per_trace_row_limit,
          ));
        }
      }
      const metrics = extractBatchTraceMetrics({
        skillId: input.skillId,
        ordinal: traceInput.ordinal,
        result: skillResult,
        dataEnvelopes: envelopes,
      });
      recordResult({
        ordinal: traceInput.ordinal,
        input: { ...traceInput, label: inputLabel(traceInput) },
        traceId: resolvedTraceId,
        status: skillResult.success === false ? 'failed' : 'completed',
        metrics,
        evidenceEnvelopeIds: envelopes
          .map(envelope => envelope.meta.evidenceRefId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
        diagnostics: skillResult.diagnostics.map(diagnosticMessage),
        executionTimeMs: skillResult.executionTimeMs || Date.now() - start,
        ...(skillResult.error ? { error: skillResult.error } : {}),
      });
    } catch (error) {
      recordResult({
        ordinal: traceInput.ordinal,
        input: { ...traceInput, label: inputLabel(traceInput) },
        ...(traceId ? { traceId } : {}),
        status: 'failed',
        metrics: [],
        evidenceEnvelopeIds: [],
        diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }],
        executionTimeMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (lease && scope && leaseStore) {
        leaseStore.releaseHolder(scope, lease.id, 'batch_trace_run', `batch:${runId}:${traceInput.ordinal}`);
      }
    }
  });

  if (batchLocalTraceIds.length > 0) {
    traceProcessor.cleanupProcessorsForTraces(batchLocalTraceIds);
  }

  const perTrace = results.sort((a, b) => a.ordinal - b.ordinal);
  const status = statusForResults(perTrace);
  const domainAnalysis = skill.batch_analysis
    ? runBatchPostProcessor({
      skillId: skill.name,
      config: skill.batch_analysis,
      traces: perTrace.map(result => {
        const retained = sourceEnvelopes.get(result.ordinal);
        return {
          ordinal: result.ordinal,
          traceIdentity: result.input.traceId ?? result.input.tracePath ?? result.input.label ?? `trace-${result.ordinal}`,
          ...(result.traceId ? {traceId: result.traceId} : {}),
          status: result.status,
          ...(retained ? {sourceEnvelope: retained.envelope, preTruncatedRowCount: retained.truncatedRowCount} : {}),
          ...(result.error ? {error: result.error} : {}),
        };
      }),
    })
    : undefined;
  return {
    schemaVersion: BATCH_TRACE_RUN_SCHEMA_VERSION,
    id: runId,
    ...(input.scope ? { tenantId: input.scope.tenantId, workspaceId: input.scope.workspaceId } : {}),
    ...(input.scope?.userId ? { createdBy: input.scope.userId } : {}),
    createdAt,
    startedAt,
    completedAt: Date.now(),
    status,
    input: {
      skillId: input.skillId,
      params: input.params ?? {},
      traceInputs: input.traceInputs,
      maxConcurrency,
      traceLimit,
    },
    perTrace,
    aggregate: aggregateBatchTraceResults(perTrace),
    ...(domainAnalysis ? {domainAnalysis} : {}),
  };
}
