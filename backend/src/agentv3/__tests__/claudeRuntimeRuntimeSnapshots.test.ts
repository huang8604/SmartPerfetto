// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import { getProviderService, resetProviderService } from '../../services/providerManager';
import { saveClaudeSessionMapToRuntimeSnapshots } from '../../services/runtimeSnapshotStore';
import { ClaudeRuntime, __testing } from '../claudeRuntime';

const claudeSdkMock = require('@anthropic-ai/claude-agent-sdk') as {
  __setQueryImplementation: (impl: (params: any) => AsyncIterable<any>) => void;
  __getQueryCalls: () => any[];
  __resetQueryMock: () => void;
};

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  providerDataDirOverride: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  precompactThreshold: process.env.CLAUDE_PRECOMPACT_THRESHOLD,
  precompactWarnEnabled: process.env.CLAUDE_PRECOMPACT_WARN_ENABLED,
};

let tmpDir: string | undefined;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runtimeSnapshotCount(): number {
  const db = openEnterpriseDb(dbPath);
  try {
    const row = db.prepare<unknown[], { count: number }>(
      'SELECT COUNT(*) AS count FROM runtime_snapshots',
    ).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-claude-runtime-snapshot-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
  resetProviderService();
});

afterEach(async () => {
  claudeSdkMock.__resetQueryMock();
  sessionContextManager.remove('session-a');
  sessionContextManager.remove('session-quick');
  sessionContextManager.remove('session-provider');
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('PROVIDER_DATA_DIR_OVERRIDE', originalEnv.providerDataDirOverride);
  restoreEnvValue('CLAUDE_PRECOMPACT_THRESHOLD', originalEnv.precompactThreshold);
  restoreEnvValue('CLAUDE_PRECOMPACT_WARN_ENABLED', originalEnv.precompactWarnEnabled);
  resetProviderService();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('ClaudeRuntime enterprise runtime_snapshots session map', () => {
  it('does not mark a correction timeout partial when the existing conclusion is deliverable', () => {
    const conclusion =
      '我来分析这个 WebView 应用的启动性能。首先提交分析计划并获取启动概览数据。计划已提交。开始 Phase 1：获取启动概览数据。\n\n' +
      '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主因是主线程 ChaosTask 模拟负载，证据来自 art-1 与 art-2。\n\n' +
      '## 关键证据链\n\n' +
      '- art-1: startup_analysis 显示冷启动。\n' +
      '- art-2: main thread running=63%。\n\n' +
      '## 优化建议\n\n' +
      '- App 侧：削减 ChaosTask 初始化负载。\n' +
      '- 系统侧：当前无明确系统瓶颈。';

    expect(__testing.sanitizeClaudeConclusionText(conclusion).startsWith('# 启动性能分析报告')).toBe(true);
    expect(__testing.shouldMarkCorrectionTimeoutPartial({
      correctedResult: '',
      existingConclusion: conclusion,
    })).toBe(false);
  });

  it('marks a correction timeout partial when neither correction nor existing conclusion is deliverable', () => {
    expect(__testing.shouldMarkCorrectionTimeoutPartial({
      correctedResult: '',
      existingConclusion: '我需要继续调用工具补齐 Phase 2，并稍后输出报告。',
    })).toBe(true);
  });

  it('gives correction retries enough per-turn budget for streamed report output', () => {
    expect(__testing.getCorrectionRetryTimeoutMs(5, false)).toBe(225_000);
    expect(__testing.getCorrectionRetryTimeoutMs(10, true)).toBe(300_000);
  });

  it('only skips SDK correction for deliverable reports when errors are non-content blockers', () => {
    const deliverable =
      '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 art-1。\n\n' +
      '## 关键证据链\n\n' +
      '- art-1: ChaosTask self_ms=456ms。\n\n' +
      '## 优化建议\n\n' +
      '- 延迟模拟负载。';

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'plan_deviation', severity: 'error', message: '阶段未完成' },
    ], deliverable)).toBe(true);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'missing_evidence', severity: 'error', message: '缺少证据' },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      {
        type: 'missing_reasoning',
        severity: 'error',
        message: '最终报告缺失 Final Report Contract 必需结构：App/系统分层建议。',
      },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'missing_reasoning', severity: 'error', message: '结论不完整' },
    ], '我还需要继续分析，稍后输出报告。')).toBe(false);
  });

  it('does not run SDK correction for soft truncation false positives on complete reports', () => {
    const report =
      '# 滑动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '滑动窗口总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，主因是 CustomScroll_longFrameLoad。' +
      '证据来自 evidence_ref_id=data:skill:scrolling_analysis:summary 与 source_ref=art-7。\n\n' +
      '## 关键证据链\n\n' +
      Array.from({ length: 20 }, (_, idx) =>
        `- art-${idx + 1}: frame_id=${idx + 100}, dur=${30 + idx}.1ms, reason_code=workload_heavy。`,
      ).join('\n') +
      '\n\n## 优化建议\n\n' +
      '- 拆分 CustomScroll_longFrameLoad，移出 Choreographer animation 回调。\n\n' +
      '- source_ref=art-7 value=CustomScroll_longFrameLoad 59.31ms';

    expect(__testing.looksLikeSoftTruncationFalsePositive(report)).toBe(true);
    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], report)).toBe(true);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
      { type: 'missing_reasoning', severity: 'error', message: '缺少报告结构' },
    ], report)).toBe(false);
  });

  it('still runs SDK correction for hard truncation of an otherwise structured report', () => {
    const report =
      '# 滑动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '滑动窗口总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，证据来自 evidence_ref_id=data:art-1。\n\n' +
      '## 关键证据链\n\n' +
      Array.from({ length: 20 }, (_, idx) =>
        `- art-${idx + 1}: frame_id=${idx + 100}, dur=${30 + idx}.1ms, reason_code=workload_heavy。`,
      ).join('\n') +
      '\n\n## 优化建议\n\n' +
      '因此下一步需要继续';

    expect(__testing.looksLikeSoftTruncationFalsePositive(report)).toBe(false);
    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], report)).toBe(false);
  });

  it('prefers a streamed deliverable report over a terse terminal summary before verification', () => {
    const chosen = __testing.chooseClaudeConclusionText({
      finalResult: '**总结**：冷启动 TTID 1912ms，主因是 ChaosTask。',
      accumulatedAnswer:
        '我来分析这个 WebView 应用的启动性能。开始 Phase 1：获取启动概览数据。\n\n' +
        '# 启动性能分析报告\n\n' +
        '## 综合结论\n\n' +
        '冷启动 TTID=1912ms，主因是主线程 ChaosTask 模拟负载，证据来自 art-1 与 art-2。\n\n' +
        '## 关键证据链\n\n' +
        '- art-1: startup_analysis 显示冷启动。\n' +
        '- art-2: main thread running=63%。\n\n' +
        '## 优化建议\n\n' +
        '- App 侧：削减 ChaosTask 初始化负载。',
    });

    expect(chosen.startsWith('# 启动性能分析报告')).toBe(true);
    expect(chosen).not.toContain('我来分析这个 WebView 应用');
  });

  it('adds a scene report heading for structured reports that start with a domain annotation', () => {
    const normalized = __testing.ensureClaudeFinalReportHeading(
      '所有深钻数据已收集完毕。现在输出综合结论。\n\n' +
      '## ⚠️ 测试/基准应用标注\n\n' +
      'CustomScroll_longFrameLoad 是测试负载。\n\n' +
      '## 1. 概览\n\n' +
      '总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，掉帧率 2.02%。' +
      '证据来自 evidence_ref_id=data:art-4 与 source_ref=滑动性能概览。' +
      '根因集中在 animation 回调内的 CustomScroll_longFrameLoad，同步占用主线程 59.31ms。' +
      'RenderThread 仅 1.88ms，说明瓶颈不在渲染线程。' +
      '优化建议是拆分长负载并移出 Choreographer animation 回调。',
      'scrolling',
      'zh-CN',
    );

    expect(normalized.startsWith('# 滑动性能分析报告')).toBe(true);
    expect(normalized).not.toContain('所有深钻数据已收集完毕');
  });

  it('strips process narration that appears after an inserted scene report heading', () => {
    const normalized = __testing.ensureClaudeFinalReportHeading(
      '我来分析这个 trace 的滑动性能。首先提交分析计划并获取 trace 时间范围。计划缺少架构特定分析阶段，需要补充。重新提交完整计划。计划已提交。\n\n' +
      '## ⚠️ 测试/基准应用标注\n\n' +
      'CustomScroll_longFrameLoad 是测试负载。\n\n' +
      '## 1. 概览\n\n' +
      '总帧数 347，真实掉帧 7 帧，最长帧 62.73ms。证据来自 evidence_ref_id=data:art-4 与 source_ref=滑动性能概览。\n\n' +
      '## 优化建议\n\n' +
      '- App 侧：拆分 CustomScroll_longFrameLoad。',
      'scrolling',
      'zh-CN',
    );

    expect(normalized.startsWith('# 滑动性能分析报告')).toBe(true);
    expect(normalized).not.toContain('我来分析这个 trace');
    expect(normalized).not.toContain('计划缺少架构特定分析阶段');
    expect(normalized).toContain('## ⚠️ 测试/基准应用标注');
  });

  it('normalizes bridge conclusion updates before they reach session logs', () => {
    const normalized = __testing.normalizeClaudeBridgeConclusionUpdate({
      type: 'conclusion',
      content: {
        conclusion:
          '所有假设已解决，数据收集完整。输出最终报告：\n\n' +
          '# 滑动性能分析报告\n\n' +
          '## 综合结论\n\n' +
          '真实掉帧 7 帧，证据来自 evidence_ref_id=data:art-1。\n\n' +
          '## 优化建议\n\n' +
          '- 拆分长任务。',
      },
      timestamp: 1,
    } as any, 'scrolling', 'zh-CN');

    expect((normalized.content as any).conclusion).toMatch(/^# 滑动性能分析报告/);
    expect((normalized.content as any).conclusion).not.toContain('输出最终报告');
  });

  it('strips completed-data narration before startup report headings', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '所有数据收集完毕，开始撰写综合结论报告。\n\n' +
      '---\n\n' +
      '## 启动性能分析报告：`com.example.launch.aosp.heavy`\n\n' +
      '### 1. 概览\n\n' +
      '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 evidence_ref_id=data:art-1。\n\n' +
      '### 2. 优化建议\n\n' +
      '- 保留测试应用标注。',
    );

    expect(normalized).toMatch(/^## 启动性能分析报告/);
    expect(normalized).not.toContain('所有数据收集完毕');
  });

  it('strips correction scaffold from corrected reports', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '# 滑动性能分析报告\n\n' +
      '## 滑动性能分析报告（修正版）\n\n' +
      '> ⚠️ **计划执行偏差（p1.5 + p2）**\n' +
      '>\n' +
      '> - **p1.5**: invoke_skill(process_identity_resolver) 未执行。\n\n' +
      '---\n\n' +
      '### 概览\n\n' +
      '滑动总帧 347，真实掉帧 7，最长帧 62.73ms。',
    );

    expect(normalized).toMatch(/^# 滑动性能分析报告\n\n### 概览/);
    expect(normalized).not.toContain('修正版');
    expect(normalized).not.toContain('计划执行偏差');
    expect((normalized.match(/滑动性能分析报告/g) || [])).toHaveLength(1);
  });

  it('strips tool-not-executed correction scaffold from corrected reports', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '# 滑动性能分析报告\n\n' +
      '> ⚠️ **架构检测置信度低**（`detect_architecture` Skill 本次未执行，架构类型按标准 HWUI 处理）。\n\n' +
      '## 一、概览\n\n' +
      '滑动总帧 347，真实掉帧 7，证据来自 evidence_ref_id=data:skill:scrolling_analysis。\n\n' +
      '## 优化建议\n\n' +
      '- 移除 animation 回调中的长任务。',
    );

    expect(normalized).toContain('架构检测置信度低');
    expect(normalized).toContain('架构类型按标准 HWUI 处理');
    expect(normalized).not.toContain('Skill 本次未执行');
    expect(normalized).not.toContain('detect_architecture` Skill');
  });

  it('recognizes missing SDK conversations from object-shaped result errors', () => {
    const message = __testing.getSdkResultErrorMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [{ message: 'No conversation found with session ID: sdk-session-a' }],
    });

    expect(message).toBe('Claude analysis error (error_during_execution): No conversation found with session ID: sdk-session-a');
    expect(__testing.isMissingSdkConversationError(message!)).toBe(true);
  });

  it('loads SDK session mappings from runtime_snapshots on construction', () => {
    const now = Date.now();
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now,
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBe('sdk-session-a');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose stale SDK session mappings for persistence', () => {
    const now = 1_700_000_000_000;
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('removes enterprise runtime_snapshots rows during session cleanup', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(1);

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.removeSession('session-a');
    expect(runtimeSnapshotCount()).toBe(0);
  });

  it('forgets stale SDK mappings when the remote conversation is gone', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-b',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(2);

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      (runtime as any).forgetSdkSessionMapping(
        'session-a',
        'session-a',
        'Claude analysis error (error_during_execution): No conversation found with session ID: sdk-session-a',
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
    expect(runtimeSnapshotCount()).toBe(1);
  });

  it('restores full-mode snapshot SDK mappings with the snapshot timestamp', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
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
        kind: 'claude-agent-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        claude: {
          sdkSessionId: 'sdk-session-a',
          sdkSessionMode: 'full',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-a',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
  });

  it('restores full-mode comparison snapshot SDK mappings under the comparison key', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
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
      sdkSessionId: 'sdk-session-compare',
      sdkSessionMode: 'full',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
    expect((runtime as any).sessionMap.get('session-a:ref:trace-b')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-compare',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
    expect(runtime.getSdkSessionId('session-a', 'trace-b')).toBe('sdk-session-compare');
  });


  it('does not restore legacy unmarked SDK mappings from snapshots', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'session-a',
      traceId: 'trace-a',
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
      sdkSessionId: 'legacy-sdk-session',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
  });

  it('does not persist stale SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
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
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-fresh',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
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

      expect(snapshot.sdkSessionId).toBe('sdk-session-fresh');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'claude-agent-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        claude: {
          sdkSessionId: 'sdk-session-fresh',
          sdkSessionMode: 'full',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-compare',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
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
      expect(snapshot.sdkSessionId).toBe('sdk-session-compare');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: 'sdk-session-compare',
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose fresh legacy session-map entries without full-mode ownership', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'legacy-sdk-session',
      updatedAt: now,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
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
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs quick mode without SDK resume or full-session map overwrite', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const now = Date.now();
    (runtime as any).sessionMap.set('session-quick', {
      sdkSessionId: 'full-sdk-session',
      updatedAt: now,
      mode: 'full',
    });
    (runtime as any).architectureCache.set('trace-quick', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    sessionContextManager.getOrCreate('session-quick', 'trace-quick').addTurn(
      '上一轮查到的包名是什么？',
      {
        primaryGoal: '上一轮查到的包名是什么？',
        aspects: [],
        expectedOutputType: 'summary',
        complexity: 'simple',
        followUpType: 'initial',
      },
      {
        agentId: 'claude-agent',
        success: true,
        findings: [],
        confidence: 0.8,
        message: '上一轮回答：主要包名是 com.example.app。',
      },
      [],
    );
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-sdk-session',
        num_turns: 1,
        result: '当前仍然是 com.example.app。',
      };
    });

    await runtime.analyze('继续回答刚才的问题', 'session-quick', 'trace-quick', {
      analysisMode: 'fast',
      packageName: 'com.example.app',
    });

    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].prompt).toContain('上一轮回答：主要包名是 com.example.app。');
    expect((runtime as any).sessionMap.get('session-quick')).toEqual(expect.objectContaining({
      sdkSessionId: 'full-sdk-session',
      mode: 'full',
    }));
  });

  it('passes stable and volatile full-mode prompt blocks through the Claude cache boundary', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-cache-boundary', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-cache-boundary',
        num_turns: 1,
        result: [
          '## 综合结论',
          'Full-mode prompt cache boundary was applied.',
          '',
          '## 关键证据链',
          '- Selection context stayed in the volatile suffix.',
          '',
          '## 优化建议',
          '- Keep stable prompt sections cacheable.',
        ].join('\n'),
      };
    });

    const result = await runtime.analyze('分析选区内的掉帧', 'session-cache-boundary', 'trace-cache-boundary', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 } as any,
    });

    expect(result.success).toBe(true);
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(Array.isArray(call.options.systemPrompt)).toBe(true);
    const blocks = call.options.systemPrompt as string[];
    const boundaryIndex = blocks.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(blocks.slice(0, boundaryIndex).join('\n\n')).toContain('SmartPerfetto');
    expect(blocks.slice(boundaryIndex + 1).join('\n\n')).toContain('用户选区上下文');
  });

  it('keeps unsupported runtime prompt cache capabilities on the full system prompt string', () => {
    const sdkPrompt = __testing.buildClaudeSdkSystemPrompt({
      fullPrompt: 'stable\n\nvolatile',
      stablePrefix: 'stable',
      volatileSuffix: 'volatile',
    }, {
      kind: 'unsupported-runtime',
      displayName: 'Unsupported Runtime',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });

    expect(sdkPrompt).toBe('stable\n\nvolatile');
  });

  it('keeps monitor-only context pressure warnings out of user-facing progress updates', async () => {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = '0.6';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: [], rows: [] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-context-pressure', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-context-pressure',
        message: { content: [] },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 130_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-context-pressure',
        num_turns: 1,
        result: [
          '# 启动性能分析报告',
          '',
          '## 综合结论',
          '',
          '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 data:art-1。',
          '',
          '## 关键证据链',
          '',
          '- data:art-1: startup_analysis 显示冷启动。',
          '',
          '## 优化建议',
          '',
          '- 减少主线程模拟负载。',
        ].join('\n'),
      };
    });

    try {
      const result = await runtime.analyze('分析启动性能', 'session-context-pressure', 'trace-context-pressure', {
        analysisMode: 'full',
        packageName: 'com.example.launch.aosp.heavy',
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-rot threshold crossed'));
      const progressText = updates
        .filter(update => update.type === 'progress')
        .map(update => JSON.stringify(update.content))
        .join('\n');
      expect(progressText).not.toContain('接近上下文上限');
      expect(progressText).not.toContain('Context window is close to its limit');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses scoped Claude provider tuning when preparing full SDK options', async () => {
    const svc = getProviderService();
    const provider = svc.create({
      name: 'Scoped Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: {
        primary: 'provider-claude-main',
        light: 'provider-claude-light',
        subAgent: 'provider-claude-subagent',
      },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeApiKey: 'sk-provider-claude',
      },
      tuning: {
        maxTurns: 4,
        fullPerTurnMs: 10000,
        effort: 'max',
        enableSubAgents: true,
        enableVerification: false,
      },
    });
    svc.activate(provider.id);

    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: [], rows: [] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
      model: 'base-claude-main',
      maxTurns: 60,
      effort: 'low',
    });
    (runtime as any).architectureCache.set('trace-provider', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-provider-session',
        num_turns: 1,
        result: [
          '## 综合结论',
          'Scoped provider tuning was applied to the Claude full analysis path.',
          '',
          '## 证据',
          '- Provider-specific model, effort, maxTurns, and sub-agent config were used.',
        ].join('\n'),
      };
    });

    const result = await runtime.analyze('分析 UI 卡顿', 'session-provider', 'trace-provider', {
      analysisMode: 'full',
      packageName: 'com.example.app',
    });

    expect(result.success).toBe(true);
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(call.options.model).toBe('provider-claude-main');
    expect(call.options.maxTurns).toBe(4);
    expect(call.options.effort).toBe('max');
    expect(call.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-claude');
    expect(call.options.agents).toBeDefined();
    expect(JSON.stringify(call.options.agents)).toContain('provider-claude-subagent');
  });
});
