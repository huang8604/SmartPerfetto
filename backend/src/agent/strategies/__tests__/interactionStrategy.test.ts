// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { interactionStrategy } from '../interactionStrategy';
import { intervalHelpers } from '../helpers';
import type { AgentResponse } from '../../types/agentProtocol';

// =============================================================================
// Test Data
// =============================================================================

const SLOW_EVENT_COLUMNS = [
  'event_ts',
  'event_end_ts',
  'total_ms',
  'dispatch_ms',
  'handling_ms',
  'ack_ms',
  'event_type',
  'event_action',
  'process_name',
  'main_bottleneck',
  'severity',
  'perfetto_start',
  'perfetto_end',
];

// Critical slow tap: 125ms total
const criticalEvent = [
  '1000000000000',   // event_ts
  '1000125000000',   // event_end_ts (125ms later)
  125,               // total_ms
  45,                // dispatch_ms
  75,                // handling_ms
  5,                 // ack_ms
  'MOTION_EVENT',    // event_type
  'TAP',             // event_action
  'com.example.app', // process_name
  'CPU_SCHEDULER',   // main_bottleneck
  'critical',        // severity
  '1000000000000',   // perfetto_start
  '1000125000000',   // perfetto_end
];

// Warning click: 80ms total
const warningEvent = [
  '2000000000000',
  '2000080000000',
  80,
  20,
  55,
  5,
  'MOTION_EVENT',
  'CLICK',
  'com.example.app',
  'BINDER',
  'warning',
  '2000000000000',
  '2000080000000',
];

// Notice touch: 40ms total
const noticeEvent = [
  '3000000000000',
  '3000040000000',
  40,
  10,
  25,
  5,
  'KEY_EVENT',
  'PRESS',
  'com.example.app',
  'NONE',
  'notice',
  '3000000000000',
  '3000040000000',
];

// =============================================================================
// Helpers: build AgentResponse in columnar toolResults format
// =============================================================================

function buildInteractionResponse(rows: any[][]): AgentResponse {
  return {
    agentId: 'interaction_agent',
    taskId: 'task-interaction',
    success: true,
    findings: [],
    confidence: 0.9,
    executionTimeMs: 10,
    toolResults: [
      {
        success: true,
        executionTimeMs: 8,
        data: {
          slow_events: {
            columns: SLOW_EVENT_COLUMNS,
            rows,
          },
        },
      },
    ],
  };
}

// =============================================================================
// Helpers: build AgentResponse via dataEnvelopes (alternative data path)
// =============================================================================

