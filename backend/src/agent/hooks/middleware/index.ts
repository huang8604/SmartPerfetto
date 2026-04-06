// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Hook Middleware Exports
 */

export {
  createLoggingMiddleware,
  loggingMiddleware,
  type LoggingMiddlewareConfig,
} from './loggingMiddleware';

export {
  createTimingMiddleware,
  timingMiddleware,
  TimingMetricsAggregator,
  type TimingMiddlewareConfig,
  type TimingStats,
} from './timingMiddleware';