// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';

import {
  McpToolRegistry,
  MCP_NAME_PREFIX,
  buildAllowedTools,
  filterByExposure,
  type McpToolDefinition,
} from '../mcpToolRegistry';

/** Stub SDK tool object — the registry treats `tool` opaquely so a
 * marker shape is enough to verify pass-through. */
function stub(name: string): unknown {
  return {kind: 'stub', toolName: name};
}

describe('McpToolRegistry — basic registration', () => {
  it('register preserves insertion order', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'invoke_skill', 'public');
    registry.registerSdk(stub('c'), 'submit_plan', 'internal');

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('execute_sql');
    expect(list[1].name).toBe('invoke_skill');
    expect(list[2].name).toBe('submit_plan');
  });

  it('does not deduplicate by name — call sites control uniqueness', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'dup', 'public');
    registry.registerSdk(stub('b'), 'dup', 'public');
    expect(registry.size()).toBe(2);
  });

  it('register accepts a full McpToolDefinition with summary + requires', () => {
    const registry = new McpToolRegistry();
    const def: McpToolDefinition = {
      tool: stub('x'),
      name: 'execute_sql',
      exposure: 'public',
      summary: 'Run SQL on the active trace.',
      requires: ['traceProcessor'],
    };
    registry.register(def);
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('Run SQL on the active trace.');
    expect(aci[0].requires).toEqual(['traceProcessor']);
  });
});

describe('McpToolRegistry — allowedTools shape', () => {
  it('prefixes every short name with MCP_NAME_PREFIX', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'submit_plan', 'internal');

    const allowed = registry.buildAllowedTools();
    expect(allowed).toEqual([
      `${MCP_NAME_PREFIX}execute_sql`,
      `${MCP_NAME_PREFIX}submit_plan`,
    ]);
  });

  it('MCP_NAME_PREFIX matches the SDK contract', () => {
    expect(MCP_NAME_PREFIX).toBe('mcp__smartperfetto__');
  });

  it('buildAllowedTools (free function) matches registry method', () => {
    const defs: McpToolDefinition[] = [
      {tool: stub('a'), name: 'one', exposure: 'public'},
      {tool: stub('b'), name: 'two', exposure: 'internal'},
    ];
    expect(buildAllowedTools(defs)).toEqual([
      `${MCP_NAME_PREFIX}one`,
      `${MCP_NAME_PREFIX}two`,
    ]);
  });
});

describe('McpToolRegistry — filterByExposure', () => {
  function seed(): McpToolDefinition[] {
    return [
      {tool: stub('a'), name: 'execute_sql', exposure: 'public'},
      {tool: stub('b'), name: 'submit_plan', exposure: 'internal'},
      {tool: stub('c'), name: 'old_tool', exposure: 'deprecated'},
      {tool: stub('d'), name: 'invoke_skill', exposure: 'public'},
    ];
  }

  it('returns only entries matching the requested exposures', () => {
    const out = filterByExposure(seed(), ['public']);
    expect(out.map(d => d.name)).toEqual(['execute_sql', 'invoke_skill']);
  });

  it('supports multiple exposures', () => {
    const out = filterByExposure(seed(), ['public', 'deprecated']);
    expect(out.map(d => d.name)).toEqual([
      'execute_sql',
      'old_tool',
      'invoke_skill',
    ]);
  });

  it('empty exposure list yields empty output (no implicit "all")', () => {
    expect(filterByExposure(seed(), [])).toEqual([]);
  });
});

describe('McpToolRegistry — ACI snapshot', () => {
  it('emits one entry per registered tool with prefixed qualified name', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'submit_plan', 'internal');

    const aci = registry.getAci();
    expect(aci).toHaveLength(2);
    expect(aci[0]).toMatchObject({
      toolName: 'execute_sql',
      qualifiedName: `${MCP_NAME_PREFIX}execute_sql`,
      exposure: 'public',
    });
    expect(aci[1]).toMatchObject({
      toolName: 'submit_plan',
      qualifiedName: `${MCP_NAME_PREFIX}submit_plan`,
      exposure: 'internal',
    });
  });

  it('emits empty summary by default; populates when given', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'invoke_skill', 'public', {
      summary: 'Run a skill.',
    });
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('');
    expect(aci[1].summary).toBe('Run a skill.');
  });
});

describe('McpToolRegistry — buildPublicApiContract', () => {
  it('produces a valid McpPublicApiContract with provenance', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    const contract = registry.buildPublicApiContract({
      serverVersion: '1.2.3',
      protocolVersion: '2024-11-05',
    });
    expect(contract.schemaVersion).toBe(1);
    expect(contract.source).toBe('mcpToolRegistry');
    expect(contract.tools).toHaveLength(1);
    expect(contract.serverVersion).toBe('1.2.3');
    expect(contract.protocolVersion).toBe('2024-11-05');
    expect(contract.coverage.length).toBeGreaterThan(0);
  });

  it('falls back to default versions when not supplied', () => {
    const registry = new McpToolRegistry();
    const contract = registry.buildPublicApiContract();
    expect(contract.serverVersion).toBe('1.0.0');
    expect(contract.protocolVersion).toBe('2024-11-05');
  });
});

describe('McpToolRegistry — buildSdkServer', () => {
  it('returns an SDK server that the runtime can pass to query()', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    const server = registry.buildSdkServer();
    // The SDK server is opaque; we only verify it's not null and has
    // a recognizable shape (the SDK's helper returns an object).
    expect(server).toBeTruthy();
    expect(typeof server).toBe('object');
  });
});
