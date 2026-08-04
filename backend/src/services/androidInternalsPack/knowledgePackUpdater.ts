// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import fs from 'fs';
import path from 'path';
import {gunzipSync} from 'zlib';
import {Updater, type UpdaterOptions} from 'tuf-js';

import {withFilesystemRegistryLockAsync} from '../filesystemRegistryLock';
import {
  compareContentVersions,
  isAndroidInternalsPackContentVersion,
  parseAndroidInternalsPackChannel,
  parseAndroidInternalsPackManifest,
  parseAndroidInternalsPackTargetPath,
} from './manifest';
import {
  readAndroidInternalsPackLock,
  verifyAndroidInternalsPackDirectory,
} from './androidInternalsPackResolver';
import {
  androidInternalsPackActivePointerPath,
  androidInternalsPackAssetRoot,
  androidInternalsPackChannelStatePath,
  androidInternalsPackLastKnownGoodPointerPath,
  androidInternalsPackRuntimeRoot,
  androidInternalsPackStatusErrorPath,
  androidInternalsPackTufRoot,
  androidInternalsPackVersionDirectory,
  androidInternalsPackVersionsRoot,
} from './packPaths';
import type {
  AndroidInternalsPackChannel,
  AndroidInternalsPackIdentity,
  AndroidInternalsPackManifest,
  AndroidInternalsPackPointer,
  AndroidInternalsPackUpdateResult,
} from './types';

const LOCK_STALE_MS = 15 * 60 * 1_000;
const MAX_CHANNEL_BYTES = 256 * 1_024;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_AUDIT_BYTES = 4 * 1_024 * 1_024;
const MAX_LICENSE_BYTES = 2 * 1_024 * 1_024;
const MAX_DATABASE_COMPRESSED_BYTES = 128 * 1_024 * 1_024;
const MAX_DATABASE_UNCOMPRESSED_BYTES = 512 * 1_024 * 1_024;

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function requireTargetSize(filePath: string, maximum: number, label: string): void {
  const size = fs.statSync(filePath).size;
  if (size <= 0 || size > maximum) throw new Error(`aiw_pack_${label}_size_rejected`);
}

async function downloadTarget(
  updater: KnowledgePackTufClient,
  targetPath: string,
  destination: string,
  maximum: number,
): Promise<void> {
  const info = await updater.getTargetInfo(targetPath);
  if (!info) throw new Error(`aiw_pack_target_not_found:${targetPath}`);
  if (info.length > maximum) throw new Error(`aiw_pack_target_too_large:${targetPath}`);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  await updater.downloadTarget(info, destination);
  requireTargetSize(destination, maximum, 'download');
}

function defaultMetadataBaseUrl(): string {
  return process.env.SMARTPERFETTO_AIW_PACK_METADATA_BASE_URL ||
    readAndroidInternalsPackLock().repository.metadataBaseUrl;
}

function defaultTargetBaseUrl(): string {
  return process.env.SMARTPERFETTO_AIW_PACK_TARGET_BASE_URL ||
    readAndroidInternalsPackLock().repository.targetBaseUrl;
}

function prepareTufCache(): {metadataDir: string; targetDir: string} {
  const root = androidInternalsPackTufRoot();
  const metadataDir = path.join(root, 'metadata');
  const targetDir = path.join(root, 'targets');
  fs.mkdirSync(metadataDir, {recursive: true});
  fs.mkdirSync(targetDir, {recursive: true});
  const trustedRoot = path.join(metadataDir, 'root.json');
  if (!fs.existsSync(trustedRoot)) {
    fs.copyFileSync(path.join(androidInternalsPackAssetRoot(), '1.root.json'), trustedRoot);
  }
  return {metadataDir, targetDir};
}

async function fetchChannel(
  updater: KnowledgePackTufClient,
  staging: string,
): Promise<AndroidInternalsPackChannel> {
  const destination = path.join(staging, 'stable.json');
  await downloadTarget(updater, 'channels/stable.json', destination, MAX_CHANNEL_BYTES);
  return parseAndroidInternalsPackChannel(
    JSON.parse(fs.readFileSync(destination, 'utf8')) as unknown,
  );
}

