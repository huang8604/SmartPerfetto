// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * BaselineStore — durable App/Device/Build/CUJ baseline storage with
 * curation lifecycle and publish gates.
 *
 * Plan 50 M0 scope (this file):
 * - Add / get / remove / list `BaselineRecord` with JSON persistence
 *   (atomic temp+rename, schemaVersion 1).
 * - Service-layer invariants the schema does NOT enforce so older
 *   snapshots remain readable:
 *     - `status='published'` requires `sampleCount >= 3` (§4.1).
 *     - `status='published'` requires `redactionState='redacted'` whenever
 *       the key carries identifiable info (raw appId / deviceId);
 *       pre-anonymized keys can publish with `redactionState='raw'`.
 * - Stable canonical `baselineId` derivation:
 *   `${appId}/${deviceId}/${buildId}/${cuj}`.
 *
 * Out of scope here (M1 / M2):
 * - Diff and regression-gate computation (`baselineDiffer.ts`).
 * - MCP tool registration (`lookup_baseline`, `compare_to_baseline`).
 * - Express CRUD route.
 *
 * @module baselineStore
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type BaselineRecord,
  type PerfBaselineKey,
} from '../types/sparkContracts';

/** Minimum sample count enforced for `status='published'`. */
export const BASELINE_PUBLISH_MIN_SAMPLES = 3;

/** Stable on-disk envelope. Schema version mismatches load empty (file
 * preserved for inspection) — same contract as ragStore. */
interface StorageEnvelope {
  schemaVersion: 1;
  baselines: BaselineRecord[];
}

/** Normalize an appId or deviceId to detect when it carries
 * identifiable raw info. Heuristic: package-style ids
 * (`com.example.feed`) or model+os fingerprints (`pixel-9-android-15`)
 * count as identifiable; placeholder strings starting with `anon-` or
 * `redacted-` count as already anonymized. The gate is intentionally
 * conservative — a false positive (re-redacting an already anonymized
 * key) is harmless; a false negative would leak. */
function isIdentifiableComponent(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (v.startsWith('anon-')) return false;
  if (v.startsWith('redacted-')) return false;
  if (v.startsWith('placeholder-')) return false;
  return true;
}

/** Whether the key looks like it carries raw identifiable info. */
export function keyHasIdentifiableInfo(key: PerfBaselineKey): boolean {
  return (
    isIdentifiableComponent(key.appId) ||
    isIdentifiableComponent(key.deviceId)
  );
}

/** Derive the canonical baselineId from a key. */
export function deriveBaselineId(key: PerfBaselineKey): string {
  return `${key.appId}/${key.deviceId}/${key.buildId}/${key.cuj}`;
}

export interface BaselineStoreListOptions {
  /** Restrict to a single status (e.g. 'published' for read-only consumers). */
  status?: BaselineRecord['status'];
  /** Restrict to a key prefix, e.g. `${appId}/${deviceId}` for cross-build trends. */
  keyPrefix?: string;
}

/**
 * BaselineStore — local file-backed baseline storage. Single instance
 * per storage path is enough for M0; cross-process writers are not
 * supported (caller's responsibility).
 */
export class BaselineStore {
  private readonly storagePath: string;
  private readonly baselines = new Map<string, BaselineRecord>();
  private loaded = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /** Idempotently load the on-disk store into memory. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.baselines)) {
        return;
      }
      for (const b of parsed.baselines) {
        this.baselines.set(b.baselineId, b);
      }
    } catch {
      // Corrupted JSON: empty cache, file preserved for inspection.
    }
  }

  /**
   * Add or replace a baseline record. Validates the publish invariants
   * before writing — invalid records throw rather than silently
   * downgrading status, so the operator sees the failure.
   */
  addBaseline(record: BaselineRecord): void {
    this.load();
    this.assertPublishInvariants(record);
    this.baselines.set(record.baselineId, record);
    this.persist();
  }

  /** Get a baseline by id. */
  getBaseline(baselineId: string): BaselineRecord | undefined {
    this.load();
    return this.baselines.get(baselineId);
  }

  /** Remove a baseline. Returns whether anything was actually removed. */
  removeBaseline(baselineId: string): boolean {
    this.load();
    const had = this.baselines.delete(baselineId);
    if (had) this.persist();
    return had;
  }

  /**
   * List baselines with optional filters. Results are stable-ordered
   * by baselineId for deterministic consumers.
   */
  listBaselines(opts: BaselineStoreListOptions = {}): BaselineRecord[] {
    this.load();
    let out = Array.from(this.baselines.values());
    if (opts.status) {
      out = out.filter(b => b.status === opts.status);
    }
    if (opts.keyPrefix) {
      const prefix = opts.keyPrefix;
      out = out.filter(b => b.baselineId.startsWith(prefix));
    }
    out.sort((a, b) => a.baselineId.localeCompare(b.baselineId));
    return out;
  }

  /**
   * Validate the §4.1 publish invariants. Throws when violated so the
   * caller surfaces the cause to the operator instead of silently
   * downgrading the record's status.
   */
  private assertPublishInvariants(record: BaselineRecord): void {
    if (record.status !== 'published') return;

    const sampleCount = record.sampleCount ?? 0;
    if (sampleCount < BASELINE_PUBLISH_MIN_SAMPLES) {
      throw new Error(
        `Baseline '${record.baselineId}' cannot be published with sampleCount=${sampleCount} (minimum ${BASELINE_PUBLISH_MIN_SAMPLES})`,
      );
    }

    if (
      keyHasIdentifiableInfo(record.key) &&
      record.redactionState !== 'redacted'
    ) {
      throw new Error(
        `Baseline '${record.baselineId}' cannot be published with redactionState='${record.redactionState}' — key carries identifiable info`,
      );
    }
  }

  /** Atomic write: temp file + rename so a crashed process leaves the
   * existing on-disk file intact. */
  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      baselines: Array.from(this.baselines.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}
