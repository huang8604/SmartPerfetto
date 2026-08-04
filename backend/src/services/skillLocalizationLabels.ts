// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';

const ACRONYMS = new Map<string, string>([
  ['ai', 'AI'],
  ['anr', 'ANR'],
  ['api', 'API'],
  ['apk', 'APK'],
  ['app', 'App'],
  ['art', 'ART'],
  ['cpu', 'CPU'],
  ['egl', 'EGL'],
  ['fps', 'FPS'],
  ['gc', 'GC'],
  ['gles', 'GLES'],
  ['gpu', 'GPU'],
  ['hwc', 'HWC'],
  ['hwui', 'HWUI'],
  ['io', 'I/O'],
  ['ipc', 'IPC'],
  ['jni', 'JNI'],
  ['lmk', 'LMK'],
  ['oom', 'OOM'],
  ['pid', 'PID'],
  ['pss', 'PSS'],
  ['rss', 'RSS'],
  ['sdk', 'SDK'],
  ['smaps', 'smaps'],
  ['sql', 'SQL'],
  ['tid', 'TID'],
  ['ttfd', 'TTFD'],
  ['ttid', 'TTID'],
  ['ui', 'UI'],
  ['upid', 'UPID'],
  ['utid', 'UTID'],
  ['v8', 'V8'],
  ['vrr', 'VRR'],
  ['vss', 'VSS'],
]);

const UNITS = new Map<string, string>([
  ['bytes', 'bytes'],
  ['gb', 'GB'],
  ['ghz', 'GHz'],
  ['hz', 'Hz'],
  ['kb', 'KB'],
  ['mb', 'MB'],
  ['mhz', 'MHz'],
  ['ms', 'ms'],
  ['ns', 'ns'],
  ['us', 'µs'],
]);

const ZH_TOKENS = new Map<string, string>([
  ['analysis', '分析'],
  ['analyze', '分析'],
  ['architecture', '架构'],
  ['binder', 'Binder'],
  ['blocking', '阻塞'],
  ['camera', '相机'],
  ['comparison', '对比'],
  ['contention', '竞争'],
  ['critical', '关键'],
  ['detect', '检测'],
  ['detection', '检测'],
  ['detail', '详情'],
  ['diagnosis', '诊断'],
  ['event', '事件'],
  ['events', '事件'],
  ['flow', '流'],
  ['frame', '帧'],
  ['frames', '帧'],
  ['frequency', '频率'],
  ['input', '输入'],
  ['latency', '延迟'],
  ['memory', '内存'],
  ['network', '网络'],
  ['overview', '概览'],
  ['performance', '性能'],
  ['pipeline', '管线'],
  ['power', '功耗'],
  ['process', '进程'],
  ['rendering', '渲染'],
  ['resource', '资源'],
  ['root', '根因'],
  ['scheduler', '调度器'],
  ['scheduling', '调度'],
  ['scrolling', '滑动'],
  ['session', '会话'],
  ['startup', '启动'],
  ['summary', '摘要'],
  ['system', '系统'],
  ['thread', '线程'],
  ['timeline', '时间线'],
  ['trace', 'Trace'],
  ['wakeups', '唤醒'],
]);

function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .split('_')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

function englishToken(token: string): string {
  return ACRONYMS.get(token) ||
    UNITS.get(token) ||
    `${token[0].toUpperCase()}${token.slice(1)}`;
}

export function humanizeSkillIdentifier(
  value: string,
  outputLanguage: OutputLanguage,
): string {
  const tokens = identifierTokens(value);
  if (tokens.length === 0) return value.trim();
  if (outputLanguage === 'en') {
    return tokens.map(englishToken).join(' ');
  }
  return tokens
    .map(token => ZH_TOKENS.get(token) || ACRONYMS.get(token) ||
      UNITS.get(token) || englishToken(token))
    .join('');
}
