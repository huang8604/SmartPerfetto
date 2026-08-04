// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {
  generateTraceConfig,
  type TraceIntent,
} from './traceConfigGenerator';

export type CapturePresetId =
  | 'startup'
  | 'scrolling'
  | 'camera'
  | 'anr'
  | 'game'
  | 'memory'
  | 'cpu'
  | 'power'
  | 'overview'
  | 'full';

export type CaptureTarget = 'android' | 'linux';

export interface CaptureConfigRenderOptions {
  target: CaptureTarget;
  preset: CapturePresetId;
  app?: string;
  durationSeconds: number;
  bufferSizeKb?: number;
  extraAtraceCategories?: string[];
  cuj?: string;
}

export interface CapturePresetDefinition {
  id: CapturePresetId;
  label: string;
  intent: TraceIntent;
  defaultDurationSeconds: number;
  bufferSizeKb: number;
  atraceCategories: string[];
  ftraceEvents: string[];
  dataSources: string[];
  description: string;
}

const COMMON_DATA_SOURCES = [
  'android.packages_list',
  'linux.process_stats',
  'linux.sys_stats',
  'android.log',
];

const COMMON_FTRACE_EVENTS = [
  'sched/sched_switch',
  'sched/sched_blocked_reason',
  'sched/sched_waking',
  'sched/sched_wakeup',
  'sched/sched_wakeup_new',
  'sched/sched_process_exit',
  'sched/sched_process_free',
  'task/task_newtask',
  'task/task_rename',
  'power/cpu_frequency',
  'power/cpu_idle',
  'ftrace/print',
];

const BINDER_EVENTS = [
  'binder/binder_transaction',
  'binder/binder_transaction_received',
  'binder/binder_transaction_alloc_buf',
  'binder/binder_set_priority',
  'binder/binder_lock',
  'binder/binder_locked',
  'binder/binder_unlock',
];

const CAMERA_MEMORY_EVENTS = [
  'dmabuf_heap/dma_heap_stat',
  'ion/ion_stat',
  // Older Pixel/vendor kernels expose the legacy ION allocation pair rather
  // than ion_stat. Unsupported ftrace events are ignored by traced.
  'kmem/ion_heap_grow',
  'kmem/ion_heap_shrink',
];

const IO_EVENTS = [
  'block/block_rq_issue',
  'block/block_rq_complete',
  'f2fs/f2fs_sync_file_enter',
  'f2fs/f2fs_sync_file_exit',
  'ext4/ext4_sync_file_enter',
  'ext4/ext4_sync_file_exit',
];

const MEMORY_EVENTS = [
  'oom/oom_score_adj_update',
  'kmem/rss_stat',
  'vmscan/mm_vmscan_direct_reclaim_begin',
  'vmscan/mm_vmscan_direct_reclaim_end',
  'vmscan/mm_vmscan_kswapd_wake',
];

const POWER_EVENTS = [
  'power/suspend_resume',
  'power/wakeup_source_activate',
  'power/wakeup_source_deactivate',
  'power/gpu_frequency',
  'thermal/thermal_temperature',
  'thermal/cdev_update',
];

