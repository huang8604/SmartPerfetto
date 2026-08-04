#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

const ROOT_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
];

const RETIRED_DOCUMENTATION_PREFIXES = [
  '.omo/evidence/',
  'docs/archive/',
  'docs/presentations/',
  'docs/reviews/',
  'docs/superpowers/',
  'research/',
];

const RETIRED_DOCUMENTATION_FILES = new Set([
  'backend/docs/state-machines.md',
  'docs/architecture/deep-dive.md',
  'docs/architecture/deep-dive-qa.md',
  'docs/product/project-description.md',
]);

const RETIRED_REFERENCE_PATTERNS = [
  ...RETIRED_DOCUMENTATION_PREFIXES,
  ...RETIRED_DOCUMENTATION_FILES,
  'docs/architecture/perfetto-ai-rfc-0025/',
];

const OPERATIONAL_DOC_PREFIXES = [
  'docs/getting-started/',
  'docs/reference/',
  'docs/operations/',
];

const OPERATIONAL_DOCS = new Set([
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/README.en.md',
  'docs/architecture/overview.md',
  'docs/architecture/overview.en.md',
  'docs/architecture/agent-runtime.md',
  'docs/architecture/agent-runtime.en.md',
  'docs/architecture/technical-architecture.md',
  'docs/architecture/technical-architecture.en.md',
  'backend/docs/DATA_CONTRACT_DESIGN.md',
  'backend/docs/DATA_CONTRACT_DESIGN.en.md',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkMarkdown(rootDir, relativeDir, files) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return;
  for (const entry of fs.readdirSync(absoluteDir, {withFileTypes: true})) {
    const relativePath = toPosix(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (RETIRED_DOCUMENTATION_PREFIXES.some(
        prefix => `${relativePath}/`.startsWith(prefix),
      )) continue;
      walkMarkdown(rootDir, relativePath, files);
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      files.push(relativePath);
    }
  }
}

export function collectMaintainedMarkdown(rootDir = DEFAULT_ROOT) {
  const files = ROOT_DOCS.filter(relativePath =>
    fs.existsSync(path.join(rootDir, relativePath)));
  walkMarkdown(rootDir, 'docs', files);
  walkMarkdown(rootDir, 'backend/docs', files);
  return [...new Set(files)].sort();
}

export function extractMarkdownLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const rawTarget = match[1].trim();
    const withoutTitle = rawTarget
      .replace(/^<|>$/g, '')
      .split(/\s+["']/)[0];
    if (
      withoutTitle.length === 0 ||
      withoutTitle.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(withoutTitle)
    ) {
      continue;
    }
    links.push({
      target: decodeURIComponent(withoutTitle.split('#')[0]),
      line: markdown.slice(0, match.index).split('\n').length,
    });
  }
  return links;
}

export function extractHtmlLinks(markdown) {
  const links = [];
  const pattern = /<(?:img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1].trim().split('#')[0];
    if (
      target.length === 0 ||
      target.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }
    links.push({
      target: decodeURIComponent(target),
      line: markdown.slice(0, match.index).split('\n').length,
    });
  }
  return links;
}

function isRetiredDocumentationPath(relativePath) {
  return (
    RETIRED_DOCUMENTATION_FILES.has(relativePath) ||
    relativePath.startsWith('docs/architecture/perfetto-ai-rfc-0025/') ||
    RETIRED_DOCUMENTATION_PREFIXES.some(prefix => relativePath.startsWith(prefix))
  );
}

export function findRetiredDocumentationPaths(paths) {
  return paths.filter(isRetiredDocumentationPath);
}

function listTrackedFiles(rootDir) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter(relativePath => fs.existsSync(path.join(rootDir, relativePath)));
}

function sourceFilesForRetiredReferenceCheck(paths) {
  const extensions = /\.(?:cjs|go|js|json|md|mdx|mjs|sh|ts|tsx|yaml|yml)$/;
  return paths.filter(relativePath =>
    extensions.test(relativePath) &&
    !relativePath.startsWith('frontend/') &&
    !relativePath.startsWith('perfetto/') &&
    !isRetiredDocumentationPath(relativePath),
  );
}

