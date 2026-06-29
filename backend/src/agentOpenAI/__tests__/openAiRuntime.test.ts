// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { OpenAIRuntime, __testing } from '../openAiRuntime';
import type { AnalysisPlanV3, PlanPhase } from '../../agentv3/types';

function phase(id: string, status: PlanPhase['status']): PlanPhase {
  const p: PlanPhase = {
    id,
    name: `Phase ${id}`,
    goal: `Goal ${id}`,
    expectedTools: ['invoke_skill'],
    status,
  };
  if (status === 'completed' || status === 'skipped') {
    p.summary = `Evidence summary for ${id}`;
  }
  return p;
}

function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {
    phases,
    successCriteria: 'Complete every phase before final answer',
    submittedAt: Date.now(),
    toolCallLog: [],
  };
}

function rawOutputTextDelta(delta: string): any {
  return {
    type: 'raw_model_stream_event',
    data: {
      type: 'output_text_delta',
      delta,
    },
  };
}

function streamContext(sessionId: string, quickMode: boolean): any {
  return {
    sessionId,
    quickMode,
    answerStreamFilter: __testing.createOpenAiReasoningFilterState(),
    toolInputsByTaskId: new Map(),
  };
}

function createRuntimeWithUpdates(): { runtime: any; updates: any[] } {
  const runtime = new OpenAIRuntime({} as any) as any;
  const updates: any[] = [];
  runtime.on('update', (update: any) => updates.push(update));
  return { runtime, updates };
}

