// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  isUnsupported,
  makeSparkProvenance,
  type StdlibSkillCoverageContract,
  type TraceSummaryV2Contract,
} from '../sparkContracts';

describe('sparkContracts — shared provenance', () => {
  it('makeSparkProvenance stamps schemaVersion and createdAt', () => {
    const p = makeSparkProvenance({source: 'plan-01-test'});
    expect(p.schemaVersion).toBe(1);
    expect(p.source).toBe('plan-01-test');
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.unsupportedReason).toBeUndefined();
  });

  it('makeSparkProvenance carries unsupportedReason when supplied', () => {
    const p = makeSparkProvenance({
      source: 'plan-01-test',
      unsupportedReason: 'stdlib asset missing',
    });
    expect(p.unsupportedReason).toBe('stdlib asset missing');
    expect(isUnsupported(p)).toBe(true);
  });

  it('isUnsupported is false when no reason is set', () => {
    const p = makeSparkProvenance({source: 'plan-01-test'});
    expect(isUnsupported(p)).toBe(false);
  });
});

describe('Plan 01 — StdlibSkillCoverageContract', () => {
  it('accepts a minimal contract with only required provenance', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({source: 'stdlib-skill-coverage'}),
      totalModules: 0,
      modulesCovered: 0,
      skillsWithDrift: 0,
      uncoveredModules: [],
      skillUsage: [],
      coverage: [
        {sparkId: 1, planId: '01', status: 'scaffolded'},
        {sparkId: 21, planId: '01', status: 'scaffolded'},
      ],
    };
    expect(contract.coverage).toHaveLength(2);
    expect(contract.totalModules).toBe(0);
  });

  it('records unsupported probes without inventing metrics', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({
        source: 'stdlib-skill-coverage',
        unsupportedReason: 'stdlib asset missing on host',
      }),
      totalModules: 0,
      modulesCovered: 0,
      skillsWithDrift: 0,
      uncoveredModules: [],
      skillUsage: [],
      coverage: [{sparkId: 1, planId: '01', status: 'unsupported'}],
    };
    expect(isUnsupported(contract)).toBe(true);
    expect(contract.coverage[0].status).toBe('unsupported');
  });

  it('captures per-skill drift when a skill omits a stdlib prerequisite', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({source: 'stdlib-skill-coverage'}),
      totalModules: 200,
      modulesCovered: 60,
      skillsWithDrift: 1,
      uncoveredModules: [
        {module: 'android.input.events', declaredBySkills: 0, usedBySkills: 0},
      ],
      skillUsage: [
        {
          skillId: 'binder_root_cause',
          declared: ['android.binder'],
          detected: ['android.binder', 'slices.with_context'],
          declaredButUnused: [],
          detectedButUndeclared: ['slices.with_context'],
        },
      ],
      coverage: [{sparkId: 1, planId: '01', status: 'scaffolded'}],
    };
    expect(contract.skillUsage[0].detectedButUndeclared).toContain(
      'slices.with_context',
    );
    expect(contract.uncoveredModules[0].module).toBe('android.input.events');
  });
});

describe('Plan 02 — TraceSummaryV2Contract', () => {
  it('keeps probes and metrics aligned with provenance', () => {
    const contract: TraceSummaryV2Contract = {
      ...makeSparkProvenance({source: 'trace-summary-v2'}),
      traceProcessorBuild: 'v55.0',
      traceRange: {startNs: 0, endNs: 5_000_000_000},
      probes: {
        frame_timeline: true,
        cpu_frequency: false,
      },
      metrics: [
        {
          metricId: 'frames.jank_count',
          value: 12,
          unit: 'count',
          layer: 'L1',
          source: 'frame_timeline',
        },
      ],
      coverage: [
        {sparkId: 2, planId: '02', status: 'scaffolded'},
        {sparkId: 22, planId: '02', status: 'scaffolded'},
        {sparkId: 102, planId: '02', status: 'scaffolded'},
      ],
    };
    expect(contract.metrics[0].layer).toBe('L1');
    expect(contract.probes.cpu_frequency).toBe(false);
    expect(contract.coverage.map(c => c.sparkId)).toEqual([2, 22, 102]);
  });

  it('represents missing trace_processor builds as unsupported', () => {
    const contract: TraceSummaryV2Contract = {
      ...makeSparkProvenance({
        source: 'trace-summary-v2',
        unsupportedReason: 'trace_processor_shell version cannot be probed',
      }),
      traceRange: {startNs: 0, endNs: 0},
      probes: {},
      metrics: [],
      coverage: [{sparkId: 102, planId: '02', status: 'unsupported'}],
    };
    expect(isUnsupported(contract)).toBe(true);
    expect(contract.metrics).toHaveLength(0);
  });
});
