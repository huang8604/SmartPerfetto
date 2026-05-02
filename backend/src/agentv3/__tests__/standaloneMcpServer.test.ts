// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';

import {McpToolRegistry} from '../mcpToolRegistry';
import {
  dispatch,
  runStdioLoop,
  RPC_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestSource,
  type ResponseSink,
} from '../standaloneMcpServer';

/** Minimal SDK-tool stub that pretends to be the shape `tool()`
 * from `@anthropic-ai/claude-agent-sdk` returns. */
function stubSdkTool(opts: {
  description?: string;
  inputSchema?: unknown;
  handler?: (args: unknown) => Promise<unknown> | unknown;
}): unknown {
  return {
    description: opts.description ?? '',
    inputSchema: opts.inputSchema ?? {type: 'object'},
    handler: opts.handler ?? (async () => ({content: [{type: 'text', text: 'ok'}]})),
  };
}

describe('dispatch — initialize', () => {
  it('returns protocolVersion + serverInfo + tools capability', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(resp?.id).toBe(1);
    const result = resp!.result as {
      protocolVersion: string;
      serverInfo: {name: string};
      capabilities: {tools: object};
    };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('smartperfetto');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('drops notifications (no id) silently', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      method: 'initialize',
    });
    expect(resp).toBeNull();
  });
});

describe('dispatch — tools/list', () => {
  it('returns ONLY public exposure tools', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({description: 'public alpha'}),
      'alpha',
      'public',
    );
    registry.registerSdk(
      stubSdkTool({description: 'internal beta'}),
      'beta',
      'internal',
    );
    registry.registerSdk(
      stubSdkTool({description: 'deprecated gamma'}),
      'gamma',
      'deprecated',
    );

    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = (resp!.result as {tools: Array<{name: string}>}).tools;
    expect(tools.map(t => t.name)).toEqual(['alpha']);
  });

  it('descriptor carries name + description + safe permissive inputSchema', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        description: 'Describe the thing.',
        inputSchema: {type: 'object', properties: {q: {type: 'string'}}},
      }),
      'alpha',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    const tools = (resp!.result as {tools: Array<unknown>}).tools as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>;
    expect(tools[0].name).toBe('alpha');
    expect(tools[0].description).toBe('Describe the thing.');
    // Codex round E P1#1: SDK's inputSchema is Zod raw shape, not
    // JSON Schema. We emit a safe permissive descriptor — the
    // handler still validates against the Zod schema on tools/call.
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('parse-error sentinel surfaces as a real PARSE_ERROR (Codex round E P2#5)', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: null,
      method: '__parse_error__',
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);
    expect(resp!.id).toBeNull();
  });
});

describe('dispatch — tools/call', () => {
  it('invokes the handler and returns its result', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async (args: unknown) => ({
          content: [{type: 'text', text: `got ${JSON.stringify(args)}`}],
        }),
      }),
      'echo',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {name: 'echo', arguments: {q: 'hello'}},
    });
    expect((resp!.result as {content: Array<{text: string}>}).content[0].text).toBe(
      'got {"q":"hello"}',
    );
  });

  it('400/METHOD_NOT_FOUND for unknown tool', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {name: 'unknown'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('refuses to call internal tools (hidden from external hosts)', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({}),
      'submit_plan',
      'internal',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {name: 'submit_plan'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(resp!.error?.message).toMatch(/not exposed/);
  });

  it('surfaces handler exceptions as TOOL_EXECUTION_FAILED', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async () => {
          throw new Error('boom');
        },
      }),
      'broken',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {name: 'broken'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(resp!.error?.message).toBe('boom');
  });

  it('INVALID_PARAMS when name is missing', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe('dispatch — unknown methods', () => {
  it('METHOD_NOT_FOUND for any other method name', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 9,
      method: 'resources/list',
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

// ----------------------------------------------------------------------
// runStdioLoop — drive the dispatcher with a fake source/sink so we
// don't need to spawn a subprocess to validate the loop semantics.
// ----------------------------------------------------------------------

class ScriptedSource implements RequestSource {
  private idx = 0;
  constructor(private requests: (JsonRpcRequest | null)[]) {}
  async next(): Promise<JsonRpcRequest | null> {
    if (this.idx >= this.requests.length) return null;
    return this.requests[this.idx++];
  }
}

class CollectingSink implements ResponseSink {
  responses: JsonRpcResponse[] = [];
  send(r: JsonRpcResponse): void {
    this.responses.push(r);
  }
}

describe('runStdioLoop', () => {
  it('processes a sequence of requests in order', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async (args: unknown) => ({
          content: [{type: 'text', text: 'echo'}],
        }),
      }),
      'echo',
      'public',
    );
    const source = new ScriptedSource([
      {jsonrpc: '2.0', id: 1, method: 'initialize'},
      {jsonrpc: '2.0', id: 2, method: 'tools/list'},
      {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'echo'}},
      null,
    ]);
    const sink = new CollectingSink();
    await runStdioLoop(registry, source, sink);
    expect(sink.responses).toHaveLength(3);
    expect(sink.responses[0].id).toBe(1);
    expect(sink.responses[1].id).toBe(2);
    expect(sink.responses[2].id).toBe(3);
  });

  it('keeps running after a tool failure', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async () => {
          throw new Error('intentional');
        },
      }),
      'broken',
      'public',
    );
    registry.registerSdk(
      stubSdkTool({handler: async () => ({content: [{type: 'text', text: 'ok'}]})}),
      'fine',
      'public',
    );
    const source = new ScriptedSource([
      {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'broken'}},
      {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'fine'}},
      null,
    ]);
    const sink = new CollectingSink();
    await runStdioLoop(registry, source, sink);
    expect(sink.responses).toHaveLength(2);
    expect(sink.responses[0].error?.code).toBe(RPC_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(sink.responses[1].result).toBeDefined();
  });
});
