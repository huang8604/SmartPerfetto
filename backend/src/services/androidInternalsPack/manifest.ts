// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import fs from 'fs';

import {
  ANDROID_INTERNALS_PACK_FORMAT_VERSION,
  ANDROID_INTERNALS_PACK_ID,
  ANDROID_INTERNALS_PACK_LICENSE,
  ANDROID_INTERNALS_PACK_SCHEMA_VERSION,
  type AndroidInternalsPackChannel,
  type AndroidInternalsPackManifest,
} from './types';

const SHA256_RE = /^[0-9a-f]{64}$/;
const CALVER_RE = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function isAndroidInternalsPackContentVersion(value: unknown): value is string {
  return typeof value === 'string' && CALVER_RE.test(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_aiw_pack_${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid_aiw_pack_${field}`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid_aiw_pack_${field}`);
  }
  return Number(value);
}

function sha256(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!SHA256_RE.test(parsed)) throw new Error(`invalid_aiw_pack_${field}`);
  return parsed;
}

function contentVersion(value: unknown, field = 'content_version'): string {
  const parsed = text(value, field);
  if (!isAndroidInternalsPackContentVersion(parsed)) {
    throw new Error(`invalid_aiw_pack_${field}`);
  }
  return parsed;
}

function exactInteger(value: unknown, expected: number, field: string): number {
  const parsed = integer(value, field);
  if (parsed !== expected) throw new Error(`unsupported_aiw_pack_${field}`);
  return parsed;
}

export function parseAndroidInternalsPackManifest(value: unknown): AndroidInternalsPackManifest {
  const root = record(value, 'manifest');
  const compatibility = record(root.compatibility, 'compatibility');
  const database = record(root.database, 'database');
  const audit = record(root.audit, 'audit');
  const licenses = record(root.licenses, 'licenses');
  const licenseFiles = record(licenses.files, 'license_files');
  const revocation = record(root.revocation, 'revocation');
  const parsedLicenseFiles: Record<string, string> = {};
  for (const [name, hash] of Object.entries(licenseFiles)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid_aiw_pack_license_name');
    parsedLicenseFiles[name] = sha256(hash, `license_hash_${name}`);
  }
  if (Object.keys(parsedLicenseFiles).length === 0) {
    throw new Error('invalid_aiw_pack_license_files');
  }
  if (root.packId !== ANDROID_INTERNALS_PACK_ID) throw new Error('invalid_aiw_pack_id');
  if (licenses.expression !== ANDROID_INTERNALS_PACK_LICENSE) {
    throw new Error('invalid_aiw_pack_license_expression');
  }
  if (database.file !== 'content.sqlite.gz' || database.compression !== 'gzip') {
    throw new Error('invalid_aiw_pack_database_contract');
  }
  if (audit.file !== 'audit-summary.json') throw new Error('invalid_aiw_pack_audit_contract');
  if (typeof revocation.revoked !== 'boolean') throw new Error('invalid_aiw_pack_revoked');
  const sourceRevision = text(root.sourceRevision, 'source_revision');
  if (!GIT_SHA_RE.test(sourceRevision)) throw new Error('invalid_aiw_pack_source_revision');
  const generatedAt = text(root.generatedAt, 'generated_at');
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('invalid_aiw_pack_generated_at');

  return {
    schemaVersion: exactInteger(
      root.schemaVersion,
      ANDROID_INTERNALS_PACK_SCHEMA_VERSION,
      'schema_version',
    ) as 1,
    packId: ANDROID_INTERNALS_PACK_ID,
    packFormatVersion: exactInteger(
      root.packFormatVersion,
      ANDROID_INTERNALS_PACK_FORMAT_VERSION,
      'format_version',
    ) as 1,
    contentVersion: contentVersion(root.contentVersion),
    contentFingerprint: sha256(root.contentFingerprint, 'content_fingerprint'),
    sourceRevision,
    generatedAt,
    articleCount: integer(root.articleCount, 'article_count'),
    sectionCount: integer(root.sectionCount, 'section_count'),
    chunkCount: integer(root.chunkCount, 'chunk_count'),
    compatibility: {
      smartPerfettoMinVersion: text(
        compatibility.smartPerfettoMinVersion,
        'min_smartperfetto_version',
      ),
      smartPerfettoMaxVersion: text(
        compatibility.smartPerfettoMaxVersion,
        'max_smartperfetto_version',
      ),
    },
    database: {
      file: 'content.sqlite.gz',
      compression: 'gzip',
      sha256: sha256(database.sha256, 'database_sha256'),
      uncompressedSha256: sha256(
        database.uncompressedSha256,
        'database_uncompressed_sha256',
      ),
      compressedBytes: integer(database.compressedBytes, 'database_compressed_bytes'),
      uncompressedBytes: integer(database.uncompressedBytes, 'database_uncompressed_bytes'),
    },
    audit: {
      file: 'audit-summary.json',
      sha256: sha256(audit.sha256, 'audit_sha256'),
    },
    licenses: {
      expression: ANDROID_INTERNALS_PACK_LICENSE,
      attribution: text(licenses.attribution, 'attribution'),
      copyrightHolder: text(licenses.copyrightHolder, 'copyright_holder'),
      files: parsedLicenseFiles,
    },
    revocation: {
      revoked: revocation.revoked,
      minimumSafeVersion: contentVersion(
        revocation.minimumSafeVersion,
        'minimum_safe_version',
      ),
      ...(revocation.reasonCode === null
        ? {reasonCode: null}
        : typeof revocation.reasonCode === 'string'
          ? {reasonCode: revocation.reasonCode}
          : {}),
    },
  };
}

