// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ModelRouter } from '../modelRouter';
import type { ProgressEmitter } from '../orchestratorTypes';
import type { AgentResponse, SharedAgentContext } from '../../types/agentProtocol';
import type { Finding } from '../../types';
import { synthesizeFeedback } from '../feedbackSynthesizer';

function makeEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function makeSharedContext(): SharedAgentContext {
  return {
    sessionId: 's1',
    traceId: 't1',
    hypotheses: new Map(),
    confirmedFindings: [],
    investigationPath: [],
  };
}

function makeModelRouter(contradictions: string[]): ModelRouter {
  return {
    callWithFallback: jest.fn().mockResolvedValue({
      success: true,
      response: JSON.stringify({
        correlatedFindings: [],
        contradictions,
        hypothesisUpdates: [],
        informationGaps: [],
      }),
      modelId: 'test-model',
      usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      latencyMs: 1,
    }),
  } as unknown as ModelRouter;
}

function makeRawModelRouter(responseText: string): ModelRouter {
  return {
    callWithFallback: jest.fn().mockResolvedValue({
      success: true,
      response: responseText,
      modelId: 'test-model',
      usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      latencyMs: 1,
    }),
  } as unknown as ModelRouter;
}

function makeResponse(findings: AgentResponse['findings']): AgentResponse {
  return {
    agentId: 'frame_agent',
    taskId: `task_${Math.random()}`,
    success: true,
    findings,
    confidence: 0.8,
    executionTimeMs: 1,
  };
}

type FindingOverrides = Partial<Finding>;

type DegradedPayload = { fallback?: string } | undefined;

function makeFinding(overrides: FindingOverrides): Finding {
  return {
    id: 'f_default',
    category: 'frame',
    type: 'issue',
    severity: 'warning',
    title: '默认发现',
    description: '默认描述',
    source: 'scrolling_analysis',
    confidence: 0.75,
    ...overrides,
  };
}

function makeWindowFinding(
  id: string,
  title: string,
  sessionId: number,
  startTsNs: string,
  endTsNs: string,
  evidenceId: string,
  severity: Finding['severity'] = 'warning'
): Finding {
  return makeFinding({
    id,
    severity,
    title,
    description: '数据来源: Scrolling 帧列表',
    details: { sourceWindow: { sessionIds: [sessionId], startTsNs, endTsNs } },
    evidence: [{ evidenceId }],
  });
}

function makeSingleResponse(finding: Finding): AgentResponse[] {
  return [makeResponse([finding])];
}

function setHypothesis(shared: SharedAgentContext, overrides: {
  id: string;
  description: string;
  confidence: number;
  status: 'proposed' | 'investigating' | 'confirmed' | 'rejected';
}): void {
  const now = Date.now();
  shared.hypotheses.set(overrides.id, {
    id: overrides.id,
    description: overrides.description,
    confidence: overrides.confidence,
    status: overrides.status,
    createdAt: now,
    updatedAt: now,
    supportingEvidence: [],
    contradictingEvidence: [],
    proposedBy: 'test',
  });
}

function hasPassthroughFallbackDegradeEvent(emitter: ProgressEmitter): boolean {
  const calls = (emitter.emitUpdate as jest.Mock).mock.calls as unknown[][];
  return calls.some((call: unknown[]) => {
    return call[0] === 'degraded'
      && (call[1] as DegradedPayload)?.fallback === 'passthrough findings';
  });
}

describe('feedbackSynthesizer contradiction handling', () => {
  test('does not treat different session scopes as contradiction even with two evidence ids', async () => {
    const ev1 = 'ev_111111111111';
    const ev2 = 'ev_222222222222';
    const modelRouter = makeModelRouter([
      `第一次分析中掉帧数为25帧（${ev1}），第二次为38帧（${ev2}），需确认测试条件是否一致`,
    ]);

    const responses: AgentResponse[] = [
      makeResponse([
        makeWindowFinding('f1', '区间1 滑动卡顿检测: 25 帧 (7.6%)', 1, '1000', '2000', ev1),
      ]),
      makeResponse([
        makeWindowFinding('f2', '区间2 滑动卡顿检测: 38 帧 (12.2%)', 2, '3000', '4000', ev2, 'critical'),
      ]),
    ];

    const result = await synthesizeFeedback(
      responses,
      makeSharedContext(),
      modelRouter,
      makeEmitter()
    );

    const contradicted = result.newFindings.filter(f => Boolean((f.details as Record<string, unknown> | undefined)?._contradicted));
    expect(contradicted).toHaveLength(0);
    expect(result.informationGaps.some(g => g.includes('矛盾:'))).toBe(false);
  });

  test('marks findings as contradicted when evidence conflict is within the same session scope', async () => {
    const ev1 = 'ev_aaaaaaaaaaaa';
    const ev2 = 'ev_bbbbbbbbbbbb';
    const modelRouter = makeModelRouter([
      `同一区间内掉帧统计冲突：25帧（${ev1}） vs 38帧（${ev2}）`,
    ]);

    const responses: AgentResponse[] = [
      makeResponse([
        makeWindowFinding('f1', '区间1 滑动卡顿检测: 25 帧 (7.6%)', 1, '1000', '2000', ev1),
      ]),
      makeResponse([
        makeWindowFinding('f2', '区间1 滑动卡顿检测: 38 帧 (12.2%)', 1, '1000', '2000', ev2, 'critical'),
      ]),
    ];

    const result = await synthesizeFeedback(
      responses,
      makeSharedContext(),
      modelRouter,
      makeEmitter()
    );

    const contradicted = result.newFindings.filter(f => Boolean((f.details as Record<string, unknown> | undefined)?._contradicted));
    expect(contradicted.length).toBeGreaterThan(0);
    for (const f of contradicted) {
      expect((f.confidence || 0)).toBeLessThanOrEqual(0.75);
    }
    expect(result.informationGaps.some(g => g.includes('矛盾:'))).toBe(true);
  });

  test('skips contradiction when frame counts map to different sliding intervals even without evidence ids', async () => {
    const modelRouter = makeModelRouter([
      '同一区间1的滑动卡顿检测数据存在不一致：第一次报告25帧，第二次报告38帧',
    ]);

    const responses: AgentResponse[] = [
      makeResponse([
        makeWindowFinding('f1', '区间1 滑动卡顿检测: 25 帧 (7.6%)', 1, '1000', '2000', 'ev_cccccccccccc'),
      ]),
      makeResponse([
        makeWindowFinding('f2', '区间2 滑动卡顿检测: 38 帧 (12.2%)', 2, '3000', '4000', 'ev_dddddddddddd'),
      ]),
    ];

    const result = await synthesizeFeedback(
      responses,
      makeSharedContext(),
      modelRouter,
      makeEmitter()
    );

    const contradicted = result.newFindings.filter(
      f => Boolean((f.details as Record<string, unknown> | undefined)?._contradicted)
    );
    expect(contradicted).toHaveLength(0);
    expect(result.informationGaps.some(g => g.includes('矛盾:'))).toBe(false);
  });
});

