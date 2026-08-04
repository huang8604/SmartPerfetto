// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { buildQuickAcknowledgementDirectAnswer } from '../quickAcknowledgementDirectAnswer';

describe('buildQuickAcknowledgementDirectAnswer', () => {
  it('builds a concise Chinese acknowledgement without evidence claims', () => {
    const answer = buildQuickAcknowledgementDirectAnswer({ outputLanguage: 'zh-CN' });

    expect(answer).toEqual({
      conclusion: '收到。',
      confidence: 1,
    });
  });

  it('localizes the acknowledgement to English', () => {
    const answer = buildQuickAcknowledgementDirectAnswer({ outputLanguage: 'en' });

    expect(answer.conclusion).toBe('Got it.');
    expect(answer.confidence).toBe(1);
  });
});