describe('OpenAIRuntime plan completion guard', () => {
  it('treats full-mode runs as incomplete until every plan phase is closed', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: false,
      pendingPhases: [],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending'), phase('p3', 'in_progress')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [
        expect.objectContaining({ id: 'p2' }),
        expect.objectContaining({ id: 'p3' }),
      ],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('does not require a plan in quick mode', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', true)).toMatchObject({
      complete: true,
      hasPlan: false,
      pendingPhases: [],
    });
  });

  it('does not treat closed phases with weak summaries as complete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const weak = phase('p1', 'completed');
    weak.summary = 'done';

    runtime.sessionPlans.set('s1', {
      current: plan([weak]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
    });
  });

  it('does not treat completed phases as complete until structured expected calls are observed', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const p1 = phase('p1', 'completed');
    p1.expectedCalls = [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }];
    runtime.sessionPlans.set('s1', {
      current: plan([p1]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
      evidenceGaps: [expect.objectContaining({ phase: expect.objectContaining({ id: 'p1' }) })],
    });

    runtime.sessionPlans.get('s1')!.current!.toolCallLog.push({
      toolName: 'invoke_skill',
      skillId: 'scrolling_analysis',
      matchedPhaseId: 'p1',
      timestamp: Date.now(),
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('allows deterministic stream finalization after full-mode plan completion', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'in_progress')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(false);

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '', 'previous answer')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', true, 'final text')).toBe(false);
  });

  it('does not read finalOutput after forced plan-complete aborts', () => {
    const stream = {
      get finalOutput() {
        throw new Error('finalOutput getter should not be read');
      },
    };

    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: false,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: true,
    })).toBeUndefined();
  });

  it('reads finalOutput only after natural stream completion', () => {
    expect(__testing.readCompletedStreamFinalOutput({ finalOutput: 'done' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
    })).toBe('done');
  });

  it('does not treat stream finalOutput as final before a full-mode plan is complete', () => {
    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: '我将先查询 FrameTimeline。' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: false,
      planComplete: false,
    })).toBeUndefined();

    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: 'quick answer' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: true,
      planComplete: false,
    })).toBe('quick answer');

    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: '## 综合结论\n\n证据完整。' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: false,
      planComplete: true,
    })).toBe('## 综合结论\n\n证据完整。');
  });

  it('suppresses full-mode answer deltas before a plan is submitted', () => {
    const { runtime, updates } = createRuntimeWithUpdates();

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('我将分析这个 doFrame 帧，首先查询 FrameTimeline。'),
      'zh-CN',
      streamContext('s-pre-plan', false),
    );

    expect(delta).toBe('');
    expect(updates.some(update => update.type === 'answer_token')).toBe(false);
  });

  it('suppresses full-mode answer deltas while the plan is still pending', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-pending', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending')]),
      history: [],
    });

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('我将重新制定计划并继续分析。'),
      'zh-CN',
      streamContext('s-pending', false),
    );

    expect(delta).toBe('');
    expect(updates.some(update => update.type === 'answer_token')).toBe(false);
  });

  it('streams answer deltas after a full-mode plan is complete', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-complete', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。'),
      'zh-CN',
      streamContext('s-complete', false),
    );

    expect(delta).toBe('## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。');
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'answer_token',
      content: { token: '## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。' },
    }));
  });

  it('keeps quick-mode answer streaming unchanged', () => {
    const { runtime, updates } = createRuntimeWithUpdates();

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('快速结论：主线程 Running 时间最高。'),
      'zh-CN',
      streamContext('s-quick', true),
    );

    expect(delta).toBe('快速结论：主线程 Running 时间最高。');
    expect(updates.some(update => update.type === 'answer_token')).toBe(true);
  });

  it('records OpenAI tool calls into the active analysis plan', () => {
    const { runtime } = createRuntimeWithUpdates();
    const p1 = phase('p1', 'in_progress');
    p1.expectedCalls = [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }];
    runtime.sessionPlans.set('s-tools', {
      current: plan([p1]),
      history: [],
    });
    const context = streamContext('s-tools', false);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {
        rawItem: {
          callId: 'call-1',
          id: 'item-1',
          name: 'invoke_skill',
          arguments: JSON.stringify({ skillId: 'scrolling_analysis', params: { process_name: 'demo' } }),
        },
      },
    } as any, 'zh-CN', context);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {
        rawItem: {
          callId: 'call-1',
          output: JSON.stringify([{ type: 'text', text: '{"success":true,"planPhaseId":"p1"}' }]),
        },
      },
    } as any, 'zh-CN', context);

    expect(runtime.sessionPlans.get('s-tools')!.current!.toolCallLog).toContainEqual(expect.objectContaining({
      toolName: 'invoke_skill',
      skillId: 'scrolling_analysis',
      matchedPhaseId: 'p1',
    }));
  });

  it('strips OpenAI-compatible reasoning markers from visible text', () => {
    expect(__testing.stripOpenAiReasoningArtifacts(
      '<think>内部推理不应展示</think>\n\n## 综合结论\n\n用户可见结论。</think>',
    )).toBe('## 综合结论\n\n用户可见结论。');

    expect(__testing.stripOpenAiReasoningArtifacts(
      '## 综合结论\n\n用户可见结论。\n\n<think>未闭合内部推理',
    )).toBe('## 综合结论\n\n用户可见结论。');

    expect(__testing.sanitizeOpenAiConclusionText(
      '## 综合结论\n\nFrame 卡顿主要来自主线程阻塞。</think>',
    )).toBe('## 综合结论\n\nFrame 卡顿主要来自主线程阻塞。');
  });

  it('strips reasoning markers across split answer deltas', () => {
    const state = __testing.createOpenAiReasoningFilterState();

    expect(__testing.filterOpenAiVisibleAnswerDelta('<thi', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('nk>内部推理', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('仍然不可见</thi', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('nk>## 综合结论', state)).toBe('## 综合结论');
    expect(__testing.filterOpenAiVisibleAnswerDelta('\n\n用户可见。', state)).toBe('\n\n用户可见。');
  });

  it('tracks reasoning state while full-mode answer deltas are suppressed', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-transition', {
      current: plan([phase('p1', 'pending')]),
      history: [],
    });
    const context = streamContext('s-transition', false);

    expect(runtime.handleStreamEvent(
      rawOutputTextDelta('<think>内部推理开始'),
      'zh-CN',
      context,
    )).toBe('');

    runtime.sessionPlans.set('s-transition', {
      current: plan([phase('p1', 'completed')]),
      history: [],
    });

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('仍然不可见</think>## 综合结论'),
      'zh-CN',
      context,
    );

    expect(delta).toBe('## 综合结论');
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'answer_token',
      content: { token: '## 综合结论' },
    }));
  });

  it('strips leading process narration from plan-idle conclusions', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。p2.7 的触发条件检查已经完成，接下来输出结论。\n\n' +
      '**根因编号映射**\n\n' +
      '- S1: 主线程 Running 占比 63%，对应 art-1 的线程状态表。\n' +
      '- S2: Sleeping 占比 35%，对应 art-2 的阻塞明细表，需要作为次要风险说明。',
      { completedByPlanIdle: true, planComplete: true, fallbackConclusion: 'fallback' },
    );

    expect(sanitized).toContain('**根因编号映射**');
    expect(sanitized).not.toContain('我需要完成剩余的阶段状态更新');
  });

  it('strips multi-paragraph planning narration before the report body', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我来分析 `com.example.launch.aosp.heavy` 的启动性能。这是一个启动分析场景。\n\n' +
      '首先，提交分析计划：## Phase 1 — 启动概览采集\n\n' +
      '调用 `startup_analysis` 获取启动事件列表、延迟归因、主线程热点。\n\n' +
      '### Phase 1 关键发现记录\n\n' +
      '- 冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。\n' +
      '- 主线程 Running=63%，证据来自 art-10。',
    );

    expect(sanitized).toContain('### Phase 1 关键发现记录');
    expect(sanitized).not.toContain('我来分析');
    expect(sanitized).not.toContain('提交分析计划');
    expect(sanitized).not.toContain('调用 `startup_analysis`');
  });

  it('strips scratch findings and continuation narration before an embedded final report heading', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '**根因分布统计：**\n' +
      '- **workload_heavy**: 6帧 (85.7%) - 最严重62.73ms，超预算7.5倍\n\n' +
      '根据 Phase 1.9 要求，我需要对占比 >15% 的根因类型进行深钻。workload_heavy 占比 85.7%，必须深钻。\n\n' +
      '让我更新计划并执行深钻：## 滑动性能分析报告\n\n' +
      '### 概览\n\n' +
      '本次分析覆盖 347 帧，结论引用 art-14 和 art-16。\n\n' +
      '### 根因\n\n' +
      '主线程 animation/CustomScroll_longFrameLoad 是主要耗时点，证据来自 frame_blocking_calls。',
      { completedByPlanIdle: true, planComplete: true },
    );

    expect(sanitized.trim().startsWith('## 滑动性能分析报告')).toBe(true);
    expect(sanitized).toContain('本次分析覆盖 347 帧');
    expect(sanitized).not.toContain('根据 Phase 1.9 要求');
    expect(sanitized).not.toContain('让我更新计划');
  });

  it('falls back to completed phase summaries when the candidate is only process narration', () => {
    expect(__testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      {
        completedByPlanIdle: true,
        planComplete: true,
        fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
      },
    )).toBe('分析计划已完成，基于已完成阶段摘要输出。');
  });

  it('treats startup-type validation scratch text as process narration', () => {
    const fallback = '## 综合结论\n\n冷启动 TTID=1912ms，主因是主线程模拟负载。\n\n## 关键证据链\n\n- startup_analysis type_display=冷启动，R009 已修正。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate:
        '验证逻辑：\n' +
        '- **bindApplication 不存在** → 没有 Application 初始化阶段\n' +
        '- **performCreate 存在** → 有 Activity 重建\n\n' +
        '但 Skill 将其重分类为冷启动（R009），可能是因为该应用行为特殊。实际上根据框架信号，**应维持温启动分类**。\n\n' +
        '现在进入 Phase 2，调用 startup_detail：Phase 2 返回了丰富数据。关键概览：Q1=62.8%, Q4b=35.1%。',
      accumulatedAnswer: '',
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(fallback);
  });

  it('recovers the accumulated report when the plan-idle candidate is only bookkeeping', () => {
    const report = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '启动诊断完成，主线程 Running=63%，ChaosTask self=456ms，结论引用 art-10 和 data:sql_summary:current:abc。\n\n' +
      '## 根因\n\n' +
      '模拟负载是主要瓶颈，LoadSimulator_ActivityInit=250ms，相关数据来自 art-32。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      accumulatedAnswer: report,
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
    });

    expect(chosen).toBe(report);
  });

  it('does not treat phase process narration as a valid final report', () => {
    const fallback = '## 综合结论\n\n阶段证据已收敛。\n\n## 关键证据链\n\n- TTID=1912ms。';
    const leaked = [
      '1. **冷启动**，dur=1338.65ms，原分类warm已被重分类为cold（R009）',
      '2. **TTID=1912.20ms > dur=1338.65ms**，差距573.55ms（R008触发）',
      '',
      '现在完成Phase 1，进入Phase 1.5验证启动类型，然后进入Phase 2深钻。',
    ].join('\n');

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: leaked,
      accumulatedAnswer: leaked,
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(fallback);
  });

  it('recovers the accumulated report after natural plan completion when finalOutput collapses to fallback', () => {
    const fallback = '## 综合结论\n\n' +
      '完成综合结论输出。冷启动 TTID=1912ms，主因是主线程模拟负载。\n\n' +
      '## 分阶段证据摘要\n\n' +
      '- 启动概览采集: 获取启动概览，TTID=1912ms。\n' +
      '- 综合结论: 完成综合结论输出。';
    const report = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主线程模拟负载是主因；ChaosTask self=456ms，LoadSimulator_ActivityInit self=249.8ms，SimulateInflation self=175.5ms。' +
      '四象限 Q1=62.8%、Q4b=35.1%，CPU-bound 为主，证据引用 art-10、art-32 和 data:sql_table:current:abc。\n\n' +
      '## 关键证据链\n\n' +
      '- startup_detail 显示主线程 Running=63%，S=35%，D=1.7%。\n' +
      '- hot_slice_states 显示 ChaosTask/SimulateInflation Running >98%。\n' +
      '- memory_pressure_in_range 显示 pressure_level=none，排除内存压力。\n\n' +
      '## 优化建议\n\n' +
      '降低启动期模拟负载，拆分 Activity 初始化中的同步等待，并把 inflate 成本移出首帧关键路径。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      accumulatedAnswer: report,
      completedByPlanIdle: false,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(report);
  });

  it('keeps a valid finalOutput report instead of preferring stale accumulated text', () => {
    const staleInterimReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '这是较早的阶段性报告，包含还没有被后续 SQL 校正的初步判断，文本更长但不是最终答案。\n\n' +
      '## 早期证据\n\n' +
      '- 初步估算 TTID=2100ms，ChaosTask=500ms。\n' +
      '- 初步估算内存压力可疑，但后续阶段尚未验证。\n\n' +
      '## 待验证项\n\n' +
      '仍需要继续执行内存压力、Binder、CPU 频率和 WebView 排除检查。\n\n' +
      '## 临时建议\n\n' +
      '先降低模拟负载，并继续收集证据。'.repeat(8);
    const finalReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '最终校正后 TTID=1912ms，主因是主线程模拟负载；内存压力、CPU 频率和 Binder 均可排除。\n\n' +
      '## 关键证据链\n\n' +
      '- startup_detail 显示 ChaosTask self=456ms。\n' +
      '- memory_pressure_in_range 显示 pressure_level=none。\n\n' +
      '## 优化建议\n\n' +
      '拆分主线程同步负载。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: finalReport,
      accumulatedAnswer: `${staleInterimReport}\n\n${finalReport}`,
      completedByPlanIdle: false,
      planComplete: true,
      fallbackConclusion: '## 综合结论\n\n阶段摘要。\n\n## 分阶段证据摘要\n\n- p1: 采集摘要。',
    });

    expect(chosen).toBe(finalReport);
  });

  it('uses the current run answer before cross-continuation accumulated text for recovery', () => {
    expect(__testing.selectOpenAiRecoveryAnswer({
      runAnswer: '## 当前最终报告\n\n证据已完成校正。',
      accumulatedAnswer: '## 早期阶段报告\n\n这是上一轮 continuation 的阶段性内容。',
    })).toBe('## 当前最终报告\n\n证据已完成校正。');

    expect(__testing.selectOpenAiRecoveryAnswer({
      runAnswer: '   ',
      accumulatedAnswer: '## 累计报告\n\n只有当前 run 为空时才使用累计文本。',
    })).toBe('## 累计报告\n\n只有当前 run 为空时才使用累计文本。');
  });

  it('requests bounded final-report continuations when a completed plan only has summary fallback', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = { complete: true, hasPlan: true, pendingPhases: [] };
    const fallback = '## 综合结论\n\n阶段摘要。\n\n## 分阶段证据摘要\n\n- p1: 采集摘要。';
    const summaryLikeFallback = '## 综合结论\n\n完成综合结论输出。冷启动 TTID=1912ms。\n\n' +
      '## 分阶段证据摘要\n\n' +
      '- 启动概览采集: 获取启动概览，TTID=1912ms。\n' +
      '- 启动详情分析: 四象限 Q1=62.8%、Q4b=35.1%。';
    const fullReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '这是面向用户的完整最终报告，包含 TTID=1912ms、ChaosTask=456ms、LoadSimulator_ActivityInit=249.8ms 等证据。\n\n' +
      '## 关键证据链\n\n' +
      '- 引用 art-10 和 data:sql_table:current:abc。\n' +
      '- 排除 CPU 频率、内存压力、Binder 等系统因素。\n\n' +
      '## 优化建议\n\n' +
      '拆分主线程同步负载，延后非首帧必要工作。';

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: true,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: summaryLikeFallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '1. **冷启动**，dur=1338.65ms。',
        '',
        '现在完成Phase 1，进入Phase 1.5验证启动类型。',
      ].join('\n'),
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '### Phase 1 关键发现记录',
        '',
        '- 冷启动 dur=1338.65ms，TTID=1912.20ms。',
        '- 主线程 Running=63%。',
      ].join('\n'),
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 1,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 2,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 4,
    })).toBe(false);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fullReport,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(false);
  });

  it('requests final-report continuation when the scene contract is incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '## 综合结论',
        '',
        'com.example.demo 滑动性能一般：347帧中7帧真实掉帧，最长帧62.73ms。',
        '',
        '## 根因拆解',
        '',
        '- animation 回调同步执行 CustomScroll_longFrameLoad。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
    })).toBe(true);
  });

  it('requests final-report continuation when the memory scene contract is incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 内存分析报告',
        '',
        '## 综合结论',
        '',
        'PSS 持续上涨，可能存在泄漏，需要优化内存。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析内存上涨和 GC 抖动',
      sceneType: 'memory',
    })).toBe(true);
  });

  it('requests final-report continuation when the power background-governance contract is incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 功耗分析报告',
        '',
        '## 综合结论',
        '',
        '后台 JobScheduler 耗电高，可能是 quota 导致，需要减少后台任务。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析 JobScheduler runtime quota pending reason stop reason',
      sceneType: 'power',
    })).toBe(true);
  });

  it('requests final-report continuation when the network request-stage contract is incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 网络分析报告',
        '',
        '## 综合结论',
        '',
        'OkHttp 请求慢主要是 DNS/TLS/TTFB 慢，建议优化缓存和服务端。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析 OkHttp EventListener DNS TLS TTFB 是否慢',
      sceneType: 'network',
    })).toBe(true);
  });

  it('requests final-report continuation when startup diagnostic API boundaries are incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 启动性能分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationStartInfo 显示启动慢，App Performance Score 偏低，建议优化启动。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationStartInfo STARTUP_STATE 和 App Performance Score 分析启动 TTID/TTFD',
      sceneType: 'startup',
    })).toBe(true);
  });

  it('requests final-report continuation when memory diagnostic API boundaries are incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 内存分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationExitInfo REASON_LOW_MEMORY 说明 OOM 来自内存泄漏，建议优化对象释放。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationExitInfo REASON_LOW_MEMORY 和 ProfilingManager heap dump 分析 OOM',
      sceneType: 'memory',
    })).toBe(true);
  });

  it('requests final-report continuation when ANR diagnostic API boundaries are incomplete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# ANR 分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationExitInfo getAnrInfo 和 ProfilingTrigger system trace 说明当前 ANR 是系统确认根因。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationExitInfo getAnrInfo 和 ProfilingTrigger ANR system trace 分析 ANR',
      sceneType: 'anr',
    })).toBe(true);
  });

  it('uses a full-report continuation prompt that preserves scene-specific sections', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    const zhPrompt = runtime.buildFinalReportAfterPlanCompletePrompt('zh-CN');
    expect(zhPrompt).toContain('继续遵守本轮场景策略');
    expect(zhPrompt).toContain('Final Report Contract');
    expect(zhPrompt).toContain('场景契约要求的结构');
    expect(zhPrompt).toContain('完整性优先');
    expect(zhPrompt).toContain('先输出 Final Report Contract 要求的必需结构');
    expect(zhPrompt).toContain('证据类型');
    expect(zhPrompt).toContain('版本/政策敏感');
    expect(zhPrompt).toContain('缺失数据只能写成限制');
    expect(zhPrompt).not.toContain('2500-3500');
    expect(zhPrompt).not.toContain('最多 1200');

    const enPrompt = runtime.buildFinalReportAfterPlanCompletePrompt('en');
    expect(enPrompt).toContain('scene strategy');
    expect(enPrompt).toContain('Final Report Contract');
    expect(enPrompt).toContain('structures required by the scene contract');
    expect(enPrompt).toContain('Prioritize completeness');
    expect(enPrompt).toContain('before long trees');
    expect(enPrompt).toContain('evidence type');
    expect(enPrompt).toContain('version/policy-sensitive');
    expect(enPrompt).toContain('Missing data is a limitation');
    expect(enPrompt).not.toContain('1,200-1,800');
    expect(enPrompt).not.toContain('at most 700');
  });

  it('uses user-facing continuation progress text instead of provider internals', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const message = runtime.formatPlanContinuationMessage({
      hasPlan: true,
      complete: false,
      pendingPhases: [
        { id: 'p3', name: '综合结论' },
      ] as any,
    }, 'zh-CN');

    expect(message).toBe('继续补齐剩余分析阶段：综合结论');
    expect(message).not.toContain('OpenAI');
    expect(message).not.toContain('plan');
    expect(message).not.toContain('提前结束');

    const reportMessage = runtime.formatPlanCompleteReportContinuationMessage('zh-CN');
    expect(reportMessage).toBe('最终报告仍需补齐，继续整理完整结论。');
    expect(reportMessage).not.toContain('OpenAI');
    expect(reportMessage).not.toContain('plan');
    expect(reportMessage).not.toContain('provider');
  });

  it('builds a user-facing structured fallback when a completed plan has no final answer text', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const p1 = phase('p1', 'completed');
    p1.name = '获取启动概览';
    p1.summary = '检测到冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。';
    const p2 = phase('p2', 'completed');
    p2.name = '综合结论';
    p2.goal = '输出最终结论和优化建议';
    p2.summary = '主要瓶颈是 ChaosTask self=456ms，相关数据来自 art-30。';
    runtime.sessionPlans.set('s1', {
      current: plan([p1, p2]),
      history: [],
    });

    const fallback = runtime.buildCompletedPlanFallbackConclusion('s1', false, 'zh-CN');

    expect(fallback).toContain('## 综合结论');
    expect(fallback).toContain('主要瓶颈是 ChaosTask self=456ms');
    expect(fallback).toContain('## 关键证据链');
    expect(fallback).toContain('## 根因拆解');
    expect(fallback).toContain('art-30');
    expect(fallback).not.toContain('## 分阶段证据摘要');
    expect(fallback).not.toContain('模型未生成独立最终段落');
  });

  it('recognizes provider stream termination as recoverable', () => {
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('terminated'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('stream terminated before completion'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('socket hang up'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('rate limit exceeded'))).toBe(false);
  });

  it('builds partial phase-summary fallback for interrupted incomplete plans', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'completed'), phase('p3', 'pending')]),
      history: [],
    });

    const fallback = runtime.buildPlanPhaseSummaryFallbackConclusion('s1', false, 'zh');

    expect(fallback).toContain('OpenAI 流在计划完成前中断');
    expect(fallback).toContain('p1 Phase p1');
    expect(fallback).toContain('p2 Phase p2');
    expect(fallback).toContain('未完成阶段：p3:Phase p3');
  });

  it('records max-turns partial results into session context', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const addTurn = jest.fn();
    const updateWorkingMemoryFromConclusion = jest.fn();
    const updates: any[] = [];
    runtime.on('update', (update: any) => updates.push(update));

    const result = runtime.recordMaxTurnsPartialResult({
      error: new Error('Max turns exceeded'),
      query: '分析卡顿',
      sessionId: 's-max',
      outputLanguage: 'zh-CN',
      accumulatedAnswer: '## 综合结论\n\nOpenAI 已收集到部分证据，但达到轮次上限。',
      context: {
        hypotheses: [],
        previousTurns: [{ id: 'prev' }],
        sessionContext: {
          addTurn,
          updateWorkingMemoryFromConclusion,
        },
      },
      startTime: Date.now() - 1000,
      rounds: 5,
      quickMode: false,
      maxTurns: 1,
    });

    expect(result.partial).toBe(true);
    expect(result.terminationReason).toBe('max_turns');
    expect(addTurn).toHaveBeenCalledWith(
      '分析卡顿',
      expect.objectContaining({ complexity: 'complex', followUpType: 'extend' }),
      expect.objectContaining({
        agentId: 'openai-agent',
        partial: true,
        terminationReason: 'max_turns',
      }),
      result.findings,
    );
    expect(updateWorkingMemoryFromConclusion).not.toHaveBeenCalled();
    expect(updates.some(update => update.type === 'conclusion')).toBe(true);
    expect(updates.some(update => update.type === 'answer_token' && update.content?.done === true)).toBe(true);
    expect(updates.some(update => (
      update.type === 'degraded' &&
      String(update.content?.message).includes('当前上限 1 turns')
    ))).toBe(true);
  });
});

