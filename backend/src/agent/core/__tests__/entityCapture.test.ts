// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Entity Capture Unit Tests
 */

import {
  captureEntitiesFromResponses,
  captureEntitiesFromIntervals,
  applyCapturedEntities,
  mergeCapturedEntities,
  CapturedEntities,
} from '../entityCapture';
import { createEntityStore, EntityStore } from '../../context/entityStore';
import type { AgentResponse, AgentToolResult } from '../../types/agentProtocol';
import type { FocusInterval } from '../../strategies/types';

describe('entityCapture', () => {
  describe('captureEntitiesFromResponses', () => {
    test('extracts frames from get_app_jank_frames (columnar format)', () => {
      const response: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_1',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            get_app_jank_frames: {
              columns: ['frame_id', 'start_ts', 'end_ts', 'process_name', 'session_id', 'jank_type'],
              rows: [
                [1436069, '123456789000000', '123456889000000', 'com.example.app', 1, 'App Deadline Missed'],
                [1436070, '123456889000000', '123456989000000', 'com.example.app', 1, 'Buffer Stuffing'],
              ],
            },
          },
        }],
      };

      const captured = captureEntitiesFromResponses([response]);

      expect(captured.frames).toHaveLength(2);
      expect(captured.frames[0].frame_id).toBe('1436069');
      expect(captured.frames[0].start_ts).toBe('123456789000000');
      expect(captured.frames[0].jank_type).toBe('App Deadline Missed');
      expect(captured.frames[1].frame_id).toBe('1436070');

      expect(captured.candidateFrameIds).toEqual(['1436069', '1436070']);
    });

    test('extracts sessions from scroll_sessions (array format)', () => {
      const response: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_1',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            scroll_sessions: [
              { session_id: 1, start_ts: '100000000000000', end_ts: '200000000000000', process_name: 'com.example.app', frame_count: 120, jank_count: 5 },
              { session_id: 2, start_ts: '200000000000000', end_ts: '300000000000000', process_name: 'com.example.app', frame_count: 80, jank_count: 2 },
            ],
          },
        }],
      };

      const captured = captureEntitiesFromResponses([response]);

      expect(captured.sessions).toHaveLength(2);
      expect(captured.sessions[0].session_id).toBe('1');
      expect(captured.sessions[0].frame_count).toBe(120);
      expect(captured.sessions[1].session_id).toBe('2');

      expect(captured.candidateSessionIds).toEqual(['1', '2']);
    });

    test('handles camelCase field names', () => {
      const response: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_1',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            jank_frames: [
              { frameId: 1436069, startTs: '123456789000000', endTs: '123456889000000', processName: 'com.example.app', sessionId: 1, jankType: 'App Deadline Missed' },
            ],
          },
        }],
      };

      const captured = captureEntitiesFromResponses([response]);

      expect(captured.frames).toHaveLength(1);
      expect(captured.frames[0].frame_id).toBe('1436069');
      expect(captured.frames[0].start_ts).toBe('123456789000000');
      expect(captured.frames[0].jank_type).toBe('App Deadline Missed');
    });

    test('deduplicates entities by ID', () => {
      const response1: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_1',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            get_app_jank_frames: [
              { frame_id: 1436069, start_ts: '100' },
            ],
          },
        }],
      };

      const response2: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_2',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            frames: [
              { frame_id: 1436069, start_ts: '200' }, // Same ID, different data
            ],
          },
        }],
      };

      const captured = captureEntitiesFromResponses([response1, response2]);

      expect(captured.frames).toHaveLength(1);
      expect(captured.candidateFrameIds).toHaveLength(1);
    });

    test('handles empty responses', () => {
      const captured = captureEntitiesFromResponses([]);
      expect(captured.frames).toHaveLength(0);
      expect(captured.sessions).toHaveLength(0);
    });

    test('handles responses without data', () => {
      const response: AgentResponse = {
        agentId: 'frame_agent',
        taskId: 'task_1',
        success: false,
        findings: [],
        confidence: 0,
        executionTimeMs: 100,
        toolResults: [],
      };

      const captured = captureEntitiesFromResponses([response]);
      expect(captured.frames).toHaveLength(0);
      expect(captured.sessions).toHaveLength(0);
    });
  });

  describe('captureEntitiesFromIntervals', () => {
    test('extracts frame entities from intervals', () => {
      const intervals: FocusInterval[] = [
        {
          id: 0,
          processName: 'com.example.app',
          startTs: '123456789000000',
          endTs: '123456889000000',
          priority: 1,
          label: '帧 1436069',
          metadata: {
            sourceEntityType: 'frame',
            sourceEntityId: 1436069,
            frameId: 1436069,
            sessionId: 1,
            jankType: 'App Deadline Missed',
            durMs: 100,
          },
        },
      ];

      const captured = captureEntitiesFromIntervals(intervals);

      expect(captured.frames).toHaveLength(1);
      expect(captured.frames[0].frame_id).toBe('1436069');
      expect(captured.frames[0].start_ts).toBe('123456789000000');
      expect(captured.frames[0].session_id).toBe('1');
      expect(captured.frames[0].jank_type).toBe('App Deadline Missed');
      expect(captured.frames[0].source).toBe('interval');

      expect(captured.candidateFrameIds).toEqual(['1436069']);
    });

    test('extracts session entities from intervals', () => {
      const intervals: FocusInterval[] = [
        {
          id: 1,
          processName: 'com.example.app',
          startTs: '100000000000000',
          endTs: '200000000000000',
          priority: 1,
          label: '会话 1',
          metadata: {
            sourceEntityType: 'session',
            sourceEntityId: 1,
            sessionId: 1,
            frameCount: 120,
            jankCount: 5,
          },
        },
      ];

      const captured = captureEntitiesFromIntervals(intervals);

      expect(captured.sessions).toHaveLength(1);
      expect(captured.sessions[0].session_id).toBe('1');
      expect(captured.sessions[0].start_ts).toBe('100000000000000');
      expect(captured.sessions[0].frame_count).toBe(120);
      expect(captured.sessions[0].source).toBe('interval');

      expect(captured.candidateSessionIds).toEqual(['1']);
    });

    test('handles snake_case metadata keys', () => {
      const intervals: FocusInterval[] = [
        {
          id: 0,
          processName: 'com.example.app',
          startTs: '123456789000000',
          endTs: '123456889000000',
          priority: 1,
          metadata: {
            sourceEntityType: 'frame',
            frame_id: 1436069,
            session_id: 1,
            jank_type: 'App Deadline Missed',
          },
        },
      ];

      const captured = captureEntitiesFromIntervals(intervals);

      expect(captured.frames).toHaveLength(1);
      expect(captured.frames[0].frame_id).toBe('1436069');
      expect(captured.frames[0].session_id).toBe('1');
      expect(captured.frames[0].jank_type).toBe('App Deadline Missed');
    });
  });

  describe('applyCapturedEntities', () => {
    test('upserts entities and updates candidate lists', () => {
      const store = createEntityStore();
      const captured: CapturedEntities = {
        frames: [
          { frame_id: '1436069', start_ts: '100', end_ts: '200', source: 'table' },
          { frame_id: '1436070', start_ts: '200', end_ts: '300', source: 'table' },
        ],
        sessions: [
          { session_id: '1', start_ts: '100', end_ts: '300', source: 'table' },
        ],
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: ['1436069', '1436070'],
        candidateSessionIds: ['1'],
      };

      applyCapturedEntities(store, captured);

      expect(store.getAllFrames()).toHaveLength(2);
      expect(store.getAllSessions()).toHaveLength(1);
      expect(store.getFrame('1436069')).toBeDefined();
      expect(store.getSession('1')).toBeDefined();
      expect(store.getLastCandidateFrames()).toEqual(['1436069', '1436070']);
      expect(store.getLastCandidateSessions()).toEqual(['1']);
    });

    test('does not overwrite candidates with empty lists', () => {
      const store = createEntityStore();
      store.setLastCandidateFrames(['old1', 'old2']);

      const captured: CapturedEntities = {
        frames: [],
        sessions: [],
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: [],
        candidateSessionIds: [],
      };

      applyCapturedEntities(store, captured);

      // Should preserve old candidates
      expect(store.getLastCandidateFrames()).toEqual(['old1', 'old2']);
    });
  });

  describe('mergeCapturedEntities', () => {
    test('merges multiple captures and deduplicates', () => {
      const capture1: CapturedEntities = {
        frames: [{ frame_id: '1', start_ts: '100' }],
        sessions: [{ session_id: '1', start_ts: '100' }],
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: ['1', '2'],
        candidateSessionIds: ['1'],
      };

      const capture2: CapturedEntities = {
        frames: [
          { frame_id: '1', start_ts: '200' }, // Duplicate
          { frame_id: '3', start_ts: '300' },
        ],
        sessions: [{ session_id: '2', start_ts: '200' }],
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: ['2', '3'],
        candidateSessionIds: ['2'],
      };

      const merged = mergeCapturedEntities(capture1, capture2);

      // Frames deduplicated by ID (first wins)
      expect(merged.frames).toHaveLength(2);
      expect(merged.frames.map(f => f.frame_id).sort()).toEqual(['1', '3']);
      expect(merged.frames.find(f => f.frame_id === '1')?.start_ts).toBe('100'); // First one wins

      // Sessions merged
      expect(merged.sessions).toHaveLength(2);

      // Candidate IDs deduplicated
      expect(merged.candidateFrameIds.sort()).toEqual(['1', '2', '3']);
      expect(merged.candidateSessionIds.sort()).toEqual(['1', '2']);
    });
  });
});