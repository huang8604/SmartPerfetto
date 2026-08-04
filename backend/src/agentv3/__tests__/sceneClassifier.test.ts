// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneClassifier unit tests
 *
 * Tests keyword/compound-pattern classification into SceneType.
 * The classifier is pure function (<1ms, no LLM), making it ideal for unit tests.
 */

import { jest, describe, it, expect } from '@jest/globals';

// Mock strategyLoader before importing classifier
jest.mock('../strategyLoader', () => ({
  getRegisteredScenes: jest.fn(() => [
    {
      scene: 'multi_trace_result_comparison',
      priority: 0,
      keywords: [
        '分析结果对比',
        '结果对比',
        '多 trace 结果对比',
        '另外一个 trace 的分析结果',
        'compare analysis results',
      ],
      compoundPatterns: [
        /对比.*(?:分析结果|结果|snapshot|snapshots|SID|sid)/i,
        /对比.*(?:另一个\s*Trace|另外一个\s*Trace|两个\s*Trace|多\s*Trace).*(?:分析结果|结果|snapshot|snapshots|SID|sid)/i,
        /(?:分析结果|结果|snapshot).*(?:对比|compare)/i,
      ],
    },
    {
      scene: 'anr',
      priority: 1,
      keywords: ['anr', '死锁', 'not responding', 'deadlock'],
      compoundPatterns: [/anr.*(?:原因|分析|根因)/i],
    },
    {
      scene: 'startup',
      priority: 2,
      keywords: ['启动', 'launch', 'startup', '冷启动', '温启动', '热启动'],
      compoundPatterns: [/ttid.*ttfd/i, /启动.*耗时/],
    },
    {
      scene: 'scrolling',
      priority: 3,
      keywords: [
        '滑动',
        'scroll',
        'jank',
        '卡顿',
        '掉帧',
        'fling',
        'frame',
        'recycler',
        'recyclerview',
        'scrollview',
        'scrollstate',
      ],
      compoundPatterns: [],
    },
    {
      scene: 'interaction',
      priority: 4,
      keywords: ['点击', 'click', 'touch', '响应'],
      compoundPatterns: [],
    },
    {
      scene: 'overview',
      priority: 5,
      keywords: ['概览', 'overview', '总览'],
      compoundPatterns: [],
    },
    {
      scene: 'io',
      priority: 5,
      keywords: [
        'io',
        'i/o',
        'storage',
        'disk',
        'fsync',
        'sqlite',
        'room',
        'sharedpreferences',
        'queuedwork',
        'contentprovider',
        'cursorwindow',
        'mediaprovider',
        'scoped storage',
        '存储',
        '磁盘',
        '数据库',
        '文件',
      ],
      compoundPatterns: [
        /(?:SQLite|Room|database|数据库).*(?:慢|阻塞|等待|ANR|启动)/i,
        /(?:SharedPreferences|QueuedWork|ContentProvider|CursorWindow).*(?:慢|阻塞|等待|ANR|启动)/i,
      ],
    },
    {
      scene: 'general',
      priority: 99,
      keywords: [],
      compoundPatterns: [],
    },
  ]),
}));

import { classifyScene } from '../sceneClassifier';