export const CAPTURE_PRESETS: CapturePresetDefinition[] = [
  {
    id: 'startup',
    label: 'Android startup',
    intent: 'startup',
    defaultDurationSeconds: 20,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'dalvik', 'binder_driver', 'pm', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...IO_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline'],
    description: 'App launch and first-frame investigation with sched, binder, IO, logcat, and FrameTimeline.',
  },
  {
    id: 'scrolling',
    label: 'Android scrolling/jank',
    intent: 'scrolling',
    defaultDurationSeconds: 15,
    bufferSizeKb: 65536,
    atraceCategories: ['gfx', 'view', 'input', 'wm', 'am', 'binder_driver', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, 'power/gpu_frequency'],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Scrolling and frame-jank capture with FrameTimeline, input, scheduler, and CPU/GPU frequency.',
  },
  {
    id: 'camera',
    label: 'Android Camera',
    intent: 'camera',
    defaultDurationSeconds: 20,
    bufferSizeKb: 98304,
    atraceCategories: ['camera', 'hal', 'gfx', 'view', 'binder_driver', 'freq', 'sched'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...CAMERA_MEMORY_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline'],
    description: 'Camera request, binder, scheduler, preview presentation, and DMA-BUF/ION allocation evidence.',
  },
  {
    id: 'anr',
    label: 'Android ANR/main-thread block',
    intent: 'anr',
    defaultDurationSeconds: 30,
    bufferSizeKb: 98304,
    atraceCategories: ['am', 'wm', 'view', 'input', 'dalvik', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...IO_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.input.inputevent'],
    description: 'ANR and main-thread blocking with input, binder, scheduler, IO, and logcat context.',
  },
  {
    id: 'game',
    label: 'Android game/rendering',
    intent: 'gpu',
    defaultDurationSeconds: 20,
    bufferSizeKb: 98304,
    atraceCategories: ['gfx', 'view', 'input', 'wm', 'am', 'hal', 'video', 'rs', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, 'power/gpu_frequency'],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'gpu.counters', 'gpu.renderstages'],
    description: 'Game and native rendering capture with app/SF frame signals plus CPU/GPU scheduling context.',
  },
  {
    id: 'memory',
    label: 'Android memory',
    intent: 'memory',
    defaultDurationSeconds: 30,
    bufferSizeKb: 98304,
    atraceCategories: ['am', 'wm', 'view', 'dalvik', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...MEMORY_EVENTS, ...IO_EVENTS],
    dataSources: COMMON_DATA_SOURCES,
    description: 'Memory pressure, GC, process stats, LMK-adj, reclaim, IO, and logcat correlation.',
  },
  {
    id: 'cpu',
    label: 'Android CPU/scheduler',
    intent: 'generic',
    defaultDurationSeconds: 15,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS],
    dataSources: COMMON_DATA_SOURCES,
    description: 'Scheduler, CPU frequency/idle, process stats, and lightweight app context.',
  },
  {
    id: 'power',
    label: 'Android power/battery',
    intent: 'power',
    defaultDurationSeconds: 60,
    bufferSizeKb: 131072,
    atraceCategories: ['am', 'pm', 'power', 'network', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...POWER_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.power', 'android.network_packets'],
    description: 'Battery drain, power rails, suspend/wakeup, wakelock, CPU idle/frequency, and modem correlation.',
  },
  {
    id: 'overview',
    label: 'Android overview',
    intent: 'generic',
    defaultDurationSeconds: 20,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'dalvik', 'binder_driver', 'pm', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Balanced default for scene discovery and first-pass SmartPerfetto analysis.',
  },
  {
    id: 'full',
    label: 'Android full diagnostic',
    intent: 'generic',
    defaultDurationSeconds: 20,
    bufferSizeKb: 131072,
    atraceCategories: [
      'am',
      'adb',
      'aidl',
      'dalvik',
      'audio',
      'binder_lock',
      'binder_driver',
      'bionic',
      'camera',
      'database',
      'gfx',
      'hal',
      'input',
      'network',
      'nnapi',
      'pm',
      'power',
      'rs',
      'res',
      'rro',
      'sm',
      'ss',
      'vibrator',
      'video',
      'view',
      'webview',
      'wm',
    ],
    ftraceEvents: [
      ...COMMON_FTRACE_EVENTS,
      ...BINDER_EVENTS,
      ...IO_EVENTS,
      ...MEMORY_EVENTS,
      ...CAMERA_MEMORY_EVENTS,
      'irq/irq_handler_entry',
      'irq/irq_handler_exit',
      'sync/sync_timeline',
      'sync/sync_wait',
      'power/gpu_frequency',
      'raw_syscalls/sys_enter',
      'raw_syscalls/sys_exit',
    ],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Broad diagnostic preset based on the local full config pattern; higher overhead, richer evidence.',
  },
];

const PRESET_BY_ID = new Map(CAPTURE_PRESETS.map((preset) => [preset.id, preset]));

export function getCapturePreset(id: CapturePresetId): CapturePresetDefinition {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new Error(`unknown capture preset: ${id}`);
  return preset;
}

export function isCapturePresetId(value: string): value is CapturePresetId {
  return PRESET_BY_ID.has(value as CapturePresetId);
}

export function listCapturePresets(): CapturePresetDefinition[] {
  return [...CAPTURE_PRESETS];
}

export function renderAndroidTraceConfig(opts: CaptureConfigRenderOptions): string {
  if (opts.target !== 'android') {
    throw new Error(`capture config target ${opts.target} is not implemented`);
  }

  const preset = getCapturePreset(opts.preset);
  const durationMs = Math.round((opts.durationSeconds ?? preset.defaultDurationSeconds) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('capture duration must be a positive number of seconds');
  }

  const packageName = opts.app?.trim() || '*';
  const contract = generateTraceConfig({
    intent: preset.intent,
    packageName,
    cuj: opts.cuj,
  });
  const dataSources = unique([
    ...preset.dataSources,
    ...contract.fragments.map((fragment) => fragment.dataSource),
  ]);
  const ftraceEvents = unique(preset.ftraceEvents);
  const atraceCategories = unique([
    ...preset.atraceCategories,
    ...(opts.extraAtraceCategories ?? []),
  ]);
  const bufferSizeKb = opts.bufferSizeKb ?? calculateCaptureBufferSizeKb(opts.durationSeconds, preset.bufferSizeKb);

  return [
    `# SmartPerfetto capture preset: ${preset.id}`,
    `# ${preset.description}`,
    `# Trace config generator rationale: ${contract.rationale}`,
    'buffers {',
    `  size_kb: ${bufferSizeKb}`,
    '  fill_policy: RING_BUFFER',
    '}',
    'buffers {',
    '  size_kb: 4096',
    '  fill_policy: RING_BUFFER',
    '}',
    ...dataSources
      .filter((source) => source !== 'linux.ftrace')
      .map((source) => renderDataSource(source)),
    'data_sources {',
    '  config {',
    '    name: "linux.ftrace"',
    '    target_buffer: 0',
    '    ftrace_config {',
    ...ftraceEvents.map((event) => `      ftrace_events: "${escapeTextProto(event)}"`),
    ...atraceCategories.map((category) => `      atrace_categories: "${escapeTextProto(category)}"`),
    `      atrace_apps: "${escapeTextProto(packageName)}"`,
    '    }',
    '  }',
    '}',
    `duration_ms: ${durationMs}`,
    'flush_period_ms: 5000',
    'incremental_state_config {',
    '  clear_period_ms: 5000',
    '}',
    '',
  ].join('\n');
}

export function readTraceConfigFile(
  configPath: string,
  opts: { durationSeconds?: number; bufferSizeKb?: number } = {},
): { path: string; textproto: string; durationMs?: number; templated: boolean } {
  const resolved = path.resolve(configPath);
  const source = fs.readFileSync(resolved, 'utf-8');
  const rendered = renderTraceConfigTemplate(source, opts);
  return {
    path: resolved,
    textproto: rendered.textproto,
    durationMs: extractDurationMs(rendered.textproto),
    templated: rendered.templated,
  };
}

export function renderTraceConfigTemplate(
  textproto: string,
  opts: { durationSeconds?: number; bufferSizeKb?: number } = {},
): { textproto: string; templated: boolean } {
  const needsDuration = textproto.includes('{duration_ms}');
  const needsBuffer = textproto.includes('{buffer_size_kb}');
  if (!needsDuration && !needsBuffer) {
    return { textproto, templated: false };
  }
  if (needsDuration && opts.durationSeconds === undefined) {
    throw new Error('config template contains {duration_ms}; pass --duration <seconds>');
  }
  const durationMs = opts.durationSeconds !== undefined
    ? Math.round(opts.durationSeconds * 1000)
    : undefined;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    throw new Error('--duration must be a positive number of seconds');
  }
  const bufferSizeKb = opts.bufferSizeKb
    ?? calculateCaptureBufferSizeKb(opts.durationSeconds ?? 10);
  return {
    textproto: textproto
      .replace(/\{duration_ms\}/g, String(durationMs ?? ''))
      .replace(/\{buffer_size_kb\}/g, String(bufferSizeKb)),
    templated: true,
  };
}

