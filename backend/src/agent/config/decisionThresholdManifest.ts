// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Decision Tree Threshold Manifest
 *
 * Centralized threshold configuration for decision-tree checks and
 * decision-tree post-processing findings extraction.
 */

export interface ScrollingDecisionThresholds {
  noProblem: {
    minAvgFps: number;
    maxJankRate: number;
  };
  continuousLowPattern: {
    maxFpsVariance: number;
    maxAvgFps: number;
  };
  surfaceFlinger: {
    maxAvgCompositionMs: number;
  };
  renderThread: {
    minAvgRenderMs: number;
  };
  mainThread: {
    minAvgDoFrameMs: number;
  };
  cpuScheduling: {
    minAvgRunnableMs: number;
  };
  jankClassification: {
    appDeadlineMissedMinRatio: number;
    sfStuffingMinRatio: number;
    binderBlockMinMs: number;
  };
}

export interface LaunchDecisionThresholds {
  coldLaunch: {
    maxTtidMs: number;
  };
  processStart: {
    minZygoteForkMs: number;
  };
  activityCreate: {
    minLayoutInflateMs: number;
  };
  warmLaunch: {
    maxDurationMs: number;
  };
  hotLaunch: {
    maxDurationMs: number;
  };
}

export interface DecisionTreePostProcessingThresholds {
  findings: {
    lowFps: {
      threshold: number;
      highSeverityThreshold: number;
    };
    slowStartup: {
      thresholdMs: number;
      highSeverityThresholdMs: number;
    };
  };
}

export interface DecisionThresholdManifest {
  scrolling: ScrollingDecisionThresholds;
  launch: LaunchDecisionThresholds;
  postProcessing: DecisionTreePostProcessingThresholds;
}

export const DEFAULT_DECISION_THRESHOLD_MANIFEST: DecisionThresholdManifest = {
  scrolling: {
    noProblem: {
      minAvgFps: 55,
      maxJankRate: 0.05,
    },
    continuousLowPattern: {
      maxFpsVariance: 15,
      maxAvgFps: 50,
    },
    surfaceFlinger: {
      maxAvgCompositionMs: 4,
    },
    renderThread: {
      minAvgRenderMs: 16,
    },
    mainThread: {
      minAvgDoFrameMs: 12,
    },
    cpuScheduling: {
      minAvgRunnableMs: 5,
    },
    jankClassification: {
      appDeadlineMissedMinRatio: 0.6,
      sfStuffingMinRatio: 0.6,
      binderBlockMinMs: 5,
    },
  },
  launch: {
    coldLaunch: {
      maxTtidMs: 1000,
    },
    processStart: {
      minZygoteForkMs: 100,
    },
    activityCreate: {
      minLayoutInflateMs: 200,
    },
    warmLaunch: {
      maxDurationMs: 500,
    },
    hotLaunch: {
      maxDurationMs: 200,
    },
  },
  postProcessing: {
    findings: {
      lowFps: {
        threshold: 55,
        highSeverityThreshold: 30,
      },
      slowStartup: {
        thresholdMs: 1000,
        highSeverityThresholdMs: 2000,
      },
    },
  },
};

export function getScrollingDecisionThresholds(
  manifest: DecisionThresholdManifest = DEFAULT_DECISION_THRESHOLD_MANIFEST
): ScrollingDecisionThresholds {
  return manifest.scrolling || DEFAULT_DECISION_THRESHOLD_MANIFEST.scrolling;
}

export function getLaunchDecisionThresholds(
  manifest: DecisionThresholdManifest = DEFAULT_DECISION_THRESHOLD_MANIFEST
): LaunchDecisionThresholds {
  return manifest.launch || DEFAULT_DECISION_THRESHOLD_MANIFEST.launch;
}

export function getDecisionTreePostProcessingThresholds(
  manifest: DecisionThresholdManifest = DEFAULT_DECISION_THRESHOLD_MANIFEST
): DecisionTreePostProcessingThresholds {
  return manifest.postProcessing || DEFAULT_DECISION_THRESHOLD_MANIFEST.postProcessing;
}