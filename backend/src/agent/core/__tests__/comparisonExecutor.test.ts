// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * ComparisonExecutor Unit Tests
 */

import { ComparisonExecutor } from '../executors/comparisonExecutor';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { AnalysisServices, ExecutionContext, ProgressEmitter } from '../orchestratorTypes';
import type { Intent } from '../../types';
import type { ModelRouter } from '../modelRouter';

describe('ComparisonExecutor', () => {
  let sessionContext: EnhancedSessionContext;
  let mockModelRouter: jest.Mocked<Partial<ModelRouter>>;
  let services: AnalysisServices;
  let emitter: ProgressEmitter;
  let emittedUpdates: Array<{ type: string; content: any }>;
  let logs: string[];

  beforeEach(() => {
    sessionContext = new EnhancedSessionContext('session-1', 'trace-1');
    emittedUpdates = [];
    logs = [];

    mockModelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: '帧 1436069 表现更差，主要原因是 App Deadline Missed 导致的卡顿。',
        modelId: 'test-model',
        usage: { inputTokens: 200, outputTokens: 100, totalCost: 0.002 },
        latencyMs: 800,
      }),
    };

    services = {
      modelRouter: mockModelRouter as unknown as ModelRouter,
      messageBus: {} as any,
      circuitBreaker: {} as any,
    };

    emitter = {
      emitUpdate: (type, content) => {
        emittedUpdates.push({ type, content });
      },
      log: (message) => {
        logs.push(message);
      },
    };
  });

  function buildExecutionContext(entities: Array<{ type: 'frame' | 'session'; id: number | string }>): ExecutionContext {
    return {
      query: '比较帧 1436069 和 1436070',
      sessionId: 'session-1',
      traceId: 'trace-1',
      intent: {
        primaryGoal: '比较两个帧',
        aspects: ['jank'],
        expectedOutputType: 'comparison',
        complexity: 'moderate',
        followUpType: 'compare',
        referencedEntities: entities.map(e => ({ type: e.type, id: e.id })),
      },
      initialHypotheses: [],
      sharedContext: {
        sessionId: 'session-1',
        traceId: 'trace-1',
        hypotheses: new Map(),
        confirmedFindings: [],
        investigationPath: [],
      },
      options: {},
      config: {
        maxRounds: 5,
        maxConcurrentTasks: 3,
        confidenceThreshold: 0.7,
        maxNoProgressRounds: 2,
        maxFailureRounds: 2,
        enableLogging: true,
      },
    };
  }

  describe('execute', () => {
    test('compares multiple frames from EntityStore cache', async () => {
      // Pre-populate EntityStore with frame data
      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '123456789000000',
        end_ts: '123456889000000',
        process_name: 'com.example.app',
        jank_type: 'App Deadline Missed',
        dur_ms: 45.5,
        vsync_missed: 2,
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '123456889000000',
        end_ts: '123456939000000',
        process_name: 'com.example.app',
        jank_type: 'No Jank',
        dur_ms: 16.2,
        vsync_missed: 0,
      });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
        { type: 'frame', id: 1436070 },
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].type).toBe('comparison_table');
      expect(result.findings[1].type).toBe('comparison_narrative');
      expect(result.confidence).toBe(0.85);
    });

    test('comparison table contains frame data', async () => {
      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
        jank_type: 'App Deadline Missed',
        dur_ms: 45.5,
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '200',
        end_ts: '300',
        jank_type: 'No Jank',
        dur_ms: 16.2,
      });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
        { type: 'frame', id: 1436070 },
      ]);

      const result = await executor.execute(ctx, emitter);

      const tableFinding = result.findings.find(f => f.type === 'comparison_table');
      expect(tableFinding?.description).toContain('1436069');
      expect(tableFinding?.description).toContain('1436070');
      expect(tableFinding?.description).toContain('App Deadline Missed');
    });

    test('compares multiple sessions from EntityStore cache', async () => {
      const store = sessionContext.getEntityStore();
      store.upsertSession({
        session_id: '1',
        start_ts: '100000000000000',
        end_ts: '200000000000000',
        process_name: 'com.example.app',
        frame_count: 120,
        jank_count: 5,
      });
      store.upsertSession({
        session_id: '2',
        start_ts: '200000000000000',
        end_ts: '300000000000000',
        process_name: 'com.example.app',
        frame_count: 80,
        jank_count: 2,
      });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'session', id: 1 },
        { type: 'session', id: 2 },
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(2);
      const tableFinding = result.findings.find(f => f.type === 'comparison_table');
      expect(tableFinding?.description).toContain('卡顿率');
    });

    test('returns error when fewer than 2 entities', async () => {
      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].type).toBe('comparison_error');
      expect(result.findings[0].description).toContain('至少两个');
      expect(result.confidence).toBe(0.5);
    });

    test('returns error for mixed entity types', async () => {
      const store = sessionContext.getEntityStore();
      store.upsertFrame({ frame_id: '1436069', start_ts: '100', end_ts: '200' });
      store.upsertSession({ session_id: '1', start_ts: '100', end_ts: '200' });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
        { type: 'session', id: 1 },
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].type).toBe('comparison_error');
      expect(result.findings[0].description).toContain('相同类型');
    });

    test('returns error when entity resolution fails', async () => {
      // Don't pre-populate EntityStore - entities won't be found
      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 9999998 },
        { type: 'frame', id: 9999999 },
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].type).toBe('comparison_error');
      expect(result.confidence).toBe(0.3);
    });

    test('uses fallback narrative when LLM fails', async () => {
      mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(
        new Error('All models failed')
      );

      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
        jank_type: 'App Deadline Missed',
        dur_ms: 45.5,
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '200',
        end_ts: '300',
        jank_type: 'No Jank',
        dur_ms: 16.2,
      });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
        { type: 'frame', id: 1436070 },
      ]);

      const result = await executor.execute(ctx, emitter);

      // Should still have findings with fallback narrative
      expect(result.findings).toHaveLength(2);
      const narrativeFinding = result.findings.find(f => f.type === 'comparison_narrative');
      expect(narrativeFinding?.description).toContain('对比了 2 个帧');
    });

    test('determines severity based on comparison data', async () => {
      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
        jank_type: 'App Deadline Missed',
        dur_ms: 50, // > 32ms threshold
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '200',
        end_ts: '300',
        jank_type: 'No Jank',
        dur_ms: 16,
      });

      const executor = new ComparisonExecutor(sessionContext, services);
      const ctx = buildExecutionContext([
        { type: 'frame', id: 1436069 },
        { type: 'frame', id: 1436070 },
      ]);

      const result = await executor.execute(ctx, emitter);

      const narrativeFinding = result.findings.find(f => f.type === 'comparison_narrative');
      expect(narrativeFinding?.severity).toBe('warning');
    });
  });
});