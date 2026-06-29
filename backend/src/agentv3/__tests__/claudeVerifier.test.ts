// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * claudeVerifier unit tests
 *
 * Tests the 4-layer verification pipeline:
 * 1. Heuristic checks (6 sub-checks)
 * 2. Plan adherence
 * 3. Hypothesis resolution
 * 4. Scene completeness
 *
 * LLM verification (Layer 5) is not tested here — it requires an SDK call.
 * The generateCorrectionPrompt helper is also tested.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Finding } from '../../agent/types';
import type { AnalysisPlanV3, Hypothesis } from '../types';

// Mock fs for learned patterns I/O
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return false;
      return (actual as any).existsSync(p);
    }),
    readFileSync: jest.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return '[]';
      return (actual as any).readFileSync(p, enc);
    }),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

import {
  verifyHeuristic,
  verifyPlanAdherence,
  verifyHypotheses,
  verifySceneCompleteness,
  verifyConclusion,
  generateCorrectionPrompt,
  learnFromVerificationResults,
  normalizeLLMSeverity,
  isConclusionIncomplete,
  parseVerifierJsonIssues,
} from '../claudeVerifier';
import { extractFindingsFromText } from '../claudeFindingExtractor';

const mockFs = require('fs') as jest.Mocked<typeof import('fs')>;
const actualFs = jest.requireActual<typeof import('fs')>('fs');

beforeEach(() => {
  (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
    const p = args[0] as string;
    if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return false;
    return actualFs.existsSync(p);
  });
  (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
    const p = args[0] as string;
    if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return '[]';
    return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
  });
  (mockFs.writeFileSync as jest.Mock).mockClear();
  (mockFs.renameSync as jest.Mock).mockClear();
  (mockFs.mkdirSync as jest.Mock).mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test finding',
    description: 'Test description with some detail',
    severity: 'warning',
    ...overrides,
  };
}

