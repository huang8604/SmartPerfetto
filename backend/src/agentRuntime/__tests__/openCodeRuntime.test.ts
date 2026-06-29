// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OpenCodeRuntime,
  completeOpenCodeFinalReportPhaseIfDelivered,
  createOpenCodeHardenedConfig,
  createOpenCodeStandaloneMcpConfig,
  createOpenCodeStandaloneMcpToolNames,
  createOpenCodeToolAllowlist,
  dispatchOpenCodeBridgeRequest,
  extractOpenCodeAssistantText,
  getOpenCodePlanCompletionStatus,
  getOpenCodeEngineCapabilities,
  getOpenCodeRuntimeDiagnostics,
  __testing as openCodeTesting,
  projectOpenCodeEventToStreamingUpdate,
  runOpenCodePrompt,
  type OpenCodeSdkModuleLoader,
} from '../openCodeRuntime';
import type { RuntimeFactoryInput } from '../runtimeRegistry';
import { createTraceProcessorQueryCancelledError } from '../../services/traceProcessorCancellation';

function createFakeRuntimeInput(): RuntimeFactoryInput {
  return {
    traceProcessorService: {} as any,
    selection: {
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      source: 'env',
    },
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

async function withBackendDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-state-'));
  const previous = process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
    else process.env.SMARTPERFETTO_BACKEND_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createFakeModuleLoader(record: {
  createOptions?: Record<string, unknown>;
  promptInput?: unknown;
  closeCount: number;
}): OpenCodeSdkModuleLoader {
  return jest.fn(async () => ({
    createOpencode: jest.fn(async (options?: Record<string, unknown>) => {
      record.createOptions = options;
      return {
        server: {
          url: 'http://127.0.0.1:4106',
          close: jest.fn(() => {
            record.closeCount += 1;
          }),
        },
        client: {
          session: {
            create: jest.fn(async () => ({ data: { id: 'ses-opencode-test' } })),
            prompt: jest.fn(async (input: unknown) => {
              record.promptInput = input;
              return { data: { info: { role: 'user' }, parts: [] } };
            }),
          },
        },
      };
    }),
  }));
}

describe('experimental OpenCode runtime contract', () => {
  it('describes OpenCode as hidden, server-backed, JSON Schema, and no shell/file tools', () => {
    expect(getOpenCodeEngineCapabilities()).toEqual({
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      displayName: 'Experimental OpenCode',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });

  it('hardens OpenCode config and disables dangerous built-in tools', () => {
    const config = createOpenCodeHardenedConfig(['smartperfetto_query_trace']);

    expect(config).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      instructions: [],
      mcp: {},
      lsp: false,
      formatter: false,
      permission: {
        edit: 'deny',
        bash: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      grep: false,
      glob: false,
      edit: false,
      write: false,
      apply_patch: false,
      webfetch: false,
      websearch: false,
      skill: false,
      todowrite: false,
      question: false,
      smartperfetto_query_trace: true,
    });
    expect((config.agent as any).smartperfetto.tools).toMatchObject(
      config.tools as Record<string, unknown>,
    );
  });

  it('adds standalone public MCP only behind the hidden OpenCode MCP gate', () => {
    expect(createOpenCodeStandaloneMcpConfig({})).toEqual({});

    const config = createOpenCodeHardenedConfig([], {
      SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP: '1',
      SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["/usr/bin/node","/tmp/smartperfetto-mcp.js"]',
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '7777',
    });

    expect(config.mcp).toEqual({
      smartperfetto: {
        type: 'local',
        enabled: true,
        timeout: 7777,
        command: ['/usr/bin/node', '/tmp/smartperfetto-mcp.js'],
        environment: {
          SMARTPERFETTO_STANDALONE_MCP: '1',
        },
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      edit: false,
      write: false,
      apply_patch: false,
      lookup_blog_knowledge: true,
      smartperfetto_lookup_blog_knowledge: true,
      mcp__smartperfetto__lookup_blog_knowledge: true,
    });
  });

  it('uses the engine-local OpenCode MCP bridge child in source mode', () => {
    const command = openCodeTesting.resolveOpenCodeBridgeCommand({});

    expect(command[0]).toContain('tsx');
    expect(command[1]).toBe(path.resolve(
      process.cwd(),
      'src/agentRuntime/engines/opencode/openCodeMcpBridgeChild.ts',
    ));
  });

  it('enumerates conservative standalone MCP tool-name variants for OpenCode', () => {
    expect(createOpenCodeStandaloneMcpToolNames()).toEqual(
      expect.arrayContaining([
        'lookup_blog_knowledge',
        'smartperfetto_lookup_blog_knowledge',
        'mcp__smartperfetto__lookup_blog_knowledge',
        'recall_similar_case',
        'smartperfetto_recall_similar_case',
        'mcp__smartperfetto__recall_similar_case',
      ]),
    );
  });

  it('builds per-request tool allowlists by denying built-ins first', () => {
    expect(createOpenCodeToolAllowlist(['smartperfetto_query_trace'])).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      read: false,
      apply_patch: false,
      smartperfetto_query_trace: true,
    });
  });

  it('extracts final assistant text without leaking user prompts or reasoning', () => {
    const response = {
      data: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: '用户原始问题，不应作为报告' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'internal reasoning should not leak' },
            { type: 'text', text: '最终报告正文' },
            { type: 'step-finish' },
          ],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe('最终报告正文');
  });

  it('prefers a full assistant report over a later short assistant summary', () => {
    const fullReport = [
      '# 启动性能分析报告',
      '',
      '## 结论',
      '这是 OpenCode 生成的完整报告正文。',
      '',
      '## 证据',
      '- smartperfetto_query_trace 返回了启动阶段证据。',
      '',
      '## 建议',
      '继续保留完整证据链。',
    ].join('\n');
    const response = {
      data: [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: fullReport }],
        },
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: '分析完成，完整报告已经生成。' }],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe(fullReport);
  });

  it('uses OpenCode promptAsync and polls completed assistant messages', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: '异步最终报告' }],
          },
        ],
      });
    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith({
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project', limit: 50, order: 'asc' },
    });
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('异步最终报告');
  });

  it('does not return an assistant message that existed before the async prompt', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const oldAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-old' },
      parts: [{ type: 'text', text: '上一轮旧报告' }],
    };
    const newAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-new' },
      parts: [{ type: 'text', text: '本轮新报告' }],
    };
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [oldAssistant, newAssistant] });

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '继续分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 4_000,
    });

    expect(messages).toHaveBeenCalledTimes(3);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('本轮新报告');
  });

  it('emits SmartPerfetto tool dispatch and response events from the OpenCode MCP bridge', async () => {
    const updates: any[] = [];
    const handler = jest.fn(async (args: Record<string, unknown>, extra: any) => ({
      content: [{ type: 'text', text: `ran ${args.sql} aborted=${extra.signal?.aborted ?? null}` }],
    }));
    const controller = new AbortController();
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler,
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-1',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    }, update => updates.push(update), {
      getSignal: () => controller.signal,
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-1',
      result: {
        content: [{ type: 'text', text: 'ran select 1 aborted=false' }],
      },
    });
    expect(handler).toHaveBeenCalledWith(
      { sql: 'select 1' },
      { runtime: 'opencode', signal: controller.signal },
    );
    expect(updates).toEqual([
      expect.objectContaining({
        type: 'agent_task_dispatched',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          toolName: 'smartperfetto_query_trace',
          args: { sql: 'select 1' },
        }),
      }),
      expect.objectContaining({
        type: 'agent_response',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          result: 'ran select 1 aborted=false',
        }),
      }),
    ]);
  });

  it('records OpenCode MCP bridge tool executions into the shared analysis plan evidence log', async () => {
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
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'invoke_skill',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => ({
            content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
          })),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__invoke_skill',
        arguments: { skillId: 'jank_frame_detail', params: { frameId: 59665219 } },
      },
    }, undefined, {
      analysisPlan: { current: plan },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      result: {
        content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
      },
    });
    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        inputSummary: 'jank_frame_detail(frameId)',
        matchedPhaseId: 'p-frame-detail',
      }),
    ]);
  });

  it('rethrows bridge tool cancellation instead of returning a JSON-RPC tool error', async () => {
    await expect(dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => {
            throw createTraceProcessorQueryCancelledError();
          }),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-cancel',
      method: 'tools/call',
      params: {
        name: 'smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats completed and skipped OpenCode plan phases as closed', () => {
    expect(getOpenCodePlanCompletionStatus({
      phases: [
        { id: 'p1', status: 'completed', summary: '已完成概览采集并记录关键证据。' },
        { id: 'p2', status: 'skipped', summary: '已确认该阶段在当前 trace 中不可验证并跳过。' },
      ],
    } as any)).toMatchObject({ complete: true, pending: [] });

    expect(getOpenCodePlanCompletionStatus({
      phases: [
        { id: 'p1', status: 'completed', summary: '已完成概览采集并记录关键证据。' },
        { id: 'p2', status: 'in_progress' },
      ],
    } as any)).toMatchObject({ complete: false, pending: ['p2'] });
  });

  it('does not treat a completed OpenCode phase as closed when required tool evidence is missing', () => {
    const status = getOpenCodePlanCompletionStatus({
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
      toolCallLog: [],
    } as any);

    expect(status).toMatchObject({
      complete: false,
      pending: ['p-frame-detail'],
    });
    expect(status.evidenceGaps?.[0].missingExpectedCalls).toEqual([
      { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
    ]);
  });

  it('auto-closes only the final OpenCode report phase after a deliverable report is present', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '概览采集',
          goal: '采集滑动概览',
          status: 'completed',
          summary: '已采集滑动概览、掉帧数量和最长帧耗时等关键证据。',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整分析报告',
          status: 'in_progress',
        },
      ],
    } as any;
    const report = [
      '# 滑动性能分析报告',
      '',
      '## 代表帧分析',
      '- evidence/source: art-frame-detail 显示主线程阻塞 18.2ms。',
      '',
      '## 优化建议',
      '- 将长任务拆分到异步阶段。',
    ].join('\n');

    const closed = completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 42);

    expect(closed?.id).toBe('p3');
    expect(plan.phases[1]).toMatchObject({
      status: 'completed',
      completedAt: 42,
      summary: expect.stringContaining('最终报告已由 OpenCode 直接交付'),
    });
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({ complete: true, pending: [] });
  });

  it('does not auto-close OpenCode phases when earlier work is still pending', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '概览采集',
          goal: '采集滑动概览',
          status: 'in_progress',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整分析报告',
          status: 'in_progress',
        },
      ],
    } as any;
    const report = '# 滑动性能分析报告\n\n## 代表帧分析\n- evidence/source: art-frame-detail';

    expect(completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 42)).toBeUndefined();
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({ complete: false, pending: ['p1', 'p3'] });
  });

  it('projects OpenCode events without synthesizing route terminal events', () => {
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.text.delta.1',
      data: { delta: 'hello' },
    }, 10)).toEqual({
      type: 'answer_token',
      content: 'hello',
      timestamp: 10,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.called.1',
      data: {
        tool: 'smartperfetto_query_trace',
        callID: 'call-1',
        input: { sql: 'select 1' },
      },
    }, 11)).toMatchObject({
      type: 'tool_call',
      content: {
        name: 'smartperfetto_query_trace',
        callId: 'call-1',
        runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      },
      timestamp: 11,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.failed.1',
      data: { tool: 'bash', error: { message: 'denied' } },
    }, 12)).toMatchObject({
      type: 'degraded',
      content: {
        source: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
        reason: 'tool_failed',
        tool: 'bash',
      },
      timestamp: 12,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'analysis_completed',
      data: {},
    })).toBeUndefined();
  });

  it('runs hidden no-reply smoke with isolated config and closes the server', async () => {
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
      env: {
        SMARTPERFETTO_OPENCODE_SERVER_PORT: '4106',
        SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '12345',
      },
      moduleLoader: createFakeModuleLoader(record),
    });
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '分析启动性能',
      'session-opencode',
      'trace-opencode',
      { analysisMode: 'full', packageName: 'com.example' },
    );

    expect(result).toMatchObject({
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(result.conclusion).toContain('OpenCode hidden runtime smoke completed');
    expect(record.closeCount).toBe(1);
    expect(record.createOptions).toMatchObject({
      hostname: '127.0.0.1',
      port: 4106,
      timeout: 12345,
      config: expect.objectContaining({
        share: 'disabled',
        snapshot: false,
        instructions: [],
        mcp: {},
      }),
    });
    expect(record.promptInput).toMatchObject({
      path: { id: 'ses-opencode-test' },
      body: {
        noReply: true,
        tools: expect.objectContaining({
          bash: false,
          edit: false,
          write: false,
          apply_patch: false,
        }),
      },
    });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
    ]));
  });

  it('hydrates OpenCode opaque session state and prompts the restored session', async () => {
    await withBackendDataDir(async (dataDir) => {
      const firstRecord = {
        closeCount: 0,
        createInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const firstRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencode: jest.fn(async () => {
            firstRecord.homeAtCreate = process.env.HOME;
            firstRecord.configAtCreate = process.env.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4106',
                close: jest.fn(() => {
                  firstRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  create: jest.fn(async (input: unknown) => {
                    firstRecord.createInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    firstRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });

      await firstRuntime.analyze('first OpenCode question', 'session-opencode-resume', 'trace-opencode');
      const snapshot = firstRuntime.takeSnapshot(
        'session-opencode-resume',
        'trace-opencode',
        createSnapshotFields(),
      );
      const opaque = snapshot.engineState?.kind === 'opencode'
        ? snapshot.engineState.opencode.opaque
        : undefined;

      expect(opaque).toMatchObject({
        version: 1,
        openCodeSessionId: 'ses-opencode-original',
      });
      expect(opaque?.projectDir).toContain(dataDir);
      expect(opaque?.homeDir).toContain(dataDir);
      expect(opaque?.configDir).toContain(dataDir);
      expect(firstRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(firstRecord.configAtCreate).toBe(opaque?.configDir);

      const restoredRecord = {
        closeCount: 0,
        createCalls: 0,
        getInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencode: jest.fn(async () => {
            restoredRecord.homeAtCreate = process.env.HOME;
            restoredRecord.configAtCreate = process.env.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4107',
                close: jest.fn(() => {
                  restoredRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  get: jest.fn(async (input: unknown) => {
                    restoredRecord.getInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  create: jest.fn(async () => {
                    restoredRecord.createCalls += 1;
                    return { data: { id: 'ses-opencode-new' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    restoredRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });
      restoredRuntime.restoreFromSnapshot('session-opencode-resume', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up OpenCode question', 'session-opencode-resume', 'trace-opencode');

      expect(restoredRecord.createCalls).toBe(0);
      expect(restoredRecord.getInput).toEqual({
        path: { id: 'ses-opencode-original' },
        query: { directory: opaque?.projectDir },
      });
      expect(restoredRecord.promptInput).toMatchObject({
        path: { id: 'ses-opencode-original' },
        query: { directory: opaque?.projectDir },
      });
      expect(restoredRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(restoredRecord.configAtCreate).toBe(opaque?.configDir);
    });
  });

  it('degrades OpenCode restore when the third-party session is unavailable', async () => {
    await withBackendDataDir(async () => {
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencode: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: 'ses-opencode-original' } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          })),
        }),
      });
      await runtime.analyze('first', 'session-opencode-missing', 'trace-opencode');
      const snapshot = runtime.takeSnapshot(
        'session-opencode-missing',
        'trace-opencode',
        createSnapshotFields(),
      );

      const createCalls: unknown[] = [];
      const updates: any[] = [];
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencode: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4107', close: jest.fn() },
            client: {
              session: {
                get: jest.fn(async () => {
                  throw new Error('missing session');
                }),
                create: jest.fn(async (input: unknown) => {
                  createCalls.push(input);
                  return { data: { id: 'ses-opencode-fresh' } };
                }),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          })),
        }),
      });
      restoredRuntime.on('update', update => updates.push(update));
      restoredRuntime.restoreFromSnapshot('session-opencode-missing', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up', 'session-opencode-missing', 'trace-opencode');

      expect(createCalls).toHaveLength(1);
      expect(updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'degraded',
          content: expect.objectContaining({
            module: 'opencode',
            fallback: 'fresh_session',
            reason: 'session_restore_failed',
            message: 'OpenCode session state unavailable; started a fresh OpenCode session with SmartPerfetto context.',
          }),
        }),
      ]));
    });
  });

  it('serializes OpenCode process env overrides while starting servers concurrently', async () => {
    await withBackendDataDir(async () => {
      let activeCreates = 0;
      let maxActiveCreates = 0;
      const createRecords: Array<{ home?: string; config?: string }> = [];
      const moduleLoader: OpenCodeSdkModuleLoader = async () => ({
        createOpencode: jest.fn(async () => {
          activeCreates += 1;
          maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
          createRecords.push({
            home: process.env.HOME,
            config: process.env.OPENCODE_CONFIG_DIR,
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          activeCreates -= 1;
          return {
            server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: `ses-${createRecords.length}` } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          };
        }),
      });
      const runtimeA = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });
      const runtimeB = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });

      await Promise.all([
        runtimeA.analyze('first', 'session-opencode-a', 'trace-opencode'),
        runtimeB.analyze('second', 'session-opencode-b', 'trace-opencode'),
      ]);

      expect(maxActiveCreates).toBe(1);
      expect(createRecords).toHaveLength(2);
      expect(createRecords[0].home).toContain('session-opencode-a');
      expect(createRecords[1].home).toContain('session-opencode-b');
      expect(createRecords[0].config).toContain('session-opencode-a');
      expect(createRecords[1].config).toContain('session-opencode-b');
    });
  });

  it('reports hidden runtime diagnostics without exposing a public provider', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/tmp/sdk.js',
      SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/tmp/project',
      SMARTPERFETTO_OPENCODE_SERVER_PORT: '4107',
      SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '5000',
    }, EXPERIMENTAL_OPENCODE_RUNTIME_KIND)).toMatchObject({
      configured: true,
      runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      experimental: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
      modulePath: '/tmp/sdk.js',
      projectDir: '/tmp/project',
      serverPort: 4107,
      serverTimeoutMs: 5000,
      standaloneMcpEnabled: false,
      standaloneMcpTimeoutMs: 5000,
    });
  });

  it('reports public OpenCode diagnostics by default for M14 provider checks', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      PATH: '/usr/bin',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
    })).toMatchObject({
      configured: true,
      runtime: 'opencode',
      experimental: false,
      modelConfigured: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
    });
  });
});
