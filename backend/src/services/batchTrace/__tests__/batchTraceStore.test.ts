// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import { describe, expect, it } from '@jest/globals';
import { applyEnterpriseMinimalSchema } from '../../enterpriseSchema';
import { BatchTraceRunRepository } from '../batchTraceStore';
import {
  BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
  BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
  BATCH_TRACE_RUN_SCHEMA_VERSION,
  type BatchTraceRunV1,
} from '../batchTraceTypes';
import {
  HEAP_PATH_CLUSTER_SCHEMA_VERSION,
  HEAP_PATH_NORMALIZATION_VERSION,
} from '../../../types/heapPathCluster';

function db(): Database.Database {
  const database = new Database(':memory:');
  applyEnterpriseMinimalSchema(database);
  database.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', NULL, 1, 1)
  `).run();
  database.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
    VALUES ('workspace-a', 'tenant-a', 'Workspace A', NULL, NULL, 1, 1)
  `).run();
  return database;
}

function run(): BatchTraceRunV1 {
  return {
    schemaVersion: BATCH_TRACE_RUN_SCHEMA_VERSION,
    id: 'batch-1',
    createdAt: 1,
    startedAt: 2,
    completedAt: 3,
    status: 'completed',
    input: {
      skillId: 'startup_analysis',
      params: {},
      maxConcurrency: 2,
      traceLimit: 100,
      traceInputs: [{ ordinal: 0, source: 'workspace_trace', traceId: 'trace-a' }],
    },
    perTrace: [{
      ordinal: 0,
      input: { ordinal: 0, source: 'workspace_trace', traceId: 'trace-a' },
      traceId: 'trace-a',
      status: 'completed',
      metrics: [{
        key: 'startup.total_ms',
        label: 'Startup total duration',
        value: 42,
        numericValue: 42,
        unit: 'ms',
        source: { skillId: 'startup_analysis', stepId: 'overview' },
        promotableMetricKey: 'startup.total_ms',
      }],
      evidenceEnvelopeIds: ['ev-1'],
      diagnostics: [],
      executionTimeMs: 5,
    }],
    aggregate: {
      metrics: [],
      limitations: [],
    },
    domainAnalysis: {
      schemaVersion: BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
      operation: 'heap_path_cluster',
      evidence: {
        schemaVersion: BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
        skillId: 'android_heap_dominator_path_extract',
        sourceStepId: 'dominator_paths',
        requiredColumns: ['path'],
        rowCount: 1,
        rejectedRowCount: 0,
        truncatedRowCount: 0,
        rows: [{
          refId: 'batch-row-1',
          traceOrdinal: 0,
          traceIdentity: 'trace-a',
          traceId: 'trace-a',
          values: {path: '[ROOT] Root -> Leak'},
        }],
      },
      result: {
        schemaVersion: HEAP_PATH_CLUSTER_SCHEMA_VERSION,
        normalizationVersion: HEAP_PATH_NORMALIZATION_VERSION,
        status: 'insufficient_samples',
        seedHash: 'seed',
        selectedK: null,
        silhouetteScore: null,
        collapseTolerancePct: 5,
        input: {traceCount: 1, sampleCount: 1, rowCount: 1, rejectedRowCount: 0},
        clusters: [],
        failures: [],
        limitations: [],
      },
    },
  };
}

describe('BatchTraceRunRepository', () => {
  it('persists scoped run, input, result, and metric rows', () => {
    const database = db();
    const repository = new BatchTraceRunRepository(database);

    repository.saveRun({ tenantId: 'tenant-a', workspaceId: 'workspace-a' }, run());
    const stored = repository.getRun({ tenantId: 'tenant-a', workspaceId: 'workspace-a' }, 'batch-1');

    expect(stored?.id).toBe('batch-1');
    expect(stored?.domainAnalysis).toEqual(run().domainAnalysis);
    expect(database.prepare('SELECT COUNT(*) AS count FROM batch_trace_inputs').get()).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM batch_trace_results').get()).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM batch_trace_metrics').get()).toMatchObject({ count: 1 });
    database.close();
  });
});