function makePlan(overrides: Partial<AnalysisPlanV3> = {}): AnalysisPlanV3 {
  return {
    phases: [
      {
        id: 'phase-1',
        name: 'Data Collection',
        goal: 'Collect frame data',
        expectedTools: ['execute_sql', 'invoke_skill'],
        status: 'completed',
        summary: 'Collected 200 frames from frame_timeline',
      },
    ],
    successCriteria: 'Identify root cause of jank',
    submittedAt: Date.now(),
    toolCallLog: [
      { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'phase-1' },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('verifyHeuristic', () => {
  describe('Check 1: CRITICAL without evidence', () => {
    it('should flag CRITICAL findings without evidence', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [] })];
      const issues = verifyHeuristic(findings, 'Some conclusion text that is long enough');
      expect(issues.some(i => i.type === 'missing_evidence' && i.severity === 'error')).toBe(true);
    });

    it('should pass CRITICAL findings with evidence', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [{ type: 'data', value: '50ms' }] })];
      const issues = verifyHeuristic(findings, 'Some conclusion text that is long enough');
      expect(issues.filter(i => i.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag markdown severity table cells as CRITICAL findings without evidence', () => {
      const conclusion = `
| 类型 | 帧数 | 占比 | 根因 | 严重度 |
|------|------|------|------|--------|
| \`CustomScroll_longFrameLoad\` | 6 | 85.7% | ANIMATION 回调同步重载 | [CRITICAL] |

这是一段足够长的结论，用于描述滑动性能问题和后续排查方向。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings.map(finding => finding.title)).not.toContain('|');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag a critical finding when its evidence is a markdown metrics table', () => {
      const conclusion = `
### 代表帧分析

**[CRITICAL] Frame 2 — 主线程 ANIMATION 同步重载**

| 属性 | 数值 |
|---|---|
| 帧耗时 | **62.73ms（7.5x 预算）** |
| vsync_missed | 7 帧 |
| \`Choreographer#doFrame\` | 60.85ms |
| \`animation\` → \`CustomScroll_longFrameLoad_1\` | **59.02ms** |
| 主线程 Running 占比 | **95.9%**（无锁/IO/GC） |
| RenderThread | 仅 1.88ms，98.3% 等待主线程 |

**因果链**：\`Choreographer#doFrame\` → ANIMATION 回调 → \`CustomScroll_longFrameLoad_1\`

这段结论说明 Frame 2 的超时由主线程同步执行 ANIMATION 负载造成，RenderThread 主要在等待主线程，不是渲染线程自身瓶颈。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('62.73ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag a critical recommendation when its evidence is inline metric text', () => {
      const conclusion = `
### 优化建议

1. **[CRITICAL] \`CustomScroll_longFrameLoad\` 移出 ANIMATION 回调** — 当前 6/7 帧在 \`Choreographer#doFrame\` 的 ANIMATION 阶段同步执行 47-59ms。建议异步执行或预计算，预估消除 86% 掉帧，FPS 升至约 120。

这段结论明确将优化建议绑定到已观测的帧数量、主线程阶段、耗时范围和预估收益。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('47-59ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });
  });

  describe('Check 2: Too many CRITICALs', () => {
    it('should warn when >5 CRITICAL findings', () => {
      const findings = Array.from({ length: 6 }, (_, i) =>
        makeFinding({ severity: 'critical', evidence: [{ type: 'data' }], title: `Issue ${i}` }),
      );
      const issues = verifyHeuristic(findings, 'Conclusion with enough text here');
      expect(issues.some(i => i.type === 'too_many_criticals')).toBe(true);
    });

    it('should not warn with <=5 CRITICALs', () => {
      const findings = Array.from({ length: 5 }, (_, i) =>
        makeFinding({ severity: 'critical', evidence: [{ type: 'data' }], title: `Issue ${i}` }),
      );
      const issues = verifyHeuristic(findings, 'Conclusion with enough text here');
      expect(issues.filter(i => i.type === 'too_many_criticals')).toHaveLength(0);
    });
  });

  describe('Check 3: Known misdiagnosis patterns', () => {
    it('should flag VSync alignment false positive only for scoped scenes', () => {
      const findings = [makeFinding({ title: 'VSync 对齐异常', description: 'VSync misalign detected' })];
      const pipelineIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'pipeline');
      expect(pipelineIssues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
        message: expect.stringContaining('VRR'),
      }));

      const scrollResponseIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'scroll_response');
      expect(scrollResponseIssues.some(i => i.type === 'known_misdiagnosis')).toBe(true);

      const startupIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'startup');
      expect(startupIssues.filter(i => i.type === 'known_misdiagnosis')).toHaveLength(0);
    });

    it('should flag Buffer Stuffing only for scoped scenes', () => {
      const findings = [makeFinding({ title: 'Buffer Stuffing 严重', description: 'Buffer Stuffing critical' })];
      const pipelineIssues = verifyHeuristic(findings, 'Buffer Stuffing critical 掉帧', 'pipeline');
      expect(pipelineIssues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
        message: expect.stringContaining('Buffer Stuffing'),
      }));

      const interactionIssues = verifyHeuristic(findings, 'Buffer Stuffing critical 掉帧', 'interaction');
      expect(interactionIssues.filter(i => i.type === 'known_misdiagnosis')).toHaveLength(0);
    });

    it('should flag single frame CRITICAL globally when a scene is provided', () => {
      const findings = [makeFinding({ title: '单帧异常', severity: 'critical', description: '1帧异常 critical', evidence: [{}] })];
      const issues = verifyHeuristic(findings, '单帧异常是严重问题', 'startup');
      expect(issues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
      }));
    });

    it('appends learned patterns after strategy patterns', () => {
      const learned = [{
        keywords: ['VSync', 'alignment'],
        message: 'Learned VSync warning',
        occurrences: 2,
        createdAt: Date.now(),
      }];
      (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
        const p = args[0] as string;
        if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return true;
        return actualFs.existsSync(p);
      });
      (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
        const p = args[0] as string;
        if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) {
          return JSON.stringify(learned);
        }
        return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
      });

      const issues = verifyHeuristic([], 'VSync alignment misalign and VSync 对齐异常严重', 'pipeline')
        .filter(issue => issue.type === 'known_misdiagnosis');
      expect(issues.map(issue => issue.message)).toEqual([
        expect.stringContaining('VRR'),
        expect.stringContaining('(学习) Learned VSync warning'),
      ]);
    });
  });

  describe('Check 4: Severity mismatch', () => {
    it('should warn when conclusion mentions CRITICAL but findings have none', () => {
      const findings = [makeFinding({ severity: 'warning' })];
      const issues = verifyHeuristic(findings, 'Found [CRITICAL] issue in rendering pipeline that is really bad');
      expect(issues.some(i => i.type === 'severity_mismatch')).toBe(true);
    });

    it('should not warn when findings have CRITICAL too', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [{}] })];
      const issues = verifyHeuristic(findings, 'Found [CRITICAL] issue');
      expect(issues.filter(i => i.type === 'severity_mismatch')).toHaveLength(0);
    });
  });

  describe('Check 5: Empty conclusion', () => {
    it('should error when conclusion is too short', () => {
      const issues = verifyHeuristic([], 'short');
      expect(issues.some(i => i.type === 'missing_reasoning' && i.severity === 'error')).toBe(true);
    });

    it('should pass with sufficient conclusion length', () => {
      const issues = verifyHeuristic([], 'A'.repeat(60));
      expect(issues.filter(i =>
        i.type === 'missing_reasoning' && i.severity === 'error' && i.message.includes('过短'),
      )).toHaveLength(0);
    });
  });

  describe('Check 6: Causal reasoning', () => {
    it('6a: should warn when duration data exists without causal keywords', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'Frame took 35.2 ms to render, which is longer than expected',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i =>
        i.type === 'missing_reasoning' && i.message.includes('缺少根因'),
      )).toBe(true);
    });

    it('6a: should pass when causal keywords present', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'Frame took 35.2 ms 因为 CPU 频率降低导致渲染超时',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.filter(i =>
        i.type === 'missing_reasoning' && i.message.includes('缺少根因'),
      )).toHaveLength(0);
    });

    it('6b: should warn CRITICAL with quantitative data but no baseline', () => {
      const findings = [makeFinding({
        severity: 'critical',
        evidence: [{}],
        description: 'RenderThread 耗时 50ms, CPU usage 80%',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('对比基准'))).toBe(true);
    });

    it('6b: should pass when baseline comparison present', () => {
      const findings = [makeFinding({
        severity: 'critical',
        evidence: [{}],
        description: 'RenderThread 耗时 50ms, 超过阈值 16.6ms 因为 GPU 阻塞',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.filter(i => i.message.includes('对比基准'))).toHaveLength(0);
    });

    it('6c: should warn when overall reasoning density is low', () => {
      const findings = Array.from({ length: 4 }, (_, i) =>
        makeFinding({
          severity: 'high',
          title: `Issue ${i}`,
          description: `耗时 ${10 + i} ms 超过预期`,
        }),
      );
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('推理密度'))).toBe(true);
    });

    it('6d: should warn on long descriptions with metrics but few causal connectors', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'A'.repeat(100) + ' 测量到 50ms, 30%, 200MB 的数据指标. ' + 'B'.repeat(100),
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('因果连接'))).toBe(true);
    });
  });
});

describe('verifyPlanAdherence', () => {
  it('should error when no plan submitted', () => {
    const issues = verifyPlanAdherence(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].type).toBe('plan_deviation');
  });

  it('should pass a fully completed plan', () => {
    const issues = verifyPlanAdherence(makePlan());
    // Might have reasoning summary warnings but no plan_deviation errors
    const deviations = issues.filter(i => i.type === 'plan_deviation');
    expect(deviations.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('should warn on pending phases with tool calls', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'completed', summary: 'Done with phase 1' },
        { id: 'p2', name: 'Phase 2', goal: 'G2', expectedTools: ['invoke_skill'], status: 'pending' },
      ],
      toolCallLog: [{ toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' }],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'warning')).toBe(true);
  });

  it('should error on pending phases with no tool calls', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'pending' },
      ],
      toolCallLog: [],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'error')).toBe(true);
  });

  it('should error on completed phase without matched tool calls', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1', name: 'Phase 1', goal: 'G1',
        expectedTools: ['execute_sql'],
        status: 'completed',
        summary: 'Completed analysis',
      }],
      toolCallLog: [], // No tool calls matched to phase
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' && i.severity === 'error' && i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('allows a final conclusion phase to synthesize prior evidence without its own matched tool call', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '证据采集',
          goal: '收集 frame timeline 和关键证据',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已收集掉帧分布和关键 frame 证据，确认存在 62.73ms 长帧。',
        },
        {
          id: 'p2',
          name: '综合结论与优化建议',
          goal: '整合前序证据输出最终报告',
          expectedTools: ['fetch_artifact', 'lookup_knowledge'],
          status: 'completed',
          summary: '最终报告已输出，包含根因、证据链、代表帧和优化建议。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'scrolling_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
        { toolName: 'fetch_artifact', timestamp: Date.now(), matchedPhaseId: 'p1' },
        { toolName: 'lookup_knowledge', timestamp: Date.now(), matchedPhaseId: 'p1' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('综合结论与优化建议'),
    )).toBe(false);
  });

  it('allows a final conclusion expectedCall when the required call ran in an evidence phase', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '根因分析',
          goal: '执行阻塞链分析',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已通过 blocking_chain_analysis 确认主线程同步等待路径。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '输出最终报告',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
          status: 'completed',
          summary: '最终报告复用了前序阻塞链证据并给出修复建议。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'blocking_chain_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('blocking_chain_analysis'),
    )).toBe(false);
  });

  it('does not let dangling tool attribution satisfy final conclusion expectations', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: 'Conclusion',
          goal: 'write final report',
          expectedTools: ['fetch_artifact'],
          status: 'completed',
          summary: 'Final report was written from supposed prior evidence.',
        },
      ],
      toolCallLog: [
        { toolName: 'fetch_artifact', timestamp: Date.now(), matchedPhaseId: 'old-phase' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('still errors when a final conclusion expectedCall never ran anywhere', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '根因分析',
          goal: '执行代表帧分析',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已完成代表帧分析，但尚未执行阻塞链分析。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '输出最终报告',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
          status: 'completed',
          summary: '最终报告声称包含阻塞链证据。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'jank_frame_detail',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('缺失: invoke_skill(blocking_chain_analysis)'),
    )).toBe(true);
  });

  it('does not let support tools satisfy a structured expectedCalls phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Root Cause',
        goal: 'Run the specific root-cause skill and supporting SQL',
        expectedTools: ['invoke_skill', 'execute_sql'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        status: 'completed',
        summary: 'Completed root-cause analysis with supporting SQL',
      }],
      toolCallLog: [
        { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('未执行全部结构化预期调用'),
    )).toBe(true);
  });

  it('does not let attribution-only resolver satisfy a structured expectedCalls phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Flutter pipeline',
        goal: 'Run the Flutter skill and resolve process identity if needed',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'flutter_scrolling_analysis' }],
        status: 'completed',
        summary: 'Completed identity resolution only',
      }],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'process_identity_resolver',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('未执行全部结构化预期调用'),
    )).toBe(true);
  });

  it('requires every structured expectedCalls entry before completing a phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Multi-skill root cause',
        goal: 'Run every required root-cause skill',
        expectedTools: ['invoke_skill'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
        ],
        status: 'completed',
        summary: 'Only the overview skill ran',
      }],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'scrolling_analysis',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('缺失: invoke_skill(jank_frame_detail)'),
    )).toBe(true);
  });

  it('accepts a completed structured expectedCalls phase after the required skill runs', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Root Cause',
        goal: 'Run the specific root-cause skill and supporting SQL',
        expectedTools: ['invoke_skill', 'execute_sql'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        status: 'completed',
        summary: 'Completed root-cause analysis with supporting SQL',
      }],
      toolCallLog: [
        { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' },
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'jank_frame_detail',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'error')).toBe(false);
  });

  it('should warn when completed phases lack reasoning summary', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G', expectedTools: [], status: 'completed', summary: 'Done with this phase.' },
        { id: 'p2', name: 'Phase 2', goal: 'G', expectedTools: [], status: 'completed' },
      ],
      toolCallLog: [],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'missing_reasoning' && i.message.includes('推理摘要'),
    )).toBe(true);
  });

  it('should error when plan carries unresolvedAspects (Phase 2.3 force-accepted gap)', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G', expectedTools: [], status: 'completed', summary: 'Done.' },
      ],
      toolCallLog: [],
      unresolvedAspects: ['startup_timing', 'launch_type_verdict'],
    });
    const issues = verifyPlanAdherence(plan);
    const unresolvedIssue = issues.find(
      i => i.severity === 'error' && i.message.includes('未覆盖场景必要 aspect'),
    );
    expect(unresolvedIssue).toBeDefined();
    expect(unresolvedIssue!.message).toContain('startup_timing');
    expect(unresolvedIssue!.message).toContain('launch_type_verdict');
  });
});

describe('verifyHypotheses', () => {
  it('should pass when all hypotheses resolved', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'RenderThread blocked', status: 'confirmed', formedAt: Date.now(), resolvedAt: Date.now() },
      { id: 'h2', statement: 'Memory pressure', status: 'rejected', formedAt: Date.now(), resolvedAt: Date.now() },
    ];
    expect(verifyHypotheses(hypotheses)).toHaveLength(0);
  });

  it('should pass with empty hypotheses', () => {
    expect(verifyHypotheses([])).toHaveLength(0);
  });

  it('should error when unresolved hypotheses exist', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'RenderThread blocked by Binder', status: 'formed', formedAt: Date.now() },
    ];
    const issues = verifyHypotheses(hypotheses);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].type).toBe('unresolved_hypothesis');
    expect(issues[0].message).toContain('RenderThread blocked');
  });

  it('should only flag formed hypotheses, not resolved ones', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'Blocked', status: 'confirmed', formedAt: Date.now(), resolvedAt: Date.now() },
      { id: 'h2', statement: 'Leaked', status: 'formed', formedAt: Date.now() },
    ];
    const issues = verifyHypotheses(hypotheses);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Leaked');
    expect(issues[0].message).not.toContain('Blocked');
  });
});

describe('verifySceneCompleteness', () => {
  it('should warn scrolling scene missing frame/jank content', () => {
    const findings = [makeFinding({ title: 'CPU issue', description: 'CPU is busy', category: 'cpu' })];
    const issues = verifySceneCompleteness('scrolling', findings, 'CPU analysis done');
    expect(issues.some(i => i.type === 'missing_check' && i.message.includes('帧'))).toBe(true);
  });

  it('should pass scrolling scene with frame content', () => {
    const findings = [makeFinding({ title: 'Jank frames detected', description: '15帧卡顿' })];
    const issues = verifySceneCompleteness('scrolling', findings, '帧渲染分析完成');
    expect(issues).toHaveLength(0);
  });

  it('should warn scrolling with significant jank but no deep drill', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧，freq_ramp_slow 占 47%，workload_heavy 占 9%。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.some(i => i.message.includes('Phase 1.9') || i.message.includes('深钻'))).toBe(true);
  });

  it('should require deep drill for small but real app jank counts', () => {
    const findings = [makeFinding({ title: 'Jank', description: '真实掉帧 7 帧，App Deadline Missed' })];
    const conclusion = '滑动分析：347帧中真实掉帧 7 帧，主要为 workload_heavy 和 lock_binder_wait。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.some(i => i.severity === 'error' && i.message.includes('深钻'))).toBe(true);
  });

  it('does not count lookup_knowledge alone as scrolling deep drill evidence', () => {
    const findings = [makeFinding({ title: 'Jank', description: '真实掉帧 7 帧，App Deadline Missed' })];
    const conclusion = '滑动分析：真实掉帧 7 帧。lookup_knowledge rendering-pipeline 解释了 Android 渲染背景。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion, [
      { toolName: 'lookup_knowledge', timestamp: Date.now(), inputSummary: 'rendering-pipeline', matchedPhaseId: 'p5' },
    ]);
    expect(issues.some(i => i.severity === 'error' && i.message.includes('深钻'))).toBe(true);
  });

  it('should pass scrolling with deep drill evidence present', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧。blocking_chain_analysis 显示主线程被 Binder 阻塞。lookup_knowledge cpu-scheduler。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.filter(i => i.message.includes('深钻'))).toHaveLength(0);
  });

  it('should count executed deep-drill tool calls even when the conclusion cites artifact names', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧。代表帧证据来自 art-21 和 art-16。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion, [
      { toolName: 'mcp__smartperfetto__invoke_skill', timestamp: Date.now(), skillId: 'jank_frame_detail', matchedPhaseId: 'p5' },
      { toolName: 'mcp__smartperfetto__invoke_skill', timestamp: Date.now(), skillId: 'frame_blocking_calls', matchedPhaseId: 'p5' },
    ]);
    expect(issues.filter(i => i.message.includes('深钻'))).toHaveLength(0);
  });

  it('should warn startup scene missing TTID/TTFD', () => {
    const findings = [makeFinding({ title: 'CPU busy', description: 'Some CPU work' })];
    const issues = verifySceneCompleteness('startup', findings, 'Done');
    expect(issues.some(i => i.message.includes('TTID/TTFD'))).toBe(true);
  });

  it('should pass startup scene with TTID mention and root-cause id reference', () => {
    // Avoid "冷启动" so cold-start-specific checks don't fire. The startup
    // scene-completeness check requires a root-cause id reference
    // (A1-A18 / B1-B12) followed within 30 chars by a context word
    // ("阻塞" / "加载" / "压力" / etc.) so a bare "A2" alone won't pass.
    const findings = [makeFinding({
      title: 'Startup analysis',
      description: 'TTID=850ms。根因 A2: 磁盘 IO 阻塞。',
    })];
    const conclusion = '启动性能分析。根因 A2 磁盘 IO 阻塞导致 TTID 延长。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues).toHaveLength(0);
  });

  it('should warn ANR scene missing deadlock/ANR content', () => {
    const findings = [makeFinding({ title: 'Memory high', description: 'OOM risk' })];
    const issues = verifySceneCompleteness('anr', findings, 'Memory analysis');
    expect(issues.some(i => i.message.includes('阻塞/死锁'))).toBe(true);
  });

  it('should not check general scene', () => {
    // verifySceneCompleteness is only called for non-general scenes
    // But if called with 'general', it should return no issues
    const issues = verifySceneCompleteness('general', [], '');
    expect(issues).toHaveLength(0);
  });
});

describe('generateCorrectionPrompt', () => {
  it('should include ERROR issues in the correction prompt', () => {
    const issues = [
      { type: 'missing_evidence' as const, severity: 'error' as const, message: 'CRITICAL 发现缺少证据' },
      { type: 'plan_deviation' as const, severity: 'warning' as const, message: '有阶段未完成' },
    ];
    const prompt = generateCorrectionPrompt(issues, '原始结论文本');
    expect(prompt).toContain('[ERROR]');
    expect(prompt).toContain('CRITICAL 发现缺少证据');
    expect(prompt).toContain('有阶段未完成'); // Warnings in "注意事项"
    expect(prompt).toContain('原始结论文本');
  });

  it('should handle only warnings gracefully', () => {
    const issues = [
      { type: 'too_many_criticals' as const, severity: 'warning' as const, message: '过多 CRITICAL' },
    ];
    const prompt = generateCorrectionPrompt(issues, '结论');
    // No ERROR items → empty numbered list, but warnings section present
    expect(prompt).toContain('过多 CRITICAL');
  });

  it('should use "generate from scratch" prompt when conclusion is incomplete', () => {
    const issues = [
      { type: 'unresolved_hypothesis' as const, severity: 'error' as const, message: '假设未解决' },
    ];
    // Short conclusion = just reasoning notes, no structured report
    const shortConclusion = '正在分析数据，发现 136 帧掉帧。准备输出结论。';
    const prompt = generateCorrectionPrompt(issues, shortConclusion);
    expect(prompt).toContain('结论尚未生成');
    expect(prompt).toContain('完整的结构化分析报告');
  });

  it('should inject scrolling final report contract for incomplete scrolling conclusions', () => {
    const issues = [
      { type: 'missing_reasoning' as const, severity: 'error' as const, message: '结论不完整' },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析滑动帧。', 'zh-CN', 'scrolling');
    expect(prompt).toContain('Final Report Contract');
    expect(prompt).toContain('全帧根因分布');
    expect(prompt).toContain('代表帧分析');
    expect(prompt).toContain('峰值/口径指标');
  });

  it('should spell out missing Final Report Contract sections during correction', () => {
    const issues = [
      {
        type: 'missing_reasoning' as const,
        severity: 'error' as const,
        message: 'Final Report Contract required structure missing: 代表帧分析',
      },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析滑动帧。', 'zh-CN', 'scrolling');
    expect(prompt).toContain('必须补齐的缺失小节');
    expect(prompt).toContain('- 代表帧分析');
    expect(prompt).toContain('清晰同名小节');
  });

  it('should inject startup final report contract instead of scrolling-specific requirements', () => {
    const issues = [
      { type: 'missing_reasoning' as const, severity: 'error' as const, message: '结论不完整' },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析启动耗时。', 'zh-CN', 'startup');
    expect(prompt).toContain('Final Report Contract');
    expect(prompt).toContain('启动类型与 TTID/TTFD');
    expect(prompt).toContain('阶段耗时分解');
    expect(prompt).toContain('App/系统分层建议');
    expect(prompt).not.toContain('全帧根因分布');
    expect(prompt).not.toContain('代表帧分析');
  });

  it('should use normal correction prompt when conclusion is complete', () => {
    const issues = [
      { type: 'missing_evidence' as const, severity: 'error' as const, message: 'CRITICAL 缺少证据' },
    ];
    const fullConclusion = '## 滑动性能分析报告\n\n### 1. 概览\n' + '详细内容'.repeat(300);
    const prompt = generateCorrectionPrompt(issues, fullConclusion);
    expect(prompt).not.toContain('结论尚未生成');
    expect(prompt).toContain('请修正以下问题');
    expect(prompt).toContain('修正阶段不要调用工具或重新查询数据');
    expect(prompt).toContain('不要把报告标成');
    expect(prompt).toContain('计划执行偏差');
    expect(prompt).toContain('不要声称某个工具或 Skill 未执行');
  });
});

describe('parseVerifierJsonIssues', () => {
  it('parses the first balanced JSON array and ignores prose after it', () => {
    const issues = parseVerifierJsonIssues(
      '```json\n' +
      '[{"type":"missing_evidence","severity":"critical","message":"缺少 art-1 证据"}]\n' +
      '```\n' +
      '补充说明：[不要把这段当作 JSON]',
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('missing_evidence');
    expect(issues[0].message).toContain('art-1');
  });

  it('skips non-JSON bracketed prose before the verifier array', () => {
    const issues = parseVerifierJsonIssues(
      '[ERROR] 需要关注：\n' +
      '[{"type":"severity_mismatch","severity":"warning","message":"单帧异常不应标 critical"}]',
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('severity_mismatch');
  });
});

