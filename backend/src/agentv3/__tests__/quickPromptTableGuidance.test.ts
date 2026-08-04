// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { loadPromptTemplate } from '../strategyLoader';

describe('prompt-quick table guidance', () => {
  it('keeps table-first guidance for tabular facts', () => {
    const prompt = loadPromptTemplate('prompt-quick');

    expect(prompt).toContain('表格优先呈现可表格化结果');
    expect(prompt).toContain('紧凑 Markdown 表格');
    expect(prompt).toContain('不要把多行/多指标结果压成长段落');
  });
});
