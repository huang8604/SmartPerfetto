#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {resolveCaseTrace} = require('../../Trace/tools/lib/catalog.cjs');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const mode = parseMode(process.argv.slice(2));
const keepArtifacts = process.env.SMARTPERFETTO_CODEBASE_E2E_KEEP === '1';
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-codebase-e2e-'));

main()
  .then(() => {
    if (!keepArtifacts) fs.rmSync(workRoot, {recursive: true, force: true});
  })
  .catch((err) => {
    console.error(`\nCodebase-aware E2E failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    console.error(`Artifacts kept at: ${workRoot}`);
    process.exit(1);
  });

async function main() {
  const heavyTrace = resolveHeavyTrace();
  const lightTrace = resolveLightTrace();
  const appRoot = resolveHighPerformanceRoot();
  const synthetic = createSyntheticCodebases();
  const traceProcessorPath = resolveTraceProcessorPath();
  assertFile(heavyTrace, 'Heavy trace');
  assertFile(lightTrace, 'Light trace');
  assertDir(appRoot, 'HighPerformance app repo');
  assertFile(traceProcessorPath, 'trace_processor_shell');

  const cli = resolveCli(mode);
  const sessionHome = path.join(workRoot, 'home');
  const logsDir = path.join(workRoot, 'logs');
  const dataDir = path.join(workRoot, 'data');
  const outputDir = path.join(workRoot, 'output');
  const envFile = path.join(workRoot, 'codebase-e2e.env');
  fs.mkdirSync(outputDir, {recursive: true});

  const baseEnv = {
    ...process.env,
    HOME: path.join(workRoot, 'user-home'),
    SMARTPERFETTO_HOME: sessionHome,
    SMARTPERFETTO_BACKEND_LOG_DIR: logsDir,
    SMARTPERFETTO_BACKEND_DATA_DIR: dataDir,
    SMARTPERFETTO_AGENT_RUNTIME: 'openai-agents-sdk',
    SMARTPERFETTO_CLI_E2E_FAKE: '1',
    SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE: 'Codebase-aware E2E fake conclusion: HighPerformance Heavy/Light analysis completed.',
    SMARTPERFETTO_CODE_AWARE: 'on',
    OPENAI_API_KEY: 'codebase-e2e-openai-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
    OPENAI_MODEL: 'codebase-e2e-model',
    TRACE_PROCESSOR_PATH: traceProcessorPath,
    NODE_ENV: 'test',
    NO_COLOR: '1',
  };
  writeEnvFile(envFile, {
    NODE_ENV: baseEnv.NODE_ENV,
    SMARTPERFETTO_HOME: baseEnv.SMARTPERFETTO_HOME,
    SMARTPERFETTO_BACKEND_LOG_DIR: baseEnv.SMARTPERFETTO_BACKEND_LOG_DIR,
    SMARTPERFETTO_BACKEND_DATA_DIR: baseEnv.SMARTPERFETTO_BACKEND_DATA_DIR,
    SMARTPERFETTO_AGENT_RUNTIME: baseEnv.SMARTPERFETTO_AGENT_RUNTIME,
    SMARTPERFETTO_CLI_E2E_FAKE: baseEnv.SMARTPERFETTO_CLI_E2E_FAKE,
    SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE: baseEnv.SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE,
    SMARTPERFETTO_CODE_AWARE: baseEnv.SMARTPERFETTO_CODE_AWARE,
    OPENAI_API_KEY: baseEnv.OPENAI_API_KEY,
    OPENAI_BASE_URL: baseEnv.OPENAI_BASE_URL,
    OPENAI_MODEL: baseEnv.OPENAI_MODEL,
    TRACE_PROCESSOR_PATH: baseEnv.TRACE_PROCESSOR_PATH,
  });

  const runCli = (name, args, options = {}) => runProcess(name, cli.command, [
    ...cli.prefixArgs,
    '--env-file',
    envFile,
    '--session-dir',
    sessionHome,
    ...args,
  ], {
    cwd: repoRoot,
    env: baseEnv,
    timeoutMs: options.timeoutMs ?? 180000,
    expectExit: options.expectExit ?? 0,
  });

  console.log(`[codebase-e2e] mode=${mode}`);
  console.log(`[codebase-e2e] app=${appRoot}`);
  console.log(`[codebase-e2e] heavy=${heavyTrace}`);
  console.log(`[codebase-e2e] light=${lightTrace}`);

  const noCodebaseRun = parseJson(runCli(
    'light run without configured codebase',
    [
      'run',
      '--format',
      'json',
      '--code-aware',
      'metadata_only',
      lightTrace,
      '分析 Light 启动表现；当前 session 未配置 codebase，应该正常降级为 trace-only 分析',
    ],
    {timeoutMs: 240000},
  ).stdout);
  assert.equal(noCodebaseRun.ok, true);
  assertFile(noCodebaseRun.reportPath, 'no-codebase report');
  assertFileNotContains(noCodebaseRun.reportPath, 'CodeRef', 'no-codebase report');
  assertFileNotContains(noCodebaseRun.reportPath, '代码引用与 Patch|Code References and Patches', 'no-codebase report');

  const preview = parseJson(runCli('codebase preview', ['codebase', 'preview', appRoot]).stdout);
  assert.equal(preview.blocked, false);
  assert(preview.acceptedFileCount > 0, 'preview should accept source files');

  const register = runCli('codebase register', [
    'codebase',
    'register',
    appRoot,
    '--name',
    'HighPerformanceFriendsCircle',
    '--path-filter',
    'launch-aosp/',
    '--path-filter',
    'launch-common/',
    '--path-filter',
    'load-config/',
  ]).stdout.trim();
  const codebaseId = register.split(/\s+/)[0];
  assert.match(codebaseId, /^cb_/);

  const reindex = parseJson(runCli('codebase reindex', ['codebase', 'reindex', codebaseId]).stdout);
  assert.equal(reindex.codebaseId, codebaseId);
  assert(reindex.filesProcessed > 0, 'reindex should process source files');
  assert(reindex.chunksAdded > 0, 'reindex should add chunks');

  const symbols = parseJson(runCli('codebase symbols', ['codebase', 'symbols', 'MainActivity', '--codebase-id', codebaseId]).stdout);
  assert.equal(symbols.success, true);
  assert(symbols.candidates.some((candidate) => /MainActivity\.kt$/.test(candidate.filePath || '')));

  const kernelDryRun = parseJson(runCli('kernel register dry-run', [
    'codebase',
    'register',
    synthetic.kernelRoot,
    '--kind',
    'kernel_source',
    '--name',
    'Synthetic Kernel',
    '--vendor',
    'mtk',
    '--license',
    'GPL-2.0-only',
    '--path-filter',
    'drivers/android/',
    '--dry-run',
  ]).stdout);
  assert.equal(kernelDryRun.kind, 'kernel_source');
  assert.equal(kernelDryRun.displayName, 'Synthetic Kernel');
  assert(kernelDryRun.acceptedFileCount > 0, 'kernel dry-run should see source files');

  const kernelRegister = runCli('kernel register', [
    'codebase',
    'register',
    synthetic.kernelRoot,
    '--kind',
    'kernel_source',
    '--name',
    'Synthetic Kernel',
    '--vendor',
    'mtk',
    '--license',
    'GPL-2.0-only',
    '--path-filter',
    'drivers/android/',
  ]).stdout.trim();
  const kernelCodebaseId = kernelRegister.split(/\s+/)[0];
  assert.match(kernelCodebaseId, /^cb_/);
  const kernelReindex = parseJson(runCli('kernel reindex', ['codebase', 'reindex', kernelCodebaseId]).stdout);
  assert.equal(kernelReindex.codebaseId, kernelCodebaseId);
  assert(kernelReindex.chunksAdded > 0, 'kernel reindex should add chunks');
  const kernelSymbol = parseJson(runCli('kernel symbols', [
    'codebase',
    'symbols',
    'binder_wait_for_work',
    '--codebase-id',
    kernelCodebaseId,
  ]).stdout);
  assert.equal(kernelSymbol.success, true);
  assert(kernelSymbol.candidates.some((candidate) => /drivers\/android\/binder\.c$/.test(candidate.filePath || '')));

  const aospRegister = runCli('aosp register', [
    'codebase',
    'register',
    synthetic.aospRoot,
    '--kind',
    'aosp',
    '--name',
    'Synthetic AOSP',
    '--license',
    'Apache-2.0',
    '--build-id',
    'aosp-build-e2e',
    '--commit',
    'abc1234',
    '--path-filter',
    'frameworks/native/',
  ]).stdout.trim();
  const aospCodebaseId = aospRegister.split(/\s+/)[0];
  assert.match(aospCodebaseId, /^cb_/);
  const aospReindex = parseJson(runCli('aosp reindex', ['codebase', 'reindex', aospCodebaseId]).stdout);
  assert.equal(aospReindex.codebaseId, aospCodebaseId);
  assert(aospReindex.chunksAdded > 0, 'aosp reindex should add chunks');
  const aospSymbol = parseJson(runCli('aosp symbols', [
    'codebase',
    'symbols',
    'DrawFrameTask::run',
    '--codebase-id',
    aospCodebaseId,
  ]).stdout);
  assert.equal(aospSymbol.success, true);
  assert(aospSymbol.candidates.some((candidate) => /DrawFrameTask\.cpp$/.test(candidate.filePath || '')));

  for (const trace of [heavyTrace, lightTrace]) {
    const query = parseJson(runCli(
      `query ${path.basename(trace)}`,
      ['query', '--format', 'json', trace, '--sql', 'select count(*) as slice_count from slice'],
      {timeoutMs: 240000},
    ).stdout);
    assert.equal(query.ok, true);
    assert(query.result.rows[0][0] > 1000, `${trace} should contain slice rows`);
  }

  const heavyRun = parseJson(runCli(
    'heavy code-aware run',
    [
      'run',
      '--format',
      'json',
      '--code-aware',
      'metadata_only',
      '--codebase-id',
      codebaseId,
      heavyTrace,
      '分析 Heavy 启动慢，并结合 HighPerformanceFriendsCircle 源码定位 MainActivity/LoadSimulator 相关原因',
    ],
    {timeoutMs: 240000},
  ).stdout);
  assert.equal(heavyRun.ok, true);
  assert.match(heavyRun.sessionId, /^agent-/);
  assert.match(heavyRun.conclusion, /CodeRef/);
  assert.match(heavyRun.conclusion, /MainActivity\.kt:22-27/);
  assert.match(heavyRun.conclusion, /LoadSimulator\.kt/);
  assertFile(heavyRun.reportPath, 'heavy report');
  assertFile(heavyRun.turnReportPath, 'heavy turn report');
  assertFileContains(heavyRun.reportPath, '代码引用与 Patch|Code References and Patches', 'heavy report');
  assertFileContains(heavyRun.reportPath, 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt:22-27', 'heavy report');
  assertFileContains(heavyRun.reportPath, 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt', 'heavy report');
  assertFileNotContains(heavyRun.reportPath, appRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'heavy report');
  assertFileNotContains(heavyRun.reportPath, 'class LoadSimulator', 'heavy report');

  const lightRun = parseJson(runCli(
    'light code-aware run',
    [
      'run',
      '--format',
      'json',
      '--code-aware',
      'metadata_only',
      '--codebase-id',
      codebaseId,
      lightTrace,
      '分析 Light 启动表现，并检查 HighPerformanceFriendsCircle 源码中的轻量配置路径',
    ],
    {timeoutMs: 240000},
  ).stdout);
  assert.equal(lightRun.ok, true);
  assert.match(lightRun.conclusion, /CodeRef/);
  assert.match(lightRun.conclusion, /LaunchConfig|LoadConfig/);
  assertFile(lightRun.reportPath, 'light report');
  assertFileContains(lightRun.reportPath, '代码引用与 Patch|Code References and Patches', 'light report');

  const reportJsonPath = path.join(outputDir, 'heavy-report.json');
  runCli('heavy report export json', ['report', 'export', heavyRun.sessionId, '--format', 'json', '--out', reportJsonPath]);
  const reportJson = parseJson(fs.readFileSync(reportJsonPath, 'utf-8'));
  assert.equal(reportJson.ok, true);
  assert.match(reportJson.conclusion, /Codebase-aware E2E fake conclusion/);
  assert.match(reportJson.conclusion, /CodeRef/);
  assert.match(JSON.stringify(reportJson.config), new RegExp(codebaseId));

  const reportMdPath = path.join(outputDir, 'heavy-report.md');
  runCli('heavy report export md', ['report', 'export', heavyRun.sessionId, '--format', 'md', '--out', reportMdPath]);
  assertFileContains(reportMdPath, 'SmartPerfetto CLI Report', 'markdown report');
  assertFileContains(reportMdPath, 'CodeRef', 'markdown report');

  const reportHtmlPath = path.join(outputDir, 'heavy-report.html');
  runCli('heavy report export html', ['report', 'export', heavyRun.sessionId, '--format', 'html', '--out', reportHtmlPath]);
  assertFileContains(reportHtmlPath, '代码引用与 Patch|Code References and Patches', 'html report');
  assertFileContains(reportHtmlPath, 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt', 'html report');
  assertFileNotContains(reportHtmlPath, appRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'html report');
  assertFileNotContains(reportHtmlPath, 'class LoadSimulator', 'html report');

  const registryPath = path.join(logsDir, 'codebase_registry.json');
  const ragPath = path.join(logsDir, 'rag_store.json');
  assertFile(registryPath, 'codebase registry');
  assertFile(ragPath, 'rag store');
  const rag = parseJson(fs.readFileSync(ragPath, 'utf-8'));
  assert(rag.chunks.some((chunk) => chunk.kind === 'app_source' && chunk.codebaseId === codebaseId));
  assert(rag.chunks.some((chunk) => chunk.kind === 'kernel_source' && chunk.codebaseId === kernelCodebaseId));
  assert(rag.chunks.some((chunk) => chunk.kind === 'aosp' && chunk.codebaseId === aospCodebaseId));

  console.log('[codebase-e2e] passed');
}

function createSyntheticCodebases() {
  const syntheticRoot = path.join(workRoot, 'synthetic-codebases');
  const kernelRoot = path.join(syntheticRoot, 'kernel-mtk');
  const aospRoot = path.join(syntheticRoot, 'aosp');
  writeFile(path.join(kernelRoot, 'drivers/android/binder.c'), [
    '// SPDX-License-Identifier: GPL-2.0-only',
    '',
    'int binder_wait_for_work(int pending_work) {',
    '  if (pending_work > 0) {',
    '    return 0;',
    '  }',
    '  return -1;',
    '}',
    '',
  ].join('\n'));
  writeFile(path.join(aospRoot, 'frameworks/native/services/surfaceflinger/DrawFrameTask.cpp'), [
    '// SPDX-License-Identifier: Apache-2.0',
    '',
    'namespace android {',
    'void DrawFrameTask::run() {',
    '  int frameDeadlineMissed = 0;',
    '  (void)frameDeadlineMissed;',
    '}',
    '}',
    '',
  ].join('\n'));
  return {kernelRoot, aospRoot};
}

function parseMode(args) {
  const index = args.indexOf('--mode');
  if (index < 0) return 'source';
  const value = args[index + 1];
  if (value === 'source' || value === 'dist') return value;
  throw new Error(`Invalid --mode ${value}; expected source or dist`);
}

function resolveCli(selectedMode) {
  if (selectedMode === 'dist') {
    const bin = path.join(backendRoot, 'dist/cli-user/bin.js');
    assertFile(bin, 'dist CLI');
    return {command: process.execPath, prefixArgs: [bin]};
  }
  return {command: process.execPath, prefixArgs: [path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs'), path.join(backendRoot, 'src/cli-user/bin.ts')]};
}

function resolveHeavyTrace() {
  return process.env.SMARTPERFETTO_E2E_HEAVY_TRACE ||
    resolveCaseTrace(repoRoot, 'lacunh_heavy.pftrace');
}

function resolveLightTrace() {
  return process.env.SMARTPERFETTO_E2E_LIGHT_TRACE ||
    resolveCaseTrace(repoRoot, 'launch_light.pftrace');
}

function resolveHighPerformanceRoot() {
  if (process.env.SMARTPERFETTO_E2E_APP_REPO) return process.env.SMARTPERFETTO_E2E_APP_REPO;
  const candidates = [
    '/Users/chris/Code/HighPerformanceFriendsCircle',
    path.join(os.homedir(), 'Code', 'HighPerformanceFriendsCircle'),
    path.join(os.homedir(), 'SynologyDrive', 'HighPerformanceFriendsCircle'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  if (found) return found;
  throw new Error('HighPerformance app repo not found. Set SMARTPERFETTO_E2E_APP_REPO.');
}

function resolveTraceProcessorPath() {
  const candidates = [
    process.env.TRACE_PROCESSOR_PATH,
    process.env.SMARTPERFETTO_TRACE_PROCESSOR_PATH,
    path.join(repoRoot, 'prebuilts', 'trace_processor_shell'),
    path.join(repoRoot, 'backend', 'prebuilts', 'trace_processor_shell'),
    path.join(repoRoot, 'backend', 'prebuilts', 'trace_processor', 'darwin-arm64', 'trace_processor_shell'),
    path.join(repoRoot, 'backend', 'prebuilts', 'trace_processor', 'linux-x64', 'trace_processor_shell'),
    path.join(repoRoot, 'perfetto', 'out', 'linux', 'trace_processor_shell'),
    path.join(repoRoot, 'perfetto', 'out', 'mac', 'trace_processor_shell'),
    path.join(repoRoot, 'perfetto', 'out', 'ui', 'trace_processor_shell'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('trace_processor_shell not found. Run npm run trace-processor:ensure or set TRACE_PROCESSOR_PATH.');
  return found;
}

function runProcess(name, command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== options.expectExit) {
    throw new Error(`${name} exited ${result.status}, expected ${options.expectExit}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}\n${text}`);
  }
}

function writeEnvFile(file, entries) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, Object.entries(entries)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, '\\n')}`)
    .join('\n') + '\n');
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
}

function assertFile(file, label) {
  assert(fs.existsSync(file) && fs.statSync(file).isFile(), `${label} missing: ${file}`);
}

function assertDir(dir, label) {
  assert(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `${label} missing: ${dir}`);
}

function assertFileContains(file, pattern, label) {
  assertFile(file, label);
  assert.match(fs.readFileSync(file, 'utf-8'), new RegExp(pattern));
}

function assertFileNotContains(file, pattern, label) {
  assertFile(file, label);
  assert.doesNotMatch(fs.readFileSync(file, 'utf-8'), new RegExp(pattern));
}