// ── New tests: isConclusionIncomplete ────────────────────────────────────

describe('isConclusionIncomplete', () => {
  it('should detect short reasoning notes as incomplete', () => {
    expect(isConclusionIncomplete('正在分析数据。准备出结论。')).toBe(true);
  });

  it('should detect text without headings as incomplete', () => {
    const noHeadings = '分析发现 CPU 频率问题。'.repeat(100);
    expect(isConclusionIncomplete(noHeadings)).toBe(true);
  });

  it('should accept structured report as complete', () => {
    const fullReport = '## 滑动性能分析报告\n\n### 1. 概览\n' + '详细分析内容。'.repeat(200);
    expect(isConclusionIncomplete(fullReport)).toBe(false);
  });

  it('should detect empty string as incomplete', () => {
    expect(isConclusionIncomplete('')).toBe(true);
  });
});

describe('learnFromVerificationResults', () => {
  const mockFs = require('fs') as jest.Mocked<typeof import('fs')>;

  beforeEach(() => {
    const actualFs = jest.requireActual<typeof import('fs')>('fs');
    (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('learned_misdiagnosis')) return false;
      return actualFs.existsSync(p);
    });
    (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('learned_misdiagnosis')) return '[]';
      return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
    });
    (mockFs.writeFileSync as jest.Mock).mockClear();
    (mockFs.renameSync as jest.Mock).mockClear();
    (mockFs.mkdirSync as jest.Mock).mockClear();
  });

  it('should ignore non-misdiagnosis issues', () => {
    const issues = [{ type: 'missing_evidence' as const, severity: 'error' as const, message: 'Missing data' }];
    learnFromVerificationResults(issues, []);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should extract keywords from misdiagnosis issues', () => {
    const issues = [{
      type: 'known_misdiagnosis' as const,
      severity: 'warning' as const,
      message: 'VSync alignment issue is likely VRR behavior',
    }];
    const findings = [makeFinding({ title: 'VSync Alignment Problem' })];
    learnFromVerificationResults(issues, findings);
    // Should have attempted to write patterns
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it('should enrich keywords from matching finding titles (P2-G7)', () => {
    const issues = [{
      type: 'severity_mismatch' as const,
      severity: 'warning' as const,
      message: 'Buffer Stuffing 标记可能是假阳性',
    }];
    const findings = [makeFinding({
      title: 'Buffer Stuffing 严重',
      description: 'Buffer Stuffing 标记为 critical',
    })];
    learnFromVerificationResults(issues, findings);
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });
});

