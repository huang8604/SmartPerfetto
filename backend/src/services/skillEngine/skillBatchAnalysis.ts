// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillDefinition} from './types';

export interface SkillBatchAnalysisValidationIssue {
  path: string;
  message: string;
}

const ALLOWED_KEYS = new Set([
  'operation',
  'source_step',
  'output_contract',
  'per_trace_row_limit',
  'total_row_limit',
  'required_columns',
]);

function issue(path: string, message: string): SkillBatchAnalysisValidationIssue {
  return {path, message};
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateSkillBatchAnalysis(skill: SkillDefinition): SkillBatchAnalysisValidationIssue[] {
  const value = (skill as SkillDefinition & {batch_analysis?: unknown}).batch_analysis;
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [issue('batch_analysis', 'must be an object')];
  }

  const config = value as unknown as Record<string, unknown>;
  const issues: SkillBatchAnalysisValidationIssue[] = [];
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) issues.push(issue(`batch_analysis.${key}`, 'unknown field'));
  }

  if (skill.type === 'comparison' || skill.type === 'pipeline_definition') {
    issues.push(issue('batch_analysis', `is not supported for skill type '${skill.type}'`));
  }
  if (config.operation !== 'heap_path_cluster') {
    issues.push(issue('batch_analysis.operation', "must be 'heap_path_cluster'"));
  }
  if (config.output_contract !== 'HeapPathClusterAnalysisV1') {
    issues.push(issue('batch_analysis.output_contract', "must be 'HeapPathClusterAnalysisV1'"));
  }

  const sourceStep = typeof config.source_step === 'string' ? config.source_step.trim() : '';
  if (!sourceStep) {
    issues.push(issue('batch_analysis.source_step', 'must be a non-empty string'));
  } else if (!skill.steps?.some(step => step.id === sourceStep)) {
    issues.push(issue('batch_analysis.source_step', `references missing step '${sourceStep}'`));
  }

  const perTraceLimit = config.per_trace_row_limit;
  const totalLimit = config.total_row_limit;
  if (!isPositiveInteger(perTraceLimit)) {
    issues.push(issue('batch_analysis.per_trace_row_limit', 'must be a positive safe integer'));
  }
  if (!isPositiveInteger(totalLimit)) {
    issues.push(issue('batch_analysis.total_row_limit', 'must be a positive safe integer'));
  }
  if (isPositiveInteger(perTraceLimit) && isPositiveInteger(totalLimit) && perTraceLimit > totalLimit) {
    issues.push(issue('batch_analysis.per_trace_row_limit', 'must not exceed total_row_limit'));
  }

  if (!Array.isArray(config.required_columns) || config.required_columns.length === 0) {
    issues.push(issue('batch_analysis.required_columns', 'must be a non-empty array'));
  } else {
    const columns = config.required_columns;
    const normalized = columns
      .filter((column): column is string => typeof column === 'string')
      .map(column => column.trim());
    if (normalized.length !== columns.length || normalized.some(column => column.length === 0)) {
      issues.push(issue('batch_analysis.required_columns', 'must contain only non-empty strings'));
    } else if (new Set(normalized).size !== normalized.length) {
      issues.push(issue('batch_analysis.required_columns', 'must not contain duplicates'));
    }
  }

  return issues;
}
