// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { RecordedTrace } from './traceRecorder';
import { Finding, Diagnostic } from './types';

export interface EvalCase {
  id: string;
  query: string;
  traceFile: string;
  expectedFindings: ExpectedFinding[];
  expectedDiagnostics?: string[];
  maxDurationMs?: number;
  minConfidence?: number;
}

export interface ExpectedFinding {
  category?: string;
  severity?: 'info' | 'warning' | 'critical';
  titleContains?: string;
  descriptionContains?: string;
}

export interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number;
  metrics: {
    findingRecall: number;
    findingPrecision: number;
    durationWithinLimit: boolean;
    confidenceAboveThreshold: boolean;
  };
  details: {
    matchedFindings: number;
    totalExpected: number;
    totalActual: number;
    durationMs: number;
    confidence: number;
  };
  errors: string[];
}

export interface EvalSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  avgScore: number;
  avgFindingRecall: number;
  avgFindingPrecision: number;
  avgDurationMs: number;
  results: EvalResult[];
}

export class AgentEvalSystem {
  private cases: EvalCase[] = [];

  addCase(evalCase: EvalCase): void {
    this.cases.push(evalCase);
  }

  addCases(cases: EvalCase[]): void {
    this.cases.push(...cases);
  }

  evaluateTrace(recordedTrace: RecordedTrace, evalCase: EvalCase): EvalResult {
    const errors: string[] = [];
    
    const actualFindings = this.extractFindings(recordedTrace);
    
    const matchedFindings = this.countMatchedFindings(
      actualFindings,
      evalCase.expectedFindings
    );

    const totalExpected = evalCase.expectedFindings.length;
    const totalActual = actualFindings.length;
    
    const findingRecall = totalExpected > 0 ? matchedFindings / totalExpected : 1;
    const findingPrecision = totalActual > 0 ? matchedFindings / totalActual : 1;
    
    const durationMs = recordedTrace.metadata.totalDurationMs;
    const durationWithinLimit = evalCase.maxDurationMs 
      ? durationMs <= evalCase.maxDurationMs 
      : true;
    
    if (evalCase.maxDurationMs && !durationWithinLimit) {
      errors.push(`Duration ${durationMs}ms exceeds limit ${evalCase.maxDurationMs}ms`);
    }

    const confidence = recordedTrace.metadata.confidence;
    const confidenceAboveThreshold = evalCase.minConfidence
      ? confidence >= evalCase.minConfidence
      : true;
    
    if (evalCase.minConfidence && !confidenceAboveThreshold) {
      errors.push(`Confidence ${confidence} below threshold ${evalCase.minConfidence}`);
    }

    const f1Score = findingRecall + findingPrecision > 0
      ? (2 * findingRecall * findingPrecision) / (findingRecall + findingPrecision)
      : 0;

    const score = this.calculateScore({
      findingRecall,
      findingPrecision,
      durationWithinLimit,
      confidenceAboveThreshold,
    });

    const passed = score >= 0.7 && errors.length === 0;

    return {
      caseId: evalCase.id,
      passed,
      score,
      metrics: {
        findingRecall,
        findingPrecision,
        durationWithinLimit,
        confidenceAboveThreshold,
      },
      details: {
        matchedFindings,
        totalExpected,
        totalActual,
        durationMs,
        confidence,
      },
      errors,
    };
  }

  private extractFindings(trace: RecordedTrace): Finding[] {
    const findings: Finding[] = [];
    
    for (const expertTrace of trace.orchestratorTrace.expertTraces) {
      for (const thought of expertTrace.thoughts) {
        if (thought.observation && thought.confidence > 0.5) {
          findings.push({
            id: `thought_${findings.length}`,
            category: 'performance',
            severity: thought.confidence > 0.8 ? 'critical' : 'warning',
            title: thought.observation.substring(0, 50),
            description: thought.observation,
            evidence: [],
          });
        }
      }
    }
    
    return findings;
  }

  private countMatchedFindings(actual: Finding[], expected: ExpectedFinding[]): number {
    let matched = 0;
    
    for (const exp of expected) {
      const found = actual.some(act => this.findingMatches(act, exp));
      if (found) matched++;
    }
    
    return matched;
  }

