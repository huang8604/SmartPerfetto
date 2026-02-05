/**
 * FocusStore Unit Tests
 * v2.0: Incremental scope primary focus should reflect latest interaction.
 */

import { FocusStore } from '../focusStore';

describe('FocusStore', () => {
  test('buildIncrementalContext uses most recent focus as primary', () => {
    const store = new FocusStore();

    // First: user clicks a frame (entity focus)
    store.recordEntityClick('frame', '1');

    // Then: user asks a new question (question focus)
    store.recordQuestion('为什么会卡顿？');

    const ctx = store.buildIncrementalContext();
    expect(ctx.primaryFocusType).toBe('question');
    expect(ctx.focusedQuestions.length).toBeGreaterThan(0);
  });

  test('buildIncrementalContext keeps recent entity focus even if weights differ', () => {
    const store = new FocusStore();

    // Many question interactions to create higher-weight historical focuses
    store.recordQuestion('Q1');
    store.recordQuestion('Q1'); // boost same focus
    store.recordQuestion('Q1'); // boost same focus

    // Then user drills into a frame (should become primary + be included)
    store.recordInteraction({
      type: 'drill_down',
      target: { entityType: 'frame', entityId: '1436069' },
      source: 'query',
      timestamp: Date.now(),
    });

    const ctx = store.buildIncrementalContext();
    expect(ctx.primaryFocusType).toBe('entity');
    expect(ctx.focusedEntities.some(e => e.type === 'frame' && e.id === '1436069')).toBe(true);
  });
});

