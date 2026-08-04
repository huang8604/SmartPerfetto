// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {CodebaseRef} from '../codebase/codebaseRegistry';
import type {PathPreviewResult} from '../codebase/pathSecurityGate';
import {
  MAX_SOURCE_CHUNKS_PER_GENERATION,
  assertCodebaseRootIdentity,
  resolveMaxSourceChunks,
  selectCodebasePreviewFiles,
} from '../rag/sourceFileSelection';

const ref: CodebaseRef = {
  codebaseId: 'cb-test',
  kind: 'app_source',
  displayName: 'App',
  rootPath: '/repo',
  rootRealpath: '/repo',
  pathFilters: ['app/src'],
  consent: {
    sendToProvider: false,
    consentedAt: 1,
    consentedBy: 'test',
    consentHash: 'hash',
  },
  indexGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};

const preview: PathPreviewResult = {
  rootPath: '/repo',
  rootRealpath: '/repo',
  blocked: false,
  acceptedFiles: [
    {relativePath: 'app/src/Main.kt', sizeBytes: 1},
    {relativePath: 'tools/Secret.kt', sizeBytes: 1},
  ],
  skippedFiles: [],
  skippedFileCount: 0,
};

describe('selectCodebasePreviewFiles', () => {
  it('rejects physical root drift while preserving Windows case-insensitive identity', () => {
    expect(() => assertCodebaseRootIdentity('/repo/source', '/repo/other', 'linux'))
      .toThrow('codebase_root_realpath_drift');
    expect(() => assertCodebaseRootIdentity('C:\\Repo\\Source', 'c:\\repo\\source', 'win32'))
      .not.toThrow();
  });

  it('intersects a request prefix with registered filters instead of expanding them', () => {
    expect(selectCodebasePreviewFiles(preview, ref, 'tools')).toEqual([]);
    expect(selectCodebasePreviewFiles(preview, ref, 'app')).toEqual([preview.acceptedFiles[0]]);
  });

  it('matches registered filters, request prefixes, and exclude globs case-insensitively on Windows', () => {
    const windowsRef: CodebaseRef = {
      ...ref,
      pathFilters: ['APP/SRC'],
      excludeGlobs: ['**/GENERATED/**'],
    };
    const windowsPreview: PathPreviewResult = {
      ...preview,
      acceptedFiles: [
        {relativePath: 'app/src/Main.KT', sizeBytes: 1},
        {relativePath: 'app/src/Generated/Skip.kt', sizeBytes: 1},
      ],
    };

    expect(selectCodebasePreviewFiles(windowsPreview, windowsRef, 'App/Src', 'win32'))
      .toEqual([windowsPreview.acceptedFiles[0]]);
  });

  it('applies a finite generation-wide chunk limit', () => {
    expect(resolveMaxSourceChunks(undefined)).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
    expect(resolveMaxSourceChunks(7)).toBe(7);
    expect(() => resolveMaxSourceChunks(0)).toThrow('maxChunks must be an integer');
    expect(() => resolveMaxSourceChunks(MAX_SOURCE_CHUNKS_PER_GENERATION + 1))
      .toThrow('maxChunks must be an integer');
  });
});
