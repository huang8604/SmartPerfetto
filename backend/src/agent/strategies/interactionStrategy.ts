// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Interaction / Click Response Analysis Strategy
 *
 * A 2-stage deterministic pipeline for analyzing click/touch response performance:
 * 1. Overview: Discover slow input events (latency distribution, bottleneck classification)
 * 2. Per-Event Detail: Deep-dive on each slow event (quadrant, Binder, CPU, blocking, IO)
 *
 * Modelled after scrollingStrategy — Stage 0 runs the overview composite skill with
 * `enable_per_event_detail: false` so the built-in iterator is skipped, then Stage 1
 * runs click_response_detail per slow event via direct_skill execution.
 *
 * Trigger keywords: 点击, 触摸, 输入延迟, click, tap, touch, input latency, etc.
 */

import { AgentResponse } from '../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  FocusInterval,
  IntervalHelpers,
} from './types';
import { unwrapStepResult } from './helpers';

// =============================================================================
// Internal Types
// =============================================================================

interface RawSlowEvent {
  eventTs: string;
  eventEndTs: string;
  totalMs: number;
  dispatchMs: number;
  handlingMs: number;
  ackMs: number;
  eventType: string;
  eventAction: string;
  processName: string;
  mainBottleneck: string;
  severity: string;
  perfettoStart: string;
  perfettoEnd: string;
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// =============================================================================
// Trigger
// =============================================================================

function isInteractionQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    q.includes('点击') ||
    q.includes('触摸') ||
    q.includes('输入延迟') ||
    q.includes('响应延迟') ||
    q.includes('点击慢') ||
    q.includes('响应慢') ||
    q.includes('点击卡顿') ||
    q.includes('click') ||
    q.includes('tap') ||
    q.includes('touch') ||
    q.includes('input latency') ||
    q.includes('response time') ||
    q.includes('click delay') ||
    q.includes('input delay')
  );
}

// =============================================================================
// Interval Extraction: Slow Events (Stage 0 → Stage 1)
// =============================================================================

/**
 * Extract per-event FocusIntervals from the overview stage responses.
 * Parses slow_events data from click_response_analysis to identify
 * individual slow input events that need detailed analysis.
 */
