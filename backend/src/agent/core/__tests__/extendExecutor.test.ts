/**
 * ExtendExecutor Unit Tests
 */

import { ExtendExecutor } from '../executors/extendExecutor';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { AnalysisServices, ExecutionContext, ProgressEmitter } from '../orchestratorTypes';
import type { ModelRouter } from '../modelRouter';

describe('ExtendExecutor', () => {
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
        response: 'Analysis complete.',
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

  function buildExecutionContext(): ExecutionContext {
    return {
      query: '继续分析',
      sessionId: 'session-1',
      traceId: 'trace-1',
      intent: {
        primaryGoal: '分析更多帧',
        aspects: ['jank'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
        followUpType: 'extend',
        referencedEntities: [],
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
    test('returns nothing-to-extend when no candidate entities', async () => {
      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].type).toBe('extend_complete');
      expect(result.findings[0].title).toContain('无更多实体');
      expect(result.confidence).toBe(0.9);
    });

    test('processes unanalyzed frame candidates', async () => {
      const store = sessionContext.getEntityStore();

      // Add frames to store with timestamps
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '123456789000000',
        end_ts: '123456889000000',
        process_name: 'com.example.app',
        jank_type: 'App Deadline Missed',
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '123456889000000',
        end_ts: '123456989000000',
        process_name: 'com.example.app',
        jank_type: 'Buffer Stuffing',
      });
      store.upsertFrame({
        frame_id: '1436071',
        start_ts: '123456989000000',
        end_ts: '123457089000000',
        process_name: 'com.example.app',
        jank_type: 'No Jank',
      });

      // Set candidates - all unanalyzed
      store.setLastCandidateFrames(['1436069', '1436070', '1436071']);

      const executor = new ExtendExecutor(sessionContext, services, undefined, undefined, 2);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // Should have summary finding
      const summaryFinding = result.findings.find(f => f.type === 'extend_summary');
      expect(summaryFinding).toBeDefined();
      expect(summaryFinding?.description).toContain('2');

      // Should return analyzed entity IDs
      expect(result.analyzedEntityIds?.frames).toHaveLength(2);
      expect(result.analyzedEntityIds?.frames).toContain('1436069');
      expect(result.analyzedEntityIds?.frames).toContain('1436070');

      // Should have remaining info gap
      expect(result.informationGaps.length).toBeGreaterThan(0);
    });

    test('skips already-analyzed frames', async () => {
      const store = sessionContext.getEntityStore();

      // Add frames
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
        jank_type: 'App Deadline Missed',
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '200',
        end_ts: '300',
        jank_type: 'Buffer Stuffing',
      });

      // Set candidates and mark one as analyzed
      store.setLastCandidateFrames(['1436069', '1436070']);
      store.markFrameAnalyzed('1436069');

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // Should only process the unanalyzed one
      expect(result.analyzedEntityIds?.frames).toContain('1436070');
      expect(result.analyzedEntityIds?.frames).not.toContain('1436069');
    });

    test('processes session candidates when no frame candidates', async () => {
      const store = sessionContext.getEntityStore();

      // Add sessions instead of frames
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

      // Set session candidates only
      store.setLastCandidateSessions(['1', '2']);

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // Should process sessions
      expect(result.analyzedEntityIds?.sessions).toBeDefined();
      expect(result.analyzedEntityIds?.sessions?.length).toBeGreaterThan(0);
    });

    test('returns resolution failed when entities lack timestamps', async () => {
      const store = sessionContext.getEntityStore();

      // Add frame without timestamps
      store.upsertFrame({
        frame_id: '1436069',
        jank_type: 'App Deadline Missed',
        // No start_ts/end_ts
      });

      store.setLastCandidateFrames(['1436069']);

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      expect(result.findings[0].type).toBe('extend_error');
      expect(result.findings[0].description).toContain('时间戳');
      expect(result.confidence).toBe(0.3);
    });

    test('respects batch size configuration', async () => {
      const store = sessionContext.getEntityStore();

      // Add many frames
      for (let i = 0; i < 10; i++) {
        store.upsertFrame({
          frame_id: String(1436060 + i),
          start_ts: String(100 + i * 100),
          end_ts: String(200 + i * 100),
          jank_type: 'App Deadline Missed',
        });
      }

      store.setLastCandidateFrames(
        Array.from({ length: 10 }, (_, i) => String(1436060 + i))
      );

      // Use batch size of 3
      const executor = new ExtendExecutor(sessionContext, services, undefined, undefined, 3);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // Should only process batch size
      expect(result.analyzedEntityIds?.frames).toHaveLength(3);
    });

    test('generates correct summary message', async () => {
      const store = sessionContext.getEntityStore();

      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
      });
      store.upsertFrame({
        frame_id: '1436070',
        start_ts: '200',
        end_ts: '300',
      });

      store.setLastCandidateFrames(['1436069', '1436070']);

      const executor = new ExtendExecutor(sessionContext, services, undefined, undefined, 1);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      const summaryFinding = result.findings.find(f => f.type === 'extend_summary');
      expect(summaryFinding?.description).toContain('1 个帧');
      expect(summaryFinding?.description).toContain('1 个帧未分析');
    });

    test('indicates all entities analyzed when batch covers remaining', async () => {
      const store = sessionContext.getEntityStore();

      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
      });

      store.setLastCandidateFrames(['1436069']);

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      const summaryFinding = result.findings.find(f => f.type === 'extend_summary');
      expect(summaryFinding?.description).toContain('已分析完毕');
      expect(result.informationGaps).toHaveLength(0);
    });

    test('returns captured entities for orchestrator write-back', async () => {
      const store = sessionContext.getEntityStore();

      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
        jank_type: 'App Deadline Missed',
      });

      store.setLastCandidateFrames(['1436069']);

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      const result = await executor.execute(ctx, emitter);

      // capturedEntities should be present (may be empty if no SQL run)
      expect(result.capturedEntities).toBeDefined();
      // analyzedEntityIds should be present for orchestrator to mark as analyzed
      expect(result.analyzedEntityIds).toBeDefined();
    });

    test('emits correct progress updates', async () => {
      const store = sessionContext.getEntityStore();

      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '100',
        end_ts: '200',
      });

      store.setLastCandidateFrames(['1436069']);

      const executor = new ExtendExecutor(sessionContext, services);
      const ctx = buildExecutionContext();

      await executor.execute(ctx, emitter);

      expect(emittedUpdates.some(u => u.content.phase === 'extending')).toBe(true);
      expect(emittedUpdates.some(u => u.type === 'finding')).toBe(true);
    });
  });
});