describe('feedbackSynthesizer schema-repair handling', () => {
  test('recovers wrapped snake_case payload without passthrough fallback', async () => {
    const modelRouter = makeRawModelRouter(JSON.stringify({
      result: {
        correlated_findings: [{ text: '主线程耗时与掉帧峰值同窗出现' }],
        conflicts: '同一会话内掉帧统计口径不一致',
        hypothesis_updates: [
          {
            hypothesis_id: 'h_main',
            action: 'strengthen',
            confidence_delta: '0.2',
            explanation: '逐帧数据支持主线程触发',
          },
        ],
        information_gaps: [{ statement: '缺少温控与频率联动证据' }],
      },
    }));

    const shared = makeSharedContext();
    setHypothesis(shared, {
      id: 'h_main',
      description: '主线程触发是主要矛盾',
      confidence: 0.5,
      status: 'proposed',
    });

    const emitter = makeEmitter();
    const result = await synthesizeFeedback(
      makeSingleResponse(
        makeFinding({
          id: 'f1',
          title: '区间1 掉帧上升',
          description: '主线程耗时高于预算',
          source: 'jank_frame_detail',
          confidence: 0.7,
        })
      ),
      shared,
      modelRouter,
      emitter
    );

    const updated = result.updatedHypotheses.find(h => h.id === 'h_main');
    expect(updated?.confidence).toBeGreaterThan(0.5);
    expect(result.informationGaps).toContain('缺少温控与频率联动证据');
    expect(hasPassthroughFallbackDegradeEvent(emitter)).toBe(false);
  });

  test('infers hypothesis action from confidence_delta when action missing', async () => {
    const modelRouter = makeRawModelRouter(JSON.stringify({
      hypothesisUpdates: [
        {
          hypothesisId: 'h_sched',
          confidence_delta: '-0.15',
          reason: '调度证据不足',
        },
      ],
      informationGaps: '需要补充 scheduler trace 证据',
    }));

    const shared = makeSharedContext();
    setHypothesis(shared, {
      id: 'h_sched',
      description: '调度延迟是主因',
      confidence: 0.8,
      status: 'confirmed',
    });

    const emitter = makeEmitter();
    const result = await synthesizeFeedback(
      makeSingleResponse(
        makeFinding({
          id: 'f2',
          category: 'cpu',
          title: '调度信号不足',
          description: '未观察到显著 runnable backlog',
          source: 'sched_latency_in_range',
          confidence: 0.7,
        })
      ),
      shared,
      modelRouter,
      emitter
    );

    const updated = result.updatedHypotheses.find(h => h.id === 'h_sched');
    expect(updated?.confidence).toBeLessThan(0.8);
    expect(updated?.status).toBe('investigating');
    expect(result.informationGaps).toContain('需要补充 scheduler trace 证据');
    expect(hasPassthroughFallbackDegradeEvent(emitter)).toBe(false);
  });

  test('recovers non-json free-text synthesis output without passthrough fallback', async () => {
    const modelRouter = makeRawModelRouter(`Correlated Findings:
- 主线程耗时与掉帧峰值同窗出现

Contradictions:
- 同一会话掉帧统计口径冲突（ev_111111111111 vs ev_222222222222）

Information Gaps:
- 缺少温控与频率联动证据

Hypothesis Updates:
- hypothesisId=h_free action=support confidence_delta=0.12 reason=逐帧证据支持`);

    const shared = makeSharedContext();
    setHypothesis(shared, {
      id: 'h_free',
      description: '主线程触发是主因',
      confidence: 0.4,
      status: 'proposed',
    });

    const emitter = makeEmitter();
    const result = await synthesizeFeedback(
      makeSingleResponse(
        makeFinding({
          id: 'f3',
          title: '主线程耗时升高',
          description: '与掉帧峰值重叠',
          confidence: 0.7,
        })
      ),
      shared,
      modelRouter,
      emitter
    );

    expect(result.informationGaps).toContain('矛盾: 同一会话掉帧统计口径冲突（ev_111111111111 vs ev_222222222222）');
    expect(result.informationGaps).toContain('缺少温控与频率联动证据');
    expect(result.updatedHypotheses.find(h => h.id === 'h_free')?.confidence).toBeGreaterThan(0.4);
    expect(hasPassthroughFallbackDegradeEvent(emitter)).toBe(false);
  });
});