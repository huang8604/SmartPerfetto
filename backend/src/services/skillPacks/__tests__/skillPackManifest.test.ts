// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import {
  canonicalJson,
  parseSkillPackManifest,
} from '../skillPackManifest';
import type { SkillPackManifestV1 } from '../skillPackTypes';

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validManifest(overrides: Partial<SkillPackManifestV1> = {}): SkillPackManifestV1 {
  return {
    schemaVersion: 1,
    packId: 'local-pack',
    name: 'Local Pack',
    version: '1.0.0',
    publisher: 'local',
    description: 'A local reviewed pack',
    license: 'AGPL-3.0-or-later',
    assets: [
      {
        kind: 'skill',
        path: 'atomic/local_jank.skill.yaml',
        sha256: sha('skill'),
        sizeBytes: 5,
      },
      {
        kind: 'fragment',
        path: 'fragments/local.sql',
        sha256: sha('fragment'),
        sizeBytes: 8,
      },
      {
        kind: 'doc',
        path: 'docs/readme.md',
        sha256: sha('doc'),
        sizeBytes: 3,
      },
    ],
    compatibility: {
      smartPerfettoMinVersion: '0.1.0',
    },
    ...overrides,
  };
}

describe('skill pack manifest parser', () => {
  it('parses a valid local manifest and returns a stable manifest hash', () => {
    const manifest = validManifest();

    const parsed = parseSkillPackManifest(manifest);

    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.manifestHash).toBe(
      createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex'),
    );
  });

  it.each([
    ['../atomic/escape.skill.yaml', 'invalid_asset_path'],
    ['/tmp/atomic/escape.skill.yaml', 'invalid_asset_path'],
    ['atomic/.hidden.skill.yaml', 'invalid_asset_path'],
    ['strategies/prompt.md', 'invalid_asset_path'],
    ['vendors/acme/x.override.yaml', 'invalid_asset_path'],
    ['custom/local.skill.yaml', 'invalid_asset_path'],
    ['atomic/hook.sh', 'invalid_asset_path'],
  ])('rejects unsafe asset path %s', (assetPath, expectedError) => {
    const manifest = validManifest({
      assets: [
        {
          kind: 'skill',
          path: assetPath,
          sha256: sha('asset'),
          sizeBytes: 1,
        },
      ],
    });

    expect(() => parseSkillPackManifest(manifest)).toThrow(expectedError);
  });

  it('rejects unsupported asset kinds', () => {
    const manifest = validManifest({
      assets: [
        {
          kind: 'strategy' as never,
          path: 'docs/readme.md',
          sha256: sha('asset'),
          sizeBytes: 1,
        },
      ],
    });

    expect(() => parseSkillPackManifest(manifest)).toThrow('unsupported_asset_kind');
  });

  it('rejects missing or malformed hashes', () => {
    const manifest = validManifest({
      assets: [
        {
          kind: 'doc',
          path: 'docs/readme.md',
          sha256: 'abc',
          sizeBytes: 1,
        },
      ],
    });

    expect(() => parseSkillPackManifest(manifest)).toThrow('invalid_sha256');
  });

  it('rejects oversized assets', () => {
    const manifest = validManifest({
      assets: [
        {
          kind: 'doc',
          path: 'docs/large.md',
          sha256: sha('asset'),
          sizeBytes: 50 * 1024 * 1024,
        },
      ],
    });

    expect(() => parseSkillPackManifest(manifest)).toThrow('asset_too_large');
  });

  it('rejects too many assets and oversized pack totals', () => {
    expect(() => parseSkillPackManifest(validManifest({
      assets: Array.from({ length: 513 }, (_, index) => ({
        kind: 'doc',
        path: `docs/${index}.md`,
        sha256: sha(`asset-${index}`),
        sizeBytes: 1,
      })),
    }))).toThrow('invalid_asset_count');

    expect(() => parseSkillPackManifest(validManifest({
      assets: [
        {
          kind: 'doc',
          path: 'docs/large-a.md',
          sha256: sha('a'),
          sizeBytes: 20 * 1024 * 1024,
        },
        {
          kind: 'doc',
          path: 'docs/large-b.md',
          sha256: sha('b'),
          sizeBytes: 20 * 1024 * 1024,
        },
        {
          kind: 'doc',
          path: 'docs/large-c.md',
          sha256: sha('c'),
          sizeBytes: 20 * 1024 * 1024,
        },
        {
          kind: 'doc',
          path: 'docs/large-d.md',
          sha256: sha('d'),
          sizeBytes: 20 * 1024 * 1024,
        },
        {
          kind: 'doc',
          path: 'docs/large-e.md',
          sha256: sha('e'),
          sizeBytes: 20 * 1024 * 1024,
        },
        {
          kind: 'doc',
          path: 'docs/large-f.md',
          sha256: sha('f'),
          sizeBytes: 1,
        },
      ],
    }))).toThrow('asset_total_too_large');
  });

  it('rejects invalid schema version and pack IDs', () => {
    expect(() => parseSkillPackManifest({ ...validManifest(), schemaVersion: 2 })).toThrow(
      'invalid_schema_version',
    );
    expect(() => parseSkillPackManifest({ ...validManifest(), packId: '../pack' })).toThrow(
      'invalid_pack_id',
    );
  });
});
