// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisOptions } from '../../agent/core/orchestratorTypes';
import { buildComplexityClassifierInput } from '../../agentv3/queryComplexityContext';
import type { RuntimeSelection } from '../runtimeSelection';
import {
  buildRuntimeSessionMapKey,
  formatTraceContext,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
} from '../runtimeCommon';
import { createAnalysisRunSpec } from '../analysisRunSpec';

const claudeSelection: RuntimeSelection = {
  kind: 'claude-agent-sdk',
  source: 'provider',
  providerId: 'provider-claude',
  providerName: 'Claude',
  providerType: 'anthropic',
};

const openAiSelection: RuntimeSelection = {
  kind: 'openai-agents-sdk',
  source: 'snapshot',
};

describe('AnalysisRunSpec shadow mode', () => {
  it('captures shared identity, scope, trace, selection, and tool inputs without owning execution', () => {
    const options: AnalysisOptions = {
      providerId: 'provider-claude',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      runId: 'run-1',
      referenceTraceId: 'trace-ref',
      analysisMode: 'auto',
      selectionContext: {
        kind: 'area',
        startNs: 10,
        endNs: 20,
      },
      traceContext: [{
        label: 'Frame stats',
        columns: ['name', 'dur_ms'],
        rows: [['doFrame', 16.7]],
      }],
      codeAwareMode: 'provider_send',
      codebaseIds: ['app', 'app', 'lib'],
    };

    const spec = createAnalysisRunSpec({
      query: 'Compare this selected frame range',
      sessionId: 'session-1',
      traceId: 'trace-current',
      options,
      runtimeSelection: claudeSelection,
      sceneType: 'scrolling',
      outputLanguage: 'en',
      resolvedMode: 'full',
      budget: {
        model: 'claude-sonnet-4-6',
        lightModel: 'claude-haiku-4-5',
        maxTurns: 60,
        fullPathPerTurnMs: 60_000,
      },
    });

    expect(spec.identity).toEqual({
      sessionId: 'session-1',
      traceId: 'trace-current',
      referenceTraceId: 'trace-ref',
      sessionMapKey: buildRuntimeSessionMapKey('session-1', 'trace-ref'),
    });
    expect(spec.scopes.provider).toEqual(providerScopeFromAnalysisOptions(options));
    expect(spec.scopes.knowledge).toEqual(knowledgeScopeFromAnalysisOptions(options));
    expect(spec.traceContext).toEqual({
      datasetCount: 1,
      promptSection: formatTraceContext(options.traceContext, 'en'),
    });
    expect(spec.selection).toMatchObject({
      present: true,
      kind: 'area',
    });
    expect(spec.tools).toEqual({
      requestScope: {
        sessionId: 'session-1',
        hasCodebaseAccess: true,
      },
      codeAwareMode: 'provider_send',
      codebaseIds: ['app', 'lib'],
    });
    expect(spec.budget).toMatchObject({
      model: 'claude-sonnet-4-6',
      maxTurns: 60,
    });
  });

  it('reuses existing classifier input construction without storing runtime policy descriptors', () => {
    const previousTurns = [
      {
        query: 'first',
        intent: { complexity: 'simple' },
        findings: [],
      },
      {
        query: 'analyze the scroll',
        intent: { complexity: 'complex' },
        findings: [{ title: 'Long doFrame', severity: 'high', category: 'frame' }],
      },
    ] as any;
    const options: AnalysisOptions = {
      referenceTraceId: 'trace-ref',
      selectionContext: {
        kind: 'track_event',
        eventId: 7,
        ts: 42,
      },
    };

    const spec = createAnalysisRunSpec({
      query: 'continue from the selected slice',
      sessionId: 'session-1',
      traceId: 'trace-current',
      options,
      runtimeSelection: claudeSelection,
      sceneType: 'scrolling',
      outputLanguage: 'zh-CN',
      previousTurns,
    });

    expect(spec.mode.classifierInput).toEqual(buildComplexityClassifierInput({
      query: 'continue from the selected slice',
      sceneType: 'scrolling',
      selectionContext: options.selectionContext,
      hasReferenceTrace: true,
      previousTurns,
    }));
    expect(spec.mode).not.toHaveProperty('classifierPolicy');
    expect(spec).not.toHaveProperty('continuationPolicy');
  });

  it('preserves OpenAI runtime identity and shared classifier input', () => {
    const spec = createAnalysisRunSpec({
      query: 'quick status?',
      sessionId: 'session-openai',
      traceId: 'trace-openai',
      options: {
        analysisMode: 'fast',
        codeAwareMode: 'off',
        codebaseIds: ['ignored-when-off'],
      },
      runtimeSelection: openAiSelection,
      sceneType: 'general',
      outputLanguage: 'en',
      resolvedMode: 'quick',
      budget: {
        model: 'gpt-5.5',
        lightModel: 'gpt-5.4-mini',
        maxTurns: 60,
        quickMaxTurns: 50,
        maxOutputTokens: 2048,
        fullPathPerTurnMs: 60_000,
        quickPathPerTurnMs: 40_000,
      },
    });

    expect(spec.runtime.kind).toBe('openai-agents-sdk');
    expect(spec.mode).toMatchObject({
      requested: 'fast',
      resolved: 'quick',
    });
    expect(spec.tools.requestScope).toEqual({
      sessionId: 'session-openai',
      hasCodebaseAccess: false,
    });
    expect(spec.runtime.capabilities).toEqual({
      kind: 'openai-agents-sdk',
      displayName: 'OpenAI Agents SDK',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });
});