export function parseAndroidInternalsPackChannel(value: unknown): AndroidInternalsPackChannel {
  const root = record(value, 'channel');
  const targets = record(root.targets, 'channel_targets');
  const licenses = record(targets.licenses, 'channel_licenses');
  const parsedLicenses: Record<string, string> = {};
  for (const [name, target] of Object.entries(licenses)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid_aiw_pack_license_name');
    parsedLicenses[name] = parseAndroidInternalsPackTargetPath(
      target,
      `channel_license_${name}`,
    );
  }
  if (root.packId !== ANDROID_INTERNALS_PACK_ID) throw new Error('invalid_aiw_pack_channel_id');
  if (!Array.isArray(root.revokedVersions)) throw new Error('invalid_aiw_pack_revoked_versions');
  const sourceRevision = text(root.sourceRevision, 'channel_source_revision');
  if (!GIT_SHA_RE.test(sourceRevision)) throw new Error('invalid_aiw_pack_channel_source_revision');
  const generatedAt = text(root.generatedAt, 'channel_generated_at');
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('invalid_aiw_pack_channel_generated_at');
  return {
    schemaVersion: exactInteger(root.schemaVersion, 1, 'channel_schema_version') as 1,
    packId: ANDROID_INTERNALS_PACK_ID,
    contentVersion: contentVersion(root.contentVersion, 'channel_content_version'),
    contentFingerprint: sha256(root.contentFingerprint, 'channel_content_fingerprint'),
    sourceRevision,
    generatedAt,
    minimumSafeVersion: contentVersion(
      root.minimumSafeVersion,
      'channel_minimum_safe_version',
    ),
    revokedVersions: root.revokedVersions.map((item, index) =>
      contentVersion(item, `revoked_version_${index}`)),
    ...(root.reasonCode === null
      ? {reasonCode: null}
      : typeof root.reasonCode === 'string'
        ? {reasonCode: root.reasonCode}
        : {}),
    targets: {
      manifest: parseAndroidInternalsPackTargetPath(
        targets.manifest,
        'channel_manifest_target',
      ),
      database: parseAndroidInternalsPackTargetPath(
        targets.database,
        'channel_database_target',
      ),
      audit: parseAndroidInternalsPackTargetPath(
        targets.audit,
        'channel_audit_target',
      ),
      licenses: parsedLicenses,
    },
  };
}

export function parseAndroidInternalsPackTargetPath(
  value: unknown,
  field: string,
): string {
  const parsed = text(value, field);
  if (
    parsed.startsWith('/') ||
    parsed.includes('\\') ||
    parsed.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid_aiw_pack_${field}`);
  }
  return parsed;
}

export function readAndroidInternalsPackManifest(filePath: string): AndroidInternalsPackManifest {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseAndroidInternalsPackManifest(JSON.parse(raw) as unknown);
}

export function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function compareContentVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
