// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CriticalPathAnalysis} from '../criticalPathAnalyzer';
import {buildDeterministicCriticalPathSummary} from '../criticalPathAiSummary';

function fixture(): CriticalPathAnalysis {
  return {
    available: true,
    task: {
      threadStateId: 1,
      utid: 10,
      startTs: 1_000,
      dur: 50_000_000,
      durationMs: 50,
      processName: 'com.example',
      threadName: 'main',
      state: 'S',
    },
    totalMs: 50,
    blockingMs: 40,
    selfMs: 10,
    externalBlockingPercentage: 80,
    wakeupChain: [],
    moduleBreakdown: [
      {
        module: 'IO / 文件系统',
        durationMs: 40,
        percentage: 80,
        segmentCount: 1,
        examples: [],
      },
    ],
    anomalies: [
      {
        severity: 'warning',
        title: '等待链涉及 IO/page-cache 候选',
        detail: 'critical path 中出现 io_wait。',
        evidence: ['io_wait=true'],
      },
    ],
    summary: '选中 task 的外部等待占比较高。',
    recommendations: ['排查选中区间附近的同步 I/O。'],
    warnings: ['critical path 被截断。'],
    rawRows: 1,
    truncated: false,
  } as CriticalPathAnalysis;
}

describe('criticalPathAiSummary localization', () => {
  it('builds English presentation without mutating the raw analysis', () => {
    const analysis = fixture();
    const before = structuredClone(analysis);

    const summary = buildDeterministicCriticalPathSummary(analysis, 'en');

    expect(summary).toContain('External critical path: 40.00 ms (80.00%).');
    expect(summary).toContain('I/O / File system 40.00 ms');
    expect(summary).toContain(
      'The wait chain contains an I/O or page-cache candidate',
    );
    expect(analysis).toEqual(before);
  });
});
