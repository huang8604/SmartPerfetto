// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {buildCpuThermalPmu} from '../cpuThermalPmu';
import {isUnsupported} from '../../types/sparkContracts';

describe('buildCpuThermalPmu', () => {
  it('computes residency fractions over the analysis window', () => {
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1_000_000},
      freqSamples: [
        {cpu: 0, freqHz: 600_000_000, durNs: 200_000},
        {cpu: 0, freqHz: 1_800_000_000, durNs: 800_000},
      ],
    });
    expect(c.cpuFreqResidency).toHaveLength(2);
    if (c.cpuFreqResidency) {
      expect(c.cpuFreqResidency[0].fraction).toBeCloseTo(0.2);
      expect(c.cpuFreqResidency[1].fraction).toBeCloseTo(0.8);
    }
  });

  it('routes hot temps to hard_throttle', () => {
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      thermalSamples: [{zone: 'cpu0', ts: 0, tempMc: 90_000}],
    });
    expect(c.thermalDecision).toBe('hard_throttle');
  });

  it('routes shutdown-stage to shutdown_imminent', () => {
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      thermalSamples: [{zone: 'cpu0', ts: 0, tempMc: 99_000, throttleStage: 3}],
    });
    expect(c.thermalDecision).toBe('shutdown_imminent');
  });

  it('routes 95C+ without HAL stage to shutdown_imminent (Codex round 4 regression)', () => {
    // Thermal zones often expose only temp counters with no HAL stage.
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      thermalSamples: [{zone: 'skin', ts: 0, tempMc: 96_000}],
    });
    expect(c.thermalDecision).toBe('shutdown_imminent');
  });

  it('keeps 60-69C readings as cool (Codex round 6 regression)', () => {
    // The documented bracket says "cool < 70°C". 65°C without a HAL
    // throttle stage must NOT route to soft_throttle.
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      thermalSamples: [{zone: 'skin', ts: 0, tempMc: 65_000}],
    });
    expect(c.thermalDecision).toBe('cool');
  });

  it('computes smoothVsJankComparison delta', () => {
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      smoothFraction: 0.95,
      jankFraction: 0.6,
    });
    expect(c.smoothVsJankComparison?.delta).toBeCloseTo(0.35);
  });

  it('marks unsupported when no facets provided', () => {
    const c = buildCpuThermalPmu({range: {startNs: 0, endNs: 1}});
    expect(isUnsupported(c)).toBe(true);
  });

  it('treats empty arrays as missing data, not as supported coverage (Codex regression)', () => {
    const c = buildCpuThermalPmu({
      range: {startNs: 0, endNs: 1},
      freqSamples: [],
      thermalSamples: [],
      pmuSamples: [],
    });
    expect(isUnsupported(c)).toBe(true);
    expect(c.cpuFreqResidency).toBeUndefined();
    expect(c.thermalSamples).toBeUndefined();
    expect(c.thermalDecision).toBeUndefined();
    expect(c.pmuAttribution).toBeUndefined();
    for (const entry of c.coverage) {
      expect(entry.status).toBe('scaffolded');
    }
  });
});
