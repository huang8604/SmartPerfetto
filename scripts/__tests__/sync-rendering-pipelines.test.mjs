import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applySyncPlan,
  buildSyncPlan,
  checkSynchronizedState,
  findStaleRenderingReferences,
  validatePublicExport,
  validateRenderingFixtureQueries,
  validateSource,
} from '../sync-rendering-pipelines.mjs';

const ARTICLE_FILES = Array.from(
  { length: 14 },
  (_, index) => `S${String(index + 1).padStart(2, '0')}_article_${index + 1}.md`,
);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rendering-pipelines-sync-'));
  const sourceDir = join(root, 'source');
  const docsDir = join(root, 'docs');
  const pipelinesDir = join(root, 'pipelines');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(pipelinesDir, { recursive: true });

  const documents = ARTICLE_FILES.map((file, index) => {
    const content = `# Article ${index + 1}\n\nBody ${index + 1}.\n`;
    writeFileSync(join(sourceDir, file), content);
    return { file, sha256: sha256(content) };
  });

  writeFileSync(join(docsDir, 'legacy.md'), '# Legacy\n');
  writeFileSync(
    join(pipelinesDir, 'standard.skill.yaml'),
    [
      'name: pipeline_standard',
      'meta:',
      '  pipeline_id: STANDARD',
      '  doc_path: rendering_pipelines/legacy.md',
      'teaching:',
      '  title: Legacy prose',
      '  summary: Must be removed',
      'auto_pin:',
      '  instructions: []',
      '',
    ].join('\n'),
  );

  const catalog = {
    source: {
      repository: 'https://github.com/Gracker/rendering_pipelines',
      commit: 'a'.repeat(40),
    },
    documents,
    rendering_types: {
      S02_STANDARD: { kind: 'concrete', document: ARTICLE_FILES[1] },
    },
    default: {
      pipeline_id: 'STANDARD',
      rendering_type_id: 'S02_STANDARD',
    },
    pipelines: {
      STANDARD: {
        file: 'standard.skill.yaml',
        classification_role: 'variant',
        teaching_type_id: 'S02_STANDARD',
        rendering_type_id: 'S02_STANDARD',
        architecture_type: 'STANDARD',
        signal_scope: 'app',
        primary_eligible: true,
        feature_visible: false,
      },
    },
  };

  return { root, sourceDir, docsDir, pipelinesDir, catalog };
}

test('requires exactly the pinned S01-S14 article inventory and hashes', () => {
  const fixture = createFixture();
  try {
    assert.doesNotThrow(() => validateSource(fixture.sourceDir, fixture.catalog));
    writeFileSync(join(fixture.sourceDir, 'unexpected.md'), '# Extra\n');
    assert.throws(
      () => validateSource(fixture.sourceDir, fixture.catalog),
      /unexpected\.md/,
    );
    rmSync(join(fixture.sourceDir, 'unexpected.md'));
    writeFileSync(join(fixture.sourceDir, ARTICLE_FILES[0]), '# Drift\n');
    assert.throws(
      () => validateSource(fixture.sourceDir, fixture.catalog),
      /sha256/i,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('apply replaces legacy docs and reduces YAML teaching to the catalog reference', () => {
  const fixture = createFixture();
  try {
    const plan = buildSyncPlan({
      sourceDir: fixture.sourceDir,
      docsDir: fixture.docsDir,
      pipelinesDir: fixture.pipelinesDir,
      catalog: fixture.catalog,
    });
    applySyncPlan(plan);

    assert.deepEqual(readdirSync(fixture.docsDir).sort(), ARTICLE_FILES);
    const pipeline = readFileSync(
      join(fixture.pipelinesDir, 'standard.skill.yaml'),
      'utf8',
    );
    assert.match(
      pipeline,
      new RegExp(`doc_path: rendering_pipelines/${ARTICLE_FILES[1]}`),
    );
    assert.match(
      pipeline,
      new RegExp(`teaching:\\n  source: "rendering_pipelines/${ARTICLE_FILES[1]}"`),
    );
    assert.doesNotMatch(pipeline, /Legacy prose|Must be removed/);
    assert.deepEqual(
      checkSynchronizedState({
        sourceDir: fixture.sourceDir,
        docsDir: fixture.docsDir,
        pipelinesDir: fixture.pipelinesDir,
        catalog: fixture.catalog,
      }),
      [],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('check mode reports concrete document and YAML drift without writing', () => {
  const fixture = createFixture();
  try {
    const failures = checkSynchronizedState({
      sourceDir: fixture.sourceDir,
      docsDir: fixture.docsDir,
      pipelinesDir: fixture.pipelinesDir,
      catalog: fixture.catalog,
    });
    assert.ok(failures.some((failure) => failure.includes('legacy.md')));
    assert.ok(failures.some((failure) => failure.includes('standard.skill.yaml')));
    assert.equal(readFileSync(join(fixture.docsDir, 'legacy.md'), 'utf8'), '# Legacy\n');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('active reference policy rejects legacy docs and superseded taxonomy claims', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(
      findStaleRenderingReferences({
        catalog: fixture.catalog,
        files: new Map([
          ['current.md', `See rendering_pipelines/${ARTICLE_FILES[1]}.`],
        ]),
      }),
      [],
    );
    const failures = findStaleRenderingReferences({
      catalog: fixture.catalog,
      files: new Map([
        ['legacy.md', 'See rendering_pipelines/android_view_standard.md.'],
        ['roadmap.yaml', 'Phase E will split a new pipeline ID.'],
        ['semantics.md', 'present fence 影响可见上屏。'],
      ]),
    });
    assert.ok(failures.some((failure) => failure.includes('android_view_standard.md')));
    assert.ok(failures.some((failure) => failure.includes('Phase E')));
    assert.ok(failures.some((failure) => failure.includes('present fence')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('public export must contain exactly the pinned catalog documents', () => {
  const fixture = createFixture();
  try {
    const pipelineDocs = Object.fromEntries(
      ARTICLE_FILES.map((file) => [
        `docs/rendering_pipelines/${file}`,
        {
          disposition: 'exported',
          destination: `references/generated/pipelines/docs/${file}`,
        },
      ]),
    );
    assert.doesNotThrow(() => validatePublicExport({ pipeline_docs: pipelineDocs }, fixture.catalog));
    delete pipelineDocs[`docs/rendering_pipelines/${ARTICLE_FILES[0]}`];
    pipelineDocs['docs/rendering_pipelines/legacy.md'] = {
      disposition: 'exported',
      destination: 'references/generated/pipelines/docs/legacy.md',
    };
    assert.throws(
      () => validatePublicExport({ pipeline_docs: pipelineDocs }, fixture.catalog),
      /missing=.*S01.*unexpected=.*legacy/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('public rendering fixture assertions reference detector steps that still exist', () => {
  const detector = {
    name: 'rendering_pipeline_detection',
    steps: [
      { id: 'active_rendering_processes' },
      { id: 'bufferqueue_path_signals' },
    ],
  };
  const fixtures = {
    fixtures: [{
      assertions: [{
        query_id: 'rendering_pipeline_detection/active_rendering_processes',
      }],
    }],
  };

  assert.doesNotThrow(() => validateRenderingFixtureQueries(fixtures, detector));
  fixtures.fixtures[0].assertions[0].query_id =
    'rendering_pipeline_detection/thread_signals';
  assert.throws(
    () => validateRenderingFixtureQueries(fixtures, detector),
    /thread_signals.*unknown detector step/,
  );
});
