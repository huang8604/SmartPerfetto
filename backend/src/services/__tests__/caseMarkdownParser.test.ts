// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {parseCaseMarkdown} from '../caseMarkdownParser';

describe('caseMarkdownParser', () => {
  it('parses YAML frontmatter and preserves the Markdown body', () => {
    const result = parseCaseMarkdown(
      'backend/knowledge/cases/scrolling/example.md',
      `---
case_id: scroll_shader_compile_pixel8_001
title: Shader compile during scroll
status: reviewed
quality: curated
scene: scrolling
domain_pack: scrolling.v1
---

## Summary

RenderThread compiled shaders during the dropped-frame window.
`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.filePath).toBe(
      'backend/knowledge/cases/scrolling/example.md',
    );
    expect(result.parsed.frontmatter.case_id).toBe(
      'scroll_shader_compile_pixel8_001',
    );
    expect(result.parsed.body).toContain('## Summary');
    expect(result.parsed.body).toContain('RenderThread compiled shaders');
  });

  it('returns a structured validation issue when frontmatter is missing', () => {
    const result = parseCaseMarkdown(
      'backend/knowledge/cases/scrolling/missing.md',
      '# Missing frontmatter',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        filePath: 'backend/knowledge/cases/scrolling/missing.md',
        message: expect.stringMatching(/frontmatter/i),
      }),
    ]);
  });

  it('returns a structured validation issue for malformed YAML', () => {
    const result = parseCaseMarkdown(
      'backend/knowledge/cases/scrolling/broken.md',
      `---
case_id: [unterminated
---

body
`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].filePath).toBe(
      'backend/knowledge/cases/scrolling/broken.md',
    );
    expect(result.issues[0].message).toMatch(/yaml/i);
  });
});
