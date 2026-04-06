// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ReferencedEntity } from '../types';

export type ReferencedEntityType = ReferencedEntity['type'];

export interface EntityDescriptor {
  type: ReferencedEntityType;
  paramKey: string;
  label: string;
  idFieldKeys: string[];
  drillDownStrategy?: string;
}

export type EntityCaptureKind =
  | 'frame'
  | 'session'
  | 'cpu_slice'
  | 'binder'
  | 'gc'
  | 'memory';

const ENTITY_DESCRIPTORS: Record<ReferencedEntityType, EntityDescriptor> = {
  frame: {
    type: 'frame',
    paramKey: 'frame_id',
    label: '帧',
    idFieldKeys: ['frame_id', 'frameId'],
    drillDownStrategy: 'frame_drill_down',
  },
  session: {
    type: 'session',
    paramKey: 'session_id',
    label: '滑动会话',
    idFieldKeys: ['session_id', 'sessionId'],
    drillDownStrategy: 'session_drill_down',
  },
  startup: {
    type: 'startup',
    paramKey: 'startup_id',
    label: '启动事件',
    idFieldKeys: ['startup_id', 'startupId'],
    drillDownStrategy: 'startup_drill_down',
  },
  process: {
    type: 'process',
    paramKey: 'process_name',
    label: '进程',
    idFieldKeys: ['process_name', 'processName', 'package'],
  },
  binder_call: {
    type: 'binder_call',
    paramKey: 'binder_txn_id',
    label: 'Binder 调用',
    idFieldKeys: ['binder_txn_id', 'binderTxnId', 'transaction_id', 'transactionId'],
  },
  time_range: {
    type: 'time_range',
    paramKey: 'time_range',
    label: '时间范围',
    idFieldKeys: ['time_range', 'timeRange'],
  },
};

const ENTITY_CAPTURE_STEP_PATTERNS: Record<EntityCaptureKind, readonly string[]> = {
  frame: ['get_app_jank_frames', 'batch_frame_root_cause', 'jank_frames', 'frame_list', 'frames'],
  session: ['scroll_sessions', 'sessions', 'session_list'],
  cpu_slice: ['cpu_slices', 'sched_slices', 'thread_slices', 'scheduling', 'cpu_timeline'],
  binder: ['binder_transactions', 'binder_calls', 'ipc_transactions', 'binder_blocking'],
  gc: ['gc_events', 'garbage_collection', 'gc_analysis', 'gc_pauses'],
  memory: ['memory_events', 'allocations', 'oom_events', 'lmk_events', 'memory_stats'],
};

export function getEntityDescriptor(type: ReferencedEntityType): EntityDescriptor {
  return ENTITY_DESCRIPTORS[type];
}

export function getEntityParamKey(type: ReferencedEntityType): string {
  return ENTITY_DESCRIPTORS[type].paramKey;
}

export function getEntityLabel(type: ReferencedEntityType): string {
  return ENTITY_DESCRIPTORS[type].label;
}

export function getEntityIdFieldKeys(type: ReferencedEntityType): string[] {
  return [...ENTITY_DESCRIPTORS[type].idFieldKeys];
}

export function getEntityDrillDownStrategy(type: ReferencedEntityType): string | undefined {
  return ENTITY_DESCRIPTORS[type].drillDownStrategy;
}

export function buildEntityLabel(type: ReferencedEntityType, entityId: unknown): string {
  return `${getEntityLabel(type)} ${String(entityId)}`;
}

export function getCaptureStepPatterns(kind: EntityCaptureKind): readonly string[] {
  return ENTITY_CAPTURE_STEP_PATTERNS[kind];
}

export function resolveCaptureEntityKindByStepId(
  stepId: string,
  matchMode: 'exact' | 'contains' = 'exact'
): EntityCaptureKind | null {
  const normalizedStepId = String(stepId || '').trim().toLowerCase();
  if (!normalizedStepId) return null;

  for (const kind of Object.keys(ENTITY_CAPTURE_STEP_PATTERNS) as EntityCaptureKind[]) {
    const patterns = ENTITY_CAPTURE_STEP_PATTERNS[kind];
    for (const pattern of patterns) {
      const normalizedPattern = pattern.toLowerCase();
      if (matchMode === 'exact' && normalizedStepId === normalizedPattern) {
        return kind;
      }
      if (matchMode === 'contains' && normalizedStepId.includes(normalizedPattern)) {
        return kind;
      }
    }
  }
  return null;
}