function extractSlowEventIntervals(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): FocusInterval[] {
  const rawEvents: RawSlowEvent[] = [];

  for (const resp of responses) {
    if (!resp.success) continue;

    for (const toolResult of resp.toolResults || []) {
      const data = toolResult.data as any;
      if (!data || typeof data !== 'object') continue;

      // Look for slow_events from click_response_analysis
      const slowEventsPayload = data.slow_events || data.slow_input_events;
      if (slowEventsPayload) {
        const rows = helpers.payloadToObjectRows(unwrapStepResult(slowEventsPayload));
        for (const row of rows) {
          const eventTs = String(row.event_ts ?? '').trim();
          const eventEndTs = String(row.event_end_ts ?? '').trim();
          if (!eventTs || eventTs === '0') continue;

          rawEvents.push({
            eventTs,
            eventEndTs: eventEndTs || eventTs,
            totalMs: toFiniteNumber(row.total_ms),
            dispatchMs: toFiniteNumber(row.dispatch_ms),
            handlingMs: toFiniteNumber(row.handling_ms),
            ackMs: toFiniteNumber(row.ack_ms),
            eventType: String(row.event_type ?? ''),
            eventAction: String(row.event_action ?? ''),
            processName: String(row.process_name ?? ''),
            mainBottleneck: String(row.main_bottleneck ?? ''),
            severity: String(row.severity ?? ''),
            perfettoStart: String(row.perfetto_start ?? '').trim(),
            perfettoEnd: String(row.perfetto_end ?? '').trim(),
          });
        }
      }

      // Also check dataEnvelopes for slow_events step
      const envelopes = (toolResult.dataEnvelopes || []).filter(
        (env: any) =>
          env?.meta?.skillId === 'click_response_analysis' &&
          env?.meta?.stepId === 'slow_input_events'
      );

      for (const env of envelopes) {
        const rows = helpers.payloadToObjectRows(env.data);
        for (const row of rows) {
          const eventTs = String(row.event_ts ?? '').trim();
          if (!eventTs || eventTs === '0') continue;

          // Skip if already captured from rawResults
          if (rawEvents.some(e => e.eventTs === eventTs)) continue;

          rawEvents.push({
            eventTs,
            eventEndTs: String(row.event_end_ts ?? eventTs).trim(),
            totalMs: toFiniteNumber(row.total_ms),
            dispatchMs: toFiniteNumber(row.dispatch_ms),
            handlingMs: toFiniteNumber(row.handling_ms),
            ackMs: toFiniteNumber(row.ack_ms),
            eventType: String(row.event_type ?? ''),
            eventAction: String(row.event_action ?? ''),
            processName: String(row.process_name ?? ''),
            mainBottleneck: String(row.main_bottleneck ?? ''),
            severity: String(row.severity ?? ''),
            perfettoStart: String(row.perfetto_start ?? '').trim(),
            perfettoEnd: String(row.perfetto_end ?? '').trim(),
          });
        }
      }
    }
  }

  if (rawEvents.length === 0) return [];

  // Sort by severity: critical > warning > notice, then by total_ms descending
  const severityOrder: Record<string, number> = {
    critical: 3,
    warning: 2,
    notice: 1,
  };

  rawEvents.sort((a, b) => {
    const sevDiff = (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
    if (sevDiff !== 0) return sevDiff;
    return b.totalMs - a.totalMs;
  });

  // Compute reference time for relative labels
  let referenceNs: string | undefined;
  try {
    referenceNs = rawEvents.reduce(
      (min, cur) => (BigInt(cur.eventTs) < BigInt(min) ? cur.eventTs : min),
      rawEvents[0].eventTs
    );
  } catch {
    /* use absolute if BigInt fails */
  }

  return rawEvents.map((event, index) => {
    const timeLabel = helpers.formatNsRangeLabel(
      event.eventTs,
      event.eventEndTs,
      referenceNs
    );

    return {
      id: index + 1,
      processName: event.processName,
      startTs: event.eventTs,
      endTs: event.eventEndTs,
      priority: rawEvents.length - index,
      label: `${event.eventType} · ${event.totalMs}ms · ${timeLabel}`,
      metadata: {
        eventTs: event.eventTs,
        eventEndTs: event.eventEndTs,
        totalMs: event.totalMs,
        dispatchMs: event.dispatchMs,
        handlingMs: event.handlingMs,
        eventType: event.eventType,
        eventAction: event.eventAction,
        mainBottleneck: event.mainBottleneck,
        severity: event.severity,
        perfettoStart: event.perfettoStart || undefined,
        perfettoEnd: event.perfettoEnd || undefined,
      },
    };
  });
}

// =============================================================================
// Stage Definitions
// =============================================================================

/**
 * Stage 0: Click Response Overview
 *
 * Runs click_response_analysis globally to discover:
 * - Input latency distribution
 * - Slow input events list
 * - Per-event-type breakdown
 * - Input-to-frame correlation
 *
 * The `enable_per_event_detail: false` param skips the built-in iterator
 * so Stage 1 can handle per-event deep dives with strategy-level control.
 */
const overviewStage: StageDefinition = {
  name: 'interaction_overview',
  description: 'Discover slow input events and latency distribution',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：定位慢输入事件',
  tasks: [
    {
      agentId: 'interaction_agent',
      domain: 'interaction',
      scope: 'global',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'click_response_analysis',
      skillParams: {
        enable_per_event_detail: false,
      },
      descriptionTemplate: '分析点击/触摸响应概览（延迟分布、慢事件列表、瓶颈分类）',
    },
  ],
  extractIntervals: extractSlowEventIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return { stop: true, reason: '未检测到慢输入事件，点击响应性能正常' };
    }
    return { stop: false, reason: '' };
  },
};

/**
 * Stage 1: Per-Event Detail Analysis
 *
 * Runs click_response_detail per slow event via direct_skill execution.
 * Covers: quadrant analysis, CPU core distribution, Binder calls,
 * blocking analysis, scheduling latency, file IO.
 *
 * Performance: N deterministic SQL executions per event (0 LLM calls).
 */
const perEventDetailStage: StageDefinition = {
  name: 'event_detail',
  description: 'Per-slow-event deep dive (quadrant/Binder/CPU/blocking/IO)',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：逐个慢事件深入分析',
  tasks: [
    {
      agentId: 'interaction_agent',
      domain: 'interaction',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'click_response_detail',
      paramMapping: {
        // Core timestamps from FocusInterval
        event_ts: 'startTs',
        event_end_ts: 'endTs',
        process_name: 'processName',
        // Metadata sources (resolved via interval.metadata[key])
        total_ms: 'totalMs',
        dispatch_ms: 'dispatchMs',
        handling_ms: 'handlingMs',
        event_type: 'eventType',
        event_action: 'eventAction',
        perfetto_start: 'perfettoStart',
        perfetto_end: 'perfettoEnd',
      },
      descriptionTemplate: '慢事件深挖：{{scopeLabel}}',
    },
  ],
};

// =============================================================================
// Strategy Export
// =============================================================================

export const interactionStrategy: StagedAnalysisStrategy = {
  id: 'interaction',
  name: 'Click Response / Interaction Analysis',
  trigger: isInteractionQuery,
  stages: [overviewStage, perEventDetailStage],
};