// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { backendDataPath, backendLogPath } from '../../runtimePaths';
import { CaseGraph } from '../caseGraph';
import { CaseLibrary } from '../caseLibrary';
import { RagStore } from '../ragStore';
import { openCaseCandidateOutbox } from './caseCandidateOutbox';
import { rederiveLearnedCandidates } from './caseCandidateIngester';

export interface RederiveCliArgs {
  ok: true;
  dryRun: false;
}

export interface RunCaseEvolutionRederiveOptions {
  dbPath?: string;
  caseLibraryPath?: string;
  caseGraphPath?: string;
  ragStorePath?: string;
}

export function parseRederiveCliArgs(args: string[]): RederiveCliArgs | { ok: false } {
  if (args.length > 0) return { ok: false };
  return { ok: true, dryRun: false };
}

export function runCaseEvolutionRederive(
  opts: RunCaseEvolutionRederiveOptions = {},
): ReturnType<typeof rederiveLearnedCandidates> {
  const outbox = openCaseCandidateOutbox({
    dbPath: opts.dbPath ?? backendDataPath('self_improve', 'case_evolution.db'),
  });
  try {
    return rederiveLearnedCandidates({
      outbox,
      library: new CaseLibrary(opts.caseLibraryPath ?? backendLogPath('case_library.json')),
      graph: new CaseGraph(opts.caseGraphPath ?? backendLogPath('case_graph.json')),
      ragStore: new RagStore(opts.ragStorePath ?? backendLogPath('rag_store.json')),
    });
  } finally {
    outbox.close();
  }
}

function printUsage(): void {
  console.error('Usage: npm run case-evolution:rederive');
}

async function main(): Promise<void> {
  const parsed = parseRederiveCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    printUsage();
    process.exit(2);
  }
  const result = runCaseEvolutionRederive();
  console.log(
    `[case-evolution:rederive] reviewed=${result.reviewed} demotedPrivate=${result.demotedPrivate}`,
  );
  for (const warning of result.warnings) {
    console.warn(`[case-evolution:rederive] warning: ${warning}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[case-evolution:rederive] unhandled:', err);
    process.exit(1);
  });
}
