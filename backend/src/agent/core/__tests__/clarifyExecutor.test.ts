// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * ClarifyExecutor Unit Tests
 */

import { ClarifyExecutor } from '../executors/clarifyExecutor';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { AnalysisServices, ExecutionContext, ProgressEmitter } from '../orchestratorTypes';
import type { Intent } from '../../types';
import type { ModelRouter } from '../modelRouter';

describe('ClarifyExecutor', () => {
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
        response: '这是一个解释说明。',
        modelId: 'test-model',
        usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
        latencyMs: 500,
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

  function buildExecutionContext(intent: Partial<Intent> = {}): ExecutionContext {
    return {
      query: '为什么帧 1436069 卡顿?',
      sessionId: 'session-1',
      traceId: 'trace-1',
      intent: {
        primaryGoal: '解释帧卡顿原因',
        aspects: ['jank'],
        expectedOutputType: 'diagnosis',
        complexity: 'simple',
        followUpType: 'clarify',
        referencedEntities: [{ type: 'frame' as const, id: 1436069 }],
        ...intent,
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
    test('generates explanation using LLM', async () => {
      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].type).toBe('clarification');
      expect(result.findings[0].description).toBe('这是一个解释说明。');
      expect(result.confidence).toBe(0.9);
      expect(result.rounds).toBe(1);
      expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
        expect.stringContaining('为什么帧 1436069 卡顿?'),
        'synthesis',
        expect.objectContaining({
          sessionId: 'session-1',
          traceId: 'trace-1',
          promptId: 'agent.clarifyExecutor',
          promptVersion: '1.0.0',
          contractVersion: 'clarify_text@1.0.0',
        })
      );
    });

    test('includes frame data from EntityStore in LLM prompt', async () => {
      // Pre-populate EntityStore with frame data
      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        jank_type: 'App Deadline Missed',
        dur_ms: 45.5,
        process_name: 'com.example.app',
      });

      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      await executor.execute(ctx, emitter);

      // Verify LLM was called with frame context
      expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
        expect.stringContaining('App Deadline Missed'),
        'synthesis',
        expect.objectContaining({
          sessionId: 'session-1',
          traceId: 'trace-1',
          promptId: 'agent.clarifyExecutor',
          promptVersion: '1.0.0',
          contractVersion: 'clarify_text@1.0.0',
        })
      );
    });

    test('includes session data from EntityStore in LLM prompt', async () => {
      const store = sessionContext.getEntityStore();
      store.upsertSession({
        session_id: '1',
        frame_count: 120,
        jank_count: 5,
        process_name: 'com.example.app',
      });

      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext({
        referencedEntities: [{ type: 'session' as const, id: 1 }],
      });

      await executor.execute(ctx, emitter);

      expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
        expect.stringContaining('120'),
        'synthesis',
        expect.objectContaining({
          sessionId: 'session-1',
          traceId: 'trace-1',
          promptId: 'agent.clarifyExecutor',
          promptVersion: '1.0.0',
          contractVersion: 'clarify_text@1.0.0',
        })
      );
    });

    test('uses fallback when LLM fails', async () => {
      mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(
        new Error('All models failed')
      );

      // Add frame data for fallback to use
      const store = sessionContext.getEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        jank_type: 'Buffer Stuffing',
        dur_ms: 32.1,
      });

      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // Should still produce a finding with fallback explanation
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].description).toContain('Buffer Stuffing');
      expect(logs.some(l => l.includes('LLM call failed'))).toBe(true);
    });

    test('handles empty response from LLM', async () => {
      mockModelRouter.callWithFallback = jest.fn().mockResolvedValue({
        success: true,
        response: '',
        modelId: 'test-model',
        usage: { inputTokens: 100, outputTokens: 0, totalCost: 0 },
        latencyMs: 100,
      });

      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      expect(result.findings[0].description).toContain('无法生成解释');
    });

    test('emits correct progress updates', async () => {
      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      await executor.execute(ctx, emitter);

      expect(emittedUpdates.some(u => u.type === 'progress' && u.content.phase === 'clarifying')).toBe(true);
      expect(emittedUpdates.some(u => u.type === 'finding')).toBe(true);
      expect(emittedUpdates.some(u => u.type === 'progress' && u.content.phase === 'synthesis_complete')).toBe(true);
    });

    test('does not run SQL queries (read-only mode)', async () => {
      const executor = new ClarifyExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      await executor.execute(ctx, emitter);

      // Verify no SQL-related progress updates
      expect(emittedUpdates.every(u => !u.content?.phase?.includes('sql'))).toBe(true);
      expect(logs.some(l => l.includes('read-only'))).toBe(true);
    });
  });
});