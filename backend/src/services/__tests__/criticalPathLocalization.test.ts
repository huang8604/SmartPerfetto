// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CriticalPathAnalysis} from '../criticalPathAnalyzer';
import {projectCriticalPathAnalysis} from '../criticalPathLocalization';

const analysis = {
  available: true,
  task: {
    threadStateId: 1,
    utid: 2,
    startTs: 3,
    dur: 50_000_000,
    durationMs: 50,
    state: 'S',
    processName: 'app',
    threadName: 'main',
  },
  totalMs: 50,
  blockingMs: 40,
  selfMs: 10,
  externalBlockingPercentage: 80,
  wakeupChain: [{
    startTs: 3,
    dur: 40_000_000,
    startOffsetMs: 0,
    durationMs: 40,
    utid: 2,
    modules: ['IO / 文件系统'],
    reasons: ['未知状态'],
    slices: ['stable_slice_name'],
  }],
  moduleBreakdown: [{
    module: 'IO / 文件系统',
    durationMs: 40,
    percentage: 80,
    segmentCount: 1,
    examples: ['stable.example'],
  }],
  anomalies: [{
    severity: 'warning',
    title: '等待链涉及 IO/page-cache 候选',
    detail: 'critical path 中出现 io_wait 或 kernel blocked_function 的 IO/page-cache 函数族；blocked_function 是单帧 wchan，需要结合同步读写、fsync、SQLite/WAL、page fault 或 block 层证据确认。',
    evidence: ['stable_evidence_id'],
  }],
  summary: '原始中文摘要',
  recommendations: [
    '排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。',
  ],
  warnings: ['critical path 结果较大，已按前 100 个链路段截断展示。'],
  rawRows: 1,
  truncated: true,
} satisfies CriticalPathAnalysis;

describe('criticalPathLocalization', () => {
  it('projects presentation fields while preserving evidence identifiers', () => {
    const raw = structuredClone(analysis);
    const projected = projectCriticalPathAnalysis(analysis, 'en');

    expect(projected.summary).not.toMatch(/\p{Script=Han}/u);
    expect(projected.moduleBreakdown[0].module).toBe('I/O / File system');
    expect(projected.anomalies[0].title).not.toMatch(/\p{Script=Han}/u);
    expect(projected.recommendations[0]).not.toMatch(/\p{Script=Han}/u);
    expect(projected.warnings[0]).not.toMatch(/\p{Script=Han}/u);
    expect(projected.wakeupChain[0].slices).toEqual(['stable_slice_name']);
    expect(projected.anomalies[0].evidence).toEqual(['stable_evidence_id']);
    expect(analysis).toEqual(raw);
  });

  it('projects technical warnings and state reasons for Chinese output', () => {
    const fixture: CriticalPathAnalysis = {
      ...structuredClone(analysis),
      wakeupChain: [{
        ...structuredClone(analysis.wakeupChain[0]),
        reasons: ['Sleeping', 'stable_slice_name'],
      }],
      warnings: [
        'invalid threadStateId',
        'frame timeline query failed: no such table',
      ],
    };
    const raw = structuredClone(fixture);
    const projected = projectCriticalPathAnalysis(fixture, 'zh-CN');

    expect(projected.wakeupChain[0].reasons).toEqual([
      '睡眠',
      'stable_slice_name',
    ]);
    expect(projected.warnings).toEqual([
      '无效的 threadStateId',
      'frame timeline 查询失败： no such table',
    ]);
    expect(fixture).toEqual(raw);
  });
});