export function addAtraceCategories(textproto: string, categories: string[]): string {
  const clean = unique(categories.map((category) => category.trim()));
  if (clean.length === 0) return textproto;
  const existing = new Set(
    [...textproto.matchAll(/\batrace_categories\s*:\s*"((?:\\"|[^"])*)"/g)]
      .map((match) => unescapeTextProto(match[1] ?? '')),
  );
  const additions = clean.filter((category) => !existing.has(category));
  if (additions.length === 0) return textproto;

  const atraceApps = textproto.match(/(\s*)atrace_apps\s*:/);
  if (atraceApps?.index !== undefined) {
    const indent = atraceApps[1] ?? '';
    const insert = additions.map((category) => `${indent}atrace_categories: "${escapeTextProto(category)}"`).join('\n');
    return `${textproto.slice(0, atraceApps.index)}${insert}\n${textproto.slice(atraceApps.index)}`;
  }

  const ftrace = textproto.match(/(\s*)ftrace_config\s*\{/);
  if (ftrace?.index !== undefined) {
    const lineEnd = textproto.indexOf('\n', ftrace.index);
    const insertAt = lineEnd >= 0 ? lineEnd + 1 : ftrace.index + ftrace[0].length;
    const indent = `${ftrace[1] ?? ''}  `;
    const insert = additions.map((category) => `${indent}atrace_categories: "${escapeTextProto(category)}"`).join('\n');
    return `${textproto.slice(0, insertAt)}${insert}\n${textproto.slice(insertAt)}`;
  }

  throw new Error('--categories requires a Perfetto config with ftrace_config or atrace_apps');
}

export function calculateCaptureBufferSizeKb(durationSeconds: number, minimumKb = 65536): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('--duration must be a positive number of seconds');
  }
  const estimatedKb = Math.round(durationSeconds * 8 * 1024);
  const clampedKb = Math.max(64 * 1024, Math.min(512 * 1024, estimatedKb));
  return Math.max(minimumKb, clampedKb);
}

