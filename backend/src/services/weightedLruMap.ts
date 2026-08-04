// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Map-compatible LRU bounded by both entry count and caller-defined weight. */
export class WeightedLruMap<K, V> extends Map<K, V> {
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: V, key: K) => number,
  ) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error(`WeightedLruMap maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!Number.isFinite(maxWeight) || maxWeight <= 0) {
      throw new Error(`WeightedLruMap maxWeight must be positive, got ${maxWeight}`);
    }
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined) return undefined;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    const previous = super.get(key);
    if (previous !== undefined) {
      this.totalWeight -= this.normalizedWeight(previous, key);
      super.delete(key);
    }
    super.set(key, value);
    this.totalWeight += this.normalizedWeight(value, key);
    this.evictToBudget();
    return this;
  }

  override delete(key: K): boolean {
    const value = super.get(key);
    if (value === undefined) return false;
    this.totalWeight -= this.normalizedWeight(value, key);
    return super.delete(key);
  }

  override clear(): void {
    super.clear();
    this.totalWeight = 0;
  }

  get weight(): number {
    return this.totalWeight;
  }

  private normalizedWeight(value: V, key: K): number {
    const weight = this.weigh(value, key);
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  }

  private evictToBudget(): void {
    while (this.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = super.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