// ── New tests: Check 7 (truncation detection) ────────────────────────────

describe('verifyHeuristic — Check 7: Truncation detection', () => {
  it('should warn when conclusion ends mid-sentence', () => {
    // Last line must be > 15 chars to trigger truncation check
    const conclusion = 'A'.repeat(80) + '\n分析发现主线程 ChaosTask 耗时较长但缺少根因分析链条和深层阻塞';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.some(i => i.type === 'truncation')).toBe(true);
  });

  it('should not warn when conclusion ends with Chinese period', () => {
    const conclusion = 'A'.repeat(80) + '\n分析完成，主线程无明显瓶颈。';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with English period', () => {
    const conclusion = 'A'.repeat(80) + '\nAnalysis complete, no significant bottleneck found.';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with table row', () => {
    const conclusion = 'A'.repeat(80) + '\n| Binder 阻塞 | < 5ms | ✅ 可排除 |';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with a structured evidence reference', () => {
    const conclusion = 'A'.repeat(80) + '\n- evidence_ref_id=data:skill:x; source_ref=滑动区间; row_selector=session_id IN (1,2); column=session_fps; value=109.1,108.2';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with arrow or checkmark', () => {
    const conclusion = 'A'.repeat(80) + '\n└── CPU 频率（正常，无升频不足）✅';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn on short conclusions (< 100 chars)', () => {
    const conclusion = '短结论，未完';
    const issues = verifyHeuristic([], conclusion);
    // Should trigger "conclusion too short" error but NOT truncation
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });
});

