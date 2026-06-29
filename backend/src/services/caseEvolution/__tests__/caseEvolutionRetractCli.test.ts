// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import packageJson from '../../../../package.json';
import { CaseLibrary } from '../../caseLibrary';
import { parseRetractCliArgs } from '../caseEvolutionRetractCli';
import { retractCaseEvolutionCase } from '../caseEvolutionPromotion';

let tmpDir: string;
let library: CaseLibrary;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-retract-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
  library.saveCase({
    schemaVersion: 1,
    source: 'runtime_analysis_candidate',
    createdAt: 1,
    caseId: 'learned:cand-retract',
    title: 'Retractable learned case',
    status: 'reviewed',
    redactionState: 'redacted',
    tags: ['scrolling'],
    findings: [],
    knowledge: {
      sourceFile: 'logs/case_candidates/cand-retract.json',
      body: 'body',
      quality: 'imported',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: {
        'caseEvolution.v1': {
          candidateId: 'cand-retract',
          supportingEvidence: 3,
          contradictingEvidence: 0,
          supported: true,
        },
      },
      evidenceSignatures: { required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }], supportive: [] },
      recommendations: { app: [], oem: [] },
    },
  });
  library.publishCase('learned:cand-retract', { reviewer: 'chris', curatedAt: 2 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('caseEvolutionRetractCli', () => {
  it('exposes an operator-triggered retract command', () => {
    expect(packageJson.scripts['case-evolution:retract']).toBe(
      'tsx src/services/caseEvolution/caseEvolutionRetractCli.ts',
    );
  });

  it('parses the manual case retraction target', () => {
    expect(parseRetractCliArgs(['learned:cand-retract', '--reason', 'bad recommendation'])).toEqual({
      ok: true,
      caseId: 'learned:cand-retract',
      reason: 'bad recommendation',
    });
  });

  it('retracts a published learned case back to private via saveCase', () => {
    const result = retractCaseEvolutionCase('learned:cand-retract', {
      library,
      reason: 'bad recommendation',
      clock: () => 1234,
    });

    expect(result).toMatchObject({ ok: true, caseId: 'learned:cand-retract', status: 'private' });
    const stored = library.getCase('learned:cand-retract');
    expect(stored?.status).toBe('private');
    expect(stored?.knowledge?.context['caseEvolution.v1']).toMatchObject({
      candidateId: 'cand-retract',
      retracted: true,
      retractedAt: 1234,
      retractionReason: 'bad recommendation',
    });
  });
});
