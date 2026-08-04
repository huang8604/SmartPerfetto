// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {parseArgs} from 'util';

import {
  inspectAndroidInternalsWikiIdentity,
  scanAndroidInternalsWiki,
} from '../services/androidInternalsWiki/androidInternalsWikiCorpus';
import {
  auditAndroidInternalsWiki,
  loadAuditableSkills,
  loadValidatedAssertionRefs,
  loadWikiCapabilityMap,
  type AndroidInternalsWikiAuditReport,
} from '../services/androidInternalsWiki/androidInternalsWikiAudit';

export interface AndroidInternalsWikiAuditOptions {
  repoPath: string;
  capabilityMapPath: string;
  skillsPath: string;
  fixtureManifestPath: string;
  outputPath?: string;
}

export interface AndroidInternalsWikiAuditRun {
  repository: {
    revision: string;
    contentFingerprint: string;
    dirtyAcceptedArticlePaths: string[];
  };
  report: AndroidInternalsWikiAuditReport;
}

export function runAndroidInternalsWikiAudit(
  options: AndroidInternalsWikiAuditOptions,
): AndroidInternalsWikiAuditRun {
  const corpus = scanAndroidInternalsWiki(options.repoPath);
  const report = auditAndroidInternalsWiki(
    corpus,
    loadWikiCapabilityMap(options.capabilityMapPath),
    loadAuditableSkills(options.skillsPath),
    loadValidatedAssertionRefs(options.fixtureManifestPath),
  );
  const identity = inspectAndroidInternalsWikiIdentity(corpus);
  const run: AndroidInternalsWikiAuditRun = {
    repository: {
      revision: identity.revision,
      contentFingerprint: identity.contentFingerprint,
      dirtyAcceptedArticlePaths: identity.dirtyAcceptedArticlePaths,
    },
    report,
  };
  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), {recursive: true});
    fs.writeFileSync(resolvedOutput, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  return run;
}

function parseCliOptions(argv: string[]): AndroidInternalsWikiAuditOptions {
  const {values} = parseArgs({
    args: argv,
    options: {
      repo: {type: 'string'},
      output: {type: 'string'},
      'capability-map': {type: 'string'},
      skills: {type: 'string'},
      fixtures: {type: 'string'},
    },
    strict: true,
  });
  if (!values.repo) throw new Error('--repo is required');
  const backendRoot = process.cwd();
  return {
    repoPath: path.resolve(values.repo),
    capabilityMapPath: path.resolve(
      values['capability-map'] ?? path.join(backendRoot, 'knowledge/android-internals-capability-map.yaml'),
    ),
    skillsPath: path.resolve(values.skills ?? path.join(backendRoot, 'skills')),
    fixtureManifestPath: path.resolve(values.fixtures ?? path.join(backendRoot, 'skills/public-fixtures.yaml')),
    ...(values.output ? {outputPath: path.resolve(values.output)} : {}),
  };
}

function main(): void {
  const run = runAndroidInternalsWikiAudit(parseCliOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    repository: run.repository,
    totalArticles: run.report.totalArticles,
    counts: run.report.counts,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[android-internals-audit] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
