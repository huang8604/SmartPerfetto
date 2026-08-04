// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {resolveCaseTrace} = require("../../Trace/tools/lib/catalog.cjs");

const ROOT_DIR = path.resolve(__dirname, "../..");
const PATHS = Object.freeze({
  root: ROOT_DIR,
  backend: path.join(ROOT_DIR, "backend"),
  frontend: path.join(ROOT_DIR, "frontend"),
  ui: path.join(ROOT_DIR, "perfetto", "ui"),
  playwrightConfig: path.join(
    ROOT_DIR,
    "perfetto",
    "ui",
    "playwright.smartperfetto.config.ts",
  ),
});

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath))
    throw new Error(`${label} is missing: ${filePath}`);
}

function resolveTooling() {
  requireFile(
    path.join(PATHS.frontend, "server.js"),
    "Committed frontend server",
  );
  requireFile(PATHS.playwrightConfig, "SmartPerfetto Playwright config");
  requireFile(resolveCaseTrace(ROOT_DIR, "launch_light.pftrace"), "Light launch Trace fixture");
  requireFile(resolveCaseTrace(ROOT_DIR, "lacunh_heavy.pftrace"), "Heavy launch Trace fixture");
  return {
    playwrightCli: require.resolve("@playwright/test/cli", {
      paths: [PATHS.ui],
    }),
    tsxCli: require.resolve("tsx/cli", { paths: [PATHS.backend] }),
  };
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function secureEvidenceTree(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) return;
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      fs.chmodSync(current, 0o600);
      continue;
    }
    fs.chmodSync(current, 0o700);
    for (const entry of fs.readdirSync(current)) {
      pending.push(path.join(current, entry));
    }
  }
}

function prepareRunWorkspace() {
  const runId = makeRunId();
  const artifactDir = path.join(ROOT_DIR, "output", "playwright", runId);
  const temporaryDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "smartperfetto-dual-trace-e2e-"),
  );
  const workspace = {
    runId,
    artifactDir,
    temporaryDir,
    providerDir: path.join(temporaryDir, "providers"),
    backendDataDir: path.join(temporaryDir, "backend-data"),
    backendLogDir: path.join(temporaryDir, "backend-logs"),
    uploadDir: path.join(temporaryDir, "uploads"),
    traceUploadDir: path.join(temporaryDir, "uploads", "traces"),
    fixtureDir: path.join(temporaryDir, "fixtures"),
    enterpriseDataDir: path.join(temporaryDir, "enterprise"),
    sceneReportDir: path.join(temporaryDir, "scene-reports"),
    sceneJobArtifactDir: path.join(temporaryDir, "scene-job-artifacts"),
    enterpriseDbPath: path.join(temporaryDir, "enterprise.sqlite"),
    envFile: path.join(temporaryDir, "e2e.env"),
  };
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDir, 0o700);
  for (const directory of [
    workspace.providerDir,
    workspace.backendDataDir,
    workspace.backendLogDir,
    workspace.traceUploadDir,
    workspace.fixtureDir,
    workspace.enterpriseDataDir,
    workspace.sceneReportDir,
    workspace.sceneJobArtifactDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  for (const selector of ["launch_light.pftrace", "lacunh_heavy.pftrace"]) {
    fs.copyFileSync(resolveCaseTrace(ROOT_DIR, selector), path.join(workspace.fixtureDir, selector));
  }
  return workspace;
}

module.exports = {
  PATHS,
  prepareRunWorkspace,
  resolveTooling,
  secureEvidenceTree,
  writeJson,
};
