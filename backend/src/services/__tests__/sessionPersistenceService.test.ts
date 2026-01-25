/**
 * SessionPersistenceService Unit Tests - Phase 3 Features
 *
 * Tests for EntityStore and SessionContext persistence across restarts.
 */

import { SessionPersistenceService } from '../sessionPersistenceService';
import { createEntityStore, EntityStore } from '../../agent/context/entityStore';
import { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import { StoredSession, StoredMessage } from '../../models/sessionSchema';

describe('SessionPersistenceService - Phase 3 Features', () => {
  let service: SessionPersistenceService;

  beforeEach(() => {
    // Get singleton instance
    service = SessionPersistenceService.getInstance();
  });

  // Helper to create a test session
  function createTestSession(id: string): StoredSession {
    return {
      id,
      traceId: `trace_${id}`,
      traceName: `test_trace_${id}.perfetto-trace`,
      question: 'Test analysis question',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: `msg_${id}_1`,
          role: 'user',
          content: 'Test user message',
          timestamp: Date.now(),
        },
        {
          id: `msg_${id}_2`,
          role: 'assistant',
          content: 'Test assistant response',
          timestamp: Date.now() + 1000,
        },
      ],
    };
  }

  describe('EntityStore Persistence', () => {
    const testSessionId = `test_entitystore_${Date.now()}`;

    afterEach(() => {
      // Cleanup test session
      service.deleteSession(testSessionId);
    });

    test('saveEntityStore and loadEntityStore round-trip', () => {
      // Create and save a session first
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create an EntityStore with various entities
      const store = createEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '123456789000000',
        end_ts: '123456889000000',
        process_name: 'com.example.app',
        jank_type: 'App Deadline Missed',
      });
      store.upsertSession({
        session_id: '1',
        start_ts: '100000000000000',
        end_ts: '200000000000000',
        frame_count: 120,
        jank_count: 5,
      });
      store.upsertCpuSlice({
        slice_id: 'cpu_1',
        thread_name: 'RenderThread',
        cpu: 4,
      });
      store.markFrameAnalyzed('1436069');
      store.setLastCandidateFrames(['1436069', '1436070']);

      // Save EntityStore
      const saved = service.saveEntityStore(testSessionId, store);
      expect(saved).toBe(true);

      // Load EntityStore
      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).not.toBeNull();

      // Verify frames
      const frame = loaded!.getFrame('1436069');
      expect(frame).toBeDefined();
      expect(frame?.jank_type).toBe('App Deadline Missed');
      expect(loaded!.wasFrameAnalyzed('1436069')).toBe(true);

      // Verify sessions
      const scrollSession = loaded!.getSession('1');
      expect(scrollSession).toBeDefined();
      expect(scrollSession?.frame_count).toBe(120);

      // Verify CPU slices (Phase 3)
      const cpuSlice = loaded!.getCpuSlice('cpu_1');
      expect(cpuSlice).toBeDefined();
      expect(cpuSlice?.thread_name).toBe('RenderThread');

      // Verify candidate lists
      expect(loaded!.getLastCandidateFrames()).toEqual(['1436069', '1436070']);
    });

    test('hasEntityStore returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Initially no EntityStore
      expect(service.hasEntityStore(testSessionId)).toBe(false);

      // Save EntityStore
      const store = createEntityStore();
      store.upsertFrame({ frame_id: '1' });
      service.saveEntityStore(testSessionId, store);

      // Now has EntityStore
      expect(service.hasEntityStore(testSessionId)).toBe(true);
    });

    test('getEntityStoreStats returns entity counts', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create EntityStore with multiple entities
      const store = createEntityStore();
      store.upsertFrame({ frame_id: '1' });
      store.upsertFrame({ frame_id: '2' });
      store.upsertSession({ session_id: '1' });
      store.markFrameAnalyzed('1');
      service.saveEntityStore(testSessionId, store);

      // Get stats
      const stats = service.getEntityStoreStats(testSessionId);
      expect(stats).not.toBeNull();
      expect(stats?.frameCount).toBe(2);
      expect(stats?.sessionCount).toBe(1);
      expect(stats?.analyzedFrameCount).toBe(1);
    });

    test('loadEntityStore returns null for session without EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).toBeNull();
    });

    test('saveEntityStore fails for non-existent session', () => {
      const store = createEntityStore();
      const saved = service.saveEntityStore('non_existent_session', store);
      expect(saved).toBe(false);
    });
  });

  describe('SessionContext Persistence', () => {
    const testSessionId = `test_context_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('saveSessionContext and loadSessionContext round-trip', () => {
      // Create and save a session first
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create an EnhancedSessionContext
      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      context.addTurn('What are the janky frames?', {
        primaryGoal: 'jank_analysis',
        aspects: ['frame_timing'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
      });

      // Add some entities to the context's EntityStore
      const entityStore = context.getEntityStore();
      entityStore.upsertFrame({
        frame_id: '1',
        start_ts: '100',
        jank_type: 'Buffer Stuffing',
      });

      // Save context
      const saved = service.saveSessionContext(testSessionId, context);
      expect(saved).toBe(true);

      // Load context
      const loaded = service.loadSessionContext(testSessionId);
      expect(loaded).not.toBeNull();

      // Verify conversation history
      const turns = loaded!.getAllTurns();
      expect(turns.length).toBeGreaterThan(0);

      // Verify EntityStore was restored
      const loadedStore = loaded!.getEntityStore();
      const frame = loadedStore.getFrame('1');
      expect(frame).toBeDefined();
      expect(frame?.jank_type).toBe('Buffer Stuffing');
    });

    test('hasSessionContext returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      expect(service.hasSessionContext(testSessionId)).toBe(false);

      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      service.saveSessionContext(testSessionId, context);

      expect(service.hasSessionContext(testSessionId)).toBe(true);
    });

    test('saveSessionContext also saves EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      const entityStore = context.getEntityStore();
      entityStore.upsertFrame({ frame_id: '999', start_ts: '999' });

      service.saveSessionContext(testSessionId, context);

      // Should be able to load EntityStore independently
      const loadedStore = service.loadEntityStore(testSessionId);
      expect(loadedStore).not.toBeNull();
      expect(loadedStore?.getFrame('999')).toBeDefined();
    });
  });

  describe('Cross-Restart Simulation', () => {
    const testSessionId = `test_restart_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('EntityStore survives simulated process restart', () => {
      // Phase 1: Initial session
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store1 = createEntityStore();
      store1.upsertFrame({ frame_id: '1', jank_type: 'App Deadline Missed' });
      store1.upsertFrame({ frame_id: '2', jank_type: 'Buffer Stuffing' });
      store1.markFrameAnalyzed('1');
      service.saveEntityStore(testSessionId, store1);

      // Phase 2: Simulate restart by creating new store from persistence
      const store2 = service.loadEntityStore(testSessionId);
      expect(store2).not.toBeNull();

      // Verify state was preserved
      expect(store2!.getAllFrames()).toHaveLength(2);
      expect(store2!.wasFrameAnalyzed('1')).toBe(true);
      expect(store2!.wasFrameAnalyzed('2')).toBe(false);

      // Phase 3: Continue working with restored store
      store2!.markFrameAnalyzed('2');
      store2!.upsertFrame({ frame_id: '3', jank_type: 'SurfaceFlinger Scheduling' });
      service.saveEntityStore(testSessionId, store2!);

      // Phase 4: Another restart
      const store3 = service.loadEntityStore(testSessionId);
      expect(store3!.getAllFrames()).toHaveLength(3);
      expect(store3!.wasFrameAnalyzed('1')).toBe(true);
      expect(store3!.wasFrameAnalyzed('2')).toBe(true);
      expect(store3!.wasFrameAnalyzed('3')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    const testSessionId = `test_edge_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('handles empty EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store = createEntityStore();
      service.saveEntityStore(testSessionId, store);

      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.getAllFrames()).toHaveLength(0);
      expect(loaded!.getAllSessions()).toHaveLength(0);
    });

    test('handles large entity IDs (BigInt range)', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store = createEntityStore();
      const bigId = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
      store.upsertFrame({ frame_id: bigId, start_ts: '100' });
      service.saveEntityStore(testSessionId, store);

      const loaded = service.loadEntityStore(testSessionId);
      const frame = loaded!.getFrame(bigId);
      expect(frame).toBeDefined();
      expect(frame?.frame_id).toBe(bigId);
    });

    test('overwrites previous EntityStore on save', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Save first version
      const store1 = createEntityStore();
      store1.upsertFrame({ frame_id: '1', jank_type: 'Type A' });
      service.saveEntityStore(testSessionId, store1);

      // Save second version (different data)
      const store2 = createEntityStore();
      store2.upsertFrame({ frame_id: '2', jank_type: 'Type B' });
      service.saveEntityStore(testSessionId, store2);

      // Load should return second version
      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded!.getFrame('1')).toBeUndefined(); // First version data gone
      expect(loaded!.getFrame('2')?.jank_type).toBe('Type B');
    });
  });
});
