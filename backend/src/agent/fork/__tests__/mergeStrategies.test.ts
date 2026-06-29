// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMergeStrategyRegistry } from '../mergeStrategies';
import type { Finding, StageResult, SubAgentContext } from '../../types';

function finding(id: string, title: string): Finding {
  return {
    id,
    severity: 'warning',
    title,
    description: `${title} description`,
    source: 'test',
  };
}

function stage(stageId: string, findings: Finding[]): StageResult {
  return {
    stageId,
    success: true,
    findings,
    startTime: 1,
    endTime: 2,
    retryCount: 0,
  };
}

function context(previousResults: StageResult[]): SubAgentContext {
  return {
    sessionId: 'session-test',
    traceId: 'trace-test',
    intent: {
      primaryGoal: 'test merge findings',
      aspects: [],
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
      followUpType: 'initial',
    },
    previousResults,
  };
}

describe('MergeStrategyRegistry', () => {
  it('keeps child findings discoverable when using merge_findings', () => {
    const registry = createMergeStrategyRegistry();
    const parentFinding = finding('parent-finding', 'Parent finding');
    const childFinding = finding('child-finding', 'Child finding');

    const { mergedContext, result } = registry.merge(
      context([stage('parent-stage', [parentFinding])]),
      context([stage('child-stage', [childFinding])]),
      {
        strategy: 'merge_findings',
        conflictResolution: 'keep_both',
        childSessionId: 'child-session',
        deleteAfterMerge: false,
      },
    );

    const mergedFindings = (mergedContext.previousResults || [])
      .flatMap(stageResult => stageResult.findings);

    expect(result.mergedFindingsCount).toBe(1);
    expect(mergedFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'parent-finding' }),
      expect.objectContaining({ id: 'child-finding' }),
    ]));
  });
});
