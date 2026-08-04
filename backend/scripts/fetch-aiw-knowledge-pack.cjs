#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const {Updater} = require('tuf-js');

const backendRoot = path.resolve(__dirname, '..');
const assetRoot = path.join(backendRoot, 'knowledge', 'aiw-pack');
const lockPath = path.join(assetRoot, 'knowledge-packs.lock.json');
const verifyOnly = process.argv.includes('--verify-only');
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSafeTargetPath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `Missing ${label}`);
  assert(
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    `Unsafe ${label}`,
  );
}

function validateLock(lock) {
  assert(lock?.schemaVersion === 1, 'Knowledge Pack lock schema must be 1');
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(lock?.bundled?.contentVersion || ''), 'Invalid locked Pack version');
  assert(/^[0-9a-f]{64}$/.test(lock?.bundled?.contentFingerprint || ''), 'Invalid locked Pack fingerprint');
  assert(/^[0-9a-f]{64}$/.test(lock?.bundled?.manifestSha256 || ''), 'Invalid locked manifest hash');
  assert(/^[0-9a-f]{40}$/.test(lock?.bundled?.publicRevision || ''), 'Invalid locked public revision');
  const targets = lock?.bundled?.targets;
  assertSafeTargetPath(targets?.manifest, 'locked manifest target');
  assertSafeTargetPath(targets?.database, 'locked database target');
  assertSafeTargetPath(targets?.audit, 'locked audit target');
  assert(
    targets?.licenses &&
    typeof targets.licenses === 'object' &&
    !Array.isArray(targets.licenses),
    'Missing locked license targets',
  );
  for (const [name, target] of Object.entries(targets.licenses)) {
    assert(/^[A-Za-z0-9._-]+$/.test(name), `Unsafe locked license name: ${name}`);
    assertSafeTargetPath(target, `locked license target: ${name}`);
  }
}

function verifyDirectory(directory, lock) {
  const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
  assert(sha256(manifestBytes) === lock.bundled.manifestSha256, 'Bundled manifest does not match lock');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert(manifest.packId === 'android-internals', 'Unexpected Pack id');
  assert(manifest.packFormatVersion === 1, 'Unsupported Pack format');
  assert(
    /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(manifest.contentVersion || ''),
    'Invalid manifest Pack version',
  );
  assert(manifest.contentVersion === lock.bundled.contentVersion, 'Bundled version does not match lock');
  assert(manifest.contentFingerprint === lock.bundled.contentFingerprint, 'Bundled fingerprint does not match lock');
  assert(
    manifest.licenses?.expression === 'CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial',
    'Unexpected Knowledge Pack license expression',
  );
  assert(
    manifest.database?.file === 'content.sqlite.gz' &&
    manifest.database?.compression === 'gzip',
    'Unexpected database contract',
  );
  assert(manifest.audit?.file === 'audit-summary.json', 'Unexpected audit contract');
  assert(
    manifest.licenses?.files &&
    typeof manifest.licenses.files === 'object' &&
    !Array.isArray(manifest.licenses.files) &&
    Object.keys(manifest.licenses.files).length > 0,
    'Invalid license manifest',
  );
  for (const name of Object.keys(manifest.licenses.files)) {
    assert(/^[A-Za-z0-9._-]+$/.test(name), `Unsafe manifest license name: ${name}`);
  }
  const compressed = fs.readFileSync(path.join(directory, manifest.database.file));
  assert(compressed.length === manifest.database.compressedBytes, 'Compressed database length mismatch');
  assert(sha256(compressed) === manifest.database.sha256, 'Compressed database hash mismatch');
  assert(manifest.database.uncompressedBytes <= MAX_UNCOMPRESSED_BYTES, 'Database exceeds decompression limit');
  const databaseBytes = zlib.gunzipSync(compressed, {
    maxOutputLength: manifest.database.uncompressedBytes,
  });
  assert(databaseBytes.length === manifest.database.uncompressedBytes, 'Database length mismatch');
  assert(sha256(databaseBytes) === manifest.database.uncompressedSha256, 'Database hash mismatch');
  const temporaryDatabase = path.join(os.tmpdir(), `smartperfetto-aiw-verify-${process.pid}-${crypto.randomUUID()}.sqlite`);
  fs.writeFileSync(temporaryDatabase, databaseBytes, {flag: 'wx'});
  try {
    const db = new Database(temporaryDatabase, {readonly: true, fileMustExist: true});
    try {
      assert(db.pragma('quick_check', {simple: true}) === 'ok', 'Knowledge Pack SQLite quick_check failed');
      assert(db.pragma('user_version', {simple: true}) === 1, 'Unsupported Knowledge Pack SQLite schema');
      const identity = Object.fromEntries(
        db.prepare('SELECT key, value FROM pack_manifest').all()
          .map(row => [row.key, JSON.parse(row.value)]),
      );
      assert(identity.contentVersion === manifest.contentVersion, 'SQLite version mismatch');
      assert(identity.contentFingerprint === manifest.contentFingerprint, 'SQLite fingerprint mismatch');
      assert(identity.sourceRevision === manifest.sourceRevision, 'SQLite source revision mismatch');
      assert(db.prepare('SELECT count(*) AS count FROM chunks').get().count === manifest.chunkCount, 'SQLite chunk count mismatch');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temporaryDatabase, {force: true});
  }
  const audit = fs.readFileSync(path.join(directory, manifest.audit.file));
  assert(sha256(audit) === manifest.audit.sha256, 'Audit hash mismatch');
  for (const [name, expectedHash] of Object.entries(manifest.licenses.files)) {
    const license = fs.readFileSync(path.join(directory, 'licenses', name));
    assert(sha256(license) === expectedHash, `License hash mismatch: ${name}`);
  }
  return manifest;
}

