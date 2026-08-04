// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  buildSmartChatReport,
  buildSmartSceneSelectionReport,
} from '../buildSmartChatReport';
import type {SceneReport} from '../types';

function makeReport(): SceneReport {
  return {
    reportId: 'smart-report-i18n',
    traceHash: 'trace-hash',
    traceId: 'trace-i18n',
    traceOrigin: 'file',
    cachePolicy: 'disk_7d',
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    traceMeta: {durationSec: 2},
    displayedScenes: [{
      id: 'scene-scroll',
      sceneType: 'scroll',
      sourceStepId: 'inertial_scrolls',
      startTs: '0',
      endTs: '1000000000',
      durationMs: 1000,
      label: 'scroll',
      metadata: {event: 'scroll'},
      severity: 'warning',
      sceneRole: 'action',
      analysisEligible: true,
      analysisState: 'completed',
    }],
    sceneVerification: {
      status: 'passed',
      verifier: 'deterministic',
      summary: '场景还原复核通过：1 个场景，1 个可深钻。',
      checkedSceneCount: 1,
      lowConfidenceSceneIds: [],
      conflictSceneIds: [],
      issues: [],
    },
    cachedDataEnvelopes: [],
    jobs: [{
      jobId: 'job-scroll',
      analysisId: 'analysis-i18n',
      interval: {
        displayedSceneId: 'scene-scroll',
        priority: 75,
        routeRuleId: 'scroll-route',
        skillId: 'scrolling_analysis',
        params: {},
      },
      attempt: 0,
      state: 'completed',
      result: {
        jobId: 'job-scroll',
        displayedSceneId: 'scene-scroll',
        skillId: 'scrolling_analysis',
        displayResults: [],
        dataEnvelopes: [],
        durationMs: 25,
        projection: {
          sceneId: 'scene-scroll',
          skillId: 'scrolling_analysis',
          routeId: 'scroll-route',
          metrics: {display_result_count: 1},
          evidenceRefs: ['data:scene_job:job-scroll'],
          topRowsSample: [],
          omittedRowCount: 0,
        },
      },
    }],
    summary: '中文模型叙事不应泄漏到英文投影。',
    insights: [],
    partialReport: false,
    totalDurationMs: 25,
    generatedBy: {runtime: 'claude-sdk', pipelineVersion: 'v2'},
    summaries: {
      'zh-CN': '用户先打开应用，随后滑动查看内容。',
      en: 'The user opened the app and then scrolled through the content.',
    },
  };
}

describe('smart chat report output language', () => {
  it('renders the selection preview and contract in English', () => {
    const result = buildSmartSceneSelectionReport({
      sessionId: 'session-i18n',
      report: makeReport(),
      outputLanguage: 'en',
    });

    expect(result.conclusion).toContain('# Smart Analysis Report: Scene Inventory');
    expect(result.conclusion).toContain('Scroll: 1');
    expect(result.conclusion).toContain('## Next Step');
    expect(result.conclusion).not.toMatch(/[\u4e00-\u9fff]/);
    expect(result.conclusionContract?.conclusions[0].statement)
      .toContain('select a deep-dive scope');
    expect(result.conclusionContract?.nextSteps[0]).toContain('Choose “All”');
  });

  it('renders the completed smart report, findings, and contract in English', () => {
    const result = buildSmartChatReport({
      sessionId: 'session-i18n',
      report: makeReport(),
      outputLanguage: 'en',
    });

    expect(result.conclusion).toContain('# Smart Analysis Report');
    expect(result.conclusion).toContain('## Per-Scene Summary');
    expect(result.conclusion).toContain(
      'The user opened the app and then scrolled through the content.',
    );
    expect(result.conclusion).not.toContain('中文模型叙事不应泄漏到英文投影。');
    expect(result.conclusion).toContain('## Bottleneck Ranking');
    expect(result.conclusion).not.toMatch(/[\u4e00-\u9fff]/);
    expect(result.findings[0]?.title).toContain('Scroll');
    expect(result.findings[0]?.description).toContain('Scene duration');
    expect(result.conclusionContract?.conclusions[0].statement)
      .toContain('Smart analysis detected');
    expect(result.conclusionContract?.claims?.[0]?.text).toContain('deep-dive results');
  });
});
