// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceDataset } from '../core/orchestratorTypes';
import type { SelectionContext } from '../../agentv3/types';
import { selectAnalysisEligibleScenes } from './sceneIntervalBuilder';
import type {
  DisplayedScene,
  SceneAnalysisSelection,
  SceneReport,
} from './types';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../../agentv3/outputLanguage';
import {displaySceneType, projectDisplayedScene} from './scenePresentation';

export interface SmartDeepDiveDispatch {
  query: string;
  selectedScenes: DisplayedScene[];
  selectionContext?: SelectionContext;
  traceContext?: TraceDataset[];
  packageName?: string;
}

const STARTUP_TYPES = new Set(['cold_start', 'warm_start', 'hot_start']);
const SCROLL_TYPES = new Set(['scroll', 'inertial_scroll']);
const CLICK_TYPES = new Set(['tap', 'long_press', 'screen_unlock']);
const NAVIGATION_TYPES = new Set(['back_key', 'home_key', 'recents_key', 'navigation', 'window_transition', 'app_switch']);
const DEVICE_TYPES = new Set(['screen_on', 'screen_off', 'screen_sleep', 'idle']);
const ANR_TYPES = new Set(['anr', 'jank_region']);

export function buildSmartDeepDiveDispatch(input: {
  report: SceneReport;
  selection?: SceneAnalysisSelection;
  outputLanguage?: OutputLanguage;
}): SmartDeepDiveDispatch | null {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const selectedScenes = selectAnalysisEligibleScenes(
    input.report.displayedScenes,
    input.selection,
  );
  if (selectedScenes.length === 0) return null;

  const query = buildDispatchQuery(input.selection, selectedScenes, outputLanguage);
  const selectionContext = buildAreaSelectionContext(selectedScenes);
  const traceContext = buildSelectedScenesTraceContext(
    selectedScenes,
    outputLanguage,
  );
  const packageName = inferPackageName(selectedScenes);

  return {
    query,
    selectedScenes: selectedScenes.map(scene =>
      projectDisplayedScene(scene, outputLanguage)),
    selectionContext,
    traceContext,
    packageName,
  };
}

function buildDispatchQuery(
  selection: SceneAnalysisSelection | undefined,
  scenes: DisplayedScene[],
  outputLanguage: OutputLanguage,
): string {
  const sceneTypes = new Set(scenes.map((scene) => scene.sceneType));
  const selectedCount = scenes.length;
  const suffix = localize(
    outputLanguage,
    `（智能分析已选中 ${selectedCount} 个场景）`,
    ` (${selectedCount} Smart Analysis scenes selected)`,
  );

  if (!selection || selection.scope === 'all') {
    return localize(
      outputLanguage,
      `按场景时间线分析这个 trace 的性能问题${suffix}`,
      `Analyze performance issues across this trace's scene timeline${suffix}`,
    );
  }

  if (isSubset(sceneTypes, STARTUP_TYPES)) return localize(outputLanguage, `分析启动性能${suffix}`, `Analyze startup performance${suffix}`);
  if (isSubset(sceneTypes, SCROLL_TYPES)) return localize(outputLanguage, `分析滑动性能${suffix}`, `Analyze scrolling performance${suffix}`);
  if (isSubset(sceneTypes, CLICK_TYPES)) return localize(outputLanguage, `分析点击响应性能${suffix}`, `Analyze tap response performance${suffix}`);
  if (isSubset(sceneTypes, NAVIGATION_TYPES)) return localize(outputLanguage, `分析导航和转场性能${suffix}`, `Analyze navigation and transition performance${suffix}`);
  if (isSubset(sceneTypes, DEVICE_TYPES)) return localize(outputLanguage, `分析设备状态变化对性能的影响${suffix}`, `Analyze how device state changes affect performance${suffix}`);
  if (isSubset(sceneTypes, ANR_TYPES)) return localize(outputLanguage, `分析 ANR 和严重卡顿区间${suffix}`, `Analyze ANR and severe jank intervals${suffix}`);

  const label = selection.label?.trim();
  return outputLanguage === 'zh-CN' && label
    ? `分析${label}相关性能问题${suffix}`
    : localize(
        outputLanguage,
        `分析所选场景的性能问题${suffix}`,
        `Analyze performance issues in the selected scenes${suffix}`,
      );
}

function isSubset(values: Set<string>, allowed: Set<string>): boolean {
  if (values.size === 0) return false;
  for (const value of values) {
    if (!allowed.has(value)) return false;
  }
  return true;
}

function buildAreaSelectionContext(scenes: DisplayedScene[]): SelectionContext | undefined {
  let start: bigint | undefined;
  let end: bigint | undefined;
  for (const scene of scenes) {
    const sceneStart = parseNs(scene.startTs);
    const sceneEnd = parseNs(scene.endTs);
    if (sceneStart == null || sceneEnd == null) continue;
    start = start == null || sceneStart < start ? sceneStart : start;
    end = end == null || sceneEnd > end ? sceneEnd : end;
  }
  if (start == null || end == null || end < start) return undefined;

  const startNs = Number(start);
  const endNs = Number(end);
  if (!Number.isSafeInteger(startNs) || !Number.isSafeInteger(endNs)) {
    return undefined;
  }

  return {
    kind: 'area',
    startNs,
    endNs,
    durationNs: endNs - startNs,
    trackCount: 0,
  };
}

function buildSelectedScenesTraceContext(
  scenes: DisplayedScene[],
  outputLanguage: OutputLanguage,
): TraceDataset[] {
  return [{
    label: localize(
      outputLanguage,
      '智能分析选中的场景时间线',
      'Smart Analysis selected scene timeline',
    ),
    columns: [
      '#',
      'scene_type',
      'label',
      'start_s',
      'end_s',
      'duration_ms',
      'process',
      'severity',
      'role',
      'confidence',
      'parent_scene_id',
      'child_scene_ids',
      'source_id',
    ],
    rows: scenes.map((scene, index) => [
      index + 1,
      scene.sceneType,
      displaySceneType(scene.sceneType, outputLanguage),
      formatSeconds(scene.startTs),
      formatSeconds(scene.endTs),
      Math.round(scene.durationMs),
      scene.processName || '-',
      scene.severity,
      scene.sceneRole || 'action',
      typeof scene.confidenceScore === 'number' ? scene.confidenceScore.toFixed(2) : '-',
      scene.parentSceneId || '-',
      scene.childSceneIds?.join(',') || '-',
      scene.id,
    ]),
  }];
}

function inferPackageName(scenes: DisplayedScene[]): string | undefined {
  for (const scene of scenes) {
    const processName = scene.processName?.trim();
    if (!processName || processName === 'system') continue;
    return processName;
  }
  return undefined;
}

function parseNs(value: string): bigint | undefined {
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function formatSeconds(value: string): string {
  const parsed = parseNs(value);
  if (parsed == null) return value;
  return (Number(parsed) / 1e9).toFixed(3);
}
