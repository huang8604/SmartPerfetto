// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

interface TtlLruEntry<T> {
  value: T;
  expiresAt: number;
}

/** Bounded process-local cache with read-time TTL enforcement and LRU eviction. */
export class TtlLruCache<T> {
  private readonly entries = new Map<string, TtlLruEntry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error(`TtlLruCache maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`TtlLruCache ttlMs must be positive, got ${ttlMs}`);
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.removeExpired();
    this.entries.delete(key);
    this.entries.set(key, {value, expiresAt: this.now() + this.ttlMs});
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.removeExpired();
    return this.entries.size;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
