// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { assessFinalReportContractCompleteness } from '../finalReportContractGate';

const COMPLETE_SCROLLING_REPORT = [
  '## 全帧根因分布',
  '| reason_code | 帧数 | 占比 |',
  '| shader_compile | 6 | 30% |',
  '## 代表帧分析',
  'representative frame frame_id=42 frame duration 49ms vsync_missed=2 超预算。',
  '## 峰值/口径指标',
  '真实掉帧 real_jank=6，最长帧 longest frame=49ms，峰值明确。',
].join('\n\n');

describe('final report contract case recommendations gate', () => {
  it('does not require case citation when no strong case recommendation exists', () => {
    expect(assessFinalReportContractCompleteness({
      conclusion: COMPLETE_SCROLLING_REPORT,
      query: '分析滑动卡顿',
      sceneType: 'scrolling',
      caseRecommendations: [],
    })).toBeUndefined();
  });

  it('requires a case recommendation section when a strong typed case hit exists', () => {
    expect(assessFinalReportContractCompleteness({
      conclusion: COMPLETE_SCROLLING_REPORT,
      query: '分析滑动卡顿',
      sceneType: 'scrolling',
      caseRecommendations: [{ caseId: 'case-1', matchStrength: 'strong' }],
    })?.missingLabels).toContain('相似案例引用');
  });
});
