// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const QUICK_TRIAGE_MAX_CHINESE_CHARS = 900;
export const QUICK_TRIAGE_MAX_FACT_BULLETS = 3;
export const QUICK_TRIAGE_MAX_CLAIMS = 3;
export const QUICK_TRIAGE_MAX_REFERENCES_PER_CLAIM = 2;
export const QUICK_TRIAGE_MAX_REFERENCE_VALUE_CHARS = 48;
export const QUICK_TRIAGE_MAX_STATEMENT_CHARS = 80;

export const QUICK_TRIAGE_HEADING = '## 快速 Triage';
export const QUICK_REFERENCE_HEADING = '## 逐句数据引用（结构化来源）';

export function buildQuickArtifactGuidance(): string {
  return [
    'Use the artifact previews and evidenceRefId values in this payload to answer the quick overview now.',
    'Do not call fetch_artifact unless the user explicitly asks for row-level details or a required field is absent.',
    `Keep the final answer under ${QUICK_TRIAGE_MAX_CHINESE_CHARS} Chinese chars with exactly two headings: ${QUICK_TRIAGE_HEADING} and ${QUICK_REFERENCE_HEADING}.`,
    `Under 快速 Triage include at most ${QUICK_TRIAGE_MAX_FACT_BULLETS} fact bullets plus one short gap/next-step sentence; under citations include at most ${QUICK_TRIAGE_MAX_CLAIMS} claims.`,
  ].join(' ');
}
