/**
 * EnhancedSessionContext Unit Tests
 * Phase 5: Multi-turn Dialogue Support
 */

import {
  EnhancedSessionContext,
  SessionContextManager,
  sessionContextManager,
} from '../enhancedSessionContext';
import { Intent, Finding } from '../../types';

describe('EnhancedSessionContext', () => {
  const mockIntent: Intent = {
    primaryGoal: 'Analyze scrolling performance',
    aspects: ['jank frames', 'thread states'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
  };

  const mockFinding: Finding = {
    id: 'finding-1',
    title: 'High jank rate detected',
    description: 'Application has 15% jank frames',
    severity: 'warning',
    category: 'scrolling',
    type: 'performance',
    confidence: 0.85,
  };

  describe('Turn Management', () => {
    let ctx: EnhancedSessionContext;

    beforeEach(() => {
      ctx = new EnhancedSessionContext('session-1', 'trace-1');
    });

    test('should add conversation turn', () => {
      const turn = ctx.addTurn('What is causing the jank?', mockIntent);

      expect(turn.id).toBeDefined();
      expect(turn.query).toBe('What is causing the jank?');
      expect(turn.intent.primaryGoal).toBe('Analyze scrolling performance');
      expect(turn.turnIndex).toBe(0);
      expect(turn.completed).toBe(false);
    });

    test('should track multiple turns', () => {
      ctx.addTurn('First question', mockIntent);
      ctx.addTurn('Second question', mockIntent);

      const turns = ctx.getAllTurns();
      expect(turns.length).toBe(2);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[1].turnIndex).toBe(1);
    });

    test('should complete turn with findings', () => {
      const turn = ctx.addTurn('What is the issue?', mockIntent);

      ctx.completeTurn(turn.id, {
        success: true,
        findings: [mockFinding],
        data: { answer: 'High jank rate' },
      }, [mockFinding]);

      const completedTurn = ctx.getAllTurns()[0];
      expect(completedTurn.completed).toBe(true);
      expect(completedTurn.findings.length).toBe(1);
    });
  });

  describe('Finding Management', () => {
    let ctx: EnhancedSessionContext;

    beforeEach(() => {
      ctx = new EnhancedSessionContext('session-1', 'trace-1');
    });

    test('should register and retrieve findings', () => {
      ctx.addTurn('Question', mockIntent, undefined, [mockFinding]);

      const retrieved = ctx.getFinding('finding-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('High jank rate detected');
    });

    test('should get turn for finding', () => {
      const turn = ctx.addTurn('Question', mockIntent, undefined, [mockFinding]);

      const foundTurn = ctx.getTurnForFinding('finding-1');
      expect(foundTurn?.id).toBe(turn.id);
    });

    test('should get all findings', () => {
      const finding2: Finding = {
        id: 'finding-2',
        title: 'CPU throttling',
        description: 'CPU frequency reduced',
        severity: 'critical',
      };

      ctx.addTurn('Q1', mockIntent, undefined, [mockFinding]);
      ctx.addTurn('Q2', mockIntent, undefined, [finding2]);

      const allFindings = ctx.getAllFindings();
      expect(allFindings.length).toBe(2);
    });
  });

  describe('Context Queries', () => {
    let ctx: EnhancedSessionContext;

    beforeEach(() => {
      ctx = new EnhancedSessionContext('session-1', 'trace-1');
      ctx.addTurn('What is the jank rate?', mockIntent, undefined, [mockFinding]);
      ctx.addTurn('How can I fix it?', {
        ...mockIntent,
        primaryGoal: 'Fix performance issues',
      });
    });

    test('should query by keywords', () => {
      const results = ctx.queryContext(['jank']);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].query).toContain('jank');
    });

    test('should return all turns for empty keywords', () => {
      const results = ctx.queryContext([]);
      expect(results.length).toBe(2);
    });
  });

  describe('Context Summary', () => {
    let ctx: EnhancedSessionContext;

    beforeEach(() => {
      ctx = new EnhancedSessionContext('session-1', 'trace-1');
      ctx.addTurn('What is the performance issue?', mockIntent, undefined, [mockFinding]);
    });

    test('should generate context summary', () => {
      const summary = ctx.generateContextSummary();

      expect(summary.turnCount).toBe(1);
      expect(summary.keyFindings.length).toBeGreaterThan(0);
      expect(summary.topicsDiscussed).toContain('Analyze scrolling performance');
    });

    test('should generate prompt context', () => {
      const promptCtx = ctx.generatePromptContext(500);

      expect(promptCtx).toContain('对话历史');
      expect(typeof promptCtx).toBe('string');
    });
  });

  describe('Serialization', () => {
    test('should serialize and deserialize', () => {
      const ctx = new EnhancedSessionContext('session-1', 'trace-1');
      ctx.addTurn('Test question', mockIntent, undefined, [mockFinding]);

      const json = ctx.serialize();
      const restored = EnhancedSessionContext.deserialize(json);

      expect(restored.getSessionId()).toBe('session-1');
      expect(restored.getAllTurns().length).toBe(1);
      expect(restored.getFinding('finding-1')).toBeDefined();
    });
  });
});

describe('SessionContextManager', () => {
  test('should get or create session', () => {
    const manager = new SessionContextManager();

    const ctx1 = manager.getOrCreate('session-new', 'trace-1');
    expect(ctx1).toBeDefined();

    const ctx2 = manager.getOrCreate('session-new', 'trace-1');
    expect(ctx2).toBe(ctx1); // Same instance
  });

  test('should list sessions', () => {
    const manager = new SessionContextManager();

    manager.getOrCreate('session-a', 'trace-1');
    manager.getOrCreate('session-b', 'trace-2');

    const sessions = manager.listSessions();
    expect(sessions).toContain('session-a');
    expect(sessions).toContain('session-b');
  });

  test('should remove session', () => {
    const manager = new SessionContextManager();

    manager.getOrCreate('session-x', 'trace-1');
    manager.remove('session-x');

    const ctx = manager.get('session-x');
    expect(ctx).toBeUndefined();
  });
});
