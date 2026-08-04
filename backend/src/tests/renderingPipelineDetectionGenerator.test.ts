// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { generateRenderingPipelineDetectionSkill } from '../services/renderingPipelineDetectionSkillGenerator';
import { pipelineSkillLoader } from '../services/pipelineSkillLoader';
import {
  buildPortableRenderingPipelineDetectionSkill,
  serializePortableRenderingPipelineDetectionSkill,
} from '../scripts/materializeRenderingPipelineDetectionSkill';

describe('rendering_pipeline_detection generator', () => {
  it('generates determine_pipeline SQL from pipeline YAML detection config', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();

    expect(skill.name).toBe('rendering_pipeline_detection');
    expect(skill.type).toBe('composite');
    expect(skill.prerequisites?.modules).toEqual([
      'slices.with_context',
      'android.frames.timeline',
    ]);

    const scoreStep = skill.steps?.find((s) => s.id === 'score_pipelines') as any;
    expect(scoreStep).toBeTruthy();
    expect(typeof scoreStep.sql).toBe('string');
    expect(scoreStep.save_as).toBe('pipeline_scores');

    const determineStep = skill.steps?.find((s) => s.id === 'determine_pipeline') as any;
    expect(determineStep).toBeTruthy();
    expect(typeof determineStep.sql).toBe('string');
    expect(skill.steps?.findIndex((s) => s.id === 'score_pipelines')).toBeLessThan(
      skill.steps?.findIndex((s) => s.id === 'determine_pipeline') ?? -1
    );
    expect(determineStep.save_as).toBe('pipeline_result');

    // A representative signal name from pipeline YAML that must appear in generated SQL.
    // This ensures YAML detection is the single source of truth for scoring configuration.
    expect(scoreStep.sql).toContain('has_blast_buffer_queue');
    expect(scoreStep.sql).toContain('ANDROID_VIEW_STANDARD_BLAST');
    expect(scoreStep.sql).toContain('signal_defs');
    expect(scoreStep.sql).not.toContain('COALESCE((SELECT SUM(');
    expect(Buffer.byteLength(scoreStep.sql, 'utf8')).toBeLessThan(45_000);
    expect(Buffer.byteLength(determineStep.sql, 'utf8')).toBeLessThan(10_000);
    expect(determineStep.sql).toContain('SELECT * FROM ${pipeline_scores}');
    expect(determineStep.sql).toContain('candidate_list AS');
    expect(determineStep.sql).toContain("GROUP BY 'all_candidates'");
    expect(determineStep.sql).toContain('SELECT pipeline_id, rendering_type_id, score, rank');
    expect(determineStep.sql).toContain('ORDER BY rank ASC');

    // Non-primary / feature-only pipelines should not win primary selection.
    // Keep these checks stable to prevent regressions where a backend/impl-detail pipeline
    // becomes the primary pipeline by accident.
    expect(determineStep.sql).toContain('ANDROID_PIP_FREEFORM');
    expect(determineStep.sql).toContain('ANDROID_VIEW_MULTI_WINDOW');
    expect(determineStep.sql).toContain('ANGLE_GLES_VULKAN');

    const activeStep = skill.steps?.find((s) => s.id === 'active_rendering_processes') as any;
    expect(activeStep).toBeTruthy();
    expect(typeof activeStep.sql).toBe('string');

    // Active process detection should work across HWUI/SurfaceView/OpenGL/Vulkan/Flutter.
    expect(activeStep.sql).toContain('DrawFrame');
    expect(activeStep.sql).toContain('eglSwapBuffers');
    expect(activeStep.sql).toContain('vkQueuePresentKHR');

    const rhythmStep = skill.steps?.find((s) => s.id === 'extra_rhythm_signals') as any;
    expect(rhythmStep).toBeTruthy();
    expect(rhythmStep.sql).toContain("THEN 'camera_request_activity'");
    expect(rhythmStep.sql).not.toContain('camera_sensor_trigger');

    const layerSignalsStep = skill.steps?.find((s) => s.id === 'layer_signals') as any;
    expect(layerSignalsStep).toBeTruthy();
    expect(layerSignalsStep.sql).toContain('android_frames_layers');

    const pipelineBundleStep = skill.steps?.find((s) => s.id === 'pipeline_bundle') as any;
    expect(pipelineBundleStep).toBeTruthy();
    expect(pipelineBundleStep.type).toBe('pipeline');
    expect(pipelineBundleStep.pipeline_source).toBe('pipeline_result');
    expect(pipelineBundleStep.active_processes_source).toBe('active_rendering_processes');
  });

  it('derives type ranking, feature roles, scopes, and defaults from the catalog', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();
    const scoreStep = skill.steps?.find((step) => step.id === 'score_pipelines') as any;
    const determineStep = skill.steps?.find((step) => step.id === 'determine_pipeline') as any;
    const catalog = pipelineSkillLoader.getCatalog();

    expect(determineStep.sql).toContain('pipeline_metadata');
    expect(determineStep.sql).toContain('primary_rendering_type_id');
    expect(determineStep.sql).toContain('rendering_type_candidates_list');
    expect(determineStep.sql).toContain('pipeline_related_rendering_types');
    expect(determineStep.sql).toContain('related_rendering_type_candidates_list');
    expect(determineStep.sql).toContain(
      "('ANDROID_VIEW_MULTI_WINDOW', 'S06_MULTI_WINDOW')",
    );
    expect(determineStep.sql).toContain(
      "('VIDEO_OVERLAY_HWC', 'S12_VIDEO_OVERLAY_HWC')",
    );
    expect(determineStep.sql).toContain('S10_FLUTTER');
    expect(determineStep.sql).toContain('FLUTTER_SURFACEVIEW_IMPELLER');

    for (const [pipelineId, entry] of Object.entries(catalog.pipelines)) {
      expect(determineStep.sql).toContain(pipelineId);
      if (entry.classification_role === 'feature') {
        expect(entry.primary_eligible).toBe(false);
        expect(entry.feature_visible).toBe(true);
      }
      if (entry.signal_scope === 'global') {
        expect(scoreStep.sql).toContain(`'${pipelineId}'`);
      }
    }

    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/renderingPipelineDetectionSkillGenerator.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/NON_PRIMARY_PIPELINE_IDS|GLOBAL_SCOPE_PIPELINE_IDS|FEATURE_PIPELINE_IDS/);
    expect(source).not.toContain(['S01 §4', '特征分型'].join(' '));
  });

  it('keeps the committed portable detector byte-identical to the runtime projection', async () => {
    const portable = await buildPortableRenderingPipelineDetectionSkill();
    const serialized = serializePortableRenderingPipelineDetectionSkill(portable);
    const committed = fs.readFileSync(
      path.resolve(__dirname, '../../skills/atomic/rendering_pipeline_detection.skill.yaml'),
      'utf8',
    );

    expect(portable.steps?.some((step) => step.id === 'pipeline_bundle')).toBe(false);
    expect(portable.steps?.some((step) => step.id === 'determine_pipeline')).toBe(true);
    expect(serialized).not.toMatch(/[ \t]+$/m);
    expect(serialized).toBe(committed);
  });
});
