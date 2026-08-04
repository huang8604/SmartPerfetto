// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {validateSkillBatchAnalysis} from '../skillBatchAnalysis';
import type {SkillDefinition} from '../types';

function skill(batchAnalysis: unknown): SkillDefinition {
  return {
    name: 'heap_paths',
    version: '1',
    type: 'composite',
    meta: {display_name: 'Heap paths', description: 'Extract heap paths'},
    steps: [{id: 'dominator_paths', type: 'atomic', sql: 'SELECT 1'}],
    batch_analysis: batchAnalysis,
  } as SkillDefinition;
}

const validBatchAnalysis = {
  operation: 'heap_path_cluster',
  source_step: 'dominator_paths',
  output_contract: 'HeapPathClusterAnalysisV1',
  per_trace_row_limit: 500,
  total_row_limit: 5000,
  required_columns: [
    'upid',
    'process_name',
    'graph_sample_ts',
    'path',
    'class_name',
    'root_type',
    'self_count',
    'retained_count',
    'self_size_bytes',
    'retained_size_bytes',
  ],
};

describe('Skill batch analysis validation', () => {
  it('accepts the exact declarative heap cluster contract', () => {
    expect(validateSkillBatchAnalysis(skill(validBatchAnalysis))).toEqual([]);
  });

  it.each([
    [{...validBatchAnalysis, source_step: 'missing'}, 'batch_analysis.source_step'],
    [{...validBatchAnalysis, operation: 'unknown'}, 'batch_analysis.operation'],
    [{...validBatchAnalysis, output_contract: 'Unknown'}, 'batch_analysis.output_contract'],
    [{...validBatchAnalysis, per_trace_row_limit: 0}, 'batch_analysis.per_trace_row_limit'],
    [{...validBatchAnalysis, per_trace_row_limit: 6000}, 'batch_analysis.per_trace_row_limit'],
    [{...validBatchAnalysis, required_columns: ['path', 'path']}, 'batch_analysis.required_columns'],
    [{...validBatchAnalysis, extra: true}, 'batch_analysis.extra'],
  ])('rejects invalid config %#', (batchAnalysis, expectedPath) => {
    expect(validateSkillBatchAnalysis(skill(batchAnalysis))).toEqual(
      expect.arrayContaining([expect.objectContaining({path: expectedPath})]),
    );
  });

  it('rejects batch analysis on non-executable comparison skills', () => {
    const comparison = skill(validBatchAnalysis);
    comparison.type = 'comparison';
    comparison.steps = undefined;

    expect(validateSkillBatchAnalysis(comparison)).toEqual(
      expect.arrayContaining([expect.objectContaining({path: 'batch_analysis'})]),
    );
  });

  it('is enforced by the real CLI contract gate', () => {
    const skillId = '__invalid_batch_cli_test';
    const filePath = path.join(process.cwd(), 'skills/composite', `${skillId}.skill.yaml`);
    fs.writeFileSync(filePath, [
      `name: ${skillId}`,
      'version: "1"',
      'type: composite',
      'meta:',
      '  display_name: Invalid Batch CLI Test',
      '  description: Temporary validation fixture',
      'batch_analysis:',
      '  operation: heap_path_cluster',
      '  source_step: missing',
      '  output_contract: HeapPathClusterAnalysisV1',
      '  per_trace_row_limit: 10',
      '  total_row_limit: 20',
      '  required_columns: [path]',
      'steps:',
      '  - id: rows',
      '    type: atomic',
      '    sql: SELECT 1 AS value',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = spawnSync('npx', [
        'tsx', 'src/cli/index.ts', 'validate', skillId, '--contracts',
      ], {cwd: process.cwd(), encoding: 'utf-8'});

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('batch_analysis.source_step');
    } finally {
      fs.rmSync(filePath, {force: true});
    }
  });
});
