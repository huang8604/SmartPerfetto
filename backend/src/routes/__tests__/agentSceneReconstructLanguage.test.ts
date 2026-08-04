// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {SceneReport} from '../../agent/scene/types';
import {
  normalizeSceneOutputLanguage,
  projectSceneStoryStatusResult,
} from '../agentSceneReconstructRoutes';

describe('scene reconstruction language boundary', () => {
  it.each([
    ['en', 'en'],
    ['zh-CN', 'zh-CN'],
    [undefined, 'zh-CN'],
  ])('normalizes canonical language %p', (input, expected) => {
    expect(normalizeSceneOutputLanguage(input)).toBe(expected);
  });

  it.each(['EN', 'zh', 'english', [], {}])('rejects non-canonical language %p', (input) => {
    expect(normalizeSceneOutputLanguage(input)).toBeNull();
  });

  it('projects the polling status summary into the session output language', () => {
    const report = {
      reportId: 'report-en',
      traceHash: null,
      traceId: 'trace-1',
      traceOrigin: 'external_rpc',
      cachePolicy: 'memory_session',
      expiresAt: null,
      createdAt: 1,
      phase: 'analyzed',
      traceMeta: {durationSec: 1},
      displayedScenes: [{
        id: 'scene-1',
        sceneType: 'cold_start',
        sourceStepId: 'scene_reconstruction',
        startTs: '0',
        endTs: '1000000',
        durationMs: 1,
        label: '冷启动 (1ms)',
        metadata: {},
        severity: 'good',
        analysisState: 'completed',
      }],
      cachedDataEnvelopes: [],
      jobs: [],
      summary: '中文跨场景总结',
      insights: [],
      partialReport: false,
      totalDurationMs: 25,
      generatedBy: {runtime: 'claude-sdk', pipelineVersion: 'v2'},
    } satisfies SceneReport;

    const result = projectSceneStoryStatusResult(report, 'en');

    expect(result.summary).toBe('Scene analysis completed for 1 scene.');
    expect(result.scenesCount).toBe(1);
    expect(result.reportId).toBe('report-en');
  });
});
