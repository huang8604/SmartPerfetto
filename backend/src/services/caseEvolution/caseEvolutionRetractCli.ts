// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { retractCaseEvolutionCase } from './caseEvolutionPromotion';

export type RetractCliArgs =
  | {
      ok: true;
      caseId: string;
      reason: string | undefined;
    }
  | { ok: false };

function readArg(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function parseRetractCliArgs(args: string[]): RetractCliArgs {
  const caseId = args[0];
  if (!caseId) return { ok: false };
  return {
    ok: true,
    caseId,
    reason: readArg('--reason', args),
  };
}

function printUsage(): void {
  console.error('Usage: npm run case-evolution:retract -- <caseId> [--reason <text>]');
}

async function main(): Promise<void> {
  const parsed = parseRetractCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    printUsage();
    process.exit(2);
  }
  const result = retractCaseEvolutionCase(parsed.caseId, { reason: parsed.reason });
  if (!result.ok) {
    console.error(`[case-evolution:retract] failed (${result.reason}): ${result.details ?? ''}`);
    process.exit(1);
  }
  console.log(`[case-evolution:retract] ${result.caseId} -> ${result.status}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[case-evolution:retract] unhandled:', err);
    process.exit(1);
  });
}