describe('classifyScene', () => {
  describe('keyword matching', () => {
    it('should classify scrolling queries', () => {
      expect(classifyScene('分析滑动卡顿')).toBe('scrolling');
      expect(classifyScene('why is scroll janky?')).toBe('scrolling');
      expect(classifyScene('scroll-demo-customer-scroll.pftrace')).toBe('scrolling');
      expect(classifyScene('RecyclerView 性能')).toBe('scrolling');
      expect(classifyScene('RecyclerViewAdapter 性能')).toBe('scrolling');
      expect(classifyScene('NestedScrollView 性能')).toBe('scrolling');
      expect(classifyScene('LazyColumnScrollState 性能')).toBe('scrolling');
      expect(classifyScene('查看掉帧情况')).toBe('scrolling');
    });

    it('should classify startup queries', () => {
      expect(classifyScene('分析启动性能')).toBe('startup');
      expect(classifyScene('app launch is slow')).toBe('startup');
      expect(classifyScene('冷启动耗时多少')).toBe('startup');
    });

    it('should classify ANR queries', () => {
      expect(classifyScene('分析这个 ANR')).toBe('anr');
      expect(classifyScene('app not responding')).toBe('anr');
      expect(classifyScene('是否存在死锁')).toBe('anr');
    });

    it('should classify interaction queries', () => {
      expect(classifyScene('点击响应慢')).toBe('interaction');
    });

    it('should classify overview queries', () => {
      expect(classifyScene('给出概览')).toBe('overview');
    });

    it('should classify pure IO and storage queries', () => {
      expect(classifyScene('SQLite 查询很慢')).toBe('io');
      expect(classifyScene('SharedPreferences 退出时卡住')).toBe('io');
      expect(classifyScene('fsync 导致主线程等待')).toBe('io');
      expect(classifyScene('MediaProvider scoped storage 访问很慢')).toBe('io');
    });

    it('should classify multi-trace result comparison queries', () => {
      expect(classifyScene('把当前 Trace 的结果与另外一个 Trace 的分析结果进行对比')).toBe('multi_trace_result_comparison');
      expect(classifyScene('compare analysis results for two snapshots')).toBe('multi_trace_result_comparison');
      expect(classifyScene('对比两个 Trace 的已有分析结果')).toBe('multi_trace_result_comparison');
    });

    it('should not route live raw trace pair comparison to result-snapshot comparison', () => {
      expect(classifyScene('对比两个 Trace 的启动速度差异')).toBe('startup');
      expect(classifyScene('对比左右 Trace 的滑动 fps 差异')).toBe('scrolling');
      expect(classifyScene('对比两个 Trace 的频率差异')).toBe('general');
    });

    it('should be case-insensitive for keywords', () => {
      expect(classifyScene('SCROLL performance')).toBe('scrolling');
      expect(classifyScene('ANR analysis')).toBe('anr');
      expect(classifyScene('STARTUP time')).toBe('startup');
    });
  });

  describe('compound pattern matching', () => {
    it('should match ANR compound pattern', () => {
      expect(classifyScene('ANR 的原因是什么')).toBe('anr');
    });

    it('should match startup compound pattern', () => {
      expect(classifyScene('TTID 和 TTFD 分别是多少')).toBe('startup');
      expect(classifyScene('启动到渲染的耗时')).toBe('startup');
    });

    it('should prioritize compound patterns over lower-priority keyword matches', () => {
      // "anr 原因分析" matches ANR compound pattern (priority 1)
      // even if some word might match elsewhere
      expect(classifyScene('anr 原因分析')).toBe('anr');
    });
  });

  describe('priority ordering', () => {
    it('should prefer higher priority (lower number) when multiple match', () => {
      // "ANR 导致的启动卡顿" has keywords from both ANR and startup
      // ANR (priority 1) should win over startup (priority 2)
      expect(classifyScene('ANR 导致的启动问题')).toBe('anr');
      expect(classifyScene('ANR 中 SQLite fsync 导致卡死')).toBe('anr');
      expect(classifyScene('启动阶段 SQLite fsync 很慢')).toBe('startup');
    });
  });

  describe('fallback', () => {
    it('should return general for unmatched queries', () => {
      expect(classifyScene('what happened in this trace?')).toBe('general');
      expect(classifyScene('帮我分析一下这个 trace')).toBe('general');
      expect(classifyScene('')).toBe('general');
    });

    it('should not classify identifier substrings as scene keywords', () => {
      expect(classifyScene('上面 rcustomscroller 这个线程的核心摆放和 running 时候对应的频率是多少')).toBe('general');
      expect(classifyScene('com.example.wechatfriendforcustomscroller')).toBe('general');
      expect(classifyScene('FrameTimeline 里面这个 slice 的 dur 是多少')).toBe('general');
      expect(classifyScene('com.foo.startupmanager 这个进程的 CPU 是多少')).toBe('general');
    });

    it('should return general for empty query', () => {
      expect(classifyScene('')).toBe('general');
    });
  });
});
