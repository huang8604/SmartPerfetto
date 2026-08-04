// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { sanitizeUiActionProposals } from '../uiActionProposalSanitizer';

describe('sanitizeUiActionProposals', () => {
  it('keeps only confirmed current-trace navigation proposals', () => {
    const proposals = sanitizeUiActionProposals([
      {
        schemaVersion: 1,
        id: 'jump-good',
        kind: 'navigate_timeline',
        title: '跳到主线程阻塞',
        reason: '该时间点来自已引用证据表',
        source: { evidenceRefId: 'ev-1', skillId: 'cpu' },
        payload: { ts: '123456789', traceId: 'trace-1' },
        requiresConfirmation: true,
      },
      {
        schemaVersion: 1,
        id: 'jump-other-trace',
        kind: 'navigate_timeline',
        title: '错误 trace',
        reason: 'trace 不匹配',
        source: { evidenceRefId: 'ev-2' },
        payload: { ts: '123456789', traceId: 'trace-2' },
        requiresConfirmation: true,
      },
      {
        schemaVersion: 1,
        id: 'auto-run',
        kind: 'navigate_timeline',
        title: '无确认',
        reason: '不能自动执行',
        source: { evidenceRefId: 'ev-3' },
        payload: { ts: '123456789', traceId: 'trace-1' },
        requiresConfirmation: false,
      },
    ], { currentTraceId: 'trace-1' });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({
      schemaVersion: 1,
      id: 'jump-good',
      kind: 'navigate_timeline',
      title: '跳到主线程阻塞',
      reason: '该时间点来自已引用证据表',
      source: { evidenceRefId: 'ev-1', skillId: 'cpu' },
      payload: { ts: '123456789', traceId: 'trace-1' },
      requiresConfirmation: true,
    });
  });

  it('rejects malformed payloads and caps the sanitized result count', () => {
    const proposals = sanitizeUiActionProposals([
      {
        schemaVersion: 1,
        id: 'bad-range',
        kind: 'navigate_range',
        title: '反向区间',
        reason: 'end 必须大于 start',
        source: { evidenceRefId: 'ev-1' },
        payload: { startNs: '200', endNs: '100' },
        requiresConfirmation: true,
      },
      {
        schemaVersion: 1,
        id: 'pin-1',
        kind: 'pin_evidence',
        title: '固定证据',
        reason: '用于后续追问',
        source: { evidenceRefId: 'ev-2' },
        payload: { evidenceRefId: 'ev-2' },
        requiresConfirmation: true,
      },
      {
        schemaVersion: 1,
        id: 'pin-duplicate',
        kind: 'pin_evidence',
        title: '重复固定证据',
        reason: '相同 payload 只保留一次',
        source: { evidenceRefId: 'ev-2' },
        payload: { evidenceRefId: 'ev-2' },
        requiresConfirmation: true,
      },
      {
        schemaVersion: 1,
        id: 'open-1',
        kind: 'open_evidence_table',
        title: '打开表格',
        reason: '查看原始行',
        source: { evidenceRefId: 'ev-3', artifactId: 'art-3' },
        payload: { artifactId: 'art-3', evidenceRefId: 'ev-3' },
        requiresConfirmation: true,
      },
    ], { maxProposals: 2 });

    expect(proposals.map(proposal => proposal.id)).toEqual(['pin-1', 'open-1']);
  });
});