function walkFiles(rootDir, relativeDir, files) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return;
  for (const entry of fs.readdirSync(absoluteDir, {withFileTypes: true})) {
    const relativePath = toPosix(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) walkFiles(rootDir, relativePath, files);
    else files.push(relativePath);
  }
}

function operationalDocs(files) {
  return files.filter(relativePath =>
    OPERATIONAL_DOCS.has(relativePath) ||
    OPERATIONAL_DOC_PREFIXES.some(prefix => relativePath.startsWith(prefix)));
}

function resolvePackageDirectory(rootDir, cwd, explicitPrefix) {
  const requested = explicitPrefix
    ? path.resolve(rootDir, explicitPrefix)
    : path.resolve(rootDir, cwd);
  const packagePath = path.join(requested, 'package.json');
  return fs.existsSync(packagePath) ? requested : null;
}

export function extractNpmRunReferences(markdown) {
  const references = [];
  const lines = markdown.split('\n');
  let inFence = false;
  let cwd = '.';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cwd = '.';
      continue;
    }

    const cdMatch = line.match(/\bcd\s+([^\s;&`]+)(?:\s*&&|\s*$)/);
    const changedCwd = cdMatch
      ? toPosix(path.normalize(path.join(cwd, cdMatch[1])))
      : cwd;
    const lineCwd = changedCwd === '' ? '.' : changedCwd;
    if (inFence && /^\s*cd\s+([^\s;&]+)\s*$/.test(line)) {
      cwd = lineCwd;
    }

    const pattern = /\bnpm\s+(?:--prefix\s+([^\s]+)\s+)?run\s+([a-zA-Z0-9:_-]+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      references.push({
        prefix: match[1] ?? null,
        cwd: match[1] ? '.' : lineCwd,
        script: match[2],
        line: index + 1,
      });
    }
  }
  return references;
}

export function parseCliCommandNames(helpText) {
  const commandSection = helpText.split(/\nCommands:\n/)[1] ?? '';
  const names = [];
  for (const line of commandSection.split('\n')) {
    const match = line.match(/^\s{2}([a-z][a-z0-9-]*)\b/);
    if (match && match[1] !== 'help') names.push(match[1]);
  }
  return [...new Set(names)];
}

function readPackageScripts(packageDirectory) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  return new Set(Object.keys(packageJson.scripts ?? {}));
}

function runCliHelp(rootDir) {
  const result = spawnSync(
    'npm',
    ['--prefix', 'backend', 'run', 'cli:dev', '--', '--help'],
    {cwd: rootDir, encoding: 'utf8', timeout: 30_000},
  );
  if (result.status !== 0) {
    throw new Error(
      `CLI help failed with exit ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export function verifyDocumentation({
  rootDir = DEFAULT_ROOT,
  cliHelp = null,
  trackedFiles = null,
} = {}) {
  const files = collectMaintainedMarkdown(rootDir);
  const errors = [];
  const currentTrackedFiles = trackedFiles ?? listTrackedFiles(rootDir);
  const referencedAssets = new Set();

  for (const relativePath of findRetiredDocumentationPaths(currentTrackedFiles)) {
    errors.push(
      `${relativePath} is a retired documentation artifact; ` +
      'merge durable content into a core document',
    );
  }

  for (const relativePath of files) {
    const absolutePath = path.join(rootDir, relativePath);
    const markdown = fs.readFileSync(absolutePath, 'utf8');
    for (const link of [
      ...extractMarkdownLinks(markdown),
      ...extractHtmlLinks(markdown),
    ]) {
      const target = path.resolve(path.dirname(absolutePath), link.target);
      if (!fs.existsSync(target)) {
        errors.push(
          `${relativePath}:${link.line} broken local link ${link.target}`,
        );
      } else if (
        target.startsWith(path.join(rootDir, 'docs', 'images') + path.sep)
      ) {
        referencedAssets.add(target);
      }
    }
  }

  const imageFiles = [];
  walkFiles(rootDir, 'docs/images', imageFiles);
  for (const relativePath of imageFiles) {
    const absolutePath = path.resolve(rootDir, relativePath);
    if (!referencedAssets.has(absolutePath)) {
      errors.push(`${relativePath} is an orphan documentation asset`);
    }
  }

  for (const relativePath of sourceFilesForRetiredReferenceCheck(currentTrackedFiles)) {
    if (
      relativePath === 'scripts/verify-docs.mjs' ||
      relativePath === 'scripts/__tests__/verify-docs.test.mjs'
    ) continue;
    const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const retiredPath of RETIRED_REFERENCE_PATTERNS) {
      const index = content.indexOf(retiredPath);
      if (index < 0) continue;
      const line = content.slice(0, index).split('\n').length;
      errors.push(
        `${relativePath}:${line} references retired documentation path ` +
        retiredPath,
      );
    }
  }

  for (const relativePath of files.filter(file => file.endsWith('.en.md'))) {
    const counterpart = relativePath.replace(/\.en\.md$/, '.md');
    if (!files.includes(counterpart)) {
      errors.push(`${relativePath} is missing Chinese counterpart ${counterpart}`);
    }
  }

  const packageScripts = new Map();
  for (const relativePath of operationalDocs(files)) {
    const markdown = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const reference of extractNpmRunReferences(markdown)) {
      if (
        reference.cwd.includes('<') ||
        reference.prefix?.includes('<') ||
        reference.script.includes('<')
      ) {
        continue;
      }
      const packageDirectory = resolvePackageDirectory(
        rootDir,
        reference.cwd,
        reference.prefix,
      );
      if (!packageDirectory) {
        errors.push(
          `${relativePath}:${reference.line} npm script has no package.json in ` +
          `${reference.prefix ?? reference.cwd}`,
        );
        continue;
      }
      if (!packageScripts.has(packageDirectory)) {
        packageScripts.set(packageDirectory, readPackageScripts(packageDirectory));
      }
      if (!packageScripts.get(packageDirectory).has(reference.script)) {
        errors.push(
          `${relativePath}:${reference.line} unknown npm script ` +
          `${reference.script} in ${toPosix(path.relative(rootDir, packageDirectory)) || '.'}`,
        );
      }
    }
  }

  const releaseDocs = [
    'README.md',
    'README.zh-CN.md',
    'docs/reference/release.md',
    'docs/reference/release.en.md',
    'docs/reference/portable-packaging.md',
    'docs/reference/portable-packaging.en.md',
    'docs/reference/windows-exe.md',
    'docs/reference/windows-exe.en.md',
  ];
  for (const relativePath of releaseDocs) {
    const markdown = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    if (/npm\s+--prefix\s+backend\s+publish\b/.test(markdown)) {
      errors.push(
        `${relativePath} uses forbidden npm --prefix backend publish; publish from backend/`,
      );
    }
  }
  for (const relativePath of releaseDocs.filter(file => file.includes('/reference/'))) {
    const markdown = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    if (
      /npm run version:set -- \d+\.\d+\.\d+/.test(markdown) ||
      /npm run release:(?:portable|windows-exe) -- \d+\.\d+\.\d+/.test(markdown)
    ) {
      errors.push(`${relativePath} hardcodes a release example version; use <version>`);
    }
  }

  const actualCliHelp = cliHelp ?? runCliHelp(rootDir);
  const cliCommands = parseCliCommandNames(actualCliHelp);
  for (const relativePath of ['docs/reference/cli.md', 'docs/reference/cli.en.md']) {
    const markdown = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const command of cliCommands) {
      const documented = new RegExp(`(?:smp|smartperfetto)\\s+${command}\\b`).test(markdown);
      if (!documented) {
        errors.push(`${relativePath} does not document CLI command ${command}`);
      }
    }
  }

  return {
    checkedFiles: files.length,
    cliCommands,
    errors,
  };
}

function main() {
  let result;
  try {
    result = verifyDocumentation();
  } catch (error) {
    console.error(`Documentation verification failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    console.error(
      `Documentation verification failed: ${result.errors.length} error(s) ` +
      `across ${result.checkedFiles} Markdown files.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Documentation verification passed: ${result.checkedFiles} Markdown files, ` +
    `${result.cliCommands.length} live CLI commands.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
