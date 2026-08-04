// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../enterpriseDb';
import type { EnterpriseRepositoryScope } from '../../enterpriseRepository';
import { SkillPackInstallService } from '../skillPackInstallService';
import { SkillPackRepository } from '../skillPackRepository';
import { previewSkillPack } from '../skillPackPreviewService';
import type { SkillPackAssetKind, SkillPackManifestV1 } from '../skillPackTypes';
import { SKILL_PACK_MANIFEST_FILE } from '../skillPackManifest';

interface AssetInput {
  kind: SkillPackAssetKind;
  path: string;
  content: string;
}

const originalEnv = {
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  backendDataDir: process.env.SMARTPERFETTO_BACKEND_DATA_DIR,
};

const scopeA: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'admin-a',
};
const scopeB: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-b',
  userId: 'admin-a',
};
const skillYaml = [
  'name: local_jank',
  'version: "1"',
  'type: atomic',
  'meta:',
  '  display_name: Local Jank',
  '  description: Local reviewed skill',
  'sql: SELECT 1 AS value',
  '',
].join('\n');

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function writeAsset(root: string, asset: AssetInput): Promise<void> {
  const absolutePath = path.join(root, asset.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, asset.content, 'utf8');
}

async function writePack(root: string, assets: AssetInput[], version = '1.0.0'): Promise<SkillPackManifestV1> {
  for (const asset of assets) {
    await writeAsset(root, asset);
  }
  const manifest: SkillPackManifestV1 = {
    schemaVersion: 1,
    packId: 'local-pack',
    name: 'Local Pack',
    version,
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
  };
  await fs.writeFile(path.join(root, SKILL_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function writeBuiltInRoot(root: string): Promise<void> {
  await writeAsset(root, {
    kind: 'skill',
    path: 'atomic/builtin.skill.yaml',
    content: [
      'name: builtin_skill',
      'version: "1"',
      'type: atomic',
      'meta:',
      '  display_name: Builtin Skill',
      '  description: Builtin test skill',
      'sql: SELECT 1 AS value',
      '',
    ].join('\n'),
  });
}

function seedWorkspaceGraph(dbPath: string): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_777_000_000_000;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
        VALUES (?, 'tenant-a', ?, ?, ?)
      `).run(workspaceId, workspaceId, now, now);
    }
  } finally {
    db.close();
  }
}

describe('skill pack install service', () => {
  let tmpDir: string;
  let dbPath: string;
  let builtInDir: string;
  let packDir: string;
  let openedDbs: Database.Database[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-skill-pack-install-'));
    dbPath = path.join(tmpDir, 'enterprise.db');
    builtInDir = path.join(tmpDir, 'built-in');
    packDir = path.join(tmpDir, 'pack');
    openedDbs = [];
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
    await fs.mkdir(packDir, { recursive: true });
    await writeBuiltInRoot(builtInDir);
    seedWorkspaceGraph(dbPath);
  });

  afterEach(async () => {
    for (const db of openedDbs) {
      db.close();
    }
    restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
    restoreEnvValue('SMARTPERFETTO_BACKEND_DATA_DIR', originalEnv.backendDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createInstallService(invalidated: string[] = []): Promise<SkillPackInstallService> {
    const db = openEnterpriseDb(dbPath);
    openedDbs.push(db);
    return new SkillPackInstallService(
      new SkillPackRepository(db),
      {
        now: () => 1_777_000_001_000,
        invalidate: scope => invalidated.push(`${scope.tenantId}/${scope.workspaceId}`),
      },
    );
  }

  it('copies previewed assets into managed storage and persists metadata', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: skillYaml },
      { kind: 'fragment', path: 'fragments/local.sql', content: 'SELECT 1 AS local_value' },
      { kind: 'doc', path: 'docs/readme.md', content: '# Local Pack\n' },
    ]);
    await writeAsset(packDir, { kind: 'doc', path: 'docs/undeclared.md', content: 'ignored' });
    await fs.rm(path.join(packDir, 'docs/undeclared.md'));
    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });
    const invalidated: string[] = [];
    const service = await createInstallService(invalidated);

    const record = await service.installSkillPack(scopeA, 'admin-a', preview);

    expect(record).toMatchObject({
      id: 'local-pack',
      enabled: true,
      version: '1.0.0',
      metadata: {
        packId: 'local-pack',
        trustState: 'approved',
        approvedBy: 'admin-a',
        skillIds: ['local_jank'],
        fragmentKeys: ['fragments/local.sql'],
        docPaths: ['docs/readme.md'],
      },
    });
    await expect(fs.stat(path.join(record.sourcePath, 'atomic/local_jank.skill.yaml'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(record.sourcePath, 'docs/undeclared.md'))).rejects.toThrow();
    expect(invalidated).toEqual(['tenant-a/workspace-a']);
  });

  it('disables without deleting files and remove deletes only the managed copy', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: skillYaml },
    ]);
    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });
    const service = await createInstallService();
    const installed = await service.installSkillPack(scopeA, 'admin-a', preview);

    const disabled = await service.setSkillPackEnabled(scopeA, 'local-pack', false);

    expect(disabled.enabled).toBe(false);
    expect(disabled.metadata.disabledAt).toBe(1_777_000_001_000);
    await expect(fs.stat(path.join(installed.sourcePath, 'atomic/local_jank.skill.yaml'))).resolves.toBeTruthy();

    await service.removeSkillPack(scopeA, 'local-pack');

    await expect(fs.stat(installed.sourcePath)).rejects.toThrow();
  });

  it('rejects same pack version with different content hash', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: skillYaml },
    ]);
    const service = await createInstallService();
    const firstPreview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });
    await service.installSkillPack(scopeA, 'admin-a', firstPreview);

    await fs.rm(packDir, { recursive: true, force: true });
    await fs.mkdir(packDir, { recursive: true });
    await writePack(packDir, [
      {
        kind: 'skill',
        path: 'atomic/local_jank.skill.yaml',
        content: skillYaml.replace('SELECT 1 AS value', 'SELECT 2 AS value'),
      },
    ]);
    const secondPreview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    await expect(service.installSkillPack(scopeA, 'admin-a', secondPreview)).rejects.toThrow(
      'installed_pack_content_hash_mismatch',
    );
  });

  it('rehashes assets during install and rejects preview-to-copy changes', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: skillYaml },
    ]);
    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });
    await writeAsset(packDir, {
      kind: 'skill',
      path: 'atomic/local_jank.skill.yaml',
      content: skillYaml.replace('SELECT 1 AS value', 'SELECT 2 AS value'),
    });
    const service = await createInstallService();

    await expect(service.installSkillPack(scopeA, 'admin-a', preview)).rejects.toThrow(
      'asset_hash_mismatch:atomic/local_jank.skill.yaml',
    );
  });

  it('allows the same pack ID in different workspaces', async () => {
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/local_jank.skill.yaml', content: skillYaml },
    ]);
    const service = await createInstallService();
    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });

    await service.installSkillPack(scopeA, 'admin-a', preview);
    await service.installSkillPack(scopeB, 'admin-a', preview);

    const db = openEnterpriseDb(dbPath);
    try {
      const repository = new SkillPackRepository(db);
      expect(repository.list(scopeA).map(record => record.id)).toEqual(['local-pack']);
      expect(repository.list(scopeB).map(record => record.id)).toEqual(['local-pack']);
    } finally {
      db.close();
    }
  });
});
