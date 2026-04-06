// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

describe('scrolling_analysis skill schema', () => {
  const skillPath = path.join(process.cwd(), 'skills', 'composite', 'scrolling_analysis.skill.yaml');
  const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;

  const getStep = (id: string) => {
    const step = skill.steps?.find((s: any) => s.id === id);
    expect(step).toBeDefined();
    return step;
  };

  const getColumn = (step: any, name: string) => {
    const column = step.display?.columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('get_app_jank_frames has display: false (hidden, data-only step)', () => {
    const step = getStep('get_app_jank_frames');
    expect(step.display).toBe(false);
    // synthesize and save_as must remain for downstream Agent references
    expect(step.synthesize).toBeDefined();
    expect(step.save_as).toBe('app_jank_frames');
  });

  it('batch_frame_root_cause has duration_ms fields correctly typed', () => {
    const step = getStep('batch_frame_root_cause');

    const durMs = getColumn(step, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');

    const topSliceMs = getColumn(step, 'top_slice_ms');
    expect(topSliceMs.type).toBe('duration');
    expect(topSliceMs.format).toBe('duration_ms');

    const presentInterval = getColumn(step, 'present_interval_ms');
    expect(presentInterval.type).toBe('duration');
    expect(presentInterval.format).toBe('duration_ms');
    expect(presentInterval.unit).toBe('ms');
  });

  it('keeps ns-based frame durations explicitly normalized to ms display', () => {
    const perfSummary = getStep('performance_summary');
    const avgFrameDur = getColumn(perfSummary, 'avg_frame_dur');
    const p95FrameDur = getColumn(perfSummary, 'p95_frame_dur');

    expect(avgFrameDur.type).toBe('duration');
    expect(avgFrameDur.format).toBe('duration_ms');
    expect(avgFrameDur.unit).toBe('ns');

    expect(p95FrameDur.type).toBe('duration');
    expect(p95FrameDur.format).toBe('duration_ms');
    expect(p95FrameDur.unit).toBe('ns');

    const sessionStep = getStep('scroll_sessions');
    const duration = getColumn(sessionStep, 'duration');
    const avgDur = getColumn(sessionStep, 'avg_dur');
    const maxDur = getColumn(sessionStep, 'max_dur');

    expect(duration.type).toBe('duration');
    expect(duration.format).toBe('duration_ms');
    expect(duration.unit).toBe('ns');

    expect(avgDur.type).toBe('duration');
    expect(avgDur.format).toBe('duration_ms');
    expect(avgDur.unit).toBe('ns');

    expect(maxDur.type).toBe('duration');
    expect(maxDur.format).toBe('duration_ms');
    expect(maxDur.unit).toBe('ns');
  });

  it('keeps timestamp-range binding for batch_frame_root_cause navigation', () => {
    const step = getStep('batch_frame_root_cause');
    const startTs = getColumn(step, 'start_ts');
    const dur = getColumn(step, 'dur');

    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur');

    expect(dur.type).toBe('duration');
    expect(dur.unit).toBe('ns');
    expect(dur.hidden).toBe(true);
  });

  it('batch_frame_root_cause has expandable self-binding', () => {
    const step = getStep('batch_frame_root_cause');
    expect(step.display.expandable).toBe(true);
    expect(step.display.expandableBindSource).toBe('batch_root_cause');
    expect(step.display.layer).toBe('list');
    expect(step.display.title).toBe('掉帧列表');
  });

  it('batch_frame_root_cause has synthesize with groupBy', () => {
    const step = getStep('batch_frame_root_cause');
    expect(step.synthesize).toBeDefined();
    expect(step.synthesize.role).toBe('list');
    const fields = step.synthesize.groupBy.map((g: any) => g.field);
    expect(fields).toContain('jank_responsibility');
    expect(fields).toContain('reason_code');
  });
});