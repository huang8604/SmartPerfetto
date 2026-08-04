// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from '@jest/globals';
import { PipelineDocService } from '../pipelineDocService';
import { pipelineSkillLoader } from '../pipelineSkillLoader';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourceDocs = path.join(repoRoot, 'docs', 'rendering_pipelines');
const runtimeDocs = path.join(repoRoot, 'backend', 'dist', 'rendering_pipelines');

describe('pipeline catalog and Android 17 teaching documents', () => {
  beforeAll(async () => {
    await pipelineSkillLoader.reload();
  });

  it('loads the complete role-aware catalog without promoting features', () => {
    const catalog = pipelineSkillLoader.getCatalog();
    const entries = Object.entries(catalog.pipelines);
    expect(entries).toHaveLength(31);
    expect(pipelineSkillLoader.getAllPipelineIds()).toHaveLength(31);

    for (const [pipelineId, entry] of entries) {
      expect(pipelineSkillLoader.getPipeline(pipelineId)).not.toBeNull();
      expect(pipelineSkillLoader.getRenderingType(entry.teaching_type_id)).not.toBeNull();
      if (entry.classification_role === 'variant') {
        expect(entry.primary_eligible).toBe(true);
        expect(entry.rendering_type_id).toBe(entry.teaching_type_id);
      } else {
        expect(entry.primary_eligible).toBe(false);
        expect(entry.rendering_type_id).toBeUndefined();
      }
    }

    expect(pipelineSkillLoader.getPipelineCatalogEntry('FLUTTER_SURFACEVIEW_IMPELLER'))
      .toEqual(expect.objectContaining({
        classification_role: 'variant',
        rendering_type_id: 'S10_FLUTTER',
        architecture_type: 'FLUTTER',
      }));
    expect(pipelineSkillLoader.getPipelineCatalogEntry('VARIABLE_REFRESH_RATE'))
      .toEqual(expect.objectContaining({
        classification_role: 'feature',
        teaching_type_id: 'S01_OVERVIEW',
        primary_eligible: false,
      }));
  });

  it('derives the fallback IDs and article from the catalog default', () => {
    expect(pipelineSkillLoader.getDefaultSelection()).toEqual({
      pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      renderingTypeId: 'S02_AOSP_STANDARD',
      docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
    });
  });

  it.each([
    ['source', sourceDocs],
    ['compiled runtime', runtimeDocs],
  ])('parses upstream Flutter teaching from the %s article set', (_label, docsDir) => {
    expect(fs.existsSync(docsDir)).toBe(true);
    const service = new PipelineDocService(docsDir, pipelineSkillLoader);
    const teaching = service.getTeachingContent('FLUTTER_SURFACEVIEW_IMPELLER');
    expect(teaching).toEqual(expect.objectContaining({
      title: 'Android Perfetto 系列 - App 出图类型 - Flutter 类型',
      docPath: 'rendering_pipelines/S10_flutter_type.md',
    }));
    expect(teaching?.summary).toContain('Flutter 页面不能只用');
    expect(teaching?.mermaidBlocks.length).toBeGreaterThan(0);
  });
});
