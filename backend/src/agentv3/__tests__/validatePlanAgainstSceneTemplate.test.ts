// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 0.4 of v2.1 — exercise the shared scene-template validator.
 * `submit_plan` and `revise_plan` both delegate here so an agent cannot
 * submit a compliant plan and then revise mandatory phases away to
 * bypass the hard-gate.
 */

import { describe, it, expect } from '@jest/globals';
import { validatePlanAgainstSceneTemplate } from '../scenePlanTemplates';
import type { ExpectedCall } from '../types';

const minimalPhase = (overrides: Partial<{ name: string; goal: string; expectedTools: string[]; expectedCalls: ExpectedCall[] }> = {}) => ({
  name: '',
  goal: '',
  expectedTools: [] as string[],
  expectedCalls: [] as ExpectedCall[],
  ...overrides,
});

describe('validatePlanAgainstSceneTemplate', () => {
  it('returns no warnings for unknown scenes', () => {
    expect(validatePlanAgainstSceneTemplate([], undefined)).toEqual({
      warnings: [],
      missingAspectIds: [],
    });
    expect(validatePlanAgainstSceneTemplate([], 'never_existed')).toEqual({
      warnings: [],
      missingAspectIds: [],
    });
  });

  it('returns no warnings for scenes deliberately without a template (general)', () => {
    expect(validatePlanAgainstSceneTemplate(
      [minimalPhase({ name: 'whatever', goal: 'whatever' })],
      'general',
    )).toEqual({ warnings: [], missingAspectIds: [] });
  });

  it('flags every uncovered aspect when phases mention nothing relevant', () => {
    const result = validatePlanAgainstSceneTemplate(
      [minimalPhase({ name: 'overview', goal: 'fetch', expectedTools: ['execute_sql'] })],
      'scrolling',
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.missingAspectIds.length).toBe(result.warnings.length);
  });

  it('passes when phases cover every mandatory aspect for scrolling', () => {
    const result = validatePlanAgainstSceneTemplate(
      [
        minimalPhase({
          name: '帧渲染分析',
          goal: '获取卡顿帧分布',
          expectedTools: ['invoke_skill', 'fetch_artifact'],
          expectedCalls: [
            { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
            { tool: 'fetch_artifact' },
          ],
        }),
        minimalPhase({
          name: '根因诊断',
          goal: 'jank_frame_detail + frame_blocking_calls + blocking_chain_analysis 深入',
          expectedTools: ['invoke_skill'],
          expectedCalls: [
            { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
            { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
            { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
          ],
        }),
        minimalPhase({
          name: '架构确认',
          goal: '确认是否存在 TextureView/WebView/Flutter/Compose/mixed 混合渲染链路',
          expectedTools: ['invoke_skill', 'execute_sql'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'flutter_scrolling_analysis' }],
        }),
      ],
      'scrolling',
    );
    expect(result.warnings).toEqual([]);
    expect(result.missingAspectIds).toEqual([]);
  });

  it('requires scrolling mandatory aspects to declare structured expectedCalls', () => {
    const result = validatePlanAgainstSceneTemplate(
      [
        minimalPhase({
          name: '帧渲染分析',
          goal: '调用 scrolling_analysis 获取卡顿帧分布',
          expectedTools: ['invoke_skill'],
        }),
        minimalPhase({
          name: '根因诊断',
          goal: '使用 jank_frame_detail 深入',
          expectedTools: ['invoke_skill'],
        }),
      ],
      'scrolling',
    );
    expect(result.missingAspectIds).toEqual(expect.arrayContaining([
      'frame_jank_analysis',
      'root_cause_diagnosis',
    ]));
  });

  it('requires the full scrolling root-cause drilldown chain, not only one representative skill', () => {
    const result = validatePlanAgainstSceneTemplate(
      [
        minimalPhase({
          name: '帧渲染分析',
          goal: '调用 scrolling_analysis 获取卡顿帧分布',
          expectedTools: ['invoke_skill', 'fetch_artifact'],
          expectedCalls: [
            { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
            { tool: 'fetch_artifact' },
          ],
        }),
        minimalPhase({
          name: '根因诊断',
          goal: '使用 jank_frame_detail 深入代表帧',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        }),
        minimalPhase({
          name: '架构确认',
          goal: '确认是否存在 TextureView/WebView/Flutter/Compose/mixed 混合渲染链路',
          expectedTools: ['invoke_skill', 'execute_sql'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'flutter_scrolling_analysis' }],
        }),
      ],
      'scrolling',
    );
    expect(result.missingAspectIds).toEqual(['root_cause_diagnosis']);
  });

  it('enforces conditional aspects only when their trigger keywords appear in the plan', () => {
    const basePhases = [
      minimalPhase({
        name: '帧渲染分析',
        goal: '调用 scrolling_analysis 获取卡顿帧分布',
        expectedTools: ['invoke_skill', 'fetch_artifact'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
          { tool: 'fetch_artifact' },
        ],
      }),
      minimalPhase({
        name: '根因诊断',
        goal: '使用 jank_frame_detail + frame_blocking_calls + blocking_chain_analysis 深入',
        expectedTools: ['invoke_skill'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
      }),
    ];

    expect(validatePlanAgainstSceneTemplate(basePhases, 'scrolling').missingAspectIds)
      .not.toContain('architecture_specific_jank');

    const triggered = validatePlanAgainstSceneTemplate([
      ...basePhases,
      minimalPhase({
        name: 'Flutter TextureView 架构分析',
        goal: '确认 Flutter producer 链路',
        expectedTools: ['execute_sql'],
      }),
    ], 'scrolling');

    expect(triggered.missingAspectIds).toContain('architecture_specific_jank');
  });

  it('uses external trigger context for detected architecture without treating it as coverage', () => {
    const basePhases = [
      minimalPhase({
        name: '帧渲染分析',
        goal: '调用 scrolling_analysis 获取卡顿帧分布',
        expectedTools: ['invoke_skill', 'fetch_artifact'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
          { tool: 'fetch_artifact' },
        ],
      }),
      minimalPhase({
        name: '根因诊断',
        goal: '使用 jank_frame_detail + frame_blocking_calls + blocking_chain_analysis 深入',
        expectedTools: ['invoke_skill'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
      }),
    ];

    const result = validatePlanAgainstSceneTemplate(
      basePhases,
      'scrolling',
      undefined,
      { triggerContext: ['FLUTTER', 'TEXTUREVIEW'] },
    );

    expect(result.missingAspectIds).toContain('architecture_specific_jank');
    expect(result.nonWaivableMissingAspectIds).toEqual(['architecture_specific_jank']);
  });

  it('does not allow waivers to bypass non-waivable architecture expected calls', () => {
    const phases = [
      minimalPhase({
        name: '帧渲染分析',
        goal: '调用 scrolling_analysis 获取卡顿帧分布',
        expectedTools: ['invoke_skill', 'fetch_artifact'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
          { tool: 'fetch_artifact' },
        ],
      }),
      minimalPhase({
        name: '根因诊断',
        goal: '使用 jank_frame_detail + frame_blocking_calls + blocking_chain_analysis 深入',
        expectedTools: ['invoke_skill'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
      }),
      minimalPhase({
        name: 'Flutter TextureView 架构专项',
        goal: '拆分 HWUI host + Flutter producer + SF 合成链路，但缺少结构化 Flutter skill expectedCall',
        expectedTools: ['invoke_skill', 'execute_sql'],
      }),
    ];

    const result = validatePlanAgainstSceneTemplate(phases, 'scrolling', [
      {
        aspectId: 'architecture_specific_jank',
        reason: 'trace 数据里没有足够的 Flutter 专属信号，因此尝试用 SQL 手工拆分管线，但这个理由不能绕过结构化 expectedCall。',
      },
    ]);

    expect(result.missingAspectIds).toContain('architecture_specific_jank');
    expect(result.nonWaivableMissingAspectIds).toEqual(['architecture_specific_jank']);
  });

  it('matches keywords case-insensitively across name/goal/expectedTools', () => {
    const result = validatePlanAgainstSceneTemplate(
      [minimalPhase({
        name: 'ANR Diagnosis',
        goal: 'find DEADLOCK',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'anr_analysis' }],
      })],
      'anr',
    );
    expect(result.warnings).toEqual([]);
  });

  it('reports the same missingAspectIds across repeated calls (stable handles)', () => {
    const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
    const a = validatePlanAgainstSceneTemplate(phases, 'startup');
    const b = validatePlanAgainstSceneTemplate(phases, 'startup');
    expect(a.missingAspectIds).toEqual(b.missingAspectIds);
  });

  describe('waivers (Phase 2.3)', () => {
    it('honours a waiver whose reason meets the minimum length', () => {
      const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
      // First call without waivers — capture every missingAspectId.
      const baseline = validatePlanAgainstSceneTemplate(phases, 'startup');
      expect(baseline.missingAspectIds.length).toBeGreaterThan(0);

      const longReason = 'a'.repeat(50) + ' — trace lacks the corresponding signal';
      const waivers = baseline.missingAspectIds.map(id => ({ aspectId: id, reason: longReason }));

      const waived = validatePlanAgainstSceneTemplate(phases, 'startup', waivers);
      expect(waived.missingAspectIds).toEqual([]);
      expect(waived.warnings).toEqual([]);
    });

    it('ignores a waiver whose reason is shorter than the minimum', () => {
      const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
      const baseline = validatePlanAgainstSceneTemplate(phases, 'startup');

      const shortReason = 'short';
      const waivers = baseline.missingAspectIds.map(id => ({ aspectId: id, reason: shortReason }));

      const result = validatePlanAgainstSceneTemplate(phases, 'startup', waivers);
      expect(result.missingAspectIds).toEqual(baseline.missingAspectIds);
    });

    it('partial waivers — only the explicitly waived aspect is suppressed', () => {
      const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
      const baseline = validatePlanAgainstSceneTemplate(phases, 'startup');
      expect(baseline.missingAspectIds.length).toBeGreaterThan(1);

      const longReason = 'a'.repeat(60) + ' — justification';
      const waivers = [{ aspectId: baseline.missingAspectIds[0], reason: longReason }];
      const result = validatePlanAgainstSceneTemplate(phases, 'startup', waivers);

      expect(result.missingAspectIds).not.toContain(baseline.missingAspectIds[0]);
      expect(result.missingAspectIds).toEqual(baseline.missingAspectIds.slice(1));
    });

    it('waiver for a non-existent aspectId is harmless (no crash, no effect)', () => {
      const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
      const baseline = validatePlanAgainstSceneTemplate(phases, 'startup');

      const result = validatePlanAgainstSceneTemplate(phases, 'startup', [
        { aspectId: 'no-such-aspect', reason: 'x'.repeat(60) },
      ]);
      expect(result.missingAspectIds).toEqual(baseline.missingAspectIds);
    });
  });
});