function buildDataEnvelopeResponse(rows: any[][]): AgentResponse {
  return {
    agentId: 'interaction_agent',
    taskId: 'task-interaction-env',
    success: true,
    findings: [],
    confidence: 0.9,
    executionTimeMs: 10,
    toolResults: [
      {
        success: true,
        executionTimeMs: 8,
        data: {},
        dataEnvelopes: [
          {
            meta: {
              type: 'skill_result',
              version: '2.0',
              source: 'skill',
              skillId: 'click_response_analysis',
              stepId: 'slow_input_events',
              timestamp: Date.now(),
            },
            data: {
              columns: SLOW_EVENT_COLUMNS,
              rows,
            },
            display: {
              layer: 'list',
              format: 'table',
              title: 'Slow Input Events',
            },
          },
        ],
      },
    ],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('interactionStrategy', () => {
  // ---------------------------------------------------------------------------
  // Group 1: Trigger matching
  // ---------------------------------------------------------------------------
  describe('trigger matching', () => {
    it('matches Chinese click-related queries', () => {
      expect(interactionStrategy.trigger('分析点击响应慢')).toBe(true);
    });

    it('matches Chinese touch-related queries', () => {
      expect(interactionStrategy.trigger('触摸延迟分析')).toBe(true);
    });

    it('matches English click queries', () => {
      expect(interactionStrategy.trigger('click response analysis')).toBe(true);
    });

    it('matches English input latency queries', () => {
      expect(interactionStrategy.trigger('input latency is too high')).toBe(true);
    });

    it('rejects scrolling queries (not interaction)', () => {
      expect(interactionStrategy.trigger('分析滑动卡顿')).toBe(false);
    });

    it('rejects startup queries', () => {
      expect(interactionStrategy.trigger('启动性能分析')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 2: Stage definitions
  // ---------------------------------------------------------------------------
  describe('stage definitions', () => {
    it('has strategy id "interaction"', () => {
      expect(interactionStrategy.id).toBe('interaction');
    });

    it('has exactly 2 stages', () => {
      expect(interactionStrategy.stages).toHaveLength(2);
    });

    it('stage names are interaction_overview and event_detail', () => {
      expect(interactionStrategy.stages.map(s => s.name)).toEqual([
        'interaction_overview',
        'event_detail',
      ]);
    });

    it('stage 0 uses click_response_analysis with enable_per_event_detail: false', () => {
      const task = interactionStrategy.stages[0].tasks[0];
      expect(task.executionMode).toBe('direct_skill');
      expect(task.directSkillId).toBe('click_response_analysis');
      expect(task.skillParams).toEqual({ enable_per_event_detail: false });
      expect(task.scope).toBe('global');
    });

    it('stage 1 uses click_response_detail with per_interval scope and correct paramMapping', () => {
      const task = interactionStrategy.stages[1].tasks[0];
      expect(task.executionMode).toBe('direct_skill');
      expect(task.directSkillId).toBe('click_response_detail');
      expect(task.scope).toBe('per_interval');

      const expectedMappingKeys = [
        'event_ts',
        'event_end_ts',
        'process_name',
        'total_ms',
        'dispatch_ms',
        'handling_ms',
        'event_type',
        'event_action',
        'perfetto_start',
        'perfetto_end',
      ];
      expect(Object.keys(task.paramMapping!).sort()).toEqual(expectedMappingKeys.sort());
    });
  });

  // ---------------------------------------------------------------------------
  // Group 3: Interval extraction from toolResults
  // ---------------------------------------------------------------------------
  describe('interval extraction from toolResults', () => {
    const extract = interactionStrategy.stages[0].extractIntervals!;

    it('extractIntervals is defined on stage 0', () => {
      expect(extract).toBeDefined();
    });

    it('extracts a single slow event into one FocusInterval', () => {
      const responses: AgentResponse[] = [buildInteractionResponse([criticalEvent])];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals).toHaveLength(1);
      expect(intervals[0].startTs).toBe('1000000000000');
      expect(intervals[0].endTs).toBe('1000125000000');
      expect(intervals[0].processName).toBe('com.example.app');
    });

    it('metadata contains all expected fields', () => {
      const responses: AgentResponse[] = [buildInteractionResponse([criticalEvent])];
      const intervals = extract(responses, intervalHelpers);

      const meta = intervals[0].metadata!;
      expect(meta.eventTs).toBe('1000000000000');
      expect(meta.eventEndTs).toBe('1000125000000');
      expect(meta.totalMs).toBe(125);
      expect(meta.dispatchMs).toBe(45);
      expect(meta.handlingMs).toBe(75);
      expect(meta.eventType).toBe('MOTION_EVENT');
      expect(meta.eventAction).toBe('TAP');
      expect(meta.mainBottleneck).toBe('CPU_SCHEDULER');
      expect(meta.severity).toBe('critical');
      expect(meta.perfettoStart).toBe('1000000000000');
      expect(meta.perfettoEnd).toBe('1000125000000');
    });

    it('extracts multiple events from a single response', () => {
      const responses: AgentResponse[] = [
        buildInteractionResponse([criticalEvent, warningEvent, noticeEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals).toHaveLength(3);
    });

    it('label contains event_type and total_ms', () => {
      const responses: AgentResponse[] = [buildInteractionResponse([criticalEvent])];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals[0].label).toContain('MOTION_EVENT');
      expect(intervals[0].label).toContain('125ms');
    });

    it('assigns sequential ids starting from 1', () => {
      const responses: AgentResponse[] = [
        buildInteractionResponse([criticalEvent, warningEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals[0].id).toBe(1);
      expect(intervals[1].id).toBe(2);
    });

    it('assigns priority based on sort position (higher for first / most severe)', () => {
      const responses: AgentResponse[] = [
        buildInteractionResponse([noticeEvent, criticalEvent, warningEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);

      // After sorting: critical (index 0), warning (index 1), notice (index 2)
      // priority = rawEvents.length - index → 3, 2, 1
      expect(intervals[0].metadata!.severity).toBe('critical');
      expect(intervals[0].priority).toBe(3);

      expect(intervals[1].metadata!.severity).toBe('warning');
      expect(intervals[1].priority).toBe(2);

      expect(intervals[2].metadata!.severity).toBe('notice');
      expect(intervals[2].priority).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 4: Severity sorting
  // ---------------------------------------------------------------------------
  describe('severity sorting', () => {
    const extract = interactionStrategy.stages[0].extractIntervals!;

    it('sorts critical first, then warning, then notice', () => {
      // Feed events in reverse severity order
      const responses: AgentResponse[] = [
        buildInteractionResponse([noticeEvent, warningEvent, criticalEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals[0].metadata!.severity).toBe('critical');
      expect(intervals[1].metadata!.severity).toBe('warning');
      expect(intervals[2].metadata!.severity).toBe('notice');
    });

    it('within same severity, sorts by totalMs descending', () => {
      const highMs = [
        '4000000000000', '4000200000000', 200, 60, 130, 10,
        'MOTION_EVENT', 'TAP', 'com.example.app', 'CPU', 'critical',
        '4000000000000', '4000200000000',
      ];
      const lowMs = [
        '5000000000000', '5000100000000', 100, 30, 65, 5,
        'MOTION_EVENT', 'CLICK', 'com.example.app', 'BINDER', 'critical',
        '5000000000000', '5000100000000',
      ];

      const responses: AgentResponse[] = [
        buildInteractionResponse([lowMs, highMs]),
      ];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals[0].metadata!.totalMs).toBe(200);
      expect(intervals[1].metadata!.totalMs).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 5: shouldStop logic
  // ---------------------------------------------------------------------------
  describe('shouldStop logic', () => {
    const shouldStop = interactionStrategy.stages[0].shouldStop!;

    it('shouldStop is defined', () => {
      expect(shouldStop).toBeDefined();
    });

    it('returns stop: true when no intervals', () => {
      const decision = shouldStop([]);
      expect(decision.stop).toBe(true);
      expect(decision.reason).toBeTruthy();
    });

    it('returns stop: false when intervals exist', () => {
      const decision = shouldStop([
        {
          id: 1,
          processName: 'com.example.app',
          startTs: '1000000000000',
          endTs: '1000125000000',
          priority: 1,
        },
      ]);
      expect(decision.stop).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 6: Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    const extract = interactionStrategy.stages[0].extractIntervals!;

    it('empty responses array returns 0 intervals', () => {
      const intervals = extract([], intervalHelpers);
      expect(intervals).toHaveLength(0);
    });

    it('response with no slow_events key returns 0 intervals', () => {
      const response: AgentResponse = {
        agentId: 'interaction_agent',
        taskId: 'task-interaction',
        success: true,
        findings: [],
        confidence: 0.9,
        executionTimeMs: 10,
        toolResults: [
          {
            success: true,
            executionTimeMs: 8,
            data: { some_other_key: { columns: ['x'], rows: [[1]] } },
          },
        ],
      };
      const intervals = extract([response], intervalHelpers);
      expect(intervals).toHaveLength(0);
    });

    it('filters out events with event_ts === "0"', () => {
      const zeroTsEvent = [
        '0',             // event_ts = 0 → should be filtered
        '100000000',
        50, 10, 30, 10,
        'MOTION_EVENT', 'TAP', 'com.example.app', 'NONE', 'notice',
        '0', '100000000',
      ];
      const responses: AgentResponse[] = [
        buildInteractionResponse([zeroTsEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);
      expect(intervals).toHaveLength(0);
    });

    it('filters out events with empty event_ts', () => {
      const emptyTsEvent = [
        '',              // empty event_ts → should be filtered
        '100000000',
        50, 10, 30, 10,
        'MOTION_EVENT', 'TAP', 'com.example.app', 'NONE', 'notice',
        '', '100000000',
      ];
      const responses: AgentResponse[] = [
        buildInteractionResponse([emptyTsEvent]),
      ];
      const intervals = extract(responses, intervalHelpers);
      expect(intervals).toHaveLength(0);
    });

    it('failed response (success: false) is skipped', () => {
      const failedResponse: AgentResponse = {
        agentId: 'interaction_agent',
        taskId: 'task-interaction',
        success: false,
        findings: [],
        confidence: 0,
        executionTimeMs: 5,
        toolResults: [
          {
            success: true,
            executionTimeMs: 3,
            data: {
              slow_events: { columns: SLOW_EVENT_COLUMNS, rows: [criticalEvent] },
            },
          },
        ],
      };
      const intervals = extract([failedResponse], intervalHelpers);
      expect(intervals).toHaveLength(0);
    });

    it('deduplicates when both toolResults and dataEnvelopes contain same event', () => {
      // Create a response that has the same event in both toolResults.data.slow_events
      // AND in dataEnvelopes. The code deduplicates by eventTs.
      const response: AgentResponse = {
        agentId: 'interaction_agent',
        taskId: 'task-interaction',
        success: true,
        findings: [],
        confidence: 0.9,
        executionTimeMs: 10,
        toolResults: [
          {
            success: true,
            executionTimeMs: 8,
            data: {
              slow_events: {
                columns: SLOW_EVENT_COLUMNS,
                rows: [criticalEvent],
              },
            },
            dataEnvelopes: [
              {
                meta: {
                  type: 'skill_result',
                  version: '2.0',
                  source: 'skill',
                  skillId: 'click_response_analysis',
                  stepId: 'slow_input_events',
                  timestamp: Date.now(),
                },
                data: {
                  columns: SLOW_EVENT_COLUMNS,
                  rows: [criticalEvent],
                },
                display: {
                  layer: 'list',
                  format: 'table',
                  title: 'Slow Input Events',
                },
              },
            ],
          },
        ],
      };

      const intervals = extract([response], intervalHelpers);
      // Should be 1, not 2 — deduplication by eventTs
      expect(intervals).toHaveLength(1);
    });

    it('extracts events from dataEnvelopes when toolResults.data has no slow_events', () => {
      const responses: AgentResponse[] = [buildDataEnvelopeResponse([warningEvent])];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals).toHaveLength(1);
      expect(intervals[0].metadata!.severity).toBe('warning');
      expect(intervals[0].metadata!.totalMs).toBe(80);
    });

    it('also recognizes slow_input_events key in toolResults.data', () => {
      const response: AgentResponse = {
        agentId: 'interaction_agent',
        taskId: 'task-interaction',
        success: true,
        findings: [],
        confidence: 0.9,
        executionTimeMs: 10,
        toolResults: [
          {
            success: true,
            executionTimeMs: 8,
            data: {
              slow_input_events: {
                columns: SLOW_EVENT_COLUMNS,
                rows: [noticeEvent],
              },
            },
          },
        ],
      };

      const intervals = extract([response], intervalHelpers);
      expect(intervals).toHaveLength(1);
      expect(intervals[0].metadata!.severity).toBe('notice');
    });

    it('handles missing event_end_ts by falling back to event_ts', () => {
      const noEndTsEvent = [
        '5000000000000', // event_ts
        null,            // event_end_ts → null
        60, 15, 40, 5,
        'MOTION_EVENT', 'TAP', 'com.other.app', 'CPU', 'warning',
        '5000000000000', null,
      ];

      const responses: AgentResponse[] = [buildInteractionResponse([noEndTsEvent])];
      const intervals = extract(responses, intervalHelpers);

      expect(intervals).toHaveLength(1);
      // When event_end_ts is null/empty, it falls back to event_ts
      expect(intervals[0].endTs).toBe('5000000000000');
    });

    it('response with no toolResults returns 0 intervals', () => {
      const response: AgentResponse = {
        agentId: 'interaction_agent',
        taskId: 'task-interaction',
        success: true,
        findings: [],
        confidence: 0.9,
        executionTimeMs: 10,
      };
      const intervals = extract([response], intervalHelpers);
      expect(intervals).toHaveLength(0);
    });
  });
});