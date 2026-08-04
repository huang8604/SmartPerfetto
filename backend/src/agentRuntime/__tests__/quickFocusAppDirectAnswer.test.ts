// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { buildFocusAppEvidencePayload } from '../focusAppEvidence';
import {
  buildQuickFocusAppDirectAnswer,
  shouldUseQuickFocusAppDirectAnswer,
} from '../quickFocusAppDirectAnswer';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';

const selectionContext = {
  kind: 'area' as const,
  source: 'area_selection' as const,
  startNs: 506_731_662_000_000,
  endNs: 506_731_900_000_000,
};

function scopedFocusEvidence() {
  return buildFocusAppEvidencePayload({
    method: 'frame_timeline',
    primaryApp: 'com.example.wechatfriendforcustomscroller',
    timeRange: {
      startNs: selectionContext.startNs,
      endNs: selectionContext.endNs,
    },
    apps: [{
      packageName: 'com.example.wechatfriendforcustomscroller',
      totalDurationNs: 175_703_635,
      switchCount: 29,
    }],
  }, 'trace-1');
}

function traceWideFocusEvidence() {
  return buildFocusAppEvidencePayload({
    method: 'frame_timeline',
    primaryApp: 'com.example.wechatfriendforcustomscroller',
    apps: [{
      packageName: 'com.example.wechatfriendforcustomscroller',
      totalDurationNs: 1_700_000_000,
      switchCount: 347,
    }],
  }, 'trace-1');
}

describe('quick focus app direct answer', () => {
  it('answers selected-range focus app identity from scoped runtime evidence', () => {
    const evidence = scopedFocusEvidence();
    const answer = buildQuickFocusAppDirectAnswer({
      query: '这个选区的焦点应用是什么？',
      evidence,
      selectionContext,
      outputLanguage: 'zh-CN',
    });

    expect(answer?.conclusion).toContain('com.example.wechatfriendforcustomscroller');
    expect(answer?.conclusion).toContain('当前选区/范围内');
    expect(answer?.conclusionContract.claims?.[0]?.references.map(ref => ref.column)).toEqual(
      expect.arrayContaining([
        'package_name',
        'foreground_duration_ns',
        'foreground_count',
        'scope_start_ns',
        'scope_end_ns',
      ]),
    );

    const verified = runClaimVerification({
      conclusionContract: answer?.conclusionContract,
      dataEnvelopes: evidence.envelope ? [evidence.envelope] : [],
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('answers trace-wide current app identity from runtime focus evidence', () => {
    const evidence = traceWideFocusEvidence();
    const answer = buildQuickFocusAppDirectAnswer({
      query: '当前应用是谁？',
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(answer?.conclusion).toContain('com.example.wechatfriendforcustomscroller');
    expect(answer?.conclusion).toContain('当前 trace');
    expect(answer?.conclusionContract.claims?.[0]?.references.map(ref => ref.column)).toEqual(
      expect.arrayContaining([
        'package_name',
        'foreground_duration_ns',
        'foreground_count',
      ]),
    );
  });

  it('keeps non-identity focus app questions on the model path', () => {
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '当前应用是谁？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '哪个应用在前台？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'foreground package?',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'what is the foreground package?',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '前台包名是什么？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '选中的应用是什么？',
      selectionContext,
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '这个选区的焦点应用为什么掉帧？',
      selectionContext,
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '焦点应用有多少进程？',
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '当前应用为什么慢？',
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'foreground package jank?',
    })).toBe(false);
  });
});
