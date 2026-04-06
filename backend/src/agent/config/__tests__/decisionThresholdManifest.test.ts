// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_DECISION_THRESHOLD_MANIFEST,
  getDecisionTreePostProcessingThresholds,
  getLaunchDecisionThresholds,
  getScrollingDecisionThresholds,
} from '../decisionThresholdManifest';

describe('decisionThresholdManifest', () => {
  it('exposes stable scrolling thresholds from default manifest', () => {
    const thresholds = getScrollingDecisionThresholds();
    expect(thresholds.noProblem.minAvgFps).toBe(55);
    expect(thresholds.noProblem.maxJankRate).toBe(0.05);
    expect(thresholds.jankClassification.binderBlockMinMs).toBe(5);
  });

  it('exposes stable launch thresholds from default manifest', () => {
    const thresholds = getLaunchDecisionThresholds();
    expect(thresholds.coldLaunch.maxTtidMs).toBe(1000);
    expect(thresholds.warmLaunch.maxDurationMs).toBe(500);
    expect(thresholds.hotLaunch.maxDurationMs).toBe(200);
  });

  it('supports manifest injection for launch threshold tuning', () => {
    const tuned = {
      ...DEFAULT_DECISION_THRESHOLD_MANIFEST,
      launch: {
        ...DEFAULT_DECISION_THRESHOLD_MANIFEST.launch,
        warmLaunch: {
          maxDurationMs: 450,
        },
      },
    };
    expect(getLaunchDecisionThresholds(tuned).warmLaunch.maxDurationMs).toBe(450);
  });

  it('exposes post-processing thresholds used by stage executor', () => {
    const thresholds = getDecisionTreePostProcessingThresholds();
    expect(thresholds.findings.lowFps.threshold).toBe(55);
    expect(thresholds.findings.lowFps.highSeverityThreshold).toBe(30);
    expect(thresholds.findings.slowStartup.thresholdMs).toBe(1000);
    expect(thresholds.findings.slowStartup.highSeverityThresholdMs).toBe(2000);
  });
});