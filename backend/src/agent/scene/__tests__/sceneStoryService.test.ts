// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Focused unit tests for SceneStoryService — covers the new PR2 public
 * surface (previewOnly / getReport) and the cache-hit replay path that
 * short-circuits Stage 1-3.
 *
 * The full cold-path pipeline (Stage 1 + JobRunner + Stage 3) is exercised
 * by the existing scene-trace-regression suite, so these tests deliberately
 * stub the deps that would otherwise require a real SkillExecutor and
 * trace_processor instance.
 */

import {
  SceneStoryService,
  projectSceneReport,
  type SceneStoryServiceDeps,
  type SceneStorySession,
} from '../sceneStoryService';
import { SceneReportMemoryCache } from '../../../services/sceneReport/sceneReportMemoryCache';
import type { SceneReportStore } from '../../../services/sceneReport/sceneReportStore';
import type { SceneJobArtifactStore } from '../../../services/sceneReport/sceneJobArtifactStore';
import type { SceneRouteProfile } from '../../config/domainManifest';
import type { SceneReport } from '../types';
import type { StreamingUpdate } from '../../types';
import type { DataEnvelope } from '../../../types/dataContract';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReport(opts: { reportId?: string; hash?: string | null } = {}): SceneReport {
  return {
    reportId: opts.reportId ?? 'rpt-1',
    traceHash: opts.hash ?? 'h-cached',
    traceId: 'trace-cached',
    traceOrigin: opts.hash === null ? 'external_rpc' : 'file',
    cachePolicy: opts.hash === null ? 'memory_session' : 'disk_7d',
    expiresAt: opts.hash === null ? null : Date.now() + 60_000,
    createdAt: Date.now() - 1_000,
    traceMeta: { durationSec: 42 },
    displayedScenes: [
      {
        id: 'scene-1',
        sceneType: 'scroll',
        sourceStepId: 'inertial_scrolls',
        startTs: '0',
        endTs: '1000000000',
        durationMs: 1000,
        label: 'scroll (1000ms)',
        metadata: {},
        severity: 'warning',
        analysisState: 'completed',
      },
    ],
    cachedDataEnvelopes: [
      { meta: { type: 'skill_result' }, data: { rows: [] }, display: { layer: 'L1', format: 'table', title: 'state' } },
      { meta: { type: 'skill_result' }, data: { rows: [] }, display: { layer: 'L1', format: 'table', title: 'overlay' } },
    ] as unknown as DataEnvelope[],
    jobs: [],
    summary: '整体叙述测试',
    insights: [],
    partialReport: false,
    totalDurationMs: 1500,
    generatedBy: { runtime: 'claude-sdk', pipelineVersion: 'v2' },
  };
}

function makeSession(): SceneStorySession {
  return {
    sessionId: 'sess-1',
    status: 'pending',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    scenes: [],
    trackEvents: [],
  };
}

function envelope(
  stepId: string,
  rows: Array<Record<string, any>>,
): DataEnvelope {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    meta: {
      type: 'list',
      version: '2.0',
      source: 'test',
      skillId: 'scene_reconstruction',
      stepId,
    },
    data: {
      columns,
      rows: rows.map((row) => columns.map((c) => row[c])),
    },
    display: {
      layer: 'list',
      format: 'table',
      title: stepId,
    },
  } as unknown as DataEnvelope;
}

interface FakeReportStore extends SceneReportStore {
  saveCalls: SceneReport[];
  saveOptionCalls: Array<{ indexByHash?: boolean } | undefined>;
}

function makeFakeStore(opts: {
  reportByHash?: Record<string, SceneReport>;
  reportById?: Record<string, SceneReport>;
} = {}): FakeReportStore {
  const saveCalls: SceneReport[] = [];
  const saveOptionCalls: Array<{ indexByHash?: boolean } | undefined> = [];
  return {
    saveCalls,
    saveOptionCalls,
    save: jest.fn(async (report: SceneReport, _routeProfile?: SceneRouteProfile, saveOptions?: { indexByHash?: boolean }) => {
      saveCalls.push(report);
      saveOptionCalls.push(saveOptions);
    }),
    loadById: jest.fn(async (id: string) => opts.reportById?.[id] ?? null),
    loadByHash: jest.fn(async (hash: string, routeProfile: SceneRouteProfile = 'legacy') =>
      opts.reportByHash?.[`${hash}::${routeProfile}`] ?? opts.reportByHash?.[hash] ?? null,
    ),
    delete: jest.fn(async () => false),
    cleanupExpired: jest.fn(async () => 0),
  };
}

