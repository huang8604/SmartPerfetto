// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseEvolutionConfig } from '../../types/caseEvolution';

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function readBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase());
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  opts: {min?: number; max?: number} = {},
): number {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.floor(parsed);
  const min = opts.min ?? 1;
  if (integer < min) return fallback;
  return typeof opts.max === 'number' ? Math.min(integer, opts.max) : integer;
}

export function loadCaseEvolutionConfig(env: NodeJS.ProcessEnv = process.env): CaseEvolutionConfig {
  return {
    captureEnabled: readBoolean(env, 'CASE_EVOLUTION_CAPTURE_ENABLED'),
    reviewEnabled: readBoolean(env, 'CASE_EVOLUTION_REVIEW_ENABLED'),
    notesWriteEnabled: readBoolean(env, 'CASE_EVOLUTION_NOTES_WRITE_ENABLED'),
    ingestEnabled: readBoolean(env, 'CASE_EVOLUTION_INGEST_ENABLED'),
    retrieveEnabled: readBoolean(env, 'CASE_EVOLUTION_RETRIEVE_ENABLED'),
    promptInjectEnabled: readBoolean(env, 'CASE_EVOLUTION_PROMPT_INJECT_ENABLED'),
    includeDrafts: readBoolean(env, 'CASE_EVOLUTION_INCLUDE_DRAFTS'),
    workerConcurrency: readPositiveInt(env, 'CASE_EVOLUTION_WORKER_CONCURRENCY', 1, {max: 2}),
    queueMax: readPositiveInt(env, 'CASE_EVOLUTION_QUEUE_MAX', 100),
    cooldownMs: readPositiveInt(env, 'CASE_EVOLUTION_CANDIDATE_COOLDOWN_MS', 5 * 60 * 1000),
    dailyBudget: readPositiveInt(env, 'CASE_EVOLUTION_DAILY_BUDGET', 50),
    leaseMs: readPositiveInt(env, 'CASE_EVOLUTION_LEASE_MS', 5 * 60 * 1000),
    maxAttempts: readPositiveInt(env, 'CASE_EVOLUTION_MAX_ATTEMPTS', 3),
    pollIntervalMs: readPositiveInt(env, 'CASE_EVOLUTION_POLL_INTERVAL_MS', 60 * 1000),
  };
}

export interface CaseEvolutionConfigValidation {
  ok: boolean;
  effectiveConfig: CaseEvolutionConfig;
  warnings: string[];
  errors: string[];
}

export function validateCaseEvolutionConfig(
  config: CaseEvolutionConfig,
): CaseEvolutionConfigValidation {
  const effectiveConfig = {...config};
  const warnings: string[] = [];
  const errors: string[] = [];

  if (effectiveConfig.reviewEnabled && !effectiveConfig.captureEnabled) {
    warnings.push('REVIEW_ENABLED requires CAPTURE_ENABLED; disabling review worker');
    effectiveConfig.reviewEnabled = false;
  }
  if (effectiveConfig.notesWriteEnabled && !effectiveConfig.reviewEnabled) {
    warnings.push('NOTES_WRITE_ENABLED requires REVIEW_ENABLED; disabling sidecar writes');
    effectiveConfig.notesWriteEnabled = false;
  }
  if (effectiveConfig.ingestEnabled && !effectiveConfig.reviewEnabled) {
    warnings.push('INGEST_ENABLED requires REVIEW_ENABLED; disabling learned-case ingest');
    effectiveConfig.ingestEnabled = false;
  }
  if (effectiveConfig.promptInjectEnabled && !effectiveConfig.retrieveEnabled) {
    errors.push('PROMPT_INJECT_ENABLED requires RETRIEVE_ENABLED; disabling prompt injection');
    effectiveConfig.promptInjectEnabled = false;
  }
  if (
    effectiveConfig.includeDrafts &&
    (!effectiveConfig.retrieveEnabled || !effectiveConfig.promptInjectEnabled)
  ) {
    errors.push('INCLUDE_DRAFTS requires RETRIEVE_ENABLED and PROMPT_INJECT_ENABLED; disabling draft inclusion');
    effectiveConfig.includeDrafts = false;
  }

  return {
    ok: errors.length === 0,
    effectiveConfig,
    warnings,
    errors,
  };
}

export function isCaseEvolutionCaptureEnabled(config: CaseEvolutionConfig): boolean {
  return config.captureEnabled;
}

export function isCaseEvolutionReviewEnabled(config: CaseEvolutionConfig): boolean {
  return config.reviewEnabled;
}

export function isCaseEvolutionNotesWriteEnabled(config: CaseEvolutionConfig): boolean {
  return config.notesWriteEnabled;
}

export function isCaseEvolutionRetrieveEnabled(config: CaseEvolutionConfig): boolean {
  return config.retrieveEnabled;
}
