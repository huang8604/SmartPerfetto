// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {RequestContext} from '../../middleware/auth';
import {
  TRACE_PROCESSOR_CAPABILITY_SECRET_ENV,
  issueTraceProcessorProxyCapability,
  resetTraceProcessorProxyCapabilitiesForTests,
  resolveTraceProcessorProxyCapability,
  stripTraceProcessorCapabilityProtocols,
} from '../traceProcessorProxyCapability';

const originalSecret = process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV];
const context: RequestContext = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'api_key',
  roles: ['api_key'],
  scopes: ['trace:read', 'trace:write'],
  requestId: 'request-a',
  windowId: 'window-a',
};

beforeEach(() => {
  process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV] =
    'test-trace-processor-capability-secret-at-least-32-bytes';
  resetTraceProcessorProxyCapabilitiesForTests();
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV];
  } else {
    process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV] = originalSecret;
  }
  resetTraceProcessorProxyCapabilitiesForTests();
});

describe('trace processor WebSocket capability', () => {
  it('survives process-local state reset and restores only the bound scope', () => {
    const capability = issueTraceProcessorProxyCapability({
      context,
      leaseId: 'lease-a',
      now: 1_000,
      ttlMs: 60_000,
    });
    resetTraceProcessorProxyCapabilitiesForTests();

    expect(resolveTraceProcessorProxyCapability(
      capability.protocol,
      'lease-a',
      2_000,
    )).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      windowId: 'window-a',
      scopes: ['trace:read'],
    });
  });

  it('rejects expiration, lease mismatch, and signature tampering', () => {
    const capability = issueTraceProcessorProxyCapability({
      context,
      leaseId: 'lease-a',
      now: 1_000,
      ttlMs: 30_000,
    });

    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-b', 2_000)).toBeNull();
    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-a', 31_001)).toBeNull();
    expect(resolveTraceProcessorProxyCapability(
      `${capability.protocol.slice(0, -1)}x`,
      'lease-a',
      2_000,
    )).toBeNull();
  });

  it('removes capability subprotocols before forwarding upstream', () => {
    const capability = issueTraceProcessorProxyCapability({context, leaseId: 'lease-a'});
    expect(stripTraceProcessorCapabilityProtocols([
      capability.protocol,
      'application.trace-processor',
    ])).toEqual(['application.trace-processor']);
  });
});
