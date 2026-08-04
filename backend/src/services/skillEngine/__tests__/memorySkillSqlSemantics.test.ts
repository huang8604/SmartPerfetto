// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import {describe, expect, it} from '@jest/globals';

const sqlite3Available = spawnSync('sqlite3', ['-version'], {encoding: 'utf-8'}).status === 0;
const describeWithSqlite = sqlite3Available ? describe : describe.skip;

const loadYaml = (relativePath: string): any =>
  yaml.load(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8')) as any;

const loadStepSql = (skillPath: string, stepId: string): string => {
  const skill = loadYaml(skillPath);
  const step = skill.steps?.find((candidate: any) => candidate.id === stepId);
  expect(step?.sql).toBeTruthy();
  return step.sql;
};

const replaceParams = (sql: string, params: Record<string, string>): string =>
  sql.replace(/\$\{[^}]+}/g, token => {
    const value = params[token];
    if (value === undefined) {
      throw new Error(`Missing SQL fixture replacement for ${token}`);
    }
    return value;
  });

const runSqliteJson = (sql: string): Array<Record<string, any>> => {
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: sql,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim() || '[]') as Array<Record<string, any>>;
};

const heapGraphSchema = `
  CREATE TABLE process(upid INTEGER, name TEXT);
  CREATE TABLE thread(utid INTEGER, upid INTEGER);
  CREATE TABLE thread_track(id INTEGER, utid INTEGER);
  CREATE TABLE slice(track_id INTEGER, name TEXT, ts INTEGER, dur INTEGER);
  CREATE TABLE heap_graph_class(id INTEGER, name TEXT, deobfuscated_name TEXT);
  CREATE TABLE heap_graph_object(
    id INTEGER,
    upid INTEGER,
    graph_sample_ts INTEGER,
    type_id INTEGER,
    self_size INTEGER,
    native_size INTEGER,
    reachable INTEGER
  );
  CREATE TABLE heap_graph_reference(
    id INTEGER,
    owner_id INTEGER,
    owned_id INTEGER,
    field_name TEXT,
    deobfuscated_field_name TEXT,
    field_type_name TEXT
  );
  CREATE TABLE _excluded_refs(id INTEGER);
`;

const heapGraphFixture = `
  INSERT INTO process VALUES (1, 'com.example.app');
  INSERT INTO thread VALUES (10, 1);
  INSERT INTO thread_track VALUES (100, 10);

  INSERT INTO heap_graph_class VALUES (1, 'com.example.LeakyActivity', NULL);
  INSERT INTO heap_graph_class VALUES (2, 'com.example.ActiveActivity', NULL);
  INSERT INTO heap_graph_class VALUES (3, 'com.example.SessionViewModel', NULL);
  INSERT INTO heap_graph_class VALUES (4, 'com.example.Owner', NULL);
  INSERT INTO heap_graph_class VALUES (5, 'java.lang.ref.SoftReference', NULL);
  INSERT INTO heap_graph_class VALUES (6, 'com.example.InProgressDestroyActivity', NULL);

  INSERT INTO heap_graph_object VALUES (1, 1, 1000, 1, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (2, 1, 1000, 2, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (3, 1, 1000, 3, 512, 0, 1);
  INSERT INTO heap_graph_object VALUES (4, 1, 1000, 3, 512, 0, 1);
  INSERT INTO heap_graph_object VALUES (50, 1, 1000, 4, 256, 0, 1);
  INSERT INTO heap_graph_object VALUES (51, 1, 1000, 5, 256, 0, 1);
  INSERT INTO heap_graph_object VALUES (6, 1, 1000, 2, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (7, 1, 1000, 6, 1048576, 0, 1);

  INSERT INTO slice VALUES (100, 'SI$com.example.LeakyActivity.onDestroy', 800, 100);
  INSERT INTO slice VALUES (100, 'SI$com.example.ActiveActivity.onResume', 700, 50);
  INSERT INTO slice VALUES (100, 'SI$com.example.InProgressDestroyActivity.onDestroy', 900, 200);

  INSERT INTO heap_graph_reference VALUES (101, 50, 1, 'owner.leaky', NULL, 'com.example.LeakyActivity');
  INSERT INTO heap_graph_reference VALUES (102, 51, 1, 'java.lang.ref.Reference.referent', NULL, 'java.lang.Object');
  INSERT INTO _excluded_refs VALUES (102);
`;

const heapParams = {
  '${process_name|}': '',
  '${package|}': '',
  '${class_name_glob|}': '*ViewModel',
  '${lifecycle_slice_prefix|SI$}': 'SI$',
  '${max_candidates|50}': '50',
  '${max_reference_edges|100}': '100',
  '${graph_sample_ts}': 'NULL',
};

