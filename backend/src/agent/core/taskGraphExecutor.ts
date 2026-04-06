// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Task Graph Executor
 *
 * Executes a set of AgentTasks respecting dependency ordering.
 * Dispatches independent tasks in parallel, handles deadlock fallback,
 * and emits DataEnvelopes from agent tool results.
 *
 * Phase 2 addition: CircuitBreaker integration for failure tracking.
 */

import {
  AgentTask,
  AgentResponse,
} from '../types/agentProtocol';
import { AgentMessageBus } from '../communication';
import { CircuitBreaker } from './circuitBreaker';
import { ProgressEmitter } from './orchestratorTypes';

/**
 * Execute tasks respecting dependency ordering.
 * Tasks with satisfied dependencies are dispatched in parallel.
 * If a deadlock is detected (no ready tasks but pending remain), all remaining are dispatched.
 */
export async function executeTaskGraph(
  tasks: AgentTask[],
  messageBus: AgentMessageBus,
  emitter: ProgressEmitter,
  circuitBreaker?: CircuitBreaker
): Promise<AgentResponse[]> {
  const emitTaskDispatched = (task: AgentTask, fallback = false) => {
    emitter.emitUpdate('tool_call', {
      phase: 'task_dispatched',
      taskId: task.id,
      agentId: task.targetAgentId,
      taskTitle: task.description,
      dependencies: task.dependencies || [],
      message: fallback
        ? `派发任务（依赖降级）: ${task.description}`
        : `派发任务: ${task.description}`,
    });
  };

  const emitTaskCompleted = (response: AgentResponse) => {
    const findingsCount = Array.isArray(response.findings) ? response.findings.length : 0;
    const toolResultCount = Array.isArray(response.toolResults) ? response.toolResults.length : 0;
    emitter.emitUpdate('tool_call', {
      phase: 'task_completed',
      taskId: response.taskId,
      agentId: response.agentId,
      success: response.success,
      findingsCount,
      toolResultCount,
      summary: response.success
        ? `任务完成，发现 ${findingsCount} 条，工具返回 ${toolResultCount} 个`
        : '任务失败，请查看后续诊断信息',
    });
  };

  const pending = new Map<string, AgentTask>(tasks.map(task => [task.id, task]));
  const completed = new Set<string>();
  const responses: AgentResponse[] = [];

  while (pending.size > 0) {
    const ready = Array.from(pending.values()).filter(task =>
      (task.dependencies || []).every(dep => completed.has(dep))
    );

    if (ready.length === 0) {
      // Deadlock: execute remaining tasks without dependency gating
      const remaining = Array.from(pending.values());
      emitter.emitUpdate('progress', {
        phase: 'task_graph_stalled',
        pending: remaining.map(t => t.id),
        message: '任务依赖无法满足，继续执行剩余任务',
      });

      remaining.forEach((task) => emitTaskDispatched(task, true));
      const fallbackResponses = await messageBus.dispatchTasksParallel(remaining);
      responses.push(...fallbackResponses);
      fallbackResponses.forEach((response) => emitTaskCompleted(response));
      fallbackResponses.forEach(r => completed.add(r.taskId));
      pending.clear();
      break;
    }

    ready.forEach((task) => emitTaskDispatched(task));
    const batchResponses = await messageBus.dispatchTasksParallel(ready);
    responses.push(...batchResponses);
    batchResponses.forEach((response) => emitTaskCompleted(response));
    batchResponses.forEach(r => completed.add(r.taskId));
    ready.forEach(task => pending.delete(task.id));
  }

  // Phase 2: CircuitBreaker failure tracking
  if (circuitBreaker) {
    for (const response of responses) {
      if (!response.success) {
        const decision = circuitBreaker.recordFailure(
          response.agentId,
          `Task ${response.taskId} failed`
        );
        if (decision.action === 'ask_user') {
          emitter.emitUpdate('circuit_breaker', {
            agentId: response.agentId,
            reason: decision.reason || `Agent ${response.agentId} 失败次数过多`,
          });
        }
      } else {
        circuitBreaker.recordSuccess(response.agentId);
      }
    }
  }

  return responses;
}

import {
  EmittedEnvelopeRegistry,
  generateDeduplicationKey,
} from './emittedEnvelopeRegistry';

/**
 * Emit DataEnvelopes from agent responses via SSE.
 * Filters out empty tables and duplicates (if registry provided).
 *
 * @param responses - Agent responses containing DataEnvelopes
 * @param emitter - Progress emitter for SSE
 * @param registry - Optional registry for session-level deduplication
 */
export function emitDataEnvelopes(
  responses: AgentResponse[],
  emitter: ProgressEmitter,
  registry?: EmittedEnvelopeRegistry
): void {
  const toolResultCounts = responses.map(r => ({
    agentId: r.agentId,
    toolResults: r.toolResults?.length || 0,
    envelopes: r.toolResults?.reduce((sum, tr) => sum + (tr.dataEnvelopes?.length || 0), 0) || 0,
  }));
  emitter.log(`emitDataEnvelopes: ${responses.length} responses, tool results: ${JSON.stringify(toolResultCounts)}`);

  const allEnvelopes = responses
    .flatMap(response => response.toolResults || [])
    .flatMap(result => result.dataEnvelopes || []);

  // Filter out envelopes with no data rows (empty tables add noise without value)
  let envelopes = allEnvelopes.filter(env => {
    const payload = env.data as any;
    if (!payload) return false;
    // Keep non-table formats (text, summary, chart, etc.)
    if (env.display.format !== 'table' && env.display.format !== undefined) return true;
    // For tables: require at least one row
    const rows = payload.rows;
    return rows && Array.isArray(rows) && rows.length > 0;
  });

  const emptyFilteredCount = allEnvelopes.length - envelopes.length;
  if (emptyFilteredCount > 0) {
    emitter.log(`Filtered out ${emptyFilteredCount} empty DataEnvelope(s)`);
  }

  // Apply session-level deduplication if registry provided
  let duplicateFilteredCount = 0;
  if (registry) {
    const beforeCount = envelopes.length;
    envelopes = registry.filterNewEnvelopes(envelopes);
    duplicateFilteredCount = beforeCount - envelopes.length;
    if (duplicateFilteredCount > 0) {
      emitter.log(`Filtered out ${duplicateFilteredCount} duplicate DataEnvelope(s)`);
    }
  }

  if (envelopes.length > 0) {
    const keys = envelopes.map(e => generateDeduplicationKey(e));
    emitter.log(`Emitting ${envelopes.length} DataEnvelope(s): [${keys.join(', ')}]`);
    emitter.emitUpdate('data', envelopes);
  } else {
    emitter.log('No DataEnvelopes to emit (all responses had empty toolResults, no envelopes, or duplicates)');
  }
}