function channelState(channel: AndroidInternalsPackChannel) {
  return {
    checkedAt: new Date().toISOString(),
    contentVersion: channel.contentVersion,
    minimumSafeVersion: channel.minimumSafeVersion,
    revokedVersions: channel.revokedVersions,
    reasonCode: channel.reasonCode ?? null,
  };
}

function currentPointer(): AndroidInternalsPackPointer | undefined {
  const pointer = readJson<AndroidInternalsPackPointer>(
    androidInternalsPackActivePointerPath(),
  );
  if (
    pointer?.origin !== 'runtime' ||
    typeof pointer.installedAt !== 'string' ||
    !isAndroidInternalsPackContentVersion(pointer.contentVersion) ||
    !/^[0-9a-f]{64}$/.test(pointer.contentFingerprint) ||
    !/^[0-9a-f]{40}$/.test(pointer.sourceRevision)
  ) {
    return undefined;
  }
  return pointer;
}

function installPointer(identity: AndroidInternalsPackIdentity): AndroidInternalsPackPointer {
  return {
    contentVersion: identity.contentVersion,
    contentFingerprint: identity.contentFingerprint,
    sourceRevision: identity.sourceRevision,
    installedAt: new Date().toISOString(),
    origin: 'runtime',
  };
}

function channelAllowsVersion(
  channel: AndroidInternalsPackChannel,
  version: string,
): boolean {
  return !channel.revokedVersions.includes(version) &&
    compareContentVersions(version, channel.minimumSafeVersion) >= 0;
}

type PackTargets = AndroidInternalsPackChannel['targets'];

interface UpdateCandidate extends AndroidInternalsPackIdentity {
  manifest: AndroidInternalsPackManifest;
  targets: PackTargets;
}

function immutableTargetsForManifest(
  manifest: AndroidInternalsPackManifest,
): PackTargets {
  const prefix = `packs/android-internals/${manifest.contentVersion}`;
  return {
    manifest: parseAndroidInternalsPackTargetPath(
      `${prefix}/manifest.json`,
      'recovery_manifest_target',
    ),
    database: parseAndroidInternalsPackTargetPath(
      `${prefix}/${manifest.database.file}`,
      'recovery_database_target',
    ),
    audit: parseAndroidInternalsPackTargetPath(
      `${prefix}/${manifest.audit.file}`,
      'recovery_audit_target',
    ),
    licenses: Object.fromEntries(
      Object.keys(manifest.licenses.files).map(name => [
        name,
        parseAndroidInternalsPackTargetPath(
          `${prefix}/licenses/${name}`,
          `recovery_license_${name}`,
        ),
      ]),
    ),
  };
}

function assertManifestTargets(
  manifest: AndroidInternalsPackManifest,
  targets: PackTargets,
): void {
  const expectedLicenseNames = Object.keys(manifest.licenses.files).sort();
  const targetLicenseNames = Object.keys(targets.licenses).sort();
  if (
    expectedLicenseNames.length !== targetLicenseNames.length ||
    expectedLicenseNames.some((name, index) => name !== targetLicenseNames[index])
  ) {
    throw new Error('aiw_pack_manifest_license_targets_mismatch');
  }
}

