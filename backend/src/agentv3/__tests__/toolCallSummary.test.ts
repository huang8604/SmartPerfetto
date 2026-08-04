// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect } from '@jest/globals';
import { summarizeToolCallInput } from '../toolCallSummary';

describe('summarizeToolCallInput', () => {
  it('returns an empty digest for null/undefined input', () => {
    expect(summarizeToolCallInput('execute_sql', null)).toEqual({});
    expect(summarizeToolCallInput('execute_sql', undefined)).toEqual({});
    expect(summarizeToolCallInput('execute_sql', 'string-input')).toEqual({});
  });

  describe('execute_sql', () => {
    it('records only a structural SQL marker and a paramsHash', () => {
      const result = summarizeToolCallInput('execute_sql', { sql: 'SELECT * FROM frame' });
      expect(result.inputSummary).toBe('sql');
      expect(result.paramsHash).toMatch(/^[a-f0-9]{8}$/);
      expect(result.skillId).toBeUndefined();
    });

    it('never persists SQL literals in the summary', () => {
      const longSql = 'SELECT * FROM frame WHERE secret = "PRIVATE_PLAN_CANARY"';
      const result = summarizeToolCallInput('execute_sql', { sql: longSql });
      expect(result.inputSummary).toBe('sql');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PLAN_CANARY');
    });
  });

  describe('invoke_skill', () => {
    it('lifts skillId and lists sorted param keys', () => {
      const result = summarizeToolCallInput('invoke_skill', {
        skillId: 'startup_analysis',
        params: { traceId: 't1', appPackage: 'com.example' },
      });
      expect(result.skillId).toBe('startup_analysis');
      expect(result.inputSummary).toBe('startup_analysis(appPackage,traceId)');
    });

    it('omits param parens when params is empty/missing', () => {
      const result = summarizeToolCallInput('invoke_skill', { skillId: 'jank_frame_detail' });
      expect(result.inputSummary).toBe('jank_frame_detail');
    });

    it('returns no inputSummary when skillId is missing', () => {
      const result = summarizeToolCallInput('invoke_skill', { params: { traceId: 't1' } });
      expect(result.skillId).toBeUndefined();
      expect(result.inputSummary).toBeUndefined();
      expect(result.paramsHash).toMatch(/^[a-f0-9]{8}$/);
    });
  });

  describe('compare_skill', () => {
    it('lifts skillId so raw trace comparison calls satisfy structured expectedCalls', () => {
      const result = summarizeToolCallInput('compare_skill', {
        skillId: 'startup_analysis',
        params: { currentTraceId: 'left', referenceTraceId: 'right' },
      });
      expect(result.skillId).toBe('startup_analysis');
      expect(result.inputSummary).toBe('startup_analysis(currentTraceId,referenceTraceId)');
      expect(result.paramsHash).toMatch(/^[a-f0-9]{8}$/);
    });

    it('summarizes side-specific params for live dual-trace comparisons', () => {
      const result = summarizeToolCallInput('compare_skill', {
        skillId: 'startup_detail',
        params: { process_name: 'com.example.current' },
        currentParams: { start_ts: 100 },
        referenceParams: { start_ts: 500 },
      });

      expect(result.skillId).toBe('startup_detail');
      expect(result.inputSummary).toBe('startup_detail(process_name,current.start_ts,reference.start_ts)');
    });
  });

  describe('fetch_artifact', () => {
    it('formats artifactId and level', () => {
      const result = summarizeToolCallInput('fetch_artifact', { artifactId: 'art-42', level: 'rows' });
      expect(result.inputSummary).toBe('art-42@rows');
    });

    it('accepts `id` as an alias of `artifactId`', () => {
      const result = summarizeToolCallInput('fetch_artifact', { id: 'art-9', level: 'full' });
      expect(result.inputSummary).toBe('art-9@full');
    });
  });

  describe('unknown tools', () => {
    it('falls back to sorted field names without persisting values', () => {
      const result = summarizeToolCallInput('some_other_tool', { foo: 'PRIVATE_PLAN_CANARY', n: 42 });
      expect(result.inputSummary).toBe('some_other_tool(foo,n)');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PLAN_CANARY');
      expect(result.paramsHash).toMatch(/^[a-f0-9]{8}$/);
    });
  });

  it('produces stable hashes for identical inputs', () => {
    const a = summarizeToolCallInput('invoke_skill', { skillId: 's', params: { x: 1, y: 2 } });
    const b = summarizeToolCallInput('invoke_skill', { skillId: 's', params: { x: 1, y: 2 } });
    expect(a.paramsHash).toBe(b.paramsHash);
  });

  it('produces different hashes for different inputs', () => {
    const a = summarizeToolCallInput('invoke_skill', { skillId: 's', params: { x: 1 } });
    const b = summarizeToolCallInput('invoke_skill', { skillId: 's', params: { x: 2 } });
    expect(a.paramsHash).not.toBe(b.paramsHash);
  });
});