async function download(updater, target, destination) {
  const info = await updater.getTargetInfo(target);
  assert(info, `TUF target not found: ${target}`);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  await updater.downloadTarget(info, destination);
}

async function fetchLockedPack(lock, destination) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-aiw-fetch-'));
  try {
    const metadataDir = path.join(temporary, 'metadata');
    const targetDir = path.join(temporary, 'targets');
    const packDir = path.join(temporary, 'pack');
    fs.mkdirSync(metadataDir, {recursive: true});
    fs.mkdirSync(targetDir, {recursive: true});
    fs.mkdirSync(packDir, {recursive: true});
    fs.copyFileSync(path.join(assetRoot, '1.root.json'), path.join(metadataDir, 'root.json'));
    const revision = lock.bundled.publicRevision;
    const base = `https://raw.githubusercontent.com/Gracker/android-internals-knowledge-pack/${revision}`;
    const updater = new Updater({
      metadataDir,
      targetDir,
      metadataBaseUrl: `${base}/metadata/`,
      targetBaseUrl: `${base}/targets/`,
      config: {
        fetchTimeout: 30_000,
        fetchRetries: 2,
        userAgent: 'SmartPerfetto Knowledge-Pack bundler',
      },
    });
    await updater.refresh();
    await download(updater, lock.bundled.targets.manifest, path.join(packDir, 'manifest.json'));
    await download(updater, lock.bundled.targets.database, path.join(packDir, 'content.sqlite.gz'));
    await download(updater, lock.bundled.targets.audit, path.join(packDir, 'audit-summary.json'));
    for (const [name, target] of Object.entries(lock.bundled.targets.licenses)) {
      await download(updater, target, path.join(packDir, 'licenses', name));
    }
    verifyDirectory(packDir, lock);
    if (fs.existsSync(destination)) {
      throw new Error(`Refusing to overwrite invalid immutable bundled Pack: ${destination}`);
    }
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.renameSync(packDir, destination);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

async function main() {
  const lock = readJson(lockPath);
  validateLock(lock);
  const destination = path.join(assetRoot, 'bundled', lock.bundled.contentVersion);
  try {
    const manifest = verifyDirectory(destination, lock);
    console.log(
      `Knowledge Pack verified: ${manifest.contentVersion} ` +
      `${manifest.contentFingerprint} (${manifest.chunkCount} chunks)`,
    );
    return;
  } catch (error) {
    if (verifyOnly) throw error;
    if (fs.existsSync(destination)) throw error;
  }
  await fetchLockedPack(lock, destination);
  const manifest = verifyDirectory(destination, lock);
  console.log(
    `Knowledge Pack fetched and verified: ${manifest.contentVersion} ` +
    `${manifest.contentFingerprint} (${manifest.chunkCount} chunks)`,
  );
}

main().catch(error => {
  console.error(`Knowledge Pack fetch failed: ${error.message || error}`);
  process.exit(1);
});
