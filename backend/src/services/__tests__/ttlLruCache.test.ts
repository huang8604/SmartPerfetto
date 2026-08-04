// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {TtlLruCache} from '../ttlLruCache';

describe('TtlLruCache', () => {
  test('expires entries at read time', () => {
    let now = 1_000;
    const cache = new TtlLruCache<string>(2, 100, () => now);
    cache.set('trace-a', 'report-a');

    now = 1_099;
    expect(cache.get('trace-a')).toBe('report-a');
    now = 1_100;
    expect(cache.get('trace-a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('evicts the least recently used entry at the configured bound', () => {
    const cache = new TtlLruCache<string>(2, 1_000, () => 1_000);
    cache.set('trace-a', 'report-a');
    cache.set('trace-b', 'report-b');
    expect(cache.get('trace-a')).toBe('report-a');

    cache.set('trace-c', 'report-c');

    expect(cache.get('trace-b')).toBeUndefined();
    expect(cache.get('trace-a')).toBe('report-a');
    expect(cache.get('trace-c')).toBe('report-c');
    expect(cache.size).toBe(2);
  });

  test('supports explicit trace-lifecycle invalidation', () => {
    const cache = new TtlLruCache<string>(2, 1_000, () => 1_000);
    cache.set('trace-a', 'report-a');

    expect(cache.delete('trace-a')).toBe(true);
    expect(cache.get('trace-a')).toBeUndefined();
  });
});
