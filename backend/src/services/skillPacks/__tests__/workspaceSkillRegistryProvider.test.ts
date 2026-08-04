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
import {
  clearWorkspaceSkillRegistryCache,
  getWorkspaceSkillRegistry,
  invalidateWorkspaceSkillRegistry,
} from '../workspaceSkillRegistryProvider';

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

function skillYaml(skillId: string, selectValue = 1): string {
  return [
    `name: ${skillId}`,
    'version: "1"',
    'type: atomic',
    'meta:',
    `  display_name: ${skillId}`,
    '  description: Test skill',
    `sql: SELECT ${selectValue} AS value`,
    '',
  ].join('\n');
}

async function writeAsset(root: string, asset: AssetInput): Promise<void> {
  const absolutePath = path.join(root, asset.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, asset.content, 'utf8');
}

async function writePack(
  root: string,
  packId: string,
  assets: AssetInput[],
  version = '1.0.0',
): Promise<SkillPackManifestV1> {
  for (const asset of assets) {
    await writeAsset(root, asset);
  }
  const manifest: SkillPackManifestV1 = {
    schemaVersion: 1,
    packId,
    name: packId,
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
    content: skillYaml('builtin_skill'),
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

describe('workspace skill registry provider', () => {
  let tmpDir: string;
  let dbPath: string;
  let builtInDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-workspace-skill-registry-'));
    dbPath = path.join(tmpDir, 'enterprise.db');
    builtInDir = path.join(tmpDir, 'built-in');
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
    await writeBuiltInRoot(builtInDir);
    seedWorkspaceGraph(dbPath);
    db = openEnterpriseDb(dbPath);
  });

  afterEach(async () => {
    db.close();
    clearWorkspaceSkillRegistryCache();
    restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
    restoreEnvValue('SMARTPERFETTO_BACKEND_DATA_DIR', originalEnv.backendDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function installPack(
    scope: EnterpriseRepositoryScope,
    packId: string,
    skillId: string,
  ): Promise<void> {
    const packDir = path.join(tmpDir, packId);
    await fs.mkdir(packDir, { recursive: true });
    await writePack(packDir, packId, [
      { kind: 'skill', path: `atomic/${skillId}.skill.yaml`, content: skillYaml(skillId) },
      { kind: 'fragment', path: `fragments/${packId}.sql`, content: `${packId.replace(/-/g, '_')} AS (SELECT 1 AS value)` },
    ]);
    const preview = await previewSkillPack({ sourcePath: packDir, builtInSkillsDir: builtInDir });
    const service = new SkillPackInstallService(
      new SkillPackRepository(db),
      {
        now: () => 1_777_000_001_000,
        invalidate: invalidateWorkspaceSkillRegistry,
      },
    );
    await service.installSkillPack(scope, 'admin-a', preview);
  }

  it('loads enabled packs only for the approving workspace and exposes origin metadata', async () => {
    await installPack(scopeA, 'local-pack', 'local_jank');

    const handleA = await getWorkspaceSkillRegistry(scopeA, { db, builtInSkillsDir: builtInDir });
    const handleA2 = await getWorkspaceSkillRegistry(scopeA, { db, builtInSkillsDir: builtInDir });
    const handleB = await getWorkspaceSkillRegistry(scopeB, { db, builtInSkillsDir: builtInDir });

    expect(handleA2).toBe(handleA);
    expect(handleA.registryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(handleA.registry.getSkill('builtin_skill')).toBeTruthy();
    expect(handleA.registry.getSkill('local_jank')).toBeTruthy();
    expect(handleA.getSkillOrigin('builtin_skill')).toEqual({ origin: 'built_in' });
    expect(handleA.getSkillOrigin('local_jank')).toMatchObject({
      origin: 'external_pack',
      packId: 'local-pack',
      packVersion: '1.0.0',
      trustState: 'approved',
    });
    expect(handleB.registry.getSkill('builtin_skill')).toBeTruthy();
    expect(handleB.registry.getSkill('local_jank')).toBeUndefined();
  });

  it('drops disabled packs after install-service invalidation', async () => {
    await installPack(scopeA, 'local-pack', 'local_jank');
    const beforeDisable = await getWorkspaceSkillRegistry(scopeA, { db, builtInSkillsDir: builtInDir });
    const service = new SkillPackInstallService(
      new SkillPackRepository(db),
      { now: () => 1_777_000_002_000, invalidate: invalidateWorkspaceSkillRegistry },
    );

    await service.setSkillPackEnabled(scopeA, 'local-pack', false);
    const afterDisable = await getWorkspaceSkillRegistry(scopeA, { db, builtInSkillsDir: builtInDir });

    expect(beforeDisable.registry.getSkill('local_jank')).toBeTruthy();
    expect(afterDisable.registry.getSkill('local_jank')).toBeUndefined();
    expect(afterDisable.registryFingerprint).not.toBe(beforeDisable.registryFingerprint);
  });

  it('refuses to build a workspace registry when enabled packs collide', async () => {
    await installPack(scopeA, 'pack-a', 'duplicate_skill');
    await installPack(scopeA, 'pack-b', 'duplicate_skill');

    await expect(
      getWorkspaceSkillRegistry(scopeA, { db, builtInSkillsDir: builtInDir }),
    ).rejects.toThrow('workspace_skill_pack_skill_collision:duplicate_skill');
  });
});