interface BuiltService {
  service: SceneStoryService;
  events: Array<{ sessionId: string; update: StreamingUpdate }>;
  store: FakeReportStore;
  memoryCache: SceneReportMemoryCache;
  session: SceneStorySession;
  computeHash: jest.Mock;
  probeDuration: jest.Mock;
}

function buildService(opts: {
  reportByHash?: Record<string, SceneReport>;
  reportById?: Record<string, SceneReport>;
  computeHashReturn?: string | null;
  probeDurationReturn?: number;
  prePopulateMemoryCache?: { traceId: string; report: SceneReport; routeProfile?: SceneRouteProfile };
  jobArtifactStore?: SceneJobArtifactStore;
  toEnvelopes?: (result: any, traceId: string) => DataEnvelope[];
} = {}): BuiltService {
  const events: Array<{ sessionId: string; update: StreamingUpdate }> = [];
  const session = makeSession();

  const store = makeFakeStore({
    reportByHash: opts.reportByHash,
    reportById: opts.reportById,
  });
  const memoryCache = new SceneReportMemoryCache(10);
  if (opts.prePopulateMemoryCache) {
    memoryCache.set(
      opts.prePopulateMemoryCache.traceId,
      opts.prePopulateMemoryCache.report,
      opts.prePopulateMemoryCache.routeProfile ?? 'legacy',
    );
  }

  const computeHash = jest.fn(async () => opts.computeHashReturn ?? null);
  const probeDuration = jest.fn(async () => opts.probeDurationReturn ?? 0);

  const deps: SceneStoryServiceDeps = {
    broadcast: (sessionId, update) => events.push({ sessionId, update }),
    getSession: (id) => (id === session.sessionId ? session : undefined),
    toEnvelopes: opts.toEnvelopes ?? (() => []),
    reportStore: store,
    memoryCache,
    jobArtifactStore: opts.jobArtifactStore,
    computeHash,
    probeDuration,
  };

  return {
    service: new SceneStoryService(deps),
    events,
    store,
    memoryCache,
    session,
    computeHash,
    probeDuration,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SceneStoryService', () => {
  // -------------------------------------------------------------------------
  // Cache hit — disk store by content hash
  // -------------------------------------------------------------------------

  describe('start() — disk cache hit', () => {
    it('emits the cached SSE sequence and skips Stage 1-3 entirely', async () => {
      const cached = makeReport({ reportId: 'rpt-disk', hash: 'sha-disk' });
      const built = buildService({
        reportByHash: { 'sha-disk': cached },
        computeHashReturn: 'sha-disk',
      });

      // SkillExecutor stub that throws if anything actually calls into it.
      // Verifies the cache hit path never touches Stage 1.
      const skillExecutor = {
        execute: jest.fn(() => {
          throw new Error('Stage 1 must NOT run on cache hit');
        }),
      } as any;

      await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'trace-cached',
        skillExecutor,
      });

      // computeHash was consulted; loadByHash returned the cached report.
      expect(built.computeHash).toHaveBeenCalledWith('trace-cached');
      expect(built.store.loadByHash).toHaveBeenCalledWith('sha-disk', 'legacy');
      expect(skillExecutor.execute).not.toHaveBeenCalled();

      // Session state mirrors a completed run.
      expect(built.session.status).toBe('completed');
      expect(built.session.sceneStoryReport).toBe(cached);

      // Expected event sequence:
      //   progress(cached) → data×2 (envelopes) → scene_story_detected
      //   → track_data → scene_story_report_ready → progress(completed)
      const types = built.events.map((e) => e.update.type);
      expect(types).toEqual([
        'progress',
        'data',
        'data',
        'scene_story_detected',
        'track_data',
        'scene_story_report_ready',
        'progress',
      ]);

      const cachedProgress = built.events[0].update;
      expect((cachedProgress.content as any).phase).toBe('cached');

      const reportReady = built.events.find(
        (e) => e.update.type === 'scene_story_report_ready',
      );
      expect((reportReady?.update.content as any).cached).toBe(true);
      expect((reportReady?.update.content as any).reportId).toBe('rpt-disk');
    });

    it('uses the requested route profile for disk cache lookup', async () => {
      const smartCached = makeReport({ reportId: 'rpt-smart', hash: 'sha-shared' });
      const built = buildService({
        reportByHash: { 'sha-shared::smart': smartCached },
        computeHashReturn: 'sha-shared',
      });

      await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'trace-cached',
        skillExecutor: { execute: jest.fn() } as any,
        options: { routeProfile: 'smart' },
      });

      expect(built.store.loadByHash).toHaveBeenCalledWith('sha-shared', 'smart');
      expect(built.session.sceneStoryReport).toBe(smartCached);
    });
  });

  // -------------------------------------------------------------------------
  // Cache hit — memory cache by traceId (RPC trace, no hash)
  // -------------------------------------------------------------------------

  describe('start() — memory cache hit', () => {
    it('falls through to memory cache when computeHash returns null', async () => {
      const cached = makeReport({ reportId: 'rpt-mem', hash: null });
      const built = buildService({
        computeHashReturn: null,
        prePopulateMemoryCache: { traceId: 'rpc-trace-1', report: cached },
      });

      const skillExecutor = {
        execute: jest.fn(() => {
          throw new Error('Stage 1 must NOT run on cache hit');
        }),
      } as any;

      await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'rpc-trace-1',
        skillExecutor,
      });

      expect(built.session.sceneStoryReport).toBe(cached);
      expect(built.store.loadByHash).not.toHaveBeenCalled();
      expect(skillExecutor.execute).not.toHaveBeenCalled();

      const reportReady = built.events.find(
        (e) => e.update.type === 'scene_story_report_ready',
      );
      expect((reportReady?.update.content as any).reportId).toBe('rpt-mem');
    });

    it('uses the requested route profile for memory cache lookup', async () => {
      const smartCached = makeReport({ reportId: 'rpt-mem-smart', hash: null });
      const built = buildService({
        computeHashReturn: null,
        prePopulateMemoryCache: {
          traceId: 'rpc-trace-1',
          report: smartCached,
          routeProfile: 'smart',
        },
      });

      await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'rpc-trace-1',
        skillExecutor: { execute: jest.fn() } as any,
        options: { routeProfile: 'smart' },
      });

      expect(built.session.sceneStoryReport).toBe(smartCached);
    });

    it('falls through to cold path when memory cache misses', async () => {
      // No pre-population; expect emitCachedReport NOT to fire — but cold
      // path isn't exercised here because we don't supply a SkillExecutor
      // that succeeds. We only verify the cache check side-effects.
      const built = buildService({ computeHashReturn: null });
      const skillExecutor = {
        execute: jest.fn(async () => {
          throw new Error('cold path stub');
        }),
      } as any;

      await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'rpc-trace-cold',
        skillExecutor,
      }).catch(() => undefined); // pipeline will fail at Stage 1 — that's fine

      // No cache hit emitted — first event should be the detecting progress.
      const firstEvent = built.events[0]?.update;
      expect((firstEvent?.content as any)?.phase).toBe('detecting');
    });
  });

  describe('start() — smart scene selection gate', () => {
    it('stops after Stage 1 in previewOnly mode and does not persist a hash cache entry', async () => {
      const built = buildService({
        computeHashReturn: 'sha-preview',
        toEnvelopes: () => [
          envelope('trace_time_range', [{ duration_sec: 12 }]),
          envelope('app_launches', [
            { ts: '0', dur: '1500000000', startup_type: 'cold', package: 'com.app', startup_id: 1 },
          ]),
          envelope('user_gestures', [
            { ts: '2000000000', dur: '500000000', gesture_type: 'scroll', app_package: 'com.app' },
          ]),
        ],
      });
      const skillExecutor = {
        execute: jest.fn(async () => ({ success: true })),
      } as any;

      const report = await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'trace-preview',
        skillExecutor,
        options: {
          routeProfile: 'smart',
          previewOnly: true,
        },
      });

      expect(report?.displayedScenes.map(scene => scene.sceneType)).toEqual(['cold_start', 'scroll']);
      expect(report?.jobs).toEqual([]);
      expect(report?.sceneVerification?.status).toBe('passed');
      expect(built.store.loadByHash).not.toHaveBeenCalled();
      expect(built.store.save).not.toHaveBeenCalled();
      expect(built.events.map((e) => e.update.type)).toContain('scene_story_selection_ready');
      expect(built.events.map((e) => e.update.type)).not.toContain('scene_story_report_ready');
      const detected = built.events.find((e) => e.update.type === 'scene_story_detected');
      expect((detected?.update.content as any).sceneVerification?.checkedSceneCount).toBe(2);
      const selectionReady = built.events.find((e) => e.update.type === 'scene_story_selection_ready');
      expect((selectionReady?.update.content as any).candidateIntervalCount).toBe(2);
      expect((selectionReady?.update.content as any).reportId).toBe(report?.reportId);
      expect((selectionReady?.update.content as any).sceneVerification?.status).toBe('passed');
    });

    it('does not index selected-scope reports by trace hash', async () => {
      const built = buildService({
        computeHashReturn: 'sha-selected',
        toEnvelopes: () => [
          envelope('user_gestures', [
            { ts: '0', dur: '500000000', gesture_type: 'scroll', app_package: 'com.app' },
          ]),
        ],
      });
      const skillExecutor = {
        execute: jest.fn(async () => ({ success: true })),
      } as any;

      const report = await built.service.start({
        sessionId: built.session.sessionId,
        traceId: 'trace-selected',
        skillExecutor,
        options: {
          routeProfile: 'smart',
          selection: {
            scope: 'scene_types',
            sceneTypes: ['tap'],
            label: '点击',
          },
        },
      });

      expect(report?.displayedScenes.map(scene => scene.analysisState)).toEqual(['not_planned']);
      expect(report?.jobs).toEqual([]);
      expect(built.store.loadByHash).not.toHaveBeenCalled();
      expect(built.store.save).toHaveBeenCalledTimes(1);
      expect(built.store.saveOptionCalls[0]).toEqual({ indexByHash: false });
      expect(built.events.map((e) => e.update.type)).toContain('scene_story_report_ready');
    });
  });

  // -------------------------------------------------------------------------
  // previewOnly
  // -------------------------------------------------------------------------

  describe('previewOnly', () => {
    it('returns the cached report when the disk cache hits', async () => {
      const cached = makeReport({ reportId: 'rpt-prev', hash: 'sha-prev' });
      const built = buildService({
        reportByHash: { 'sha-prev': cached },
        computeHashReturn: 'sha-prev',
      });

      const result = await built.service.previewOnly({ traceId: 't-prev' });
      expect(result.cached).toBe(cached);
      expect(result.traceDurationSec).toBe(42); // from cached.traceMeta
      expect(result.estimate.confidence).toBe('low');
      // probeDuration runs in parallel with computeHash (P0 optimisation) —
      // its result is discarded on cache hit but the call still fires.
      expect(built.probeDuration).toHaveBeenCalled();
    });

    it('returns the memory-cached report when there is no hash', async () => {
      const cached = makeReport({ reportId: 'rpt-mem', hash: null });
      const built = buildService({
        computeHashReturn: null,
        prePopulateMemoryCache: { traceId: 't-prev-mem', report: cached },
      });

      const result = await built.service.previewOnly({ traceId: 't-prev-mem' });
      expect(result.cached).toBe(cached);
      expect(built.probeDuration).toHaveBeenCalled();
    });

    it('falls through to probe + estimate when no cache hit', async () => {
      const built = buildService({
        computeHashReturn: 'sha-cold',
        // store has no entry for this hash
        probeDurationReturn: 100,
      });

      const result = await built.service.previewOnly({ traceId: 't-cold' });
      expect(result.cached).toBeNull();
      expect(result.traceDurationSec).toBe(100);
      // 100s → 10 scenes → 8 + ceil(10/3)*30 + 5 = 8 + 120 + 5 = 133s
      expect(result.estimate.expectedScenes).toBe(10);
      expect(result.estimate.etaSec).toBe(133);
      expect(built.probeDuration).toHaveBeenCalledWith('t-cold');
    });
  });

  // -------------------------------------------------------------------------
  // getReport
  // -------------------------------------------------------------------------

  describe('finalize() — smart job artifacts', () => {
    it('stores omitted smart job rows out-of-band before report persistence', async () => {
      const artifactStore: SceneJobArtifactStore = {
        save: jest.fn(async () => ({
          artifactId: 'scene-job-sess-1-job-0-abc123',
          artifactType: 'scene_job_envelopes' as const,
          sizeBytes: 123,
          checksum: 'abc123',
        })),
      };
      const built = buildService({
        computeHashReturn: 'sha-smart',
        jobArtifactStore: artifactStore,
      });

      const job = {
        jobId: 'sess-1-job-0',
        analysisId: 'sess-1',
        interval: {
          displayedSceneId: 'scene-1',
          priority: 90,
          routeRuleId: 'smart_scroll_scene',
          skillId: 'scrolling_analysis',
          params: {},
        },
        attempt: 0,
        state: 'completed',
        result: {
          jobId: 'sess-1-job-0',
          displayedSceneId: 'scene-1',
          skillId: 'scrolling_analysis',
          displayResults: [{ frame: 1 }, { frame: 2 }, { frame: 3 }, { frame: 4 }],
          dataEnvelopes: [{ meta: { type: 'skill_result' } }],
          projection: {
            sceneId: 'scene-1',
            skillId: 'scrolling_analysis',
            routeId: 'smart_scroll_scene',
            metrics: { display_result_count: 4 },
            evidenceRefs: ['data:scene_job:sess-1-job-0'],
            topRowsSample: [{ frame: 1 }, { frame: 2 }, { frame: 3 }],
            omittedRowCount: 1,
          },
          durationMs: 20,
        },
      };

      await (built.service as any).finalize({
        sessionId: built.session.sessionId,
        traceId: 'trace-smart',
        session: built.session,
        scenes: makeReport().displayedScenes,
        jobs: [job],
        summary: 'summary',
        cancelled: false,
        traceDurationSec: 42,
        traceHash: 'sha-smart',
        stage1Envelopes: [],
        routeProfile: 'smart',
        cacheableByHash: true,
      });

      expect(artifactStore.save).toHaveBeenCalledWith(expect.objectContaining({
        traceId: 'trace-smart',
        jobId: 'sess-1-job-0',
        displayResults: job.result.displayResults,
      }));
      const persistedJob = built.store.saveCalls[0].jobs[0];
      expect(persistedJob.result?.displayResults).toEqual([]);
      expect(persistedJob.result?.dataEnvelopes).toEqual([]);
      expect(persistedJob.result?.projection?.artifactRef).toEqual({
        artifactId: 'scene-job-sess-1-job-0-abc123',
        artifactType: 'scene_job_envelopes',
        sizeBytes: 123,
        checksum: 'abc123',
      });
    });
  });

  describe('getReport', () => {
    it('delegates to reportStore.loadById', async () => {
      const stored = makeReport({ reportId: 'rpt-get', hash: 'sha-get' });
      const built = buildService({
        reportById: { 'rpt-get': stored },
      });

      expect(await built.service.getReport('rpt-get')).toBe(stored);
      expect(await built.service.getReport('rpt-missing')).toBeNull();
      expect(built.store.loadById).toHaveBeenCalledWith('rpt-get');
    });

    it('projects a cached core report into English without mutating it', () => {
      const stored = makeReport({ reportId: 'rpt-en', hash: 'sha-en' });
      const bilingualStored = {
        ...stored,
        insights: [{
          title: 'scene_story_summary',
          body: stored.summary ?? '',
          relatedDisplayedSceneIds: ['scene-1'],
        }],
        summaries: {
          'zh-CN': stored.summary ?? '',
          en: 'The user scrolled and encountered visible jank.',
        },
      };

      const projected = projectSceneReport(bilingualStored, 'en');

      expect(projected.summary).toBe(
        'The user scrolled and encountered visible jank.',
      );
      expect(projected.insights.find(item => item.title === 'scene_story_summary')?.body)
        .toBe('The user scrolled and encountered visible jank.');
      expect(projected.displayedScenes[0].label).toBe('Scroll (1000ms)');
      expect(stored.summary).toBe('整体叙述测试');
      expect(stored.displayedScenes[0].label).toBe('scroll (1000ms)');
    });
  });
});