describe('memory skill SQL semantic guards', () => {
  it('defines a bounded dominator path extraction contract with retained-size propagation', () => {
    const skill = loadYaml('skills/composite/android_heap_dominator_path_extract.skill.yaml');
    const sql = loadStepSql('skills/composite/android_heap_dominator_path_extract.skill.yaml', 'dominator_paths');

    expect(skill.batch_analysis).toEqual({
      operation: 'heap_path_cluster',
      source_step: 'dominator_paths',
      output_contract: 'HeapPathClusterAnalysisV1',
      per_trace_row_limit: 500,
      total_row_limit: 5000,
      required_columns: [
        'upid', 'process_name', 'graph_sample_ts', 'path', 'class_name',
        'root_type', 'self_count', 'retained_count', 'self_size_bytes',
        'retained_size_bytes',
      ],
    });
    expect(sql).toContain('_graph_aggregating_scan!');
    expect(sql).toContain('WITH RECURSIVE paths');
    expect(sql).toContain('PARTITION BY tree.upid, tree.graph_sample_ts');
    expect(sql).toContain('c.cumulative_size AS retained_size_bytes');
    expect(sql).toContain('p.root_type');
    expect(sql).toContain('MIN(MAX(COALESCE(${max_rows|500}, 500), 1), 500)');
  });

  it('keeps the local Perfetto excluded_refs contract aligned with skill wording', () => {
    const index = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/perfettoSqlIndex.json'), 'utf-8'));
    const excludedRefs = index.templates.find((entry: any) => entry.id === 'stdlib.android.excluded_refs');
    expect(excludedRefs?.sql).toContain('KIND_WEAK_REFERENCE');
    expect(excludedRefs?.sql).toContain('KIND_PHANTOM_REFERENCE');
    expect(excludedRefs?.sql).toContain('KIND_FINALIZER_REFERENCE');
    expect(excludedRefs?.sql).not.toContain('KIND_SOFT_REFERENCE');

    const skill = loadYaml('skills/atomic/android_heap_graph_leak_candidates.skill.yaml');
    const holderDescription = skill.output.fields.find((field: any) => field.name === 'reference_holders')?.description;
    expect(holderDescription).toContain('weak/phantom/finalizer');
    expect(holderDescription).toContain('soft reference edges are not filtered');
  });

  it('bounds heap graph row limits inside SQL', () => {
    const candidatesSql = loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates');
    const holdersSql = loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders');

    expect(candidatesSql).toContain('MIN(MAX(COALESCE(${max_candidates|50}, 50), 1), 200)');
    expect(holdersSql).toContain('MIN(MAX(COALESCE(${max_candidates|50}, 50), 1), 200)');
    expect(holdersSql).toContain('MIN(MAX(COALESCE(${max_reference_edges|100}, 100), 1), 500)');
  });
});

