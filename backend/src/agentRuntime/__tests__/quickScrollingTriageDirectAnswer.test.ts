// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import {
  QUICK_TRIAGE_MAX_CHINESE_CHARS,
  QUICK_TRIAGE_MAX_CLAIMS,
} from '../../agentv3/quickAnswerContract';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';
import {
  buildQuickScrollingTriageSkillParams,
  buildQuickScrollingTriageDirectAnswer,
  selectQuickScrollingTriageEvidenceEnvelopes,
  shouldUseQuickScrollingTriageDirectAnswer,
} from '../quickScrollingTriageDirectAnswer';

function envelope(input: {
  stepId: string;
  title: string;
  columns: string[];
  rows: unknown[][];
}): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: `scrolling_analysis:${input.stepId}`,
      timestamp: 1,
      skillId: 'scrolling_analysis',
      stepId: input.stepId,
      evidenceRefId: `data:skill:scrolling_analysis:current:test:${input.stepId}`,
      sourceToolCallId: 'runtime-skill:scrolling_analysis:test',
      traceSide: 'current',
      traceId: 'trace-1',
    },
    data: {
      columns: input.columns,
      rows: input.rows,
    },
    display: {
      layer: 'overview',
      format: 'table',
      title: input.title,
    },
  };
}

describe('shouldUseQuickScrollingTriageDirectAnswer', () => {
  it('matches broad scrolling triage questions only', () => {
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '快速看一下滑动卡不卡，FPS 怎么样' })).toBe(true);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '整体流畅吗？' })).toBe(true);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'scroll jank overview and smoothness' })).toBe(true);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'is scrolling smooth?' })).toBe(true);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '滑动 FPS 是多少？' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '快速回答：这条 trace 的滑动总帧数和 janky frame 数是多少？请引用当前证据 ID，只给结论。' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '快速看一下滑动 FPS 是多少？' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'what is the jank rate?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'what is the FPS?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'how many dropped frames?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'jank frames?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'trace jank count?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'any jank?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'is there any jank in this trace?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'jank present?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'does this trace have jank?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '这个 trace 掉帧吗？' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '有没有滑动？' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'scroll rows?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'scroll gestures?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'swipe rows?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'why is scrolling janky?' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'scrolling jank root cause' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '为什么滑动卡顿？' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '逐帧看哪一帧 root cause 和调用栈' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: '对比两个 trace 的滑动卡顿差异' })).toBe(false);
    expect(shouldUseQuickScrollingTriageDirectAnswer({ query: 'CPU 有几个核心' })).toBe(false);
  });
});

describe('buildQuickScrollingTriageSkillParams', () => {
  it('keeps quick triage on bounded overview evidence without expert probes', () => {
    expect(buildQuickScrollingTriageSkillParams({
      effectivePackageName: 'com.example.app',
      timeRange: { startNs: 1000, endNs: 2000 },
    })).toEqual({
      package: 'com.example.app',
      enable_frame_details: false,
      max_frames_per_session: 10,
      enable_expert_probes: false,
      start_ts: 1000,
      end_ts: 2000,
    });
  });
});

describe('selectQuickScrollingTriageEvidenceEnvelopes', () => {
  it('keeps only the evidence cited by quick triage direct answers', () => {
    const performance = envelope({
      stepId: 'performance_summary',
      title: '滑动性能概览',
      columns: ['total_frames'],
      rows: [[347]],
    });
    const inputLatency = envelope({
      stepId: 'input_latency_summary',
      title: 'Input 延迟概览',
      columns: ['total_input_events'],
      rows: [[35]],
    });
    const rootCause = envelope({
      stepId: 'batch_frame_root_cause',
      title: '掉帧列表',
      columns: ['frame_id'],
      rows: [['59665234']],
    });
    const skippedExpertProbe = envelope({
      stepId: 'frame_variance_probe',
      title: '帧稳定性方差（专家探针）',
      columns: ['total_frames'],
      rows: [],
    });

    expect(selectQuickScrollingTriageEvidenceEnvelopes([
      performance,
      skippedExpertProbe,
      inputLatency,
      rootCause,
    ])).toEqual([performance, inputLatency, rootCause]);
  });
});

describe('buildQuickScrollingTriageDirectAnswer', () => {
  it('builds a verifier-backed quick triage answer from scrolling_analysis envelopes', () => {
    const performance = envelope({
      stepId: 'performance_summary',
      title: '滑动性能概览',
      columns: [
        'total_frames',
        'perceived_jank_frames',
        'jank_rate',
        'buffer_stuffing_frames',
        'buffer_stuffing_rate',
        'app_janky_frames',
        'sf_jank_count',
        'actual_fps',
        'refresh_rate',
        'p95_frame_dur',
        'rating',
      ],
      rows: [[347, 7, 2.02, 14, 4.03, 6, 1, 78, 120, 6457508, '良好']],
    });
    const inputLatency = envelope({
      stepId: 'input_latency_summary',
      title: 'Input 延迟概览',
      columns: [
        'target_process',
        'total_input_events',
        'move_events',
        'p95_handling_ms',
        'max_handling_ms',
        'max_e2e_ms',
        'slow_handling_events',
        'input_backlog_frames',
        'input_latency_rating',
      ],
      rows: [['com.example.app', 35, 29, 0.71, 13.61, 98.44, 32, 2, '需关注']],
    });
    const rootCause = envelope({
      stepId: 'batch_frame_root_cause',
      title: '掉帧列表',
      columns: [
        'frame_id',
        'dur_ms',
        'vsync_missed',
        'reason_code',
        'primary_cause',
        'top_slice_name',
        'top_slice_ms',
      ],
      rows: [
        ['59665037', 18.66, 2, 'lock_binder_wait', '锁/Binder等待: Q4b(S/I)=80.4%', 'Choreographer#doFrame', 15.1],
        ['59665038', 12.4, 1, 'unknown', '证据不足', 'doFrame', 8.2],
      ],
    });

    const directAnswer = buildQuickScrollingTriageDirectAnswer({
      evidence: { envelopes: [performance, inputLatency, rootCause], effectivePackageName: 'com.example.app' },
      outputLanguage: 'zh-CN',
    });

    expect(directAnswer?.conclusion).toContain('## 快速 Triage');
    expect(directAnswer?.conclusion).toContain('共 347 帧');
    expect(directAnswer?.conclusion).toContain('Input 延迟概览');
    expect(directAnswer?.conclusion).toContain('证据索引：');
    expect(directAnswer?.conclusion).toContain('evidence_ref_id=');
    expect(directAnswer?.conclusion.length ?? 0).toBeLessThanOrEqual(QUICK_TRIAGE_MAX_CHINESE_CHARS);
    expect(directAnswer?.conclusionContract.metadata?.rounds).toBe(0);
    expect(directAnswer?.conclusionContract.claims).toHaveLength(QUICK_TRIAGE_MAX_CLAIMS);

    const verified = runClaimVerification({
      conclusionContract: directAnswer?.conclusionContract,
      dataEnvelopes: [performance, inputLatency, rootCause],
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      unsupportedClaimCount: 0,
    }));
  });
});
