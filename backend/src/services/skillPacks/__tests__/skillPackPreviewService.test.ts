// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { SkillPackAssetKind, SkillPackManifestV1 } from '../skillPackTypes';
import { SKILL_PACK_MANIFEST_FILE } from '../skillPackManifest';
import { previewSkillPack } from '../skillPackPreviewService';

interface AssetInput {
  kind: SkillPackAssetKind;
  path: string;
  content: string;
}

const localSkillYaml = [
  'name: local_jank',
  'version: "1"',
  'type: atomic',
  'meta:',
  '  display_name: Local Jank',
  '  description: Local reviewed skill',
  'sql: SELECT 1 AS value',
  '',
].join('\n');

async function writeAsset(root: string, asset: AssetInput): Promise<void> {
  const absolutePath = path.join(root, asset.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, asset.content, 'utf8');
}

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function writePack(
  root: string,
  assets: AssetInput[],
  manifestOverrides: Partial<SkillPackManifestV1> = {},
): Promise<SkillPackManifestV1> {
  for (const asset of assets) {
    await writeAsset(root, asset);
  }
  const manifest: SkillPackManifestV1 = {
    schemaVersion: 1,
    packId: 'local-pack',
    name: 'Local Pack',
    version: '1.0.0',
    publisher: 'local',
    description: 'A local pack',
    license: 'AGPL-3.0-or-later',
    assets: assets.map(asset => ({
      kind: asset.kind,
      path: asset.path,
      sha256: sha(asset.content),
      sizeBytes: Buffer.byteLength(asset.content, 'utf8'),
    })),
    compatibility: {
      smartPerfettoMinVersion: '0.1.0',
    },
    ...manifestOverrides,
  };
  await fs.writeFile(
    path.join(root, SKILL_PACK_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  return manifest;
}

async function writeBuiltInRoot(root: string, options: { skillName?: string; fragmentContent?: string } = {}): Promise<void> {
  await writeAsset(root, {
    kind: 'skill',
    path: 'atomic/builtin.skill.yaml',
    content: [
      `name: ${options.skillName ?? 'builtin_skill'}`,
      'version: "1"',
      'type: atomic',
      'meta:',
      '  display_name: Builtin Skill',
      '  description: Builtin test skill',
      'sql: SELECT 1 AS value',
      '',
    ].join('\n'),
  });
  if (options.fragmentContent !== undefined) {
    await writeAsset(root, {
      kind: 'fragment',
      path: 'fragments/common.sql',
      content: options.fragmentContent,
    });
  }
}

describe('skill pack preview service', () => {
  let tmpDir: string;
  let builtInDir: string;
  let packDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-skill-pack-preview-'));
    builtInDir = path.join(tmpDir, 'built-in');
    packDir = path.join(tmpDir, 'pack');
    await fs.mkdir(packDir, { recursive: true });
    await writeBuiltInRoot(builtInDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('previews a valid local directory without installing files', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: localSkillYaml },
      { kind: 'fragment', path: 'fragments/local.sql', content: 'SELECT 1 AS local_value' },
      { kind: 'doc', path: 'docs/readme.md', content: '# Local Pack\n' },
    ]);

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(true);
    expect(preview.skillIds).toEqual(['local_jank']);
    expect(preview.fragmentKeys).toEqual(['fragments/local.sql']);
    expect(preview.docPaths).toEqual(['docs/readme.md']);
    expect(await fs.readdir(path.join(tmpDir))).toEqual(expect.arrayContaining(['built-in', 'pack']));
  });

  it('rejects hash mismatch and missing declared assets', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: localSkillYaml },
      { kind: 'doc', path: 'docs/readme.md', content: '# Local Pack\n' },
    ]);
    await fs.writeFile(
      path.join(packDir, 'atomic/local_jank.skill.yaml'),
      localSkillYaml.replace('SELECT 1 AS value', 'SELECT 200 AS changed_value'),
      'utf8',
    );
    await fs.rm(path.join(packDir, 'docs/readme.md'));

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(false);
    expect(preview.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'asset_size_mismatch',
      'asset_hash_mismatch',
      'missing_asset',
    ]));
  });

  it('rejects undeclared files and symlinks', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: localSkillYaml },
    ]);
    await fs.writeFile(path.join(packDir, 'docs', 'extra.md'), 'extra', 'utf8').catch(async () => {
      await fs.mkdir(path.join(packDir, 'docs'), { recursive: true });
      await fs.writeFile(path.join(packDir, 'docs', 'extra.md'), 'extra', 'utf8');
    });
    await fs.symlink(path.join(tmpDir, 'outside.md'), path.join(packDir, 'docs', 'outside.md'));

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(false);
    expect(preview.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'undeclared_asset',
      'symlink_not_allowed',
    ]));
  });

  it('rejects duplicate skill IDs inside the pack', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/one.skill.yaml', content: localSkillYaml },
      { kind: 'skill', path: 'composite/two.skill.yaml', content: localSkillYaml },
    ]);

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(false);
    expect(preview.errors.map(error => error.code)).toContain('duplicate_skill_id');
  });

  it('rejects built-in skill ID collisions', async () => {
    await fs.rm(builtInDir, { recursive: true, force: true });
    await writeBuiltInRoot(builtInDir, { skillName: 'local_jank' });
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: localSkillYaml },
    ]);

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(false);
    expect(preview.errors.map(error => error.code)).toContain('skill_id_collision:local_jank');
  });

  it('rejects fragment key collisions with different SQL bytes', async () => {
    await fs.rm(builtInDir, { recursive: true, force: true });
    await writeBuiltInRoot(builtInDir, { fragmentContent: 'SELECT 1 AS builtin_value' });
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: localSkillYaml },
      { kind: 'fragment', path: 'fragments/common.sql', content: 'SELECT 2 AS external_value' },
    ]);

    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    expect(preview.success).toBe(false);
    expect(preview.errors.map(error => error.code)).toContain('fragment_key_collision:fragments/common.sql');
  });
});
