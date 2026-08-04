// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

import {SkillRegistry} from '../skillLoader';

const skillPath = path.join(
  process.cwd(),
  'skills',
  'composite',
  'camera_trace_evidence.skill.yaml',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;

const EXPECTED_STEP_IDS = [
  'evidence_coverage',
  'camera_process_candidates',
  'camera_slice_candidates',
  'camera_binder_summary',
  'camera_dmabuf_summary',
  'pixel_camera_stage_summary',
] as const;

function getStep(id: string): any {
  const step = skill.steps?.find((candidate: any) => candidate.id === id);
  expect(step).toBeDefined();
  return step;
}

function expectTypedColumns(stepId: string, expected: Record<string, string>): void {
  const columns = getStep(stepId).display?.columns;
  expect(Array.isArray(columns)).toBe(true);

  for (const [name, type] of Object.entries(expected)) {
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({name, type}),
    ]));
  }
}

function renderSqlForSqlite(sql: string): string {
  return sql
    .split('${start_ts}').join('NULL')
    .split('${end_ts}').join('NULL')
    .split('${max_rows|20}').join('20');
}

describe('camera_trace_evidence skill schema', () => {
  it('routes only requests with an explicit Camera domain anchor', () => {
    const registry = new SkillRegistry();
    const loaded = registry.loadSingleSkill(
      path.join(process.cwd(), 'skills'),
      'composite/camera_trace_evidence.skill.yaml',
    );

    expect(loaded?.name).toBe('camera_trace_evidence');
    for (const question of [
      'debug preview first frame',
      'analyze capture latency',
      '分析预览首帧',
      'generic dmabuf memory',
    ]) {
      expect(registry.findMatchingSkill(question)).toBeUndefined();
    }
    for (const question of [
      'analyze Camera preview latency',
      '分析相机首帧预览',
      'inspect cameraserver DMA-BUF',
    ]) {
      expect(registry.findMatchingSkill(question)?.name).toBe('camera_trace_evidence');
    }
  });

  it('summarizes legacy ION-only Camera allocation deltas', () => {
    const database = new Database(':memory:');
    database.function('trace_start', () => 0);
    database.function('trace_end', () => 10_000);
    database.exec(`
      CREATE TABLE android_dmabuf_allocs (
        ts INTEGER,
        buf_size INTEGER,
        process_name TEXT,
        thread_name TEXT,
        upid INTEGER,
        pid INTEGER,
        utid INTEGER,
        tid INTEGER
      );
      CREATE TABLE counter (ts INTEGER, track_id INTEGER, value INTEGER);
      CREATE TABLE thread_counter_track (id INTEGER, name TEXT, utid INTEGER);
      CREATE TABLE thread (utid INTEGER, tid INTEGER, upid INTEGER, name TEXT);
      CREATE TABLE process (upid INTEGER, pid INTEGER, name TEXT);

      INSERT INTO process VALUES (1, 100, 'cameraserver');
      INSERT INTO thread VALUES (2, 101, 1, 'CameraWorker');
      INSERT INTO thread_counter_track VALUES (3, 'mem.ion_change', 2);
      INSERT INTO counter VALUES (100, 3, 4096), (200, 3, -1024);
    `);

    try {
      const sql = renderSqlForSqlite(getStep('camera_dmabuf_summary').sql);
      const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;

      expect(rows).toEqual([
        expect.objectContaining({
          process_name: 'cameraserver',
          upid: 1,
          pid: 100,
          memory_source: 'legacy_ion',
          allocation_count: 1,
          allocation_bytes: 4096,
          release_bytes: 1024,
          observed_net_delta_bytes: 3072,
          peak_event_bytes: 4096,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('declares the evidence-first Camera composite contract', () => {
    expect(skill).toMatchObject({
      name: 'camera_trace_evidence',
      type: 'composite',
      category: 'rendering',
      tier: 'B',
    });
    expect(skill.prerequisites.required_tables).toEqual(
      expect.arrayContaining(['slice', 'thread', 'process']),
    );
    expect(skill.prerequisites.modules).toEqual(expect.arrayContaining([
      'slices.with_context',
      'android.binder',
      'android.frames.timeline',
      'android.memory.dmabuf',
      'linux.cpu.frequency',
      'pixel.camera',
    ]));
    expect(skill.steps.map((step: any) => step.id)).toEqual(EXPECTED_STEP_IDS);
  });

  it('keeps all inputs optional and window controls bounded in production SQL', () => {
    expect(skill.inputs).toEqual([
      expect.objectContaining({name: 'start_ts', type: 'timestamp', required: false}),
      expect.objectContaining({name: 'end_ts', type: 'timestamp', required: false}),
      expect.objectContaining({name: 'max_rows', type: 'integer', required: false}),
    ]);

    for (const step of skill.steps) {
      expect(step.sql).toContain('trace_start()');
      expect(step.sql).toContain('trace_end()');
      expect(step.sql).toMatch(/MIN\(MAX\(COALESCE\(\$\{max_rows\|20\}/);
    }
  });

  it('publishes stable coverage and typed evidence detail columns', () => {
    expectTypedColumns('evidence_coverage', {
      evidence_family: 'string',
      status: 'string',
      row_count: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_process_candidates', {
      identity_kind: 'string',
      process_name: 'string',
      thread_name: 'string',
      upid: 'number',
      pid: 'number',
      utid: 'number',
      tid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_slice_candidates', {
      ts: 'timestamp',
      dur_ns: 'duration',
      slice_name: 'string',
      process_name: 'string',
      thread_name: 'string',
      upid: 'number',
      utid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_binder_summary', {
      ts: 'timestamp',
      dur_ns: 'duration',
      client_process: 'string',
      client_thread: 'string',
      server_process: 'string',
      server_thread: 'string',
      client_upid: 'number',
      client_utid: 'number',
      server_upid: 'number',
      server_utid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_dmabuf_summary', {
      process_name: 'string',
      upid: 'number',
      pid: 'number',
      memory_source: 'string',
      allocation_count: 'number',
      allocation_bytes: 'bytes',
      release_bytes: 'bytes',
      observed_net_delta_bytes: 'bytes',
      peak_event_bytes: 'bytes',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('pixel_camera_stage_summary', {
      cam_id: 'number',
      node: 'string',
      port_group: 'string',
      frame_count: 'number',
      avg_duration_ns: 'duration',
      max_duration_ns: 'duration',
      source: 'string',
      limitation: 'string',
    });
  });

  it('publishes both buffer-memory evidence paths and their interpretation boundary', () => {
    const coverageStep = getStep('evidence_coverage');
    const memoryStep = getStep('camera_dmabuf_summary');

    expect(memoryStep.name).toContain('DMA-BUF/legacy ION');
    expect(memoryStep.display.title).toContain('DMA-BUF/legacy ION');
    expect(memoryStep.synthesize.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({key: 'memory_source'}),
    ]));
    for (const step of [coverageStep, memoryStep]) {
      expect(step.sql).toContain('android_dmabuf_allocs');
      expect(step.sql).toContain('thread_counter_track');
      expect(step.sql).toContain('mem.ion_change');
      expect(step.sql).toContain('retained memory');
      expect(step.sql).toContain('leak proof');
    }
  });

  it('keeps each step self-describing for evidence and report consumers', () => {
    for (const step of skill.steps) {
      expect(step.display).toEqual(expect.objectContaining({
        layer: expect.stringMatching(/^(overview|list)$/),
        level: expect.stringMatching(/^(summary|detail)$/),
        columns: expect.any(Array),
      }));
      expect(step.display.columns.length).toBeGreaterThan(0);
      expect(step.display.columns.every((column: any) => (
        typeof column.name === 'string' && typeof column.type === 'string'
      ))).toBe(true);
      expect(step.save_as).toBe(step.id);
      expect(step.synthesize).toEqual(expect.objectContaining({
        role: expect.stringMatching(/^(overview|list)$/),
        fields: expect.any(Array),
      }));
      expect(step.synthesize.fields.length).toBeGreaterThan(0);
    }
  });

  it('avoids unsupported timing and leak conclusions', () => {
    const productionText = JSON.stringify(skill).toLowerCase();
    expect(productionText).not.toMatch(/time[_ -]?to[_ -]?(open|first[_ -]?frame)/);
    expect(productionText).not.toMatch(/retained[_ -]?at[_ -]?trace[_ -]?end/);
    expect(skill.steps.every((step: any) => step.type !== 'diagnostic')).toBe(true);
  });
});
