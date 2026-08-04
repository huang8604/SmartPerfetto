// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { isConclusionLikePlanPhase } from '../planPhaseSemantics';

describe('plan phase semantics', () => {
  it.each([
    ['结构化结论', '输出 Delta 表格与分层建议'],
    ['结构化报告', '汇总已验证证据'],
    ['Structured Conclusion', 'Present verified findings'],
    ['Structured Report', 'Present verified findings'],
  ])('recognizes conclusion-only phase name %s', (name, goal) => {
    expect(isConclusionLikePlanPhase({ id: 'p-final', name, goal })).toBe(true);
  });

  it('does not classify an evidence drill as a conclusion phase', () => {
    expect(isConclusionLikePlanPhase({
      id: 'p-detail',
      name: '启动阶段深钻',
      goal: '运行 startup_detail 采集双端证据',
    })).toBe(false);
  });
});
