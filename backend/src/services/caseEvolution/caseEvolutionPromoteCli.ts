// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { promoteCaseCandidate, type CaseEvolutionPromotionTarget } from './caseEvolutionPromotion';

function printUsage(): void {
  console.error('Usage: npm run case-evolution:promote -- <candidateId> --to <reviewed|published|markdown> [--to-markdown] [--reviewer <name>]');
}

function readArg(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export type PromoteCliArgs =
  | {
      ok: true;
      candidateId: string;
      to: CaseEvolutionPromotionTarget;
      reviewer: string | undefined;
    }
  | { ok: false };

export function parsePromoteCliArgs(args: string[]): PromoteCliArgs {
  const candidateId = args[0];
  const to = args.includes('--to-markdown')
    ? 'markdown'
    : readArg('--to', args) as CaseEvolutionPromotionTarget | undefined;
  if (!candidateId || !to || !['reviewed', 'published', 'markdown'].includes(to)) {
    return { ok: false };
  }
  return {
    ok: true,
    candidateId,
    to,
    reviewer: readArg('--reviewer', args),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parsePromoteCliArgs(args);
  if (!parsed.ok) {
    printUsage();
    process.exit(2);
  }
  const result = promoteCaseCandidate(parsed.candidateId, {
    to: parsed.to,
    reviewer: parsed.reviewer,
  });
  if (!result.ok) {
    console.error(`[case-evolution:promote] failed (${result.reason}): ${result.details ?? ''}`);
    process.exit(1);
  }
  console.log(`[case-evolution:promote] ${result.caseId} -> ${result.status}`);
  if (result.markdownPath) console.log(`[case-evolution:promote] markdown: ${result.markdownPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[case-evolution:promote] unhandled:', err);
    process.exit(1);
  });
}