describeWithSqlite('android_heap_graph_leak_candidates SQL semantics', () => {
  it('classifies lifecycle evidence only when the lifecycle slice completed before the heap sample', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      heapParams
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${sql};`);

    const leaky = rows.find(row => row.class_name === 'com.example.LeakyActivity');
    expect(leaky).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'destroyed',
      leak_state: 'destroyed_reachable',
      confidence: 'high',
      component_type: 'Activity',
    }));

    const activeMultiInstance = rows.find(row => row.class_name === 'com.example.ActiveActivity');
    expect(activeMultiInstance).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'active',
      leak_state: 'multi_instance_reachable',
      confidence: 'low',
    }));

    const inProgressDestroy = rows.find(row => row.class_name === 'com.example.InProgressDestroyActivity');
    expect(inProgressDestroy).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'unknown',
      leak_state: 'unknown_reachable',
      confidence: 'info',
    }));

    const custom = rows.find(row => row.class_name === 'com.example.SessionViewModel');
    expect(custom).toEqual(expect.objectContaining({
      component_type: 'custom',
      leak_state: 'multi_instance_reachable',
      confidence: 'low',
    }));
  });

  it('starts holder lookup from suspect objects and excludes Perfetto excluded_refs', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders'),
      heapParams
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        candidate_class: 'com.example.LeakyActivity',
        owned_object_id: 1,
        owner_class: 'com.example.Owner',
        field_display: 'owner.leaky',
        leak_state: 'destroyed_reachable',
      }),
    ]);
  });

  it('clamps candidate and holder row limits to at least one row', () => {
    const limitParams = {
      ...heapParams,
      '${max_candidates|50}': '0',
      '${max_reference_edges|100}': '0',
    };
    const candidatesSql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      limitParams
    );
    const candidateRows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${candidatesSql};`);

    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toEqual(expect.objectContaining({
      class_name: 'com.example.LeakyActivity',
      leak_state: 'destroyed_reachable',
    }));

    const holdersSql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders'),
      limitParams
    );
    const holderRows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${holdersSql};`);

    expect(holderRows).toHaveLength(1);
    expect(holderRows[0]).toEqual(expect.objectContaining({
      candidate_class: 'com.example.LeakyActivity',
      field_display: 'owner.leaky',
    }));
  });
});

describeWithSqlite('RSS memory skill SQL semantics', () => {
  const rssSchema = `
    CREATE TABLE memory_rss_and_swap_per_process(
      upid INTEGER,
      pid INTEGER,
      process_name TEXT,
      ts INTEGER,
      dur INTEGER,
      rss INTEGER,
      swap INTEGER,
      anon_rss_and_swap INTEGER
    );
  `;
  const rssFixture = `
    INSERT INTO memory_rss_and_swap_per_process VALUES (1, 123, 'com.example.app', 10, 0, 104857600, 0, 83886080);
    INSERT INTO memory_rss_and_swap_per_process VALUES (1, 123, 'com.example.app', 20, 0, 167772160, 0, 150994944);
  `;
  const rssParams = {
    '${package|}': '',
    '${process_name|}': '',
    '${growth_warning_mb}': 'NULL',
    '${growth_pct_min_mb|5}': '5',
    '${growth_warning_pct|20}': '20',
    '${growth_critical_pct|50}': '50',
    '${jump_warning_mb|10}': '10',
    '${peak_avg_warning_ratio|2}': '2',
    '${start_ts}': 'NULL',
    '${end_ts}': 'NULL',
  };

  it('includes the last instant RSS sample when end_ts is omitted', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/memory_growth_detector.skill.yaml', 'memory_growth'),
      rssParams
    );
    const rows = runSqliteJson(`${rssSchema}\n${rssFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        process_name: 'com.example.app',
        samples: 2,
        rss_growth_mb: 60,
        rss_growth_pct: 60,
        rating: 'critical',
      }),
    ]);
  });

  it('keeps RSS/Swap peak timeline defaults inclusive for instant samples', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/linux_process_rss_swap_timeline.skill.yaml', 'rss_swap_peaks'),
      {
        '${package|}': '',
        '${process_name|}': '',
        '${start_ts}': 'NULL',
        '${end_ts}': 'NULL',
      }
    );
    const rows = runSqliteJson(`${rssSchema}\n${rssFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        process_name: 'com.example.app',
        samples: 2,
        max_rss_mb: 160,
      }),
    ]);
  });
});

describeWithSqlite('native heap skill SQL semantics', () => {
  const nativeHeapSchema = `
    CREATE TABLE android_heap_profile_summary_tree(
      name TEXT,
      mapping_name TEXT,
      cumulative_size INTEGER,
      self_size INTEGER,
      cumulative_alloc_size INTEGER,
      source_file TEXT
    );
  `;
  const nativeHeapFixture = `
    INSERT INTO android_heap_profile_summary_tree VALUES (
      'LeakyNativeCache',
      '/data/app/libexample.so',
      20971520,
      10485760,
      26214400,
      'cache.cc'
    );
    INSERT INTO android_heap_profile_summary_tree VALUES (
      'TransientBufferBuilder',
      '/data/app/libexample.so',
      1048576,
      524288,
      104857600,
      'buffer.cc'
    );
  `;

  it('separates unreleased native retention from allocation churn', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/native_heap_breakdown.skill.yaml', 'native_heap_hotspots'),
      {
        '${min_size_mb|1}': '10',
        '${min_alloc_mb|0}': '50',
        '${max_rows|100}': '100',
      }
    );
    const rows = runSqliteJson(`${nativeHeapSchema}\n${nativeHeapFixture}\n${sql};`);

    const retention = rows.find(row => row.name === 'LeakyNativeCache');
    expect(retention).toEqual(expect.objectContaining({
      cumulative_size_mb: 20,
      cumulative_alloc_mb: 25,
      unreleased_to_alloc_pct: 80,
      churn_ratio: 1.25,
      native_signal: 'unreleased_native_retention',
    }));

    const churn = rows.find(row => row.name === 'TransientBufferBuilder');
    expect(churn).toEqual(expect.objectContaining({
      cumulative_size_mb: 1,
      cumulative_alloc_mb: 100,
      unreleased_to_alloc_pct: 1,
      churn_ratio: 100,
      native_signal: 'allocation_churn',
    }));
  });
});
