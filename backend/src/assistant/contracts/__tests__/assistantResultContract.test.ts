import { createDataEnvelope } from '../../../types/dataContract';
import {
  buildAssistantResultContract,
} from '../assistantResultContract';

describe('assistantResultContract', () => {
  it('builds DataEnvelope + Diagnostics + Actions contract', () => {
    const envelope = createDataEnvelope(
      { columns: ['name'], rows: [['frame']] },
      {
        type: 'skill_result',
        source: 'test',
        skillId: 'scrolling',
        stepId: 'step_1',
        title: 'Test Envelope',
      }
    );

    const result = buildAssistantResultContract({
      dataEnvelopes: [
        envelope,
        { invalid: true },
      ],
      findings: [
        {
          id: 'f_1',
          category: 'scrolling',
          severity: 'critical',
          title: 'Main thread blocked',
          description: 'Long main thread slices were detected.',
          recommendations: [
            { id: 'r_1', text: 'Optimize critical path', priority: 1 },
            'Add frame markers',
          ],
        },
        {
          id: 'f_2',
          severity: 'warning',
          title: 'Jank cluster',
          description: 'Frame pacing is unstable.',
        },
      ],
    });

    expect(result.version).toBe('1.0.0');
    expect(result.dataEnvelopes).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].severity).toBe('critical');
    expect(result.actions.map((a) => a.label)).toEqual(
      expect.arrayContaining([
        'Optimize critical path',
        'Add frame markers',
        'Investigate: Jank cluster',
      ])
    );
  });

  it('deduplicates actions by label', () => {
    const result = buildAssistantResultContract({
      findings: [
        {
          id: 'f_1',
          severity: 'high',
          title: 'Issue 1',
          description: 'A',
          recommendations: ['Fix render pass'],
        },
        {
          id: 'f_2',
          severity: 'critical',
          title: 'Issue 2',
          description: 'B',
          recommendations: ['Fix render pass'],
        },
      ],
    });

    const labels = result.actions.map((a) => a.label);
    expect(labels.filter((label) => label === 'Fix render pass')).toHaveLength(1);
  });

  it('falls back to safe defaults for empty input', () => {
    const result = buildAssistantResultContract({});

    expect(result.version).toBe('1.0.0');
    expect(result.dataEnvelopes).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.actions).toEqual([]);
  });
});
