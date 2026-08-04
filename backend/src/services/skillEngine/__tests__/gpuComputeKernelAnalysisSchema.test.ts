// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';

const skillPath = path.join(
  process.cwd(),
  'skills/composite/gpu_compute_kernel_analysis.skill.yaml',
);

function loadSkill(): any {
  return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
}

describe('gpu_compute_kernel_analysis contract', () => {
  it('declares bounded vendor-neutral compute and launch evidence', () => {
    const skill = loadSkill();
    const steps = skill.steps as any[];
    const stepIds = steps.map(step => step.id);
    const allSql = steps.map(step => step.sql ?? '').join('\n');

    expect(skill.name).toBe('gpu_compute_kernel_analysis');
    expect(stepIds).toEqual(expect.arrayContaining([
      'data_check',
      'kernel_summary',
      'launch_configuration',
      'no_compute_contract',
      'missing_launch_args_contract',
    ]));
    expect(allSql).toContain('s.render_stage_category = 2');
    expect(allSql).toContain("EXTRACT_ARG(s.arg_set_id, 'kernel_demangled_name')");
    expect(allSql).toContain("EXTRACT_ARG(s.arg_set_id, 'launch.workgroup_size.x')");
    expect(allSql).toContain("EXTRACT_ARG(s.arg_set_id, 'launch.grid_size.x')");
    expect(allSql).toContain('MIN(MAX(COALESCE(${max_rows|50}, 50), 1), 200)');
    expect(allSql).not.toMatch(/compute[_ -]?bound|memory[_ -]?bound/i);
    expect(allSql).not.toMatch(/nvidia|speed[ -]?of[ -]?light|occupancy/i);
  });

  it('separates absent kernels from omitted producer launch arguments', () => {
    const skill = loadSkill();
    const steps = new Map((skill.steps as any[]).map(step => [step.id, step]));

    expect(steps.get('kernel_summary')?.condition).toBe('data_check.data[0]?.compute_rows > 0');
    expect(steps.get('launch_configuration')?.condition).toBe('data_check.data[0]?.launch_arg_rows > 0');
    expect(steps.get('no_compute_contract')?.condition).toBe('data_check.data[0]?.compute_rows === 0');
    expect(steps.get('missing_launch_args_contract')?.condition).toBe(
      'data_check.data[0]?.compute_rows > 0 && data_check.data[0]?.launch_arg_rows === 0',
    );
  });
});
