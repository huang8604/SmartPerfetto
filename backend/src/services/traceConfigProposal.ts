// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import {
  calculateCaptureBufferSizeKb,
  getCapturePreset,
  renderAndroidTraceConfig,
  type CapturePresetDefinition,
  type CapturePresetId,
} from './traceCaptureConfig';
import { generateTraceConfig } from './traceConfigGenerator';
import { localize, parseOutputLanguage, type OutputLanguage } from '../agentv3/outputLanguage';

export type TraceConfigProposalConfidence = 'high' | 'medium' | 'low';

export interface TraceConfigProposalInput {
  request: string;
  app?: string;
  durationSeconds?: number;
  categories?: string[];
  cuj?: string;
  outputLanguage?: OutputLanguage;
  now?: Date;
}

export interface TraceConfigProposalCommand {
  config: string[];
  capture: string[];
}

export interface TraceConfigProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  createdAt: string;
  source: 'deterministic';
  target: 'android';
  request: string;
  app: string;
  preset: CapturePresetId;
  presetLabel: string;
  intent: CapturePresetDefinition['intent'];
  confidence: TraceConfigProposalConfidence;
  rationale: string[];
  warnings: string[];
  blockedDangerousOptions: string[];
  command: TraceConfigProposalCommand;
  config: {
    textproto: string;
    dataSources: string[];
    ftraceEvents: string[];
    atraceCategories: string[];
    durationSeconds: number;
    bufferSizeKb: number;
  };
}

interface IntentRule {
  preset: CapturePresetId;
  confidence: TraceConfigProposalConfidence;
  rationale: string;
  requiredKeywords?: string[];
  keywords: string[];
}

interface RuleMatch {
  rule: IntentRule;
  score: number;
  matches: string[];
}

const INTENT_RULES: IntentRule[] = [
  {
    preset: 'camera',
    confidence: 'high',
    rationale: 'Camera investigations need request activity, binder, scheduler, preview presentation, and DMA-BUF/ION allocation evidence.',
    requiredKeywords: [
      'camera', 'camera2', 'camerax', 'cameraserver', 'camera hal',
      '摄像头', '相机', '取景器',
    ],
    keywords: [
      'open camera', 'camera open', 'camera startup', 'first preview',
      'preview frame', 'capture request', 'capture result', 'hal3',
      '打开相机', '相机启动', '首帧预览', '预览首帧', '拍照延迟',
    ],
  },
  {
    preset: 'startup',
    confidence: 'high',
    rationale: 'Startup investigations need launch, first-frame, scheduler, binder, IO, and FrameTimeline coverage.',
    keywords: [
      'startup',
      'start up',
      'cold start',
      'launch',
      'first frame',
      'first-frame',
      'app start',
      '启动',
      '冷启动',
      '首帧',
      '打开应用',
    ],
  },
  {
    preset: 'scrolling',
    confidence: 'high',
    rationale: 'Scrolling and jank investigations need FrameTimeline, input, scheduler, CPU/GPU frequency, and binder context.',
    keywords: [
      'scroll',
      'scrolling',
      'jank',
      'frame',
      'dropped frame',
      'stutter',
      'fling',
      '滑动',
      '滚动',
      '卡顿',
      '掉帧',
      '帧率',
    ],
  },
  {
    preset: 'anr',
    confidence: 'high',
    rationale: 'ANR investigations need input, main-thread scheduling, binder, IO, and logcat context.',
    keywords: [
      'anr',
      'not responding',
      'input timeout',
      'main thread block',
      'main-thread block',
      '主线程',
      '无响应',
      '卡死',
    ],
  },
  {
    preset: 'memory',
    confidence: 'high',
    rationale: 'Memory investigations need process stats, reclaim, LMK-adj, GC, IO, and logcat context.',
    keywords: [
      'memory',
      'mem',
      'heap',
      'gc',
      'lmk',
      'oom',
      'leak',
      '内存',
      '泄漏',
      '回收',
    ],
  },
  {
    preset: 'power',
    confidence: 'high',
    rationale: 'Power investigations need battery, power rail, suspend/wakeup, wakelock, thermal, and network drain signals.',
    keywords: [
      'power',
      'battery',
      'battery drain',
      'thermal',
      'wakelock',
      'wake lock',
      'energy',
      '耗电',
      '电量',
      '功耗',
      '温度',
      '发热',
    ],
  },
  {
    preset: 'game',
    confidence: 'medium',
    rationale: 'Rendering and game investigations need app/SF frame signals, GPU counters, render stages, and scheduling context.',
    keywords: [
      'gpu',
      'render',
      'rendering',
      'game',
      'surfaceflinger',
      'hwc',
      '游戏',
      '渲染',
      '图形',
    ],
  },
  {
    preset: 'cpu',
    confidence: 'medium',
    rationale: 'CPU investigations need scheduler, CPU frequency/idle, process stats, and lightweight app context.',
    keywords: [
      'cpu',
      'scheduler',
      'sched',
      'thread state',
      'blocked reason',
      '线程',
      '调度',
    ],
  },
  {
    preset: 'full',
    confidence: 'medium',
    rationale: 'Full diagnostic capture is broad and higher overhead; use only when the request explicitly asks for maximum coverage.',
    keywords: [
      'full diagnostic',
      'everything',
      'all signals',
      'maximum coverage',
      'comprehensive',
      '全量',
      '全部',
      '完整',
    ],
  },
  {
    preset: 'overview',
    confidence: 'medium',
    rationale: 'Overview capture is the balanced default for first-pass SmartPerfetto analysis.',
    keywords: [
      'overview',
      'generic',
      'general',
      'first pass',
      'not sure',
      '默认',
      '通用',
      '先看一下',
    ],
  },
];