// ── New tests: Startup scene completeness (cold-start specific) ──────────

describe('verifySceneCompleteness — startup cold-start checks', () => {
  it('should warn cold start missing Phase 2.6 slow reasons', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'bindApplication 477ms, TTID=1912ms 冷启动' })];
    const issues = verifySceneCompleteness('startup', findings, '冷启动总耗时 1338ms');
    expect(issues.some(i => i.message.includes('Phase 2.6') && i.message.includes('官方'))).toBe(true);
  });

  it('should not warn cold start with slow reasons present', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'TTID=850ms 冷启动' })];
    const conclusion = '冷启动分析完成。startup_slow_reasons 检查未发现 DEX2OAT 问题。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
  });

  it('should warn cold start missing JIT analysis', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'bindApplication 477ms 冷启动' })];
    const issues = verifySceneCompleteness('startup', findings, '冷启动总耗时 1338ms');
    expect(issues.some(i => i.message.includes('JIT'))).toBe(true);
  });

  it('should not warn cold start when JIT mentioned', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: '冷启动 bindApplication' })];
    const conclusion = '冷启动完成，JIT 编译影响可排除（< 5ms），startup_slow_reasons 正常。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });

  it('should warn Q4 heavy without blocking chain analysis', () => {
    const findings = [makeFinding({ title: '启动分析', description: 'Q4 Sleeping 35% 启动' })];
    const conclusion = '启动分析发现 S(Sleeping) = 470ms (35.1%)，推测为 join 等待。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.some(i => i.message.includes('阻塞链'))).toBe(true);
  });

  it('should not warn Q4 heavy when blocking chain present', () => {
    const findings = [makeFinding({ title: '启动分析', description: 'Q4 Sleeping 35% 启动' })];
    const conclusion = '启动分析：S(Sleeping) = 470ms (35.1%)。blocking_chain_analysis 显示 waker_current_slice 为 pool-3-thread 唤醒者。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('阻塞链'))).toHaveLength(0);
  });

  it('should not trigger cold-start checks for warm start', () => {
    const findings = [makeFinding({ title: '温启动分析', description: 'TTID=300ms 温启动 startup' })];
    const conclusion = '温启动总耗时 300ms。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    // Should not have Phase 2.6 or JIT warnings (these are cold-start only)
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });

  it('should not trigger cold-start checks when warm start mentions bindApplication', () => {
    // bindApplication can appear in warm-start analysis text (e.g., agent discussing its absence)
    const findings = [makeFinding({ title: '温启动分析', description: 'TTID=300ms 温启动 startup' })];
    const conclusion = '温启动分析：无 bindApplication slice，确认为温启动。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });
});

