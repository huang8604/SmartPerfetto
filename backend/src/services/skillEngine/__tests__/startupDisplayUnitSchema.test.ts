// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

describe('startup display unit contracts', () => {
  const loadYaml = (relativePath: string) => {
    const skillPath = path.join(process.cwd(), relativePath);
    return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  };

  const getColumn = (columns: any[], name: string) => {
    const column = columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('startup_events_in_range exposes ms display and ns jump fields consistently', () => {
    const skill = loadYaml('skills/atomic/startup_events_in_range.skill.yaml');
    const columns = skill.display?.columns || [];

    const durMs = getColumn(columns, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');
    expect(durMs.hidden).toBe(true);

    const startTs = getColumn(columns, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur_ns');

    const durNs = getColumn(columns, 'dur_ns');
    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');

    const ttid = getColumn(columns, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const ttfd = getColumn(columns, 'ttfd_ms');
    expect(ttfd.type).toBe('duration');
    expect(ttfd.format).toBe('duration_ms');
    expect(ttfd.unit).toBe('ms');
  });

  it('startup_detail uses ms display units for startup and CPU/quadrant durations', () => {
    const skill = loadYaml('skills/composite/startup_detail.skill.yaml');
    const getStep = (id: string) => {
      const step = skill.steps?.find((s: any) => s.id === id);
      expect(step).toBeDefined();
      return step;
    };

    const startupInfoCols = getStep('startup_info').display?.columns || [];
    const durMs = getColumn(startupInfoCols, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    const ttid = getColumn(startupInfoCols, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const startTs = getColumn(startupInfoCols, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');

    const cpuCoreCols = getStep('cpu_core_analysis').display?.columns || [];
    for (const name of ['big_core_ms', 'little_core_ms', 'total_running_ms']) {
      const col = getColumn(cpuCoreCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    const quadrantCols = getStep('quadrant_analysis').display?.columns || [];
    const quadrantDur = getColumn(quadrantCols, 'dur_ms');
    expect(quadrantDur.type).toBe('duration');
    expect(quadrantDur.format).toBe('duration_ms');
    expect(quadrantDur.unit).toBe('ms');

    const quadrantName = getColumn(quadrantCols, 'quadrant');
    expect(quadrantName.type).toBe('string');

    const percentage = getColumn(quadrantCols, 'percentage');
    expect(percentage.type).toBe('percentage');
    expect(percentage.format).toBe('percentage');
  });
});