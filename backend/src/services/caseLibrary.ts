// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CaseLibrary — durable storage for `CaseNode` records (Plan 54 M0).
 *
 * The double-control publish gate from §5.2 of the unified design doc
 * lives here. A case can become `status='published'` ONLY through the
 * dedicated `publishCase()` path AND only when:
 *   1. `redactionState === 'redacted'` — the trace artifact has been
 *      anonymized and approved as such.
 *   2. A curator has signed off — `curatedBy` is set, and
 *      `publishCase()` requires the reviewer to be passed explicitly.
 *
 * `saveCase()` itself rejects records arriving with `status='published'`
 * — the only way through is the dedicated path. This makes the
 * promotion to public a deliberate API call instead of an accidental
 * field update.
 *
 * Out of scope here (M1 / M2):
 * - Case graph / edge management (`caseGraph.ts`).
 * - MCP tools (`recall_similar_case`, `cite_case_in_report`).
 * - Express CRUD route.
 *
 * @module caseLibrary
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type CaseEducationalLevel,
  type CaseNode,
  type CurationStatus,
  makeSparkProvenance,
} from '../types/sparkContracts';

interface StorageEnvelope {
  schemaVersion: 1;
  cases: CaseNode[];
}

export interface ListOptions {
  status?: CurationStatus;
  /** Restrict to cases whose tag set overlaps with at least one of these. */
  anyOfTags?: string[];
  educationalLevel?: CaseEducationalLevel;
}

export interface PublishOptions {
  /** Reviewer name. Stamped onto `curatedBy` and `curatedAt`. */
  reviewer: string;
}

export interface ArchiveOptions {
  reason: string;
}

/**
 * CaseLibrary — local file-backed case storage. Single instance per
 * storage path; cross-process writers explicitly out of scope (matches
 * ragStore / baselineStore / projectMemory).
 */
export class CaseLibrary {
  private readonly storagePath: string;
  private readonly cases = new Map<string, CaseNode>();
  private loaded = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) return;
      for (const c of parsed.cases) this.cases.set(c.caseId, c);
    } catch {
      // Corrupted JSON: file preserved, in-memory cache stays empty.
    }
  }

  /**
   * Save (insert or replace) a case. Throws when the record arrives
   * with `status='published'` — the only legitimate path to publish
   * is the dedicated `publishCase()` call so the gate cannot be
   * bypassed by a field update.
   */
  saveCase(record: CaseNode): void {
    this.load();
    if (record.status === 'published') {
      throw new Error(
        `Use publishCase() to advance a case to 'published'; saveCase() rejects published records to keep the gate auditable`,
      );
    }
    this.cases.set(record.caseId, record);
    this.persist();
  }

  getCase(caseId: string): CaseNode | undefined {
    this.load();
    return this.cases.get(caseId);
  }

  removeCase(caseId: string): boolean {
    this.load();
    const had = this.cases.delete(caseId);
    if (had) this.persist();
    return had;
  }

  listCases(opts: ListOptions = {}): CaseNode[] {
    this.load();
    let out = Array.from(this.cases.values());
    if (opts.status) out = out.filter(c => c.status === opts.status);
    if (opts.educationalLevel)
      out = out.filter(c => c.educationalLevel === opts.educationalLevel);
    if (opts.anyOfTags && opts.anyOfTags.length > 0) {
      const wanted = new Set(opts.anyOfTags);
      out = out.filter(c => c.tags.some(t => wanted.has(t)));
    }
    out.sort((a, b) => a.caseId.localeCompare(b.caseId));
    return out;
  }

  /**
   * Advance a case to `status='published'`. Enforces the double-control
   * gate:
   *   - Case must already exist (we publish a known record).
   *   - `redactionState === 'redacted'` — anonymizer must have run.
   *   - Reviewer name supplied — curator signoff is mandatory.
   *
   * Returns the published case so callers can render the new state
   * without a follow-up read. Stamps `curatedBy` / `curatedAt` from
   * the reviewer + wall clock.
   */
  publishCase(caseId: string, opts: PublishOptions): CaseNode {
    this.load();
    const trimmedReviewer = opts.reviewer?.trim();
    if (!trimmedReviewer) {
      throw new Error(
        `Cannot publish case '${caseId}' without a reviewer signoff`,
      );
    }
    const existing = this.cases.get(caseId);
    if (!existing) {
      throw new Error(`Cannot publish case '${caseId}': not found`);
    }
    if (existing.redactionState !== 'redacted') {
      throw new Error(
        `Cannot publish case '${caseId}': redactionState='${existing.redactionState}' (must be 'redacted')`,
      );
    }
    const published: CaseNode = {
      ...existing,
      status: 'published',
      curatedBy: trimmedReviewer,
      curatedAt: Date.now(),
    };
    this.cases.set(caseId, published);
    this.persist();
    return published;
  }

  /**
   * Archive a case: drops the trace artifact pointer (so the artifact
   * store can evict the underlying file) while keeping the case
   * metadata in place for backward references. Records the supplied
   * reason on `traceUnavailableReason` so consumers see why the trace
   * is gone.
   */
  archiveCase(caseId: string, opts: ArchiveOptions): CaseNode {
    this.load();
    const reason = opts.reason?.trim();
    if (!reason) {
      throw new Error(`archiveCase requires a non-empty reason`);
    }
    const existing = this.cases.get(caseId);
    if (!existing) {
      throw new Error(`Cannot archive case '${caseId}': not found`);
    }
    const archived: CaseNode = {
      ...existing,
      ...makeSparkProvenance({
        source: existing.source,
        notes: `archived via archiveCase`,
      }),
      traceArtifactId: undefined,
      traceUnavailableReason: reason,
    };
    this.cases.set(caseId, archived);
    this.persist();
    return archived;
  }

  /** Stats by status — useful for the admin dashboard. */
  getStats(): Record<CurationStatus, number> {
    this.load();
    const out: Record<CurationStatus, number> = {
      draft: 0,
      reviewed: 0,
      published: 0,
      private: 0,
    };
    for (const c of this.cases.values()) out[c.status]++;
    return out;
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      cases: Array.from(this.cases.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}
