import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadCatalog } from '../sync-rendering-pipelines.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceDir = join(root, 'docs/rendering_pipelines');
const runtimeDir = join(root, 'backend/dist/rendering_pipelines');

test('runtime asset copier carries the exact checked Android 17 article set', () => {
  const catalog = loadCatalog();
  rmSync(runtimeDir, { recursive: true, force: true });
  execFileSync('node', ['backend/scripts/copy-runtime-assets.cjs'], { cwd: root });

  assert.deepEqual(
    readdirSync(runtimeDir).sort(),
    catalog.documents.map((document) => document.file),
  );
  for (const document of catalog.documents) {
    assert.deepEqual(
      readFileSync(join(runtimeDir, document.file)),
      readFileSync(join(sourceDir, document.file)),
      document.file,
    );
  }
});

test('Docker and portable packages consume the built backend runtime tree', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const portableScript = readFileSync(join(root, 'scripts/package-portable.sh'), 'utf8');
  assert.match(
    dockerfile,
    /COPY docs\/rendering_pipelines \/app\/docs\/rendering_pipelines/,
  );
  assert.match(
    dockerfile,
    /COPY --from=backend-builder \/app\/backend\/dist \.\/backend\/dist/,
  );
  assert.match(
    portableScript,
    /copy_dir "\$PROJECT_ROOT\/backend\/dist" "\$resources_dir\/backend\/dist"/,
  );
});

test('the PR gate checks source sync, node regressions, and generated detector drift', () => {
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const verifyCommand = rootPackage.scripts['verify:rendering-pipelines'];

  assert.match(rootPackage.scripts['verify:pr'], /verify:rendering-pipelines/);
  assert.match(verifyCommand, /check:rendering-pipelines/);
  assert.match(verifyCommand, /node --test scripts\/__tests__\/sync-rendering-pipelines\.test\.mjs/);
  assert.match(verifyCommand, /generate:pipeline-detection -- --check/);
});