describe('verifyConclusion progress output', () => {
  it('treats missing startup final-report contract sections as correction errors', async () => {
    const conclusion = [
      '# 启动性能分析报告',
      '',
      '## 启动类型与 TTID/TTFD',
      '本次为冷启动，TTID=1912ms，TTFD 不可用。',
      '',
      '## 阶段耗时分解',
      'startup_detail 显示 ChaosTask self_ms=456ms，dur_ms=1338ms。',
      '',
      '## 根因编号引用',
      'SR12 对应三方 SDK 初始化过重，SR19 对应并发启动干扰。',
      '',
      '## 优化建议',
      '[App层] 延迟非关键初始化到首帧后。',
      '',
      'JIT 编译影响可排除；startup_slow_reasons 已交叉验证。',
    ].join('\n');

    const result = await verifyConclusion([], conclusion, {
      enableLLM: false,
      sceneType: 'startup',
      query: '分析启动性能',
    });

    expect(result.passed).toBe(false);
    expect(result.heuristicIssues).toContainEqual(expect.objectContaining({
      type: 'missing_reasoning',
      severity: 'error',
      message: expect.stringContaining('App/系统分层建议'),
    }));
  });

  it('passes sceneType into heuristic misdiagnosis matching', async () => {
    const result = await verifyConclusion([], 'VSync 对齐异常严重，且报告正文已经足够长以通过长度检查。', {
      enableLLM: false,
      sceneType: 'pipeline',
    });

    expect(result.heuristicIssues).toContainEqual(expect.objectContaining({
      type: 'known_misdiagnosis',
      severity: 'warning',
      message: expect.stringContaining('VRR'),
    }));
  });

  it('emits user-facing progress without exposing internal issue details', async () => {
    const emitted: any[] = [];

    const result = await verifyConclusion([], 'short', {
      enableLLM: false,
      plan: null,
      emitUpdate: update => emitted.push(update),
      outputLanguage: 'zh-CN',
    });

    expect(result.passed).toBe(false);
    const progressMessages = emitted
      .filter(update => update.type === 'progress')
      .map(update => String(update.content?.message || ''));
    expect(progressMessages).toEqual(expect.arrayContaining([
      '质量校验记录了报告改进项，系统会根据严重程度决定自动修正或交由最终门禁处理。',
    ]));
    expect(progressMessages.join('\n')).not.toContain('[ERROR]');
    expect(progressMessages.join('\n')).not.toContain('未提交分析计划');
    expect(progressMessages.join('\n')).not.toContain('验证发现');
  });

  it('can suppress user-facing issue progress when final gates remain authoritative', async () => {
    const emitted: any[] = [];

    const result = await verifyConclusion([], 'short', {
      enableLLM: false,
      plan: null,
      emitUpdate: update => emitted.push(update),
      emitIssueProgress: false,
      outputLanguage: 'zh-CN',
    });

    expect(result.passed).toBe(false);
    expect(emitted.filter(update => update.type === 'progress')).toHaveLength(0);
  });
});

