// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  isCaseEvolutionCaptureEnabled,
  isCaseEvolutionNotesWriteEnabled,
  isCaseEvolutionReviewEnabled,
  loadCaseEvolutionConfig,
  validateCaseEvolutionConfig,
} from '../caseEvolutionConfig';

describe('loadCaseEvolutionConfig', () => {
  it('defaults every case-evolution feature flag off with conservative resource limits', () => {
    expect(loadCaseEvolutionConfig({})).toMatchObject({
      captureEnabled: false,
      reviewEnabled: false,
      notesWriteEnabled: false,
      ingestEnabled: false,
      retrieveEnabled: false,
      promptInjectEnabled: false,
      includeDrafts: false,
      workerConcurrency: 1,
      queueMax: 100,
      cooldownMs: 5 * 60 * 1000,
      dailyBudget: 50,
      leaseMs: 5 * 60 * 1000,
      maxAttempts: 3,
      pollIntervalMs: 60 * 1000,
    });
  });

  it('parses truthy flag values', () => {
    const config = loadCaseEvolutionConfig({
      CASE_EVOLUTION_CAPTURE_ENABLED: '1',
      CASE_EVOLUTION_REVIEW_ENABLED: 'true',
      CASE_EVOLUTION_NOTES_WRITE_ENABLED: 'yes',
    });

    expect(isCaseEvolutionCaptureEnabled(config)).toBe(true);
    expect(isCaseEvolutionReviewEnabled(config)).toBe(true);
    expect(isCaseEvolutionNotesWriteEnabled(config)).toBe(true);
  });

  it('caps worker concurrency and falls back for invalid numeric values', () => {
    expect(loadCaseEvolutionConfig({CASE_EVOLUTION_WORKER_CONCURRENCY: '99'}).workerConcurrency).toBe(2);
    expect(loadCaseEvolutionConfig({CASE_EVOLUTION_WORKER_CONCURRENCY: '0'}).workerConcurrency).toBe(1);
    expect(loadCaseEvolutionConfig({CASE_EVOLUTION_DAILY_BUDGET: 'bad'}).dailyBudget).toBe(50);
  });

  it('warns and disables sequential pipeline flags when their prerequisite is off', () => {
    const validation = validateCaseEvolutionConfig(loadCaseEvolutionConfig({
      CASE_EVOLUTION_REVIEW_ENABLED: '1',
      CASE_EVOLUTION_NOTES_WRITE_ENABLED: '1',
      CASE_EVOLUTION_INGEST_ENABLED: '1',
    }));

    expect(validation.ok).toBe(true);
    expect(validation.effectiveConfig.reviewEnabled).toBe(false);
    expect(validation.effectiveConfig.notesWriteEnabled).toBe(false);
    expect(validation.effectiveConfig.ingestEnabled).toBe(false);
    expect(validation.warnings.join('\n')).toContain('REVIEW_ENABLED requires CAPTURE_ENABLED');
  });

  it('fails closed when prompt injection is enabled without retrieval', () => {
    const validation = validateCaseEvolutionConfig(loadCaseEvolutionConfig({
      CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
    }));

    expect(validation.ok).toBe(false);
    expect(validation.effectiveConfig.promptInjectEnabled).toBe(false);
    expect(validation.errors.join('\n')).toContain('PROMPT_INJECT_ENABLED requires RETRIEVE_ENABLED');
  });

  it('fails closed when include drafts is enabled without both retrieval and prompt injection', () => {
    const validation = validateCaseEvolutionConfig(loadCaseEvolutionConfig({
      CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
      CASE_EVOLUTION_INCLUDE_DRAFTS: '1',
    }));

    expect(validation.ok).toBe(false);
    expect(validation.effectiveConfig.includeDrafts).toBe(false);
    expect(validation.errors.join('\n')).toContain('INCLUDE_DRAFTS requires RETRIEVE_ENABLED and PROMPT_INJECT_ENABLED');
  });
});
