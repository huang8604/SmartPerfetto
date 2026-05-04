// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect } from '@jest/globals';
import { generateRenderingPipelineDetectionSkill } from '../services/renderingPipelineDetectionSkillGenerator';

describe('rendering_pipeline_detection generator', () => {
  it('generates determine_pipeline SQL from pipeline YAML detection config', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();

    expect(skill.name).toBe('rendering_pipeline_detection');
    expect(skill.type).toBe('composite');
    expect(skill.prerequisites?.modules).toEqual([
      'slices.with_context',
      'android.frames.timeline',
    ]);

    const determineStep = skill.steps?.find((s) => s.id === 'determine_pipeline') as any;
    expect(determineStep).toBeTruthy();
    expect(typeof determineStep.sql).toBe('string');

    // A representative signal name from pipeline YAML that must appear in generated SQL.
    // This ensures YAML detection is the single source of truth for scoring configuration.
    expect(determineStep.sql).toContain('has_blast_buffer_queue');
    expect(determineStep.sql).toContain('ANDROID_VIEW_STANDARD_BLAST');
    expect(determineStep.sql).toContain('candidate_list AS');
    expect(determineStep.sql).toContain("GROUP BY 'all_candidates'");

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

    const layerSignalsStep = skill.steps?.find((s) => s.id === 'layer_signals') as any;
    expect(layerSignalsStep).toBeTruthy();
    expect(layerSignalsStep.sql).toContain('android_frames_layers');

    const pipelineBundleStep = skill.steps?.find((s) => s.id === 'pipeline_bundle') as any;
    expect(pipelineBundleStep).toBeTruthy();
    expect(pipelineBundleStep.type).toBe('pipeline');
    expect(pipelineBundleStep.pipeline_source).toBe('pipeline_result');
    expect(pipelineBundleStep.active_processes_source).toBe('active_rendering_processes');
  });
});