// ── New tests: normalizeLLMSeverity ──────────────────────────────────────

describe('normalizeLLMSeverity', () => {
  it('should map "error" to "error"', () => {
    expect(normalizeLLMSeverity('error')).toBe('error');
  });

  it('should map "critical" to "error"', () => {
    expect(normalizeLLMSeverity('critical')).toBe('error');
  });

  it('should map "high" to "warning" (importance, not action-required)', () => {
    expect(normalizeLLMSeverity('high')).toBe('warning');
  });

  it('should map "warning" to "warning"', () => {
    expect(normalizeLLMSeverity('warning')).toBe('warning');
  });

  it('should map "medium" to "warning"', () => {
    expect(normalizeLLMSeverity('medium')).toBe('warning');
  });

  it('should map "low" to "warning"', () => {
    expect(normalizeLLMSeverity('low')).toBe('warning');
  });

  it('should map "info" to "warning"', () => {
    expect(normalizeLLMSeverity('info')).toBe('warning');
  });

  it('should handle case-insensitive input', () => {
    expect(normalizeLLMSeverity('CRITICAL')).toBe('error');
    expect(normalizeLLMSeverity('High')).toBe('warning');
    expect(normalizeLLMSeverity('WARNING')).toBe('warning');
  });

  it('should handle undefined/empty gracefully', () => {
    expect(normalizeLLMSeverity(undefined as any)).toBe('warning');
    expect(normalizeLLMSeverity('')).toBe('warning');
  });
});