const DOMAIN_MATCH_BONUS = Math.max(
  ...INTENT_RULES
    .filter(rule => !rule.requiredKeywords)
    .map(rule => rule.keywords.length),
) + 1;

const PRESET_RATIONALE_ZH: Partial<Record<CapturePresetId, string>> = {
  camera: 'Camera 分析需要覆盖 request activity、binder、调度、预览呈现和 DMA-BUF/ION 分配信号。',
  startup: '启动分析需要覆盖 launch、首帧、调度、binder、IO 和 FrameTimeline 信号。',
  scrolling: '滑动和卡顿分析需要 FrameTimeline、input、调度、CPU/GPU 频率和 binder 上下文。',
  anr: 'ANR 分析需要 input、主线程调度、binder、IO 和 logcat 上下文。',
  memory: '内存分析需要 process stats、reclaim、LMK-adj、GC、IO 和 logcat 上下文。',
  power: '功耗分析需要电池、power rail、suspend/wakeup、wakelock、thermal 和网络耗电信号。',
  game: '渲染和游戏分析需要 app/SF frame 信号、GPU counters、渲染阶段和调度上下文。',
  cpu: 'CPU 分析需要 scheduler、CPU frequency/idle、process stats 和轻量 app 上下文。',
  full: 'Full diagnostic capture 覆盖面广且开销更高，只应在明确要求最大覆盖时使用。',
  overview: 'Overview capture 是 SmartPerfetto 首轮分析的均衡默认配置。',
};

const DANGEROUS_OPTION_PATTERNS: Array<{
  option: string;
  pattern: RegExp;
  warningZh: string;
  warningEn: string;
}> = [
  {
    option: 'no_guardrails',
    pattern: /\b(no[- ]?guardrails|disable guardrails|without guardrails)\b/i,
    warningZh: '请求提到了禁用 guardrails；该提案会保持 guardrails 启用。',
    warningEn: 'Request mentioned disabling guardrails; the proposal keeps guardrails enabled.',
  },
  {
    option: 'kill_stale',
    pattern: /\b(kill stale|kill perfetto|kill traced|force kill)\b/i,
    warningZh: '请求提到了终止残留 tracing 进程；该提案不会包含 --kill-stale。',
    warningEn: 'Request mentioned killing stale tracing processes; the proposal does not include --kill-stale.',
  },
  {
    option: 'sideload_tracebox',
    pattern: /\b(sideload|tracebox)\b/i,
    warningZh: '请求提到了 sideload tracebox；该提案会把 sideload 保留为录制时的显式选择。',
    warningEn: 'Request mentioned sideloading tracebox; the proposal leaves sideloading as an explicit capture-time choice.',
  },
];

export function buildTraceConfigProposal(input: TraceConfigProposalInput): TraceConfigProposalV1 {
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const request = normalizeRequest(input.request);
  if (!request) {
    throw new Error('request is required');
  }

  const match = classifyRequest(request);
  const preset = getCapturePreset(match.rule.preset);
  const app = normalizeApp(input.app);
  const durationSeconds = normalizeDuration(input.durationSeconds, preset.defaultDurationSeconds);
  const categories = normalizeCategories(input.categories);
  const generatorContract = generateTraceConfig({
    intent: preset.intent,
    packageName: app,
    cuj: input.cuj,
  });
  const dataSources = unique([
    ...preset.dataSources,
    ...generatorContract.fragments.map(fragment => fragment.dataSource),
  ]);
  const bufferSizeKb = calculateCaptureBufferSizeKb(durationSeconds, preset.bufferSizeKb);
  const blockedDangerousOptions = detectDangerousOptions(request);
  const warnings = buildWarnings({
    request,
    app,
    preset,
    blockedDangerousOptions,
    outputLanguage,
  });
  const textproto = renderAndroidTraceConfig({
    target: 'android',
    preset: preset.id,
    app,
    durationSeconds,
    extraAtraceCategories: categories,
    cuj: input.cuj,
  });
  const createdAt = (input.now ?? new Date()).toISOString();
  const proposalSeed = JSON.stringify({
    request,
    app,
    preset: preset.id,
    durationSeconds,
    categories,
    cuj: input.cuj ?? '',
  });

  return {
    schemaVersion: 1,
    proposalId: `tcp_${createHash('sha256').update(proposalSeed).digest('hex').slice(0, 16)}`,
    createdAt,
    source: 'deterministic',
    target: 'android',
    request,
    app,
    preset: preset.id,
    presetLabel: preset.label,
    intent: preset.intent,
    confidence: confidenceForMatch(match),
    rationale: [
      rationaleForRule(match.rule, outputLanguage),
      localize(
        outputLanguage,
        `匹配 ${match.matches.length} 个关键词：${match.matches.join(', ') || 'fallback overview'}。`,
        `Matched ${match.matches.length} keyword(s): ${match.matches.join(', ') || 'fallback overview'}.`,
      ),
      localize(
        outputLanguage,
        '该提案没有副作用，只渲染 Perfetto textproto 预览。',
        'The proposal is side-effect free and only renders a Perfetto textproto preview.',
      ),
    ],
    warnings,
    blockedDangerousOptions,
    command: buildCommands({
      preset: preset.id,
      app,
      durationSeconds,
      categories,
      cuj: input.cuj,
    }),
    config: {
      textproto,
      dataSources,
      ftraceEvents: [...preset.ftraceEvents],
      atraceCategories: unique([...preset.atraceCategories, ...categories]),
      durationSeconds,
      bufferSizeKb,
    },
  };
}

