import type { AgentConfig } from '../../../types/agentProtocol';
import type { SkillExecutionResult } from '../../../../services/skillEngine/types';
import type { Finding } from '../../../types';
import { BaseAgent } from '../baseAgent';

class TestAgent extends BaseAgent {
  protected buildUnderstandingPrompt(): string { return ''; }
  protected buildPlanningPrompt(): string { return ''; }
  protected buildReflectionPrompt(): string { return ''; }
  protected async generateHypotheses(): Promise<any[]> { return []; }
  protected getRecommendedTools(): string[] { return []; }
}

describe('BaseAgent - synthesize summary to findings', () => {
  const config: AgentConfig = {
    id: 'test_agent',
    name: 'Test Agent',
    domain: 'test',
    description: 'test',
    tools: [],
    maxIterations: 1,
    confidenceThreshold: 0.5,
    canDelegate: false,
  };

  test('extractFindingsFromResult emits finding from synthesize summary', () => {
    const agent = new TestAgent(config, {} as any);

    const result: SkillExecutionResult = {
      skillId: 'gc_analysis',
      skillName: 'GC 分析',
      success: true,
      displayResults: [
        {
          stepId: '__synthesize_summary__',
          title: '洞见摘要',
          level: 'key',
          layer: 'overview',
          format: 'summary',
          data: {
            summary: {
              title: '洞见摘要',
              content: '- GC 总耗时偏高\n- alloc GC 偏多',
              metrics: [
                { label: 'GC 总耗时', value: 512, unit: 'ms', severity: 'warning' },
              ],
            },
          },
        } as any,
      ],
      diagnostics: [],
      executionTimeMs: 1,
    };

    const findings = (agent as any).extractFindingsFromResult(result, result.skillId, 'memory') as Finding[];

    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('洞见摘要');
    expect(findings[0].severity).toBe('warning');
    expect((findings[0].details as any)?.metrics?.length).toBe(1);
  });

  test('severity is critical when any metric is critical', () => {
    const agent = new TestAgent(config, {} as any);

    const result: SkillExecutionResult = {
      skillId: 'cpu_analysis',
      skillName: 'CPU 分析',
      success: true,
      displayResults: [
        {
          stepId: '__synthesize_summary__',
          title: '洞见摘要',
          level: 'key',
          layer: 'overview',
          format: 'summary',
          data: {
            summary: {
              title: '洞见摘要',
              content: '- CPU 占用非常高',
              metrics: [
                { label: 'CPU Running', value: 98, unit: '%', severity: 'critical' },
              ],
            },
          },
        } as any,
      ],
      diagnostics: [],
      executionTimeMs: 1,
    };

    const findings = (agent as any).extractFindingsFromResult(result, result.skillId, 'cpu') as Finding[];
    expect(findings[0].severity).toBe('critical');
  });
});

