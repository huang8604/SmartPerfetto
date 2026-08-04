// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TeachingPipelineResponse} from '../../types/teaching.types';
import {localizeTeachingPipelineResponse} from '../teachingLocalization';

function responseFixture(): TeachingPipelineResponse {
  return {
    success: true,
    detection: {
      detected: true,
      primaryPipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      primaryRenderingTypeId: 'AOSP_STANDARD',
      primaryConfidence: 0.9,
      primary_pipeline: {
        id: 'ANDROID_VIEW_STANDARD_BLAST',
        confidence: 0.9,
      },
      renderingType: {
        id: 'AOSP_STANDARD',
        docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
      },
      candidates: [],
      renderingTypeCandidates: [],
      relatedRenderingTypes: [],
      features: [],
      subvariants: {
        buffer_mode: 'BLAST',
        flutter_engine: 'N/A',
        webview_mode: 'N/A',
        game_engine: 'N/A',
      },
      traceRequirementsMissing: [],
      trace_requirements_missing: [],
    },
    teaching: {
      title: 'Android 标准渲染管线',
      summary: '说明应用、RenderThread 与 SurfaceFlinger 之间的渲染链路。',
      mermaidBlocks: ['flowchart LR\n  App --> SF'],
      threadRoles: [
        {
          thread: 'RenderThread',
          responsibility: '提交渲染工作。',
          traceTag: 'DrawFrame',
        },
      ],
      keySlices: ['DrawFrame'],
      docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
    },
    pinPlan: {
      status: 'planned',
      instructions: [],
      expectedLaneIds: ['app'],
      expectedTrackHints: [],
      summary: '1 pin instruction planned.',
      warnings: [],
    },
    overlayPlan: {
      status: 'ready',
      skillId: 'pipeline_key_slices_overlay',
      eventIds: ['event-1'],
      keySliceNames: ['DrawFrame'],
      summary: '1 observed event ready.',
      warnings: [],
    },
    warnings: [
      {
        code: 'NO_OBSERVED_EVENTS',
        severity: 'warning',
        message: 'No observed events.',
        source: 'observed_flow',
      },
    ],
    pinInstructions: [
      {
        pattern: '^RenderThread$',
        matchBy: 'thread',
        priority: 1,
        reason: '固定渲染线程。',
      },
    ],
    activeRenderingProcesses: [],
  };
}

describe('teachingLocalization', () => {
  it('projects English presentation without changing stable evidence fields', () => {
    const fixture = responseFixture();
    const result = localizeTeachingPipelineResponse(fixture, 'en');

    expect(result.teaching?.title).not.toMatch(/\p{Script=Han}/u);
    expect(result.teaching?.summary).not.toMatch(/\p{Script=Han}/u);
    expect(result.teaching?.threadRoles[0].responsibility).not.toMatch(
      /\p{Script=Han}/u,
    );
    expect(result.pinInstructions[0].reason).not.toMatch(/\p{Script=Han}/u);
    expect(result.pinPlan?.summary).not.toMatch(/\p{Script=Han}/u);
    expect(result.overlayPlan?.summary).not.toMatch(/\p{Script=Han}/u);
    expect(result.pinInstructions[0].pattern).toBe('^RenderThread$');
    expect(result.teaching?.mermaidBlocks[0]).toBe(
      'flowchart LR\n  App --> SF',
    );
    expect(result.detection.primaryPipelineId).toBe(
      'ANDROID_VIEW_STANDARD_BLAST',
    );
  });

  it('projects Chinese presentation while preserving technical identifiers', () => {
    const fixture = responseFixture();
    fixture.teaching!.title = 'Android rendering pipeline';
    fixture.teaching!.summary = 'Rendering flow tutorial.';
    fixture.teaching!.threadRoles[0].responsibility = 'Submits rendering work.';

    const result = localizeTeachingPipelineResponse(fixture, 'zh-CN');

    expect(result.teaching?.title).toMatch(/\p{Script=Han}/u);
    expect(result.teaching?.summary).toMatch(/\p{Script=Han}/u);
    expect(result.teaching?.threadRoles[0].responsibility).toMatch(
      /\p{Script=Han}/u,
    );
    expect(result.warnings?.[0].message).toMatch(/\p{Script=Han}/u);
    expect(result.overlayPlan?.skillId).toBe(
      'pipeline_key_slices_overlay',
    );
    expect(result.teaching?.keySlices).toEqual(['DrawFrame']);
  });
});
