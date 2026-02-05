/**
 * ConclusionGenerator Unit Tests
 */

import { generateConclusion } from '../conclusionGenerator';
import type { Finding, Intent } from '../../types';
import type { ProgressEmitter } from '../orchestratorTypes';
import type { ModelRouter } from '../modelRouter';

describe('conclusionGenerator', () => {
  let mockModelRouter: jest.Mocked<Partial<ModelRouter>>;
  let emitter: ProgressEmitter;
  let emittedUpdates: Array<{ type: string; content: any }>;
  let logs: string[];

  const sharedContext = {
    sessionId: 'session-1',
    traceId: 'trace-1',
    hypotheses: new Map<string, any>(),
    confirmedFindings: [],
    investigationPath: [],
  };

  const intent: Intent = {
    primaryGoal: '分析滑动卡顿的根因',
    aspects: ['jank'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
  };

  const findings: Finding[] = [
    {
      id: 'f-1',
      severity: 'critical',
      title: '主线程阻塞导致掉帧',
      description: '在多个关键帧中观察到主线程长时间 Runnable/Running',
      details: { frame_id: 123, dur_ms: 45.2 },
      source: 'test',
      confidence: 0.9,
    },
  ];

  beforeEach(() => {
    emittedUpdates = [];
    logs = [];

    mockModelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: '测试结论',
        modelId: 'test-model',
        usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
        latencyMs: 500,
      }),
    };

    emitter = {
      emitUpdate: (type, content) => {
        emittedUpdates.push({ type, content });
      },
      log: (message) => {
        logs.push(message);
      },
    };
  });

  test('uses insight-first prompt for early turns', async () => {
    const conclusion = await generateConclusion(
      sharedContext as any,
      findings,
      intent,
      mockModelRouter as unknown as ModelRouter,
      emitter,
      undefined,
      { turnCount: 0 }
    );

    expect(conclusion).toBe('测试结论');
    expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('## 结论（按可能性排序）'),
      'synthesis',
      expect.objectContaining({
        promptId: 'agent.conclusionGenerator.insight.initial_report',
        promptVersion: '2.0.0',
        contractVersion: 'conclusion_insight_text@2.0.0',
      })
    );
  });

  test('uses focused-answer prompt when turnCount >= 1', async () => {
    const conclusion = await generateConclusion(
      sharedContext as any,
      findings,
      { ...intent, followUpType: 'extend' },
      mockModelRouter as unknown as ModelRouter,
      emitter,
      '连续多轮没有新增证据',
      { turnCount: 1, historyContext: 'HISTORY_CONTEXT' }
    );

    expect(conclusion).toBe('测试结论');
    expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('HISTORY_CONTEXT'),
      'synthesis',
      expect.objectContaining({
        promptId: 'agent.conclusionGenerator.insight.focused_answer',
        promptVersion: '2.0.0',
        contractVersion: 'conclusion_insight_text@2.0.0',
      })
    );

    // Ensure prompt includes core multi-turn instructions (but no forced Q/A template).
    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('多轮对话');
    expect(calledPrompt).toContain('## 输出要求（必须严格遵守）');
    expect(calledPrompt).toContain('总长度尽量控制在 25 行以内');
  });

  test('insight mode falls back to 4-section markdown when LLM fails (follow-up)', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(new Error('LLM down'));

    const conclusion = await generateConclusion(
      sharedContext as any,
      [],
      { ...intent, followUpType: 'extend' },
      mockModelRouter as unknown as ModelRouter,
      emitter,
      undefined,
      { turnCount: 3, historyContext: 'HISTORY' }
    );

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 不确定性与反例');
    expect(conclusion).toContain('## 下一步（最高信息增益）');
    expect(emittedUpdates.some(u => u.type === 'degraded')).toBe(true);
  });

  test('insight mode falls back to 4-section markdown when LLM fails (initial)', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(new Error('LLM down'));

    const conclusion = await generateConclusion(
      sharedContext as any,
      findings,
      intent,
      mockModelRouter as unknown as ModelRouter,
      emitter,
      undefined,
      { turnCount: 0 }
    );

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('主线程阻塞导致掉帧');
  });

  test('injects per-conclusion evidence mapping into evidence-chain section when LLM forgets to cite', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue({
      success: true,
      response: `## 结论（按可能性排序）
1. 主线程阻塞（置信度: 80%）

## 证据链（对应上述结论）
- 观察到多次长时间 Runnable/Running

## 不确定性与反例
- 仍需排除 RenderThread/GPU 的影响

## 下一步（最高信息增益）
- 针对关键帧做 drill-down`,
      modelId: 'test-model',
      usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
      latencyMs: 500,
    });

    const findingsWithEvidence: Finding[] = [
      {
        ...findings[0],
        evidence: [{ evidenceId: 'ev_0123456789ab', title: '[frame_agent] scrolling_analysis', kind: 'skill' }],
      },
    ];

    const conclusion = await generateConclusion(
      sharedContext as any,
      findingsWithEvidence,
      { ...intent, followUpType: 'extend' },
      mockModelRouter as unknown as ModelRouter,
      emitter,
      undefined,
      { turnCount: 2, historyContext: 'HISTORY' }
    );

    expect(conclusion).toContain('C1（自动补全）');
    expect(conclusion).toContain('ev_0123456789ab');
  });
});
