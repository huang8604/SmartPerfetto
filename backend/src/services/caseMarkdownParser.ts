// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import yaml from 'js-yaml';

import type {
  CaseMarkdownParseResult,
  CaseKnowledgeValidationIssue,
} from '../types/caseKnowledge';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export function parseCaseMarkdown(
  filePath: string,
  content: string,
): CaseMarkdownParseResult {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return {
      ok: false,
      issues: [issue(filePath, 'Markdown case is missing YAML frontmatter')],
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(match[1]);
  } catch (error) {
    const suffix = error instanceof Error ? `: ${error.message}` : '';
    return {
      ok: false,
      issues: [issue(filePath, `Malformed YAML frontmatter${suffix}`)],
    };
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [issue(filePath, 'YAML frontmatter must be a mapping/object')],
    };
  }

  return {
    ok: true,
    parsed: {
      filePath,
      frontmatter: parsed as Record<string, unknown>,
      body: match[2] ?? '',
    },
  };
}

function issue(
  filePath: string,
  message: string,
  fieldPath?: string,
): CaseKnowledgeValidationIssue {
  return {filePath, message, fieldPath};
}