describe('OpenAIRuntime previous response recovery', () => {
  it('keeps quick mode off the remote OpenAI response chain', () => {
    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: true,
      config: {
        protocol: 'responses',
        outputLanguage: 'en',
      } as any,
      sessionEntry: {
        history: [{ role: 'user', content: 'full-mode history' }],
        lastResponseId: 'resp_full',
        updatedAt: Date.now(),
      },
      effectivePrompt: 'what is the package name?',
      previousTurns: [{
        id: 'turn-1',
        timestamp: Date.now(),
        query: 'analyze startup',
        intent: {} as any,
        result: { message: 'Startup report with TTID=1912ms' },
        findings: [{ title: 'TTID high', severity: 'medium' }],
        turnIndex: 0,
        completed: true,
      }],
    });

    expect(resolved.previousResponseId).toBeUndefined();
    expect(resolved.shouldPersistRemoteSession).toBe(false);
    expect(resolved.input).toEqual(expect.stringContaining('## Recent Conversation Context'));
    expect(resolved.input).toEqual(expect.stringContaining('what is the package name?'));
    expect(resolved.input).not.toEqual(expect.stringContaining('full-mode history'));
  });

  it('uses fresh previous response ids only for full-mode OpenAI runs', () => {
    const now = 1_700_000_000_000;

    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: false,
      config: {
        protocol: 'responses',
        outputLanguage: 'en',
      } as any,
      sessionEntry: {
        history: [{ role: 'user', content: 'previous question' }],
        lastResponseId: 'resp_fresh',
        updatedAt: now - 1_000,
      },
      effectivePrompt: 'continue',
      previousTurns: [],
      now,
    });

    expect(resolved.input).toBe('continue');
    expect(resolved.previousResponseId).toBe('resp_fresh');
    expect(resolved.shouldPersistRemoteSession).toBe(true);
  });

  it('recognizes stale previous response errors from OpenAI Responses', () => {
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('No response found with id resp_old_123'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('previous_response_id does not exist'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('rate limit exceeded'),
      'resp_old_123',
    )).toBe(false);
  });

  it('does not expose stale OpenAI response mappings for persistence', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionMap.set('s1', {
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears stale previous response ids while preserving local history', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_stale',
      runState: '{"state":true}',
      updatedAt: Date.now(),
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      runtime.forgetOpenAILastResponseId('s1', 'No response found with id resp_stale');
    } finally {
      warnSpy.mockRestore();
    }

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      history,
      lastResponseId: undefined,
      runState: undefined,
    }));
  });

  it('does not persist stale OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionMap.set('s1', {
      history: [{ role: 'user', content: 'previous question' }],
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.openAILastResponseId).toBeUndefined();
      expect(snapshot.openAIHistory).toBeUndefined();
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
      }));
      expect(snapshot.engineState?.openai.lastResponseId).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_fresh',
      runState: '{"state":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('resp_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"state":true}');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        openai: {
          history,
          lastResponseId: 'resp_fresh',
          runState: '{"state":true}',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    const history = [{ role: 'user', content: 'previous comparison question' }];
    runtime.sessionMap.set('s1:ref:trace-b', {
      history,
      lastResponseId: 'resp_compare_fresh',
      runState: '{"compare":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        referenceTraceId: 'trace-b',
        comparisonSource: 'raw_trace_pair',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.referenceTraceId).toBe('trace-b');
      expect(snapshot.comparisonSource).toBe('raw_trace_pair');
      expect(snapshot.sdkSessionId).toBe('resp_compare_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_compare_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"compare":true}');
      expect(snapshot.engineState?.kind).toBe('openai-agents-sdk');
      expect(snapshot.engineState?.openai.lastResponseId).toBe('resp_compare_fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('restores OpenAI response mappings with the snapshot timestamp', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      engineState: {
        kind: 'openai-agents-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        openai: {
          history: [{ role: 'user', content: 'previous question' }],
          lastResponseId: 'resp_old',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_old',
      updatedAt: snapshotTimestamp,
    }));
  });

  it('restores comparison OpenAI response mappings under the comparison key', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      referenceTraceId: 'trace-b',
      comparisonSource: 'raw_trace_pair',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      openAIHistory: [{ role: 'user', content: 'previous comparison question' }],
      openAILastResponseId: 'resp_compare_old',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toBeUndefined();
    expect(runtime.sessionMap.get('s1:ref:trace-b')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_compare_old',
      updatedAt: snapshotTimestamp,
    }));
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_old');
  });

  it('restores explicit OpenAI session mappings under the comparison key', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    runtime.restoreSessionMapping('s1', 'resp_compare_restored', 'trace-b');

    expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_restored');
  });
});
