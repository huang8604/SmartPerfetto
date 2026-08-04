// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {materializeCatalogCases} = require('../lib/builder.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeCase(repoRoot, relativeDir, manifest, traceName, trace) {
  const caseDir = path.join(repoRoot, 'Trace', relativeDir);
  fs.mkdirSync(caseDir, {recursive: true});
  fs.writeFileSync(path.join(caseDir, traceName), trace);
  fs.writeFileSync(path.join(caseDir, 'case.json'), `${JSON.stringify(manifest)}\n`);
}

function fixture(output = 'Trace/.generated/constructed/derived/trace.pftrace') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-materialize-test-'));
  const base = Buffer.from([1, 2, 3]);
  const overlay = Buffer.from([4, 5]);
  writeCase(repoRoot, 'real/base', {
    id: 'base',
    kind: 'real',
    trace: {file: 'trace.pftrace', sha256: sha256(base)},
  }, 'trace.pftrace', base);
  writeCase(repoRoot, 'constructed/derived', {
    id: 'derived',
    kind: 'constructed',
    trace: {file: 'trace.overlay.pftrace', sha256: sha256(overlay)},
    construction: {base_case_id: 'base', output},
  }, 'trace.overlay.pftrace', overlay);
  return {repoRoot, base, overlay};
}

test('materializes committed base and overlay without Perfetto proto sources', () => {
  const {repoRoot, base, overlay} = fixture();
  try {
    const result = materializeCatalogCases(repoRoot);
    assert.equal(result.length, 1);
    const output = path.join(repoRoot, 'Trace/.generated/constructed/derived/trace.pftrace');
    assert.deepEqual(fs.readFileSync(output), Buffer.concat([base, overlay]));
    assert.deepEqual(
      fs.readdirSync(path.dirname(output)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects manifest hash drift before materialization', () => {
  const {repoRoot} = fixture();
  try {
    const baseManifestPath = path.join(repoRoot, 'Trace/real/base/case.json');
    const manifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
    manifest.trace.sha256 = '0'.repeat(64);
    fs.writeFileSync(baseManifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /base trace hash mismatch/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects constructed output paths outside the case generated directory', () => {
  const {repoRoot} = fixture('Trace/.generated/constructed/other/trace.pftrace');
  try {
    assert.throws(() => materializeCatalogCases(repoRoot), /constructed output must be/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects base trace paths that escape the case directory', () => {
  const {repoRoot} = fixture();
  try {
    const manifestPath = path.join(repoRoot, 'Trace/real/base/case.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.trace.file = '../outside.pftrace';
    fs.writeFileSync(path.join(repoRoot, 'Trace/real/outside.pftrace'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /base trace path escapes/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects overlay trace paths that escape the case directory', () => {
  const {repoRoot} = fixture();
  try {
    const manifestPath = path.join(repoRoot, 'Trace/constructed/derived/case.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.trace.file = '../outside.pftrace';
    fs.writeFileSync(path.join(repoRoot, 'Trace/constructed/outside.pftrace'), Buffer.from([4, 5]));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /overlay trace path escapes/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects non-regular trace inputs', () => {
  const {repoRoot} = fixture();
  try {
    const overlayPath = path.join(repoRoot, 'Trace/constructed/derived/trace.overlay.pftrace');
    fs.rmSync(overlayPath);
    fs.mkdirSync(overlayPath);
    assert.throws(() => materializeCatalogCases(repoRoot), /overlay trace must be a regular file/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});