  private findingMatches(actual: Finding, expected: ExpectedFinding): boolean {
    if (expected.category && actual.category !== expected.category) return false;
    if (expected.severity && actual.severity !== expected.severity) return false;
    if (expected.titleContains && !actual.title.toLowerCase().includes(expected.titleContains.toLowerCase())) return false;
    if (expected.descriptionContains && !actual.description.toLowerCase().includes(expected.descriptionContains.toLowerCase())) return false;
    return true;
  }

  private calculateScore(metrics: EvalResult['metrics']): number {
    const weights = {
      findingRecall: 0.35,
      findingPrecision: 0.25,
      durationWithinLimit: 0.2,
      confidenceAboveThreshold: 0.2,
    };

    return (
      metrics.findingRecall * weights.findingRecall +
      metrics.findingPrecision * weights.findingPrecision +
      (metrics.durationWithinLimit ? 1 : 0) * weights.durationWithinLimit +
      (metrics.confidenceAboveThreshold ? 1 : 0) * weights.confidenceAboveThreshold
    );
  }

  runEvaluation(traces: Map<string, RecordedTrace>): EvalSummary {
    const results: EvalResult[] = [];
    
    for (const evalCase of this.cases) {
      const trace = traces.get(evalCase.id);
      if (!trace) {
        results.push({
          caseId: evalCase.id,
          passed: false,
          score: 0,
          metrics: {
            findingRecall: 0,
            findingPrecision: 0,
            durationWithinLimit: false,
            confidenceAboveThreshold: false,
          },
          details: {
            matchedFindings: 0,
            totalExpected: evalCase.expectedFindings.length,
            totalActual: 0,
            durationMs: 0,
            confidence: 0,
          },
          errors: ['No trace found for this case'],
        });
        continue;
      }
      
      results.push(this.evaluateTrace(trace, evalCase));
    }

    const passedCases = results.filter(r => r.passed).length;
    const totalCases = results.length;
    
    const avgScore = totalCases > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / totalCases
      : 0;
    
    const avgFindingRecall = totalCases > 0
      ? results.reduce((sum, r) => sum + r.metrics.findingRecall, 0) / totalCases
      : 0;
    
    const avgFindingPrecision = totalCases > 0
      ? results.reduce((sum, r) => sum + r.metrics.findingPrecision, 0) / totalCases
      : 0;
    
    const avgDurationMs = totalCases > 0
      ? results.reduce((sum, r) => sum + r.details.durationMs, 0) / totalCases
      : 0;

    return {
      totalCases,
      passedCases,
      failedCases: totalCases - passedCases,
      avgScore: Math.round(avgScore * 100) / 100,
      avgFindingRecall: Math.round(avgFindingRecall * 100) / 100,
      avgFindingPrecision: Math.round(avgFindingPrecision * 100) / 100,
      avgDurationMs: Math.round(avgDurationMs),
      results,
    };
  }

  getCases(): EvalCase[] {
    return [...this.cases];
  }

  clearCases(): void {
    this.cases = [];
  }
}

export const SCROLLING_EVAL_CASES: EvalCase[] = [
  {
    id: 'scrolling_basic',
    query: '分析滑动性能',
    traceFile: 'app_aosp_scrolling_heavy_jank.pftrace',
    expectedFindings: [
      { category: 'performance', titleContains: 'jank' },
      { category: 'performance', titleContains: 'frame' },
    ],
    maxDurationMs: 30000,
    minConfidence: 0.3,
  },
  {
    id: 'scrolling_detailed',
    query: 'Why is scrolling laggy?',
    traceFile: 'app_aosp_scrolling_heavy_jank.pftrace',
    expectedFindings: [
      { severity: 'warning' },
      { descriptionContains: 'main thread' },
    ],
    maxDurationMs: 60000,
    minConfidence: 0.5,
  },
];

export function createEvalSystem(): AgentEvalSystem {
  const system = new AgentEvalSystem();
  system.addCases(SCROLLING_EVAL_CASES);
  return system;
}