// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createRenderer, parseOutputFormat, parseTextJsonFormat } from '../renderer';

describe('CLI renderer', () => {
  test('renders one JSON object after completion', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.onEvent({ type: 'progress', content: { phase: 'x', message: 'ignored' } } as any);
      renderer.printConclusion('done', { confidence: 0.8, rounds: 2, durationMs: 1234 });
      renderer.printCompletion({ sessionId: 's1', sessionDir: '/tmp/s1', reportPath: '/tmp/s1/report.html' });
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      sessionId: 's1',
      conclusion: 'done',
      confidence: 0.8,
      rounds: 2,
      durationMs: 1234,
    });
  });

  test('renders NDJSON event, conclusion, and completion records', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.onEvent({ type: 'progress', content: { phase: 'load', message: 'loading' } } as any);
      renderer.printConclusion('done', { confidence: 0.9 });
      renderer.printCompletion({ sessionId: 's2', sessionDir: '/tmp/s2', reportPath: '/tmp/s2/report.html' });
    });

    const lines = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: 'event', eventType: 'progress' });
    expect(lines[1]).toMatchObject({ type: 'conclusion', conclusion: 'done', confidence: 0.9 });
    expect(lines[2]).toMatchObject({ type: 'complete', ok: true, sessionId: 's2' });
  });

  test('machine conclusion includes deterministic verifier verdict', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.printConclusion('done', {
        confidence: 0.9,
        claimVerification: {
          status: 'passed',
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          issueCount: 0,
        },
      });
    });

    expect(JSON.parse(output)).toMatchObject({
      type: 'conclusion',
      conclusion: 'done',
      claimVerification: {
        status: 'passed',
        checkedClaimCount: 1,
      },
    });
  });

  test('machine completion reflects failed analysis status', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.printConclusion('failed', { confidence: 0.1 });
      renderer.printCompletion({
        sessionId: 's3',
        sessionDir: '/tmp/s3',
        reportPath: '/tmp/s3/report.html',
        success: false,
      });
    });

    expect(JSON.parse(output)).toMatchObject({ ok: false, sessionId: 's3' });
  });

  test('text completion suggests valid follow-up commands', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'text' });
      renderer.printCompletion({
        sessionId: 's4',
        sessionDir: '/tmp/s4',
        reportPath: '/tmp/s4/report.html',
      });
    });

    expect(output).toContain('smp ask s4 "..."');
    expect(output).toContain('smp repl --resume s4');
    expect(output).not.toContain('smp resume s4');
  });

  test('rejects unknown output formats', () => {
    expect(() => parseOutputFormat('xml')).toThrow('Invalid --format value');
  });

  test('rejects ndjson for text/json-only commands', () => {
    expect(parseTextJsonFormat('json')).toBe('json');
    expect(() => parseTextJsonFormat('ndjson')).toThrow('Expected text or json');
  });
});

function captureStdout(fn: () => void): string {
  const original = process.stdout.write;
  const originalConsoleLog = console.log;
  let output = '';
  (process.stdout.write as any) = (chunk: any) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    return true;
  };
  console.log = (...values: unknown[]) => {
    output += `${values.map(String).join(' ')}\n`;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
    console.log = originalConsoleLog;
  }
  return output;
}
