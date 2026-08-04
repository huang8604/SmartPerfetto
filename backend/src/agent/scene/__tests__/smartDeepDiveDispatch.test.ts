// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { buildSmartDeepDiveDispatch } from '../smartDeepDiveDispatch';
import type { DisplayedScene, SceneReport } from '../types';

function scene(overrides: Partial<DisplayedScene>): DisplayedScene {
  return {
    id: overrides.id ?? 'scene-0',
    sceneType: overrides.sceneType ?? 'scroll',
    sourceStepId: overrides.sourceStepId ?? 'user_gestures',
    startTs: overrides.startTs ?? '1000000000',
    endTs: overrides.endTs ?? '2000000000',
    durationMs: overrides.durationMs ?? 1000,
    processName: overrides.processName ?? 'com.example.app',
    label: overrides.label ?? '滑动',
    metadata: overrides.metadata ?? {},
    severity: overrides.severity ?? 'good',
    sceneRole: overrides.sceneRole,
    analysisEligible: overrides.analysisEligible,
    confidenceScore: overrides.confidenceScore,
    parentSceneId: overrides.parentSceneId,
    childSceneIds: overrides.childSceneIds,
    analysisState: overrides.analysisState ?? 'not_planned',
  };
}

function report(scenes: DisplayedScene[]): SceneReport {
  return {
    reportId: 'report-1',
    tenantId: 'default',
    workspaceId: 'default',
    traceHash: null,
    traceId: 'trace-1',
    traceOrigin: 'external_rpc',
    cachePolicy: 'memory_session',
    expiresAt: null,
    createdAt: Date.now(),
    traceMeta: {
      durationSec: 10,
    },
    displayedScenes: scenes,
    cachedDataEnvelopes: [],
    jobs: [],
    summary: null,
    insights: [],
    partialReport: false,
    totalDurationMs: 0,
    generatedBy: {
      runtime: 'legacy',
      pipelineVersion: 'v2',
    },
  };
}

describe('buildSmartDeepDiveDispatch', () => {
  it('maps selected scroll scenes to the normal scrolling analysis entry', () => {
    const dispatch = buildSmartDeepDiveDispatch({
      report: report([
        scene({ id: 'scroll-0', sceneType: 'scroll', startTs: '1000000000', endTs: '2500000000' }),
        scene({ id: 'inertial-0', sceneType: 'inertial_scroll', startTs: '2600000000', endTs: '4000000000' }),
        scene({ id: 'idle-0', sceneType: 'idle', processName: 'system' }),
      ]),
      selection: { scope: 'scene_types', sceneTypes: ['scroll', 'inertial_scroll'], label: '滑动' },
    });

    expect(dispatch?.query).toBe('分析滑动性能（智能分析已选中 2 个场景）');
    expect(dispatch?.packageName).toBe('com.example.app');
    expect(dispatch?.selectedScenes.map((item) => item.id)).toEqual(['scroll-0', 'inertial-0']);
    expect(dispatch?.selectionContext).toMatchObject({
      kind: 'area',
      startNs: 1000000000,
      endNs: 4000000000,
      durationNs: 3000000000,
    });
    expect(dispatch?.traceContext?.[0].rows).toHaveLength(2);
  });

  it('maps startup scenes to the startup analysis entry', () => {
    const dispatch = buildSmartDeepDiveDispatch({
      report: report([
        scene({ id: 'startup-0', sceneType: 'cold_start', label: '冷启动' }),
        scene({ id: 'scroll-0', sceneType: 'scroll' }),
      ]),
      selection: { scope: 'scene_types', sceneTypes: ['cold_start', 'warm_start', 'hot_start'], label: '启动' },
    });

    expect(dispatch?.query).toBe('分析启动性能（智能分析已选中 1 个场景）');
    expect(dispatch?.selectedScenes.map((item) => item.id)).toEqual(['startup-0']);
  });

  it('returns null when the requested selection has no matching scenes', () => {
    const dispatch = buildSmartDeepDiveDispatch({
      report: report([scene({ id: 'scroll-0', sceneType: 'scroll' })]),
      selection: { scope: 'scene_types', sceneTypes: ['tap'], label: '点击' },
    });

    expect(dispatch).toBeNull();
  });

  it('does not send marker or context scenes into smart deep-dive dispatch', () => {
    const dispatch = buildSmartDeepDiveDispatch({
      report: report([
        scene({ id: 'scroll-0', sceneType: 'scroll' }),
        scene({
          id: 'scroll-start-0',
          sceneType: 'scroll_start',
          durationMs: 0,
          sceneRole: 'marker',
          analysisEligible: false,
          parentSceneId: 'scroll-0',
        }),
        scene({
          id: 'idle-0',
          sceneType: 'idle',
          processName: 'system',
          sceneRole: 'context',
          analysisEligible: false,
        }),
      ]),
      selection: { scope: 'all', label: '全部场景' },
    });

    expect(dispatch?.selectedScenes.map((item) => item.id)).toEqual(['scroll-0']);
    expect(dispatch?.query).toBe('按场景时间线分析这个 trace 的性能问题（智能分析已选中 1 个场景）');
    expect(dispatch?.traceContext?.[0].rows).toHaveLength(1);
  });

  it('projects English dispatch text and scene labels without cached Chinese labels', () => {
    const dispatch = buildSmartDeepDiveDispatch({
      report: report([scene({id: 'scroll-0', sceneType: 'scroll', label: '滑动浏览 (1000ms)'})]),
      selection: {scope: 'scene_types', sceneTypes: ['scroll'], label: '滑动'},
      outputLanguage: 'en',
    });

    expect(dispatch?.query).toBe(
      'Analyze scrolling performance (1 Smart Analysis scenes selected)',
    );
    expect(dispatch?.traceContext?.[0].label).toBe(
      'Smart Analysis selected scene timeline',
    );
    expect(dispatch?.traceContext?.[0].rows[0][2]).toBe('Scroll');
    expect(JSON.stringify(dispatch)).not.toMatch(/[\u4e00-\u9fff]/u);
  });
});
