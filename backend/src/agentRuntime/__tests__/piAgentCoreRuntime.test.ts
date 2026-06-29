// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import type { StreamingUpdate } from '../../agent/types';
import {
  completePiAgentCoreFinalReportPhaseIfDelivered,
  createPiAgentCoreToolFromSharedSpec,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  getPiAgentCorePlanCompletionStatus,
  getPiAgentCoreEngineCapabilities,
  PI_AGENT_CORE_FAKE_STREAM_ENV,
  PI_AGENT_CORE_MODEL_JSON_ENV,
  PiAgentCoreRuntime,
  projectPiAgentCoreEventToStreamingUpdate,
  repairPiAgentCoreSubmitPlanArgs,
  sanitizePiAgentCoreConclusionText,
  shouldContinuePiAgentCoreFinalReportAfterPlanComplete,
  type PiAgentCoreEvent,
} from '../piAgentCoreRuntime';
import type { RuntimeToolResult, SharedToolSpec } from '../runtimeToolSpec';

class FakePiAgent {
  static instances: FakePiAgent[] = [];
  static promptMessages: unknown[] | undefined;

  state = {
    messages: [] as unknown[],
    tools: [] as unknown[],
    systemPrompt: '',
    model: undefined as unknown,
  };

  private readonly listeners: Array<(event: PiAgentCoreEvent) => void> = [];
  readonly options?: Record<string, unknown>;
  lastPrompt = '';

  constructor(options?: Record<string, unknown>) {
    this.options = options;
    FakePiAgent.instances.push(this);
    const initialState = options?.initialState as {
      tools?: unknown[];
      systemPrompt?: string;
      model?: unknown;
      messages?: unknown[];
    } | undefined;
    this.state.tools = initialState?.tools ?? [];
    this.state.systemPrompt = initialState?.systemPrompt ?? '';
    this.state.model = initialState?.model;
    this.state.messages = [...(initialState?.messages ?? [])];
  }

