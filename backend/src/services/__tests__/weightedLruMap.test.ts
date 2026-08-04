// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {WeightedLruMap} from '../weightedLruMap';

describe('WeightedLruMap', () => {
  it('evicts least-recently-used entries by count and weight', () => {
    const cache = new WeightedLruMap<string, string>(3, 6, value => value.length);
    cache.set('a', 'aa').set('b', 'bb').set('c', 'cc');
    expect(cache.get('a')).toBe('aa');

    cache.set('d', 'dd');

    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.weight).toBe(6);
  });

  it('does not retain an item larger than the full budget', () => {
    const cache = new WeightedLruMap<string, string>(3, 4, value => value.length);
    cache.set('large', '12345');

    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  it('keeps accounting correct across replacement, deletion, and clear', () => {
    const cache = new WeightedLruMap<string, string>(3, 10, value => value.length);
    cache.set('a', '12');
    cache.set('a', '1234');
    expect(cache.weight).toBe(4);
    expect(cache.delete('a')).toBe(true);
    expect(cache.weight).toBe(0);
    cache.set('b', '12');
    cache.clear();
    expect(cache.weight).toBe(0);
  });
});