function rationaleForRule(rule: IntentRule, outputLanguage: OutputLanguage): string {
  return localize(
    outputLanguage,
    PRESET_RATIONALE_ZH[rule.preset] ?? rule.rationale,
    rule.rationale,
  );
}

function normalizeRequest(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeApp(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '*';
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('durationSeconds must be a positive number');
  }
  return duration;
}

function normalizeCategories(values: string[] | undefined): string[] {
  return unique((values ?? []).map(value => value.trim()).filter(Boolean));
}

function classifyRequest(request: string): RuleMatch {
  const normalized = request.toLowerCase();
  let best: RuleMatch | undefined;
  for (const rule of INTENT_RULES) {
    const requiredMatches = (rule.requiredKeywords ?? [])
      .filter(keyword => normalized.includes(keyword.toLowerCase()));
    if (rule.requiredKeywords && requiredMatches.length === 0) continue;
    const keywordMatches = rule.keywords
      .filter(keyword => normalized.includes(keyword.toLowerCase()));
    const matches = unique([...requiredMatches, ...keywordMatches]);
    const score = keywordMatches.length
      + (requiredMatches.length > 0 ? DOMAIN_MATCH_BONUS : 0);
    if (!best || score > best.score) {
      best = { rule, score, matches };
    }
  }
  if (best && best.score > 0) return best;
  const overview = INTENT_RULES[INTENT_RULES.length - 1];
  return { rule: overview, score: 0, matches: [] };
}

function confidenceForMatch(match: RuleMatch): TraceConfigProposalConfidence {
  if (match.score === 0) return 'low';
  return match.rule.confidence;
}

function detectDangerousOptions(request: string): string[] {
  return DANGEROUS_OPTION_PATTERNS
    .filter(entry => entry.pattern.test(request))
    .map(entry => entry.option);
}

function buildWarnings(input: {
  request: string;
  app: string;
  preset: CapturePresetDefinition;
  blockedDangerousOptions: string[];
  outputLanguage: OutputLanguage;
}): string[] {
  const warnings: string[] = [];
  if (input.app === '*') {
    warnings.push(localize(
      input.outputLanguage,
      '未提供 app 包名；生成的配置会用 atrace_apps: "*" 覆盖所有 app。',
      'No app package was provided; generated config targets all apps with atrace_apps: "*".',
    ));
  }
  if (input.preset.id === 'full') {
    warnings.push(localize(
      input.outputLanguage,
      'Full diagnostic capture 开销较高；调查目标明确时优先使用更窄的 preset。',
      'Full diagnostic capture is high overhead; prefer a narrower preset when the investigation target is known.',
    ));
  }
  for (const entry of DANGEROUS_OPTION_PATTERNS) {
    if (input.blockedDangerousOptions.includes(entry.option)) {
      warnings.push(localize(input.outputLanguage, entry.warningZh, entry.warningEn));
    }
  }
  if (/\b(all categories|every category|all atrace|全部分类)\b/i.test(input.request)) {
    warnings.push(localize(
      input.outputLanguage,
      '请求提到了宽泛 atrace categories；除非显式传入 --categories，否则提案会使用所选 preset 的 categories。',
      'Request mentioned broad atrace categories; the proposal uses the selected preset categories unless --categories is provided explicitly.',
    ));
  }
  return warnings;
}

function buildCommands(input: {
  preset: CapturePresetId;
  app: string;
  durationSeconds: number;
  categories: string[];
  cuj?: string;
}): TraceConfigProposalCommand {
  const commonArgs = [
    '--preset',
    input.preset,
    '--app',
    input.app,
    '--duration',
    String(input.durationSeconds),
    ...(input.cuj ? ['--cuj', input.cuj] : []),
    ...input.categories.flatMap(category => ['--categories', category]),
  ];
  return {
    config: ['smp', 'capture', 'config', ...commonArgs],
    capture: ['smp', 'capture', 'android', ...commonArgs, '--out', '<trace.perfetto-trace>'],
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