  subscribe(listener: (event: PiAgentCoreEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async prompt(input: string): Promise<void> {
    this.lastPrompt = input;
    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Pi smoke final' }],
    };
    const messages = FakePiAgent.promptMessages ?? [assistantMessage];
    this.emit({ type: 'agent_start' });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', text: 'Pi smoke final' },
    });
    this.state.messages.push(...messages);
    this.emit({ type: 'agent_end', messages: this.state.messages });
  }

  abort(): void {}

  reset(): void {
    this.state.messages = [];
  }

  private emit(event: PiAgentCoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

beforeEach(() => {
  FakePiAgent.instances = [];
  FakePiAgent.promptMessages = undefined;
});

function createFakeTraceProcessorService() {
  return {
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    getTrace: jest.fn(() => ({
      id: 'trace-pi',
      filename: 'trace.pftrace',
      size: 1,
      uploadTime: new Date(),
      status: 'ready',
      traceOs: 'android',
      traceFormat: 'perfetto_protobuf',
    })),
  } as any;
}

const PI_TEST_MODEL_JSON = JSON.stringify({
  id: 'pi-test-model',
  name: 'Pi Test Model',
  api: 'smartperfetto-test',
  provider: 'smartperfetto',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
  apiKey: 'sk-pi-test-secret',
});

function createSharedSpec(handler?: SharedToolSpec['handler']): SharedToolSpec {
  return {
    name: 'query_trace',
    description: 'Run a trace SQL query',
    exposure: 'public',
    inputSchema: {
      sql: z.string().describe('SQL query'),
      params: z.record(z.string(), z.any()).optional(),
    },
    handler: handler ?? (async () => ({
      content: [{ type: 'text', text: 'ok' }],
    } as RuntimeToolResult)),
  };
}

function createSnapshotFields(): any {
  return {
    conversationSteps: [],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    runSequence: 1,
    conversationOrdinal: 0,
  };
}

describe('experimental Pi agent-core runtime contract', () => {
  it('describes Pi agent-core as hidden, optional, sequential, and no shell/file tool runtime', () => {
    expect(getPiAgentCoreEngineCapabilities()).toEqual({
      kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      displayName: 'Experimental Pi Agent Core',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });

  it('adapts shared SmartPerfetto tools into request-scoped Pi-like tools', async () => {
    const handler = jest.fn(async (
      _args: Record<string, unknown>,
      _extra: unknown,
    ) => ({
      content: [{ type: 'text', text: '42' }],
    } as RuntimeToolResult));
    const spec = createSharedSpec(handler);
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      runtimeKind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
    });
    const updates: unknown[] = [];
    const controller = new AbortController();

    expect(tool).toMatchObject({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      executionMode: 'sequential',
    });
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        sql: { type: 'string' },
      },
    });
    await expect(tool.execute(
      'call-1',
      { sql: 'select 1', params: '{"pid":123}' },
      controller.signal,
      (update) => updates.push(update),
    )).resolves.toMatchObject({
      content: [{ type: 'text', text: '42' }],
    });
    expect(handler).toHaveBeenCalledWith(
      { sql: 'select 1', params: { pid: 123 } },
      expect.objectContaining({
        runtime: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
        toolCallId: 'call-1',
        signal: controller.signal,
      }),
    );
    expect(updates).toEqual([
      { type: 'smartperfetto_tool_started', toolCallId: 'call-1', toolName: spec.name },
      { type: 'smartperfetto_tool_finished', toolCallId: 'call-1', toolName: spec.name },
    ]);
  });

  it('records Pi tool executions into the shared analysis plan evidence log', async () => {
    const plan = {
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '完整解释代表掉帧根因',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const spec: SharedToolSpec = {
      name: 'invoke_skill',
      description: 'Invoke a SmartPerfetto skill',
      exposure: 'public',
      inputSchema: {
        skillId: z.string(),
        params: z.record(z.string(), z.any()).optional(),
      },
      handler: jest.fn(async () => ({
        content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
      } as RuntimeToolResult)),
    };
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      runtimeKind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      analysisPlan: { current: plan },
    });

    await tool.execute(
      'call-frame-detail',
      { skillId: 'jank_frame_detail', params: { frameId: 59665219 } },
      undefined,
    );

    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        inputSummary: 'jank_frame_detail(frameId)',
        matchedPhaseId: 'p-frame-detail',
      }),
    ]);
  });

  it('repairs recoverable Pi submit_plan argument drift before shared tool validation', () => {
    const repaired = repairPiAgentCoreSubmitPlanArgs({
      phases: [
        {
          id: 'p1',
          name: '架构确认 + 概览采集',
          goal: '确认渲染架构并采集滑动帧概览',
          expectedTools: ['invoke_skill'],
        },
        { id: 'p2' },
      ],
      goal: '对主要掉帧根因类型进行机制级深钻',
      expectedTools: ['invoke_skill', 'fetch_artifact'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
      waivers: [{ aspectId: 'unsupported', reason: 'trace 不包含该场景所需的可验证事件，因此本轮无法覆盖。' }],
    });

    expect(repaired).toEqual({
      phases: [
        {
          id: 'p1',
          name: '架构确认 + 概览采集',
          goal: '确认渲染架构并采集滑动帧概览',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        },
        {
          id: 'p2',
          name: 'p2',
          goal: '对主要掉帧根因类型进行机制级深钻',
          expectedTools: ['invoke_skill', 'fetch_artifact'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        },
      ],
      successCriteria: '对主要掉帧根因类型进行机制级深钻',
      waivers: [{ aspectId: 'unsupported', reason: 'trace 不包含该场景所需的可验证事件，因此本轮无法覆盖。' }],
    });
    expect(repaired).not.toHaveProperty('goal');
  });

  it('fails closed when a shared tool is not request-allowed', () => {
    expect(() => createPiAgentCoreToolFromSharedSpec(createSharedSpec(), {
      allowedToolNames: new Set(['other_tool']),
    })).toThrow('Pi agent-core tool is not allowed in this request: query_trace');
  });

  it('describes the public Pi agent-core runtime as provider-pinnable but capability-limited', () => {
    expect(getPiAgentCoreEngineCapabilities('pi-agent-core')).toEqual({
      kind: 'pi-agent-core',
      displayName: 'Pi Agent Core',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });

  it('projects Pi agent-core events without synthesizing route terminal events', () => {
    const updates = [
      projectPiAgentCoreEventToStreamingUpdate({ type: 'agent_start' }, 1),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', text: 'hello' },
      }, 2),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'tool_execution_start',
        toolName: 'query_trace',
        toolCallId: 'call-1',
        args: { sql: 'select 1' },
      }, 3),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'tool_execution_end',
        toolName: 'query_trace',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'ok' }] },
      }, 4),
      projectPiAgentCoreEventToStreamingUpdate({ type: 'agent_end' }, 4),
    ].filter(Boolean) as StreamingUpdate[];

    expect(updates.map((update) => update.type)).toEqual([
      'progress',
      'agent_task_dispatched',
      'agent_response',
      'progress',
    ]);
    expect(updates.map((update) => update.type)).not.toContain('analysis_completed');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
    expect(updates.map((update) => update.type)).not.toContain('thought');
    expect(updates.map((update) => update.type)).not.toContain('tool_call');
    expect(updates[1].content).toMatchObject({
      taskId: 'call-1',
      toolName: 'query_trace',
      args: { sql: 'select 1' },
    });
    expect(updates[2].content).toMatchObject({
      taskId: 'call-1',
      result: 'ok',
    });
  });

  it('filters Pi message deltas so tool args and reasoning are not logged as visible text', () => {
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        text: 'Let me inspect the trace.',
      },
    })).toBeUndefined();
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        text: '{"sql":"SELECT * FROM slice"}',
      },
    })).toBeUndefined();
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        partial: {
          role: 'assistant',
          content: [{ type: 'text', text: 'cumulative partial' }],
        },
      },
    })).toBeUndefined();
  });

  it('projects Pi assistant execution errors from terminal SDK messages', () => {
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'No API provider registered for api: openai-compatible',
      },
      toolResults: [],
    }, 7)).toEqual({
      type: 'error',
      content: {
        module: 'pi-agent-core',
        message: 'No API provider registered for api: openai-compatible',
      },
      timestamp: 7,
    });
  });

  it('runs a hidden smoke analysis with an injected Pi agent-core module', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND, source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    await expect(runtime.analyze('analyze startup', 'session-pi', 'trace-pi')).resolves.toMatchObject({
      sessionId: 'session-pi',
      success: true,
      conclusion: 'Pi smoke final',
      claimSupport: [],
      claimVerificationResult: {
        status: 'not_checked',
        checkedClaimCount: 0,
        unsupportedClaimCount: 0,
      },
      identityResolutions: [],
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(updates.map((update) => update.type)).toEqual([
      'progress',
      'progress',
      'progress',
    ]);
    expect(updates.map((update) => update.type)).not.toContain('analysis_completed');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
  });

  it('runs a public Pi smoke analysis with public-preview termination metadata', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );

    await expect(runtime.analyze('analyze startup', 'session-pi', 'trace-pi')).resolves.toMatchObject({
      sessionId: 'session-pi',
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
      terminationMessage: 'Pi agent-core runtime completed through the capability-limited public preview path.',
    });
  });

  it('builds a real Pi analysis context from shared SmartPerfetto prompt and tools', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );
    runtime.restoreArchitectureCache('trace-pi', {
      type: 'WEBVIEW',
      confidence: 0.67,
      evidence: [],
    });
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    const result = await runtime.analyze('分析启动性能', 'session-pi-real', 'trace-pi', {
      analysisMode: 'full',
    });
    const agent = FakePiAgent.instances[0];
    const toolNames = agent.state.tools.map((tool: any) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'execute_sql',
      'invoke_skill',
      'lookup_sql_schema',
      'submit_plan',
      'update_plan_phase',
      'submit_hypothesis',
      'resolve_hypothesis',
    ]));
    expect(agent.state.systemPrompt.length).toBeGreaterThan(500);
    expect(agent.lastPrompt).toContain('分析启动性能');
    expect(JSON.stringify(agent.state.model)).not.toContain('sk-pi-test-secret');
    expect((agent.state.model as any).apiKey).toBeUndefined();
    expect(result).toMatchObject({
      sessionId: 'session-pi-real',
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.claimSupport).toBeUndefined();
    expect(result.identityResolutions).toBeUndefined();
    expect(updates.map((update) => update.type)).toContain('architecture_detected');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
  });

  it('hydrates Pi agent-core transcript state from opaque snapshots on follow-up', async () => {
    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First Pi answer' }],
      },
    ];
    const firstRuntime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );

    await firstRuntime.analyze('first question', 'session-pi-resume', 'trace-pi', {
      analysisMode: 'fast',
    });
    const snapshot = firstRuntime.takeSnapshot(
      'session-pi-resume',
      'trace-pi',
      createSnapshotFields(),
    );

    expect(snapshot.engineState?.kind).toBe('pi-agent-core');
    const piOpaque = snapshot.engineState?.kind === 'pi-agent-core'
      ? snapshot.engineState.pi.opaque
      : undefined;
    expect(piOpaque?.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First Pi answer' }],
      },
    ]);

    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second Pi answer' }],
      },
    ];
    const secondRuntime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );
    secondRuntime.restoreFromSnapshot('session-pi-resume', 'trace-pi', snapshot);

    await secondRuntime.analyze('follow-up question', 'session-pi-resume', 'trace-pi', {
      analysisMode: 'fast',
    });

    const restoredAgent = FakePiAgent.instances[1];
    expect(restoredAgent.options).toMatchObject({
      initialState: expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First Pi answer' }],
          },
        ],
      }),
    });
    expect(restoredAgent.lastPrompt).toBe('follow-up question');
  });

  it('keeps Pi quick mode on shared core tools without preview verification metadata', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );

    const result = await runtime.analyze('这个 trace 的应用包名是什么？', 'session-pi-quick', 'trace-pi', {
      analysisMode: 'fast',
    });
    const agent = FakePiAgent.instances[0];
    const toolNames = agent.state.tools.map((tool: any) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'execute_sql',
      'invoke_skill',
      'lookup_sql_schema',
    ]));
    expect(toolNames).not.toContain('submit_plan');
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.terminationReason).toBeUndefined();
  });

  it('keeps the final report when Pi emits trailing bookkeeping assistant text', async () => {
    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
        }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'All phases are complete. The analysis is done.' }],
      },
    ];
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
      },
    );

    const result = await runtime.analyze('分析启动性能', 'session-pi-report', 'trace-pi', {
      analysisMode: 'fast',
    });

    expect(result.conclusion).toContain('# 启动性能分析报告');
    expect(result.conclusion).toContain('ChaosTask');
    expect(result.conclusion).not.toContain('All phases are complete');
  });

  it('strips Pi process narration before a deliverable final report heading', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'I have all the necessary knowledge and data. Now let me write the comprehensive final report.\n\n' +
      'Key findings: cold startup is dominated by ChaosTask.\n\n' +
      '# 启动性能分析报告\n\n' +
      '## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('# 启动性能分析报告')).toBe(true);
    expect(report).toContain('ChaosTask');
    expect(report).not.toContain('I have all the necessary');
    expect(report).not.toContain('Key findings:');
  });

  it('auto-closes the final Pi report phase when the complete report is delivered', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动概览采集',
          goal: '获取启动事件',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已获取 startup_analysis 关键启动事件、TTID 和冷启动类型证据。',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '基于根因诊断决策树，输出完整结构化报告',
          expectedTools: ['lookup_knowledge'],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '输出完整结构化报告',
      submittedAt: 1,
      toolCallLog: [],
    } as any;

    const closed = completePiAgentCoreFinalReportPhaseIfDelivered(
      plan,
      '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
      'zh-CN',
      () => 1234,
    );

    expect(closed?.id).toBe('p3');
    expect(plan.phases[1]).toMatchObject({
      status: 'completed',
      completedAt: 1234,
    });
    expect(plan.phases[1].summary.length).toBeGreaterThanOrEqual(15);
    expect(getPiAgentCorePlanCompletionStatus(plan).complete).toBe(true);
  });

  it('does not treat a completed Pi phase as closed when required tool evidence is missing', () => {
    const plan = {
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'completed',
          summary: '已完成代表帧根因分析，并整理出主线程阻塞调用栈证据。',
        },
      ],
      successCriteria: '完整解释代表掉帧根因',
      submittedAt: 1,
      toolCallLog: [],
    } as any;

    const status = getPiAgentCorePlanCompletionStatus(plan);

    expect(status.complete).toBe(false);
    expect(status.pendingPhases.map(phase => phase.id)).toEqual(['p-frame-detail']);
    expect(status.evidenceGaps?.[0].missingExpectedCalls).toEqual([
      { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
    ]);
  });

  it('continues Pi final report generation when completed plan still misses the scene contract', () => {
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(shouldContinuePiAgentCoreFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
      conclusion: [
        '# 滑动性能分析报告',
        '',
        '## 1. 概览',
        '真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 全帧根因分布',
        '| 根因 | 帧数 | 占比 |',
        '| --- | ---: | ---: |',
        '| animation 同步阻塞 | 6 | 86% |',
      ].join('\n'),
    })).toBe(true);
  });

  it('does not continue Pi final report generation once the scene contract is satisfied', () => {
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(shouldContinuePiAgentCoreFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
      conclusion: [
        '# 滑动性能分析报告',
        '',
        '## 1. 概览',
        '真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 全帧根因分布',
        '| 根因 | 帧数 | 占比 |',
        '| --- | ---: | ---: |',
        '| animation 同步阻塞 | 6 | 86% |',
        '',
        '### 代表帧分析',
        '- 代表帧 frame_id=59665219：帧耗时 62.73ms，vsync_missed=7，超预算 54.4ms。关键 slice 为 CustomScroll_longFrameLoad 59.01ms。[Evidence:data:skill:scrolling_analysis:batch_frame_root_cause:test]',
        '',
        '### 峰值/口径指标',
        '- 真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 优化建议',
        '- 将 animation 回调里的同步重活拆分到后台线程，并用分帧提交结果；该建议直接覆盖 6/7 个掉帧样本。',
      ].join('\n'),
    })).toBe(false);
  });

  it('does not auto-close Pi final phase while earlier phases remain pending', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动概览采集',
          goal: '获取启动事件',
          expectedTools: ['invoke_skill'],
          status: 'pending',
          summary: '',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整结构化报告',
          expectedTools: ['lookup_knowledge'],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '输出完整结构化报告',
      submittedAt: 1,
      toolCallLog: [],
    } as any;

    const closed = completePiAgentCoreFinalReportPhaseIfDelivered(
      plan,
      '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
      'zh-CN',
      () => 1234,
    );

    expect(closed).toBeUndefined();
    expect(getPiAgentCorePlanCompletionStatus(plan).complete).toBe(false);
  });
});
