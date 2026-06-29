// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { loadCaseEvolutionConfig, validateCaseEvolutionConfig } from './caseEvolutionConfig';
import { openCaseCandidateOutbox } from './caseCandidateOutbox';
import { CaseEvolutionWorker } from './caseEvolutionWorker';
import { executeCaseCandidateReviewViaSdk } from './caseCandidateReviewAgentSdk';

export interface CaseEvolutionWorkerHandle {
  started: boolean;
  stop(): void;
}

export function startCaseEvolutionWorker(
  env: NodeJS.ProcessEnv = process.env,
): CaseEvolutionWorkerHandle {
  const validation = validateCaseEvolutionConfig(loadCaseEvolutionConfig(env));
  for (const warning of validation.warnings) {
    console.warn(`[CaseEvolution] ${warning}`);
  }
  for (const error of validation.errors) {
    console.error(`[CaseEvolution] ${error}`);
  }
  const config = validation.effectiveConfig;
  if (!config.reviewEnabled) {
    return {started: false, stop() {}};
  }

  const outbox = openCaseCandidateOutbox();
  const worker = new CaseEvolutionWorker({
    outbox,
    executeReview: executeCaseCandidateReviewViaSdk,
    config,
  });
  const started = worker.start();
  if (!started) {
    outbox.close();
    return {started: false, stop() {}};
  }

  return {
    started: true,
    stop() {
      worker.stop();
      outbox.close();
    },
  };
}
