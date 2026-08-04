// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Integration coverage for real on-disk strategy frontmatter.
 *
 * `sceneClassifier.test.ts` mocks `getRegisteredScenes()` to pin matcher
 * mechanics. This file proves newly added strategy keywords are actually
 * loaded from `backend/strategies/*.strategy.md`.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { classifyScene } from '../sceneClassifier';
import { invalidateStrategyCache } from '../strategyLoader';

describe('classifyScene with real strategy frontmatter', () => {
  beforeAll(() => {
    invalidateStrategyCache();
  });

  it('routes pure storage, SQLite, SharedPreferences, and provider queries to io', () => {
    expect(classifyScene('SQLite 查询很慢，怀疑 WAL checkpoint 阻塞')).toBe('io');
    expect(classifyScene('Room migration 导致数据库打开慢')).toBe('io');
    expect(classifyScene('SharedPreferences QueuedWork.waitToFinish 卡住')).toBe('io');
    expect(classifyScene('MediaProvider scoped storage 访问很慢')).toBe('io');
  });

  it('does not steal higher-priority startup, ANR, media, or network scenes', () => {
    expect(classifyScene('启动阶段 SQLite fsync 很慢')).toBe('startup');
    expect(classifyScene('ANR 中 SharedPreferences QueuedWork 卡住')).toBe('anr');
    expect(classifyScene('MediaCodec video decode stutter')).toBe('media');
    expect(classifyScene('network traffic is high')).toBe('network');
  });

  it('routes pure input-dispatch queue questions to interaction', () => {
    expect(classifyScene('InputDispatcher wait queue wq 没有收到 FINISHED ACK，输入延迟很高')).toBe('interaction');
  });

  it('keeps no-focused-window ANR on the ANR strategy', () => {
    expect(classifyScene('INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW ANR')).toBe('anr');
    expect(classifyScene('no focused window ANR during launch')).toBe('anr');
  });

  it('routes pure BufferQueue, fence, and refresh-policy questions to pipeline', () => {
    expect(classifyScene('BufferQueue release fence 和 dequeueBuffer backpressure 怎么看')).toBe('pipeline');
    expect(classifyScene('SurfaceFlinger present fence latency 怎么看')).toBe('pipeline');
    expect(classifyScene('刷新率 ARR VRR 改变帧预算的 policy 怎么分析')).toBe('pipeline');
    expect(classifyScene('GraphicBuffer 和 BufferQueue 槽位是不是同一个证据')).toBe('pipeline');
  });

  it('routes background power governance questions to power', () => {
    expect(classifyScene('JobScheduler runtime quota pending reason stop reason 怎么看')).toBe('power');
    expect(classifyScene('WorkManager foreground worker STOP_REASON_QUOTA during background drain')).toBe('power');
    expect(classifyScene('Foreground Service dataSync timeout Service.onTimeout battery drain')).toBe('power');
    expect(classifyScene('setExactAndAllowWhileIdle exact alarm wakeup battery drain')).toBe('power');
    expect(classifyScene('Android vitals partial wakelock excessive 24h 怎么确认')).toBe('power');
  });

  it('routes observability diagnostic API questions to the owning scene', () => {
    expect(classifyScene('ApplicationStartInfo STARTUP_STATE start reason TTFD 怎么对齐')).toBe('startup');
    expect(classifyScene('ApplicationExitInfo REASON_LOW_MEMORY OOM 怎么分析')).toBe('memory');
    expect(classifyScene('ProfilingManager heap dump OOM 内存泄漏怎么验证')).toBe('memory');
    expect(classifyScene('ProfilingTrigger ANR system trace 怎么和 direct blocker 对齐')).toBe('anr');
    expect(classifyScene('ApplicationExitInfo ANR getAnrInfo 怎么确认')).toBe('anr');
  });

  it('routes pure network request-stage and stack-policy questions to network', () => {
    expect(classifyScene('网络慢怎么分析')).toBe('network');
    expect(classifyScene('请求慢怎么分析')).toBe('network');
    expect(classifyScene('OkHttp EventListener DNS TLS TTFB 怎么归因')).toBe('network');
    expect(classifyScene('HTTPDNS cache TTL 导致请求慢怎么验证')).toBe('network');
    expect(classifyScene('Cronet HttpEngine HTTP/3 QUIC 0-RTT 网络慢')).toBe('network');
    expect(classifyScene('NetworkCallback validated metered bandwidth 状态怎么看')).toBe('network');
    expect(classifyScene('Android 17 ECH Certificate Transparency local network permission 请求失败')).toBe('network');
  });

  it('keeps explicit frame-drop phrasing on scrolling without broad frame keyword matches', () => {
    expect(classifyScene('analyze frame drops in this trace')).toBe('scrolling');
    expect(classifyScene('frame drop in this trace')).toBe('scrolling');
  });

  it('keeps live raw trace-pair comparisons out of result-snapshot strategy routing', () => {
    expect(classifyScene('对比两个 Trace 的启动速度差异')).toBe('startup');
    expect(classifyScene('对比左右 Trace 的滑动 fps 差异')).toBe('scrolling');
    expect(classifyScene('对比两个 Trace 的已有分析结果')).toBe('multi_trace_result_comparison');
    expect(classifyScene('compare analysis results for two snapshots')).toBe('multi_trace_result_comparison');
  });

  it('keeps scene-specific BufferQueue and graphics-memory queries on their stronger scenes', () => {
    expect(classifyScene('滑动卡顿里 BufferQueue release fence 等待')).toBe('scrolling');
    expect(classifyScene('启动阶段 queueBuffer release fence 等待')).toBe('startup');
    expect(classifyScene('dmabuf graphics memory leak OOM')).toBe('memory');
    expect(classifyScene('game fence wait GPU frame pacing')).toBe('game');
    expect(classifyScene('点击响应慢 present latency')).toBe('interaction');
  });

  it('does not let background-power routing steal stronger scenes', () => {
    expect(classifyScene('ANR 中 JobScheduler stop reason timeout')).toBe('anr');
    expect(classifyScene('启动阶段 WorkManager 初始化慢')).toBe('startup');
    expect(classifyScene('InputDispatcher ACK timeout with FGS running')).toBe('interaction');
    expect(classifyScene('WorkManager network traffic is high')).toBe('network');
    expect(classifyScene('network traffic is high')).toBe('network');
  });

  it('does not let network request-stage routing steal stronger scenes', () => {
    expect(classifyScene('启动阶段 OkHttp DNS TLS TTFB 慢')).toBe('startup');
    expect(classifyScene('ANR main thread waits on Cronet TLS recv')).toBe('anr');
    expect(classifyScene('点击响应慢 OkHttp response body decode')).toBe('interaction');
    expect(classifyScene('MediaCodec video decoder HTTP/3 QUIC buffering')).toBe('media');
  });

  it('does not let observability diagnostics steal unrelated or stronger scenes', () => {
    expect(classifyScene('ApplicationExitInfo previous crash')).toBe('general');
    expect(classifyScene('Play Vitals partial wakelock excessive 24h')).toBe('power');
    expect(classifyScene('A/B network latency experiment')).toBe('network');
    expect(classifyScene('App Performance Score render jank')).toBe('scrolling');
    expect(classifyScene('ANR with ApplicationStartInfo previous launch')).toBe('anr');
    expect(classifyScene('启动阶段 ApplicationExitInfo previous exit and ApplicationStartInfo')).toBe('startup');
  });
});
