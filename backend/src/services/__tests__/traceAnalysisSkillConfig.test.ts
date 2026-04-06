// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  assertTraceAnalysisConfiguredForStartup,
  getTraceAnalysisConfigurationStatus,
} from '../traceAnalysisSkill';

describe('TraceAnalysisSkill configuration', () => {
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  const originalStrict = process.env.TRACE_ANALYSIS_STRICT_STARTUP;

  afterEach(() => {
    process.env.DEEPSEEK_API_KEY = originalApiKey;
    process.env.TRACE_ANALYSIS_STRICT_STARTUP = originalStrict;
  });

  it('reports missing configuration when API key is absent', () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.TRACE_ANALYSIS_STRICT_STARTUP = 'false';

    const status = getTraceAnalysisConfigurationStatus();
    expect(status.configured).toBe(false);
    expect(status.missingEnv).toContain('DEEPSEEK_API_KEY');
  });

  it('throws on startup when strict validation is enabled and key is missing', () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.TRACE_ANALYSIS_STRICT_STARTUP = 'true';

    expect(() => assertTraceAnalysisConfiguredForStartup()).toThrow(
      /missing environment variables/i
    );
  });

  it('passes startup validation when required config is present', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.TRACE_ANALYSIS_STRICT_STARTUP = 'true';

    expect(() => assertTraceAnalysisConfiguredForStartup()).not.toThrow();
  });
});