async function resolveUpdateCandidate(
  updater: KnowledgePackTufClient,
  channel: AndroidInternalsPackChannel,
  packStaging: string,
): Promise<UpdateCandidate> {
  const stableAllowed = channelAllowsVersion(channel, channel.contentVersion);
  const desiredVersion = stableAllowed
    ? channel.contentVersion
    : channel.minimumSafeVersion;
  if (!channelAllowsVersion(channel, desiredVersion)) {
    throw new Error('aiw_pack_channel_has_no_safe_version');
  }
  const manifestTarget = stableAllowed
    ? channel.targets.manifest
    : parseAndroidInternalsPackTargetPath(
      `packs/android-internals/${desiredVersion}/manifest.json`,
      'recovery_manifest_target',
    );
  const manifestPath = path.join(packStaging, 'manifest.json');
  await downloadTarget(
    updater,
    manifestTarget,
    manifestPath,
    MAX_MANIFEST_BYTES,
  );
  const manifest = parseAndroidInternalsPackManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown,
  );
  if (manifest.revocation.revoked) throw new Error('aiw_pack_manifest_revoked');
  if (manifest.contentVersion !== desiredVersion) {
    throw new Error('aiw_pack_safe_manifest_version_mismatch');
  }
  if (
    stableAllowed &&
    (
      manifest.contentFingerprint !== channel.contentFingerprint ||
      manifest.sourceRevision !== channel.sourceRevision
    )
  ) {
    throw new Error('aiw_pack_channel_manifest_mismatch');
  }
  const targets = stableAllowed
    ? channel.targets
    : immutableTargetsForManifest(manifest);
  assertManifestTargets(manifest, targets);
  return {
    contentVersion: manifest.contentVersion,
    contentFingerprint: manifest.contentFingerprint,
    sourceRevision: manifest.sourceRevision,
    manifest,
    targets,
  };
}

function retainRecentVersions(activeVersion: string, lastKnownGoodVersion?: string): void {
  const root = androidInternalsPackVersionsRoot();
  if (!fs.existsSync(root)) return;
  const versions = fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse();
  const keep = new Set([
    activeVersion,
    ...(lastKnownGoodVersion ? [lastKnownGoodVersion] : []),
    ...versions.slice(0, 2),
  ]);
  for (const version of versions) {
    if (!keep.has(version)) fs.rmSync(path.join(root, version), {recursive: true, force: true});
  }
}

function persistError(error: unknown): void {
  try {
    writeJsonAtomic(androidInternalsPackStatusErrorPath(), {
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Updating diagnostic state must not hide the original update error.
  }
}

export interface UpdateAndroidInternalsPackOptions {
  checkOnly?: boolean;
  metadataBaseUrl?: string;
  targetBaseUrl?: string;
  updaterFactory?: (options: UpdaterOptions) => KnowledgePackTufClient;
}

export interface KnowledgePackTufClient {
  refresh(): Promise<void>;
  getTargetInfo(targetPath: string): Promise<{
    path: string;
    length: number;
  } | undefined>;
  downloadTarget(
    targetInfo: {path: string; length: number},
    filePath?: string,
    targetBaseUrl?: string,
  ): Promise<string>;
}

export async function updateAndroidInternalsPack(
  options: UpdateAndroidInternalsPackOptions = {},
): Promise<AndroidInternalsPackUpdateResult> {
  if (process.env.SMARTPERFETTO_AIW_PACK_ENABLED === '0') return {status: 'disabled'};
  const mode = process.env.SMARTPERFETTO_AIW_PACK_UPDATE_MODE?.toLowerCase();
  const checkOnly = options.checkOnly || mode === 'check';
  if (mode === 'off') return {status: 'disabled'};

  try {
    return await withFilesystemRegistryLockAsync(
      path.join(androidInternalsPackRuntimeRoot(), 'update'),
      'aiw_pack_update_busy',
      async lease => {
        const {metadataDir, targetDir} = prepareTufCache();
        const updater = (options.updaterFactory ?? (updaterOptions =>
          new Updater(updaterOptions) as KnowledgePackTufClient))({
          metadataDir,
          targetDir,
          metadataBaseUrl: options.metadataBaseUrl || defaultMetadataBaseUrl(),
          targetBaseUrl: options.targetBaseUrl || defaultTargetBaseUrl(),
          config: {
            fetchTimeout: 30_000,
            fetchRetries: 2,
            userAgent: 'SmartPerfetto Android-Internals-Pack',
            targetsMaxLength: MAX_MANIFEST_BYTES,
          },
        });
        await updater.refresh();
        lease.assertHeld();
        const stagingRoot = path.join(androidInternalsPackRuntimeRoot(), 'staging');
        fs.mkdirSync(stagingRoot, {recursive: true});
        const staging = fs.mkdtempSync(path.join(stagingRoot, '.update-'));
        try {
          const channel = await fetchChannel(updater, staging);
          writeJsonAtomic(androidInternalsPackChannelStatePath(), channelState(channel));
          const previous = currentPointer();
          const packStaging = path.join(staging, 'pack');
          fs.mkdirSync(packStaging, {recursive: true});
          const candidate = await resolveUpdateCandidate(
            updater,
            channel,
            packStaging,
          );
          if (
            previous?.contentVersion === candidate.contentVersion &&
            previous.contentFingerprint === candidate.contentFingerprint &&
            channelAllowsVersion(channel, previous.contentVersion)
          ) {
            fs.rmSync(androidInternalsPackStatusErrorPath(), {force: true});
            return {
              status: 'up_to_date',
              contentVersion: previous.contentVersion,
              contentFingerprint: previous.contentFingerprint,
            };
          }
          if (checkOnly) {
            return {
              status: 'check_only',
              previousVersion: previous?.contentVersion,
              contentVersion: candidate.contentVersion,
              contentFingerprint: candidate.contentFingerprint,
            };
          }

          const {manifest, targets} = candidate;
          if (
            manifest.database.compressedBytes > MAX_DATABASE_COMPRESSED_BYTES ||
            manifest.database.uncompressedBytes > MAX_DATABASE_UNCOMPRESSED_BYTES
          ) {
            throw new Error('aiw_pack_database_size_rejected');
          }
          const compressedPath = path.join(packStaging, manifest.database.file);
          await downloadTarget(
            updater,
            targets.database,
            compressedPath,
            MAX_DATABASE_COMPRESSED_BYTES,
          );
          await downloadTarget(
            updater,
            targets.audit,
            path.join(packStaging, manifest.audit.file),
            MAX_AUDIT_BYTES,
          );
          for (const [name, targetPath] of Object.entries(targets.licenses)) {
            await downloadTarget(
              updater,
              targetPath,
              path.join(packStaging, 'licenses', name),
              MAX_LICENSE_BYTES,
            );
          }
          const compressed = fs.readFileSync(compressedPath);
          if (
            compressed.length !== manifest.database.compressedBytes ||
            createHash('sha256').update(compressed).digest('hex') !== manifest.database.sha256
          ) {
            throw new Error('aiw_pack_compressed_database_mismatch');
          }
          const database = gunzipSync(compressed, {
            maxOutputLength: manifest.database.uncompressedBytes,
          });
          if (
            database.length !== manifest.database.uncompressedBytes ||
            createHash('sha256').update(database).digest('hex') !==
              manifest.database.uncompressedSha256
          ) {
            throw new Error('aiw_pack_database_mismatch');
          }
          fs.writeFileSync(path.join(packStaging, 'content.sqlite'), database, {flag: 'wx'});
          fs.rmSync(compressedPath);
          verifyAndroidInternalsPackDirectory(packStaging, 'runtime', candidate);
          lease.assertHeld();

          const destination = androidInternalsPackVersionDirectory(candidate.contentVersion);
          fs.mkdirSync(path.dirname(destination), {recursive: true});
          if (fs.existsSync(destination)) {
            verifyAndroidInternalsPackDirectory(destination, 'runtime', candidate);
          } else {
            fs.renameSync(packStaging, destination);
          }
          if (previous && channelAllowsVersion(channel, previous.contentVersion)) {
            writeJsonAtomic(androidInternalsPackLastKnownGoodPointerPath(), previous);
          }
          writeJsonAtomic(androidInternalsPackActivePointerPath(), installPointer(candidate));
          fs.rmSync(androidInternalsPackStatusErrorPath(), {force: true});
          retainRecentVersions(candidate.contentVersion, previous?.contentVersion);
          return {
            status: 'installed',
            previousVersion: previous?.contentVersion,
            contentVersion: candidate.contentVersion,
            contentFingerprint: candidate.contentFingerprint,
          };
        } finally {
          fs.rmSync(staging, {recursive: true, force: true});
        }
      },
      LOCK_STALE_MS,
    );
  } catch (error) {
    persistError(error);
    throw error;
  }
}
