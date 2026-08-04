// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';

function loadSkill(relativePath: string): any {
  return yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills', relativePath), 'utf8'));
}

describe('Android Internals backed Skill semantics', () => {
  it('does not classify generic query/apply/commit slice names as database evidence', () => {
    const skill = loadSkill('modules/kernel/filesystem_module.skill.yaml');
    const databaseSql = skill.steps.find((step: any) => step.id === 'database_operations').sql;
    const preferencesSql = skill.steps.find((step: any) => step.id === 'shared_prefs_operations').sql;
    const databaseRule = skill.steps
      .find((step: any) => step.id === 'io_diagnosis')
      .rules.find((rule: any) => rule.condition.includes('db_operations'));
    const slowIoRule = skill.steps
      .find((step: any) => step.id === 'io_diagnosis')
      .rules.find((rule: any) => rule.condition.includes('slow_io'));

    expect(databaseSql).not.toMatch(/GLOB '\*query\*'/i);
    expect(databaseSql).not.toMatch(/GLOB '\*transaction\*'/i);
    expect(databaseSql).not.toMatch(/GLOB '\*cursor\*'/i);
    expect(preferencesSql).not.toMatch(/GLOB '\*apply\*'/i);
    expect(preferencesSql).not.toMatch(/GLOB '\*commit\*'/i);
    expect(databaseRule.confidence).toBe('medium');
    expect(databaseRule.diagnosis).toContain('疑似');
    expect(slowIoRule.confidence).toBe('medium');
    expect(slowIoRule.diagnosis).toContain('疑似');
    expect(slowIoRule.diagnosis).toContain('确认');
  });

  it('keeps Handler evidence to observed main-thread callback slices', () => {
    const skill = loadSkill('atomic/main_thread_handler_callback_slices.skill.yaml');
    const callbackSql = skill.steps.find((step: any) => step.id === 'callback_slices').sql;

    expect(skill.prerequisites.modules).toContain('android.slices');
    expect(callbackSql).toContain('android_standardize_slice_name');
    expect(callbackSql).toContain("GLOB '*Handler: *'");
    expect(callbackSql).toContain("NOT GLOB 'TransactionHandler:*'");
    expect(callbackSql).toContain('t.tid = p.pid');
    expect(callbackSql).toContain('MAX(s.ts, b.start_ts) AS clipped_ts');
    expect(callbackSql).toContain('MIN(clipped_ts) AS first_ts');
    expect(callbackSql).toContain('MAX(clipped_ts) AS last_ts');
    expect(callbackSql).not.toMatch(/queue[_ ]?(wait|delay)/i);
    expect(skill.meta.description).toContain('不代表消息排队等待');
  });

  it('discovers main-thread file and SQLite slice evidence without claiming Room visibility', () => {
    const skill = loadSkill('atomic/main_thread_file_io_in_range.skill.yaml');
    const discovery = JSON.stringify({tags: skill.meta.tags, triggers: skill.triggers});

    expect(skill.meta.tags).toEqual(expect.arrayContaining(['file_io', 'sqlite', 'database']));
    expect(discovery).toContain('数据库');
    expect(discovery).not.toMatch(/room/i);
    expect(skill.meta.description).toContain('命名切片');
  });
});
