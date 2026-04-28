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
    it('summarises the SQL string and produces a paramsHash', () => {
      const result = summarizeToolCallInput('execute_sql', { sql: 'SELECT * FROM frame' });
      expect(result.inputSummary).toBe('SELECT * FROM frame');
      expect(result.paramsHash).toMatch(/^[a-f0-9]{8}$/);
      expect(result.skillId).toBeUndefined();
    });

    it('flattens whitespace and truncates long SQL', () => {
      const longSql = 'SELECT *\n   FROM   frame  WHERE  ' + 'foo OR '.repeat(40);
      const result = summarizeToolCallInput('execute_sql', { sql: longSql });
      expect(result.inputSummary?.length).toBeLessThanOrEqual(120);
      expect(result.inputSummary).toContain('SELECT * FROM frame');
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
    it('falls back to a truncated JSON dump', () => {
      const result = summarizeToolCallInput('some_other_tool', { foo: 'bar', n: 42 });
      expect(result.inputSummary).toContain('foo');
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
