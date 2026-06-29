// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisPlanV3 } from '../types';
import {
  findCompletedPhaseEvidenceGaps,
  recordPlanToolCall,
} from '../planToolCallRecorder';

function createPlan(): AnalysisPlanV3 {
  return {
    phases: [
      {
        id: 'p1',
        name: '概览采集',
        goal: '获取滑动帧概览',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }],
        status: 'completed',
        completedAt: 100,
        summary: '已完成滑动概览采集，包含掉帧帧统计和初步根因分布。',
      },
      {
        id: 'p2',
        name: '根因深钻',
        goal: '调用关键 Skill 确认每类掉帧根因',
        expectedTools: ['invoke_skill', 'fetch_artifact', 'lookup_knowledge'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
        status: 'completed',
        completedAt: 200,
        summary: '已完成主要掉帧深钻，并准备进入最终结论阶段。',
      },
      {
        id: 'p4',
        name: '综合结论',
        goal: '综合所有证据给出最终报告',
        expectedTools: ['fetch_artifact'],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '完整解释滑动掉帧根因',
    submittedAt: 1,
    toolCallLog: [
      {
        toolName: 'invoke_skill',
        timestamp: 10,
        skillId: 'scrolling_analysis',
        matchedPhaseId: 'p1',
      },
      {
        toolName: 'invoke_skill',
        timestamp: 20,
        skillId: 'jank_frame_detail',
        matchedPhaseId: 'p2',
      },
      {
        toolName: 'invoke_skill',
        timestamp: 30,
        skillId: 'frame_blocking_calls',
        matchedPhaseId: 'p2',
      },
    ],
  };
}

describe('recordPlanToolCall', () => {
  it('backfills a completed phase expectedCall gap before trusting a returned active phase id', () => {
    const plan = createPlan();

    const record = recordPlanToolCall(plan, {
      toolName: 'invoke_skill',
      input: { skillId: 'blocking_chain_analysis', params: '{}' },
      resultText: '{"success":true,"planPhaseId":"p4"}',
      timestamp: 40,
    });

    expect(record).toMatchObject({
      toolName: 'invoke_skill',
      skillId: 'blocking_chain_analysis',
      matchedPhaseId: 'p2',
    });
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

  it('keeps an active phase match when that phase has the same missing expectedCall', () => {
    const plan = createPlan();
    plan.phases[2] = {
      ...plan.phases[2],
      expectedTools: ['invoke_skill'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'invoke_skill',
      input: { skillId: 'blocking_chain_analysis', params: '{}' },
      resultText: '{"success":true,"planPhaseId":"p4"}',
      timestamp: 40,
    });

    expect(record?.matchedPhaseId).toBe('p4');
    expect(findCompletedPhaseEvidenceGaps(plan)).toHaveLength(1);
  });

  it('does not let informational strategy detail lookups satisfy evidence gaps', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '策略细节读取',
        goal: '读取 on-demand detail，但不能把它当 trace 证据',
        expectedTools: ['lookup_strategy_detail'],
        expectedCalls: [{ tool: 'lookup_strategy_detail' }],
        status: 'completed',
        completedAt: 100,
        summary: '只读取了策略说明，没有采集 trace 证据。',
      }],
      successCriteria: 'Detail lookup must remain informational',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'lookup_strategy_detail',
      input: { detailRef: 'scrolling:architecture' },
      resultText: '{"success":true,"informational":true,"planPhaseId":"p1"}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBeUndefined();
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([
      expect.objectContaining({
        phase: plan.phases[0],
        matchedCalls: [],
        missingExpectedCalls: [{ tool: 'lookup_strategy_detail' }],
      }),
    ]);
  });
});
