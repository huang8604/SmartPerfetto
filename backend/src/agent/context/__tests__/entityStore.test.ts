/**
 * EntityStore Unit Tests
 */

import {
  EntityStore,
  createEntityStore,
  FrameEntity,
  SessionEntity,
  CpuSliceEntity,
  BinderEntity,
  GcEntity,
  MemoryEntity,
  GenericEntity,
  EntityStoreSnapshot,
} from '../entityStore';

describe('EntityStore', () => {
  let store: EntityStore;

  beforeEach(() => {
    store = createEntityStore();
  });

  describe('Frame Operations', () => {
    const frame1: FrameEntity = {
      frame_id: '1436069',
      start_ts: '123456789000000',
      end_ts: '123456889000000',
      process_name: 'com.example.app',
      session_id: '1',
      jank_type: 'App Deadline Missed',
      dur_ms: 100,
      source: 'table',
    };

    const frame2: FrameEntity = {
      frame_id: '1436070',
      start_ts: '123456889000000',
      end_ts: '123456989000000',
      process_name: 'com.example.app',
      session_id: '1',
    };

    test('upsertFrame and getFrame', () => {
      store.upsertFrame(frame1);
      const retrieved = store.getFrame('1436069');

      expect(retrieved).toBeDefined();
      expect(retrieved?.frame_id).toBe('1436069');
      expect(retrieved?.start_ts).toBe('123456789000000');
      expect(retrieved?.jank_type).toBe('App Deadline Missed');
    });

    test('getFrame with number ID', () => {
      store.upsertFrame(frame1);
      const retrieved = store.getFrame(1436069);

      expect(retrieved).toBeDefined();
      expect(retrieved?.frame_id).toBe('1436069');
    });

    test('upsert merges data', () => {
      store.upsertFrame(frame1);

      // Upsert with partial update
      store.upsertFrame({
        frame_id: '1436069',
        dur_ms: 150,
        vsync_missed: 2,
      });

      const retrieved = store.getFrame('1436069');
      expect(retrieved?.dur_ms).toBe(150); // Updated
      expect(retrieved?.vsync_missed).toBe(2); // Added
      expect(retrieved?.jank_type).toBe('App Deadline Missed'); // Preserved
      expect(retrieved?.start_ts).toBe('123456789000000'); // Preserved
    });

    test('getAllFrames returns all frames', () => {
      store.upsertFrame(frame1);
      store.upsertFrame(frame2);

      const frames = store.getAllFrames();
      expect(frames).toHaveLength(2);
      expect(frames.map(f => f.frame_id).sort()).toEqual(['1436069', '1436070']);
    });

    test('markFrameAnalyzed and wasFrameAnalyzed', () => {
      store.upsertFrame(frame1);

      expect(store.wasFrameAnalyzed('1436069')).toBe(false);

      store.markFrameAnalyzed('1436069');
      expect(store.wasFrameAnalyzed('1436069')).toBe(true);
      expect(store.wasFrameAnalyzed(1436069)).toBe(true); // Number ID
    });

    test('setLastCandidateFrames and getUnanalyzedCandidateFrames', () => {
      store.setLastCandidateFrames(['1436069', '1436070', '1436071']);
      store.markFrameAnalyzed('1436069');

      const unanalyzed = store.getUnanalyzedCandidateFrames();
      expect(unanalyzed).toEqual(['1436070', '1436071']);
    });
  });

  describe('Session Operations', () => {
    const session1: SessionEntity = {
      session_id: '1',
      start_ts: '100000000000000',
      end_ts: '200000000000000',
      process_name: 'com.example.app',
      frame_count: 120,
      jank_count: 5,
    };

    test('upsertSession and getSession', () => {
      store.upsertSession(session1);
      const retrieved = store.getSession('1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.session_id).toBe('1');
      expect(retrieved?.frame_count).toBe(120);
    });

    test('markSessionAnalyzed and wasSessionAnalyzed', () => {
      store.upsertSession(session1);

      expect(store.wasSessionAnalyzed('1')).toBe(false);

      store.markSessionAnalyzed('1');
      expect(store.wasSessionAnalyzed('1')).toBe(true);
    });

    test('setLastCandidateSessions and getUnanalyzedCandidateSessions', () => {
      store.setLastCandidateSessions(['1', '2', '3']);
      store.markSessionAnalyzed('2');

      const unanalyzed = store.getUnanalyzedCandidateSessions();
      expect(unanalyzed).toEqual(['1', '3']);
    });
  });

  describe('Bulk Operations', () => {
    test('upsertFrames', () => {
      const frames: FrameEntity[] = [
        { frame_id: '1', start_ts: '100' },
        { frame_id: '2', start_ts: '200' },
        { frame_id: '3', start_ts: '300' },
      ];

      store.upsertFrames(frames);

      expect(store.getAllFrames()).toHaveLength(3);
      expect(store.getFrame('2')?.start_ts).toBe('200');
    });

    test('upsertSessions', () => {
      const sessions: SessionEntity[] = [
        { session_id: '1', frame_count: 100 },
        { session_id: '2', frame_count: 200 },
      ];

      store.upsertSessions(sessions);

      expect(store.getAllSessions()).toHaveLength(2);
      expect(store.getSession('1')?.frame_count).toBe(100);
    });
  });

  describe('Statistics', () => {
    test('getStats returns accurate counts', () => {
      store.upsertFrame({ frame_id: '1' });
      store.upsertFrame({ frame_id: '2' });
      store.upsertSession({ session_id: '1' });
      store.markFrameAnalyzed('1');
      store.setLastCandidateFrames(['1', '2', '3']);
      store.setLastCandidateSessions(['1', '2']);

      const stats = store.getStats();
      expect(stats.frameCount).toBe(2);
      expect(stats.sessionCount).toBe(1);
      expect(stats.analyzedFrameCount).toBe(1);
      expect(stats.analyzedSessionCount).toBe(0);
      expect(stats.candidateFrameCount).toBe(3);
      expect(stats.candidateSessionCount).toBe(2);
    });
  });

  describe('Serialization', () => {
    test('serialize and deserialize preserves state', () => {
      // Set up some state
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
      });
      store.markFrameAnalyzed('1436069');
      store.setLastCandidateFrames(['1436069', '1436070']);
      store.setLastCandidateSessions(['1', '2']);

      // Serialize
      const snapshot = store.serialize();
      expect(snapshot.version).toBe(1);

      // Deserialize
      const restored = EntityStore.deserialize(snapshot);

      // Verify frames
      const frame = restored.getFrame('1436069');
      expect(frame).toBeDefined();
      expect(frame?.jank_type).toBe('App Deadline Missed');
      expect(restored.wasFrameAnalyzed('1436069')).toBe(true);

      // Verify sessions
      const session = restored.getSession('1');
      expect(session).toBeDefined();
      expect(session?.frame_count).toBe(120);

      // Verify candidate lists
      expect(restored.getLastCandidateFrames()).toEqual(['1436069', '1436070']);
      expect(restored.getLastCandidateSessions()).toEqual(['1', '2']);

      // Verify unanalyzed
      expect(restored.getUnanalyzedCandidateFrames()).toEqual(['1436070']);
    });

    test('deserialize handles empty/missing fields gracefully', () => {
      const partialSnapshot: EntityStoreSnapshot = {
        version: 1,
        framesById: [],
        sessionsById: [],
        analyzedFrameIds: [],
        analyzedSessionIds: [],
        lastCandidateFrameIds: [],
        lastCandidateSessionIds: [],
      };

      const restored = EntityStore.deserialize(partialSnapshot);
      expect(restored.getAllFrames()).toHaveLength(0);
      expect(restored.getAllSessions()).toHaveLength(0);
    });
  });

  describe('Clear', () => {
    test('clear removes all data', () => {
      store.upsertFrame({ frame_id: '1' });
      store.upsertSession({ session_id: '1' });
      store.markFrameAnalyzed('1');
      store.setLastCandidateFrames(['1', '2']);

      store.clear();

      expect(store.getAllFrames()).toHaveLength(0);
      expect(store.getAllSessions()).toHaveLength(0);
      expect(store.wasFrameAnalyzed('1')).toBe(false);
      expect(store.getLastCandidateFrames()).toHaveLength(0);
    });
  });

  describe('CpuSlice Operations', () => {
    const cpuSlice1: CpuSliceEntity = {
      slice_id: '12345',
      start_ts: '100000000000',
      end_ts: '100001000000',
      dur_ns: '1000000',
      cpu: 4,
      tid: 12345,
      pid: 1000,
      process_name: 'com.example.app',
      thread_name: 'RenderThread',
      state: 'Running',
    };

    test('upsertCpuSlice and getCpuSlice', () => {
      store.upsertCpuSlice(cpuSlice1);
      const retrieved = store.getCpuSlice('12345');

      expect(retrieved).toBeDefined();
      expect(retrieved?.slice_id).toBe('12345');
      expect(retrieved?.thread_name).toBe('RenderThread');
      expect(retrieved?.cpu).toBe(4);
    });

    test('getAllCpuSlices returns all slices', () => {
      store.upsertCpuSlice(cpuSlice1);
      store.upsertCpuSlice({
        slice_id: '12346',
        start_ts: '100001000000',
        cpu: 5,
      });

      const slices = store.getAllCpuSlices();
      expect(slices).toHaveLength(2);
    });

    test('upsert merges data', () => {
      store.upsertCpuSlice(cpuSlice1);
      store.upsertCpuSlice({
        slice_id: '12345',
        priority: 120, // Add new field
      });

      const retrieved = store.getCpuSlice('12345');
      expect(retrieved?.priority).toBe(120); // Added
      expect(retrieved?.thread_name).toBe('RenderThread'); // Preserved
    });
  });

  describe('Binder Operations', () => {
    const binder1: BinderEntity = {
      transaction_id: 'binder_100',
      client_pid: 1000,
      client_process: 'com.example.app',
      server_pid: 2000,
      server_process: 'system_server',
      start_ts: '100000000000',
      dur_ns: '5000000',
      is_reply: false,
    };

    test('upsertBinder and getBinder', () => {
      store.upsertBinder(binder1);
      const retrieved = store.getBinder('binder_100');

      expect(retrieved).toBeDefined();
      expect(retrieved?.client_process).toBe('com.example.app');
      expect(retrieved?.server_process).toBe('system_server');
    });

    test('getAllBinders returns all transactions', () => {
      store.upsertBinder(binder1);
      store.upsertBinder({
        transaction_id: 'binder_101',
        is_reply: true,
      });

      const binders = store.getAllBinders();
      expect(binders).toHaveLength(2);
    });
  });

  describe('GC Operations', () => {
    const gc1: GcEntity = {
      gc_id: 'gc_1',
      gc_type: 'young',
      gc_reason: 'Alloc',
      freed_bytes: 1024000,
      pause_time_ns: 500000,
      is_blocking: false,
      start_ts: '100000000000',
    };

    test('upsertGc and getGc', () => {
      store.upsertGc(gc1);
      const retrieved = store.getGc('gc_1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.gc_type).toBe('young');
      expect(retrieved?.freed_bytes).toBe(1024000);
    });

    test('getAllGcs returns all GC events', () => {
      store.upsertGc(gc1);
      store.upsertGc({
        gc_id: 'gc_2',
        gc_type: 'full',
        is_blocking: true,
      });

      const gcs = store.getAllGcs();
      expect(gcs).toHaveLength(2);
    });
  });

  describe('Memory Operations', () => {
    const memory1: MemoryEntity = {
      memory_id: 'mem_1',
      event_type: 'LMK_KILL',
      size_bytes: 100000000,
      oom_score: 800,
      process_name: 'com.example.background',
      ts: '100000000000',
    };

    test('upsertMemory and getMemory', () => {
      store.upsertMemory(memory1);
      const retrieved = store.getMemory('mem_1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.event_type).toBe('LMK_KILL');
      expect(retrieved?.oom_score).toBe(800);
    });

    test('getAllMemories returns all memory events', () => {
      store.upsertMemory(memory1);
      store.upsertMemory({
        memory_id: 'mem_2',
        event_type: 'OOM',
        size_bytes: 200000000,
      });

      const memories = store.getAllMemories();
      expect(memories).toHaveLength(2);
    });
  });

  describe('Generic Entity Operations', () => {
    const generic1: GenericEntity = {
      entity_id: 'custom_1',
      entity_type: 'custom_event',
      data: {
        custom_field: 'value1',
        numeric_field: 42,
      },
      start_ts: '100000000000',
    };

    test('upsertGeneric and getGeneric', () => {
      store.upsertGeneric(generic1);
      const retrieved = store.getGeneric('custom_1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.entity_type).toBe('custom_event');
      expect(retrieved?.data?.custom_field).toBe('value1');
    });

    test('getAllGenerics returns all generic entities', () => {
      store.upsertGeneric(generic1);
      store.upsertGeneric({
        entity_id: 'custom_2',
        entity_type: 'another_type',
        data: { key: 'value' },
      });

      const generics = store.getAllGenerics();
      expect(generics).toHaveLength(2);
    });
  });

  describe('Generalized Analysis Tracking', () => {
    test('markEntityAnalyzed and wasEntityAnalyzed work for all types', () => {
      // CPU Slice
      store.upsertCpuSlice({ slice_id: 'cpu_1' });
      expect(store.wasEntityAnalyzed('cpu_slice', 'cpu_1')).toBe(false);
      store.markEntityAnalyzed('cpu_slice', 'cpu_1');
      expect(store.wasEntityAnalyzed('cpu_slice', 'cpu_1')).toBe(true);

      // Binder
      store.upsertBinder({ transaction_id: 'binder_1' });
      expect(store.wasEntityAnalyzed('binder', 'binder_1')).toBe(false);
      store.markEntityAnalyzed('binder', 'binder_1');
      expect(store.wasEntityAnalyzed('binder', 'binder_1')).toBe(true);

      // GC
      store.upsertGc({ gc_id: 'gc_1' });
      expect(store.wasEntityAnalyzed('gc', 'gc_1')).toBe(false);
      store.markEntityAnalyzed('gc', 'gc_1');
      expect(store.wasEntityAnalyzed('gc', 'gc_1')).toBe(true);

      // Memory
      store.upsertMemory({ memory_id: 'mem_1' });
      expect(store.wasEntityAnalyzed('memory', 'mem_1')).toBe(false);
      store.markEntityAnalyzed('memory', 'mem_1');
      expect(store.wasEntityAnalyzed('memory', 'mem_1')).toBe(true);

      // Generic
      store.upsertGeneric({ entity_id: 'gen_1', entity_type: 'custom' });
      expect(store.wasEntityAnalyzed('generic', 'gen_1')).toBe(false);
      store.markEntityAnalyzed('generic', 'gen_1');
      expect(store.wasEntityAnalyzed('generic', 'gen_1')).toBe(true);
    });

    test('frame/session have dedicated APIs separate from generalized tracking', () => {
      // Legacy API uses dedicated storage (analyzedFrameIds/analyzedSessionIds)
      store.upsertFrame({ frame_id: '1' });
      store.markFrameAnalyzed('1');
      expect(store.wasFrameAnalyzed('1')).toBe(true);

      // Generalized API uses separate storage (analyzedEntityIds map)
      store.markEntityAnalyzed('frame', '2');
      expect(store.wasEntityAnalyzed('frame', '2')).toBe(true);

      // These are separate tracking mechanisms
      expect(store.wasFrameAnalyzed('2')).toBe(false); // Not in legacy storage
      expect(store.wasEntityAnalyzed('frame', '1')).toBe(false); // Not in generalized storage

      // Same for sessions
      store.upsertSession({ session_id: '1' });
      store.markSessionAnalyzed('1');
      expect(store.wasSessionAnalyzed('1')).toBe(true);

      store.markEntityAnalyzed('session', '2');
      expect(store.wasEntityAnalyzed('session', '2')).toBe(true);
      expect(store.wasSessionAnalyzed('2')).toBe(false);
    });
  });

  describe('Extended Statistics', () => {
    test('getStats returns counts for all entity types', () => {
      store.upsertFrame({ frame_id: '1' });
      store.upsertFrame({ frame_id: '2' });
      store.upsertSession({ session_id: '1' });
      store.upsertCpuSlice({ slice_id: 'cpu_1' });
      store.upsertCpuSlice({ slice_id: 'cpu_2' });
      store.upsertCpuSlice({ slice_id: 'cpu_3' });
      store.upsertBinder({ transaction_id: 'binder_1' });
      store.upsertGc({ gc_id: 'gc_1' });
      store.upsertGc({ gc_id: 'gc_2' });
      store.upsertMemory({ memory_id: 'mem_1' });
      store.upsertGeneric({ entity_id: 'gen_1', entity_type: 'custom' });

      store.markFrameAnalyzed('1');
      store.markEntityAnalyzed('cpu_slice', 'cpu_1');
      store.markEntityAnalyzed('binder', 'binder_1');

      const stats = store.getStats();
      expect(stats.frameCount).toBe(2);
      expect(stats.sessionCount).toBe(1);
      expect(stats.cpuSliceCount).toBe(3);
      expect(stats.binderCount).toBe(1);
      expect(stats.gcCount).toBe(2);
      expect(stats.memoryCount).toBe(1);
      expect(stats.genericCount).toBe(1);
      expect(stats.analyzedFrameCount).toBe(1);
      expect(stats.totalEntityCount).toBe(11); // 2+1+3+1+2+1+1
    });
  });

  describe('Extended Serialization', () => {
    test('serialize and deserialize preserves all entity types', () => {
      // Set up state with all entity types
      store.upsertFrame({ frame_id: '1', start_ts: '100' });
      store.upsertSession({ session_id: '1', frame_count: 50 });
      store.upsertCpuSlice({ slice_id: 'cpu_1', thread_name: 'RenderThread' });
      store.upsertBinder({ transaction_id: 'binder_1', server_process: 'system_server' });
      store.upsertGc({ gc_id: 'gc_1', gc_type: 'young' });
      store.upsertMemory({ memory_id: 'mem_1', event_type: 'LMK' });
      store.upsertGeneric({ entity_id: 'gen_1', entity_type: 'custom', data: { key: 'value' } });

      store.markFrameAnalyzed('1');
      store.markEntityAnalyzed('cpu_slice', 'cpu_1');
      store.markEntityAnalyzed('gc', 'gc_1');

      // Serialize
      const snapshot = store.serialize();
      expect(snapshot.version).toBe(1); // Current version

      // Deserialize
      const restored = EntityStore.deserialize(snapshot);

      // Verify all entity types
      expect(restored.getFrame('1')?.start_ts).toBe('100');
      expect(restored.getSession('1')?.frame_count).toBe(50);
      expect(restored.getCpuSlice('cpu_1')?.thread_name).toBe('RenderThread');
      expect(restored.getBinder('binder_1')?.server_process).toBe('system_server');
      expect(restored.getGc('gc_1')?.gc_type).toBe('young');
      expect(restored.getMemory('mem_1')?.event_type).toBe('LMK');
      expect(restored.getGeneric('gen_1')?.data?.key).toBe('value');

      // Verify analysis state
      expect(restored.wasFrameAnalyzed('1')).toBe(true);
      expect(restored.wasEntityAnalyzed('cpu_slice', 'cpu_1')).toBe(true);
      expect(restored.wasEntityAnalyzed('gc', 'gc_1')).toBe(true);
      expect(restored.wasEntityAnalyzed('binder', 'binder_1')).toBe(false);
    });

    test('deserialize v1 snapshot is backward compatible', () => {
      // Simulate v1 snapshot (no new entity types)
      const v1Snapshot: EntityStoreSnapshot = {
        version: 1,
        framesById: [['1', { frame_id: '1', start_ts: '100' }]],
        sessionsById: [['1', { session_id: '1' }]],
        analyzedFrameIds: ['1'],
        analyzedSessionIds: [],
        lastCandidateFrameIds: ['1', '2'],
        lastCandidateSessionIds: [],
      };

      const restored = EntityStore.deserialize(v1Snapshot);

      // Old data preserved
      expect(restored.getFrame('1')?.start_ts).toBe('100');
      expect(restored.wasFrameAnalyzed('1')).toBe(true);

      // New entity types should be empty but functional
      expect(restored.getAllCpuSlices()).toHaveLength(0);
      expect(restored.getAllBinders()).toHaveLength(0);
      expect(restored.getAllGcs()).toHaveLength(0);
      expect(restored.getAllMemories()).toHaveLength(0);
      expect(restored.getAllGenerics()).toHaveLength(0);
    });
  });

  describe('Extended Clear', () => {
    test('clear removes all entity types', () => {
      store.upsertFrame({ frame_id: '1' });
      store.upsertSession({ session_id: '1' });
      store.upsertCpuSlice({ slice_id: 'cpu_1' });
      store.upsertBinder({ transaction_id: 'binder_1' });
      store.upsertGc({ gc_id: 'gc_1' });
      store.upsertMemory({ memory_id: 'mem_1' });
      store.upsertGeneric({ entity_id: 'gen_1', entity_type: 'custom' });

      store.markEntityAnalyzed('cpu_slice', 'cpu_1');
      store.markEntityAnalyzed('binder', 'binder_1');

      store.clear();

      expect(store.getAllFrames()).toHaveLength(0);
      expect(store.getAllSessions()).toHaveLength(0);
      expect(store.getAllCpuSlices()).toHaveLength(0);
      expect(store.getAllBinders()).toHaveLength(0);
      expect(store.getAllGcs()).toHaveLength(0);
      expect(store.getAllMemories()).toHaveLength(0);
      expect(store.getAllGenerics()).toHaveLength(0);
      expect(store.wasEntityAnalyzed('cpu_slice', 'cpu_1')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('handles null/undefined frame_id gracefully', () => {
      // @ts-ignore - intentionally testing edge case
      store.upsertFrame({ frame_id: null });
      // @ts-ignore
      store.upsertFrame({ frame_id: undefined });

      expect(store.getAllFrames()).toHaveLength(0);
    });

    test('handles BigInt-like string IDs', () => {
      const bigId = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
      store.upsertFrame({ frame_id: bigId, start_ts: '100' });

      const retrieved = store.getFrame(bigId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.frame_id).toBe(bigId);
    });
  });
});