export function extractDurationMs(textproto: string): number | undefined {
  const matches = [...textproto.matchAll(/^\s*duration_ms\s*:\s*(\d+)\s*$/gm)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return undefined;
  const value = Number.parseInt(last, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function renderDataSource(source: string): string {
  switch (source) {
    case 'android.network_packets':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.network_packets"',
        '    target_buffer: 1',
        '    android_network_packets_config {',
        '      poll_ms: 250',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'android.power':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.power"',
        '    target_buffer: 1',
        '    android_power_config {',
        '      battery_poll_ms: 1000',
        '      battery_counters: BATTERY_COUNTER_CHARGE',
        '      battery_counters: BATTERY_COUNTER_CAPACITY_PERCENT',
        '      battery_counters: BATTERY_COUNTER_CURRENT',
        '      battery_counters: BATTERY_COUNTER_CURRENT_AVG',
        '      battery_counters: BATTERY_COUNTER_VOLTAGE',
        '      collect_power_rails: true',
        '      collect_energy_estimation_breakdown: true',
        '      collect_entity_state_residency: true',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'linux.process_stats':
      return [
        'data_sources {',
        '  config {',
        '    name: "linux.process_stats"',
        '    target_buffer: 1',
        '    process_stats_config {',
        '      scan_all_processes_on_start: true',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'linux.sys_stats':
      return [
        'data_sources {',
        '  config {',
        '    name: "linux.sys_stats"',
        '    target_buffer: 1',
        '    sys_stats_config {',
        '      stat_period_ms: 1000',
        '      stat_counters: STAT_CPU_TIMES',
        '      stat_counters: STAT_FORK_COUNT',
        '      cpufreq_period_ms: 1000',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'android.log':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.log"',
        '    target_buffer: 1',
        '    android_log_config {',
        '      log_ids: LID_DEFAULT',
        '    }',
        '  }',
        '}',
      ].join('\n');
    default:
      return [
        'data_sources {',
        '  config {',
        `    name: "${escapeTextProto(source)}"`,
        '    target_buffer: 1',
        '  }',
        '}',
      ].join('\n');
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function escapeTextProto(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeTextProto(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
