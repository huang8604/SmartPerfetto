// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CaseGraph — directional edges between case nodes (Plan 54 M1).
 *
 * Edges live in their own store (`case_graph.json`) separate from
 * `case_library.json`. The `CaseGraphLibraryContract` joins both at
 * export time when the public bundle is generated; at runtime the two
 * services have independent CRUD lifecycles, so archiving a case does
 * not require an edge sweep and vice versa.
 *
 * Invariants enforced at insert time:
 * - No self-loops: `fromCaseId !== toCaseId` (a case cannot relate to
 *   itself in this graph; structural similarity is a content-level
 *   concern).
 * - Deduplication on the canonical key `(fromCaseId, toCaseId,
 *   relation)`. Re-inserting the same triplet replaces weight + note
 *   in place rather than adding a parallel edge.
 *
 * Foreign-key correctness against `caseLibrary.ts` is intentionally
 * NOT enforced. An edge can reference a case that does not exist (yet)
 * because the case is being archived, or because edges are imported
 * from another bundle ahead of the cases. Traversal callers handle
 * orphan edges by joining with the case library and reporting the
 * absent node — same pattern as `traceUnavailableReason` for archived
 * cases.
 *
 * Out of scope:
 * - MCP tools — `recall_similar_case`, `cite_case_in_report` land
 *   in Plan 54 M2.
 *
 * @module caseGraph
 */

import * as fs from 'fs';
import * as path from 'path';

import {type CaseEdge} from '../types/sparkContracts';

interface StorageEnvelope {
  schemaVersion: 1;
  edges: CaseEdge[];
}

/** Build the canonical dedup key for an edge. */
function edgeKey(edge: Pick<CaseEdge, 'fromCaseId' | 'toCaseId' | 'relation'>): string {
  return `${edge.fromCaseId}|${edge.toCaseId}|${edge.relation}`;
}

export interface FindRelatedOptions {
  /** Only return edges whose `relation` matches one of these values. */
  relations?: string[];
  /** Direction to traverse. `out` = from this case to others;
   *  `in` = others pointing at this case; `both` = either direction. */
  direction?: 'out' | 'in' | 'both';
  /** Maximum hits returned. Defaults to 10. */
  topK?: number;
}

/**
 * CaseGraph — local file-backed edge storage. Same persistence
 * contract as ragStore / baselineStore / projectMemory / caseLibrary.
 */
export class CaseGraph {
  private readonly storagePath: string;
  /** Map from canonical edge key to the stored edge. */
  private readonly edges = new Map<string, CaseEdge>();
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
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.edges)) return;
      for (const e of parsed.edges) this.edges.set(edgeKey(e), e);
    } catch {
      // Corrupted JSON: file preserved, in-memory cache stays empty.
    }
  }

  /**
   * Add or replace an edge. Throws on self-loop. Re-inserting the
   * same `(from, to, relation)` triplet replaces weight + note +
   * edgeId (so callers can keep the latest curator note).
   */
  addEdge(edge: CaseEdge): void {
    this.load();
    if (edge.fromCaseId === edge.toCaseId) {
      throw new Error(
        `Self-loops are not permitted: edge '${edge.edgeId}' has fromCaseId === toCaseId === '${edge.fromCaseId}'`,
      );
    }
    this.edges.set(edgeKey(edge), edge);
    this.persist();
  }

  /** Remove an edge by canonical id. Returns whether it was present. */
  removeEdge(edgeId: string): boolean {
    this.load();
    let foundKey: string | undefined;
    for (const [k, e] of this.edges) {
      if (e.edgeId === edgeId) {
        foundKey = k;
        break;
      }
    }
    if (!foundKey) return false;
    this.edges.delete(foundKey);
    this.persist();
    return true;
  }

  /** Get all edges originating at the case. */
  getEdgesFrom(caseId: string): CaseEdge[] {
    this.load();
    return Array.from(this.edges.values())
      .filter(e => e.fromCaseId === caseId)
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  }

  /** Get all edges pointing at the case. */
  getEdgesTo(caseId: string): CaseEdge[] {
    this.load();
    return Array.from(this.edges.values())
      .filter(e => e.toCaseId === caseId)
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  }

  /**
   * Single-hop traversal. Returns related case ids paired with the
   * connecting edge, ordered by edge weight descending (unweighted
   * edges sort to the back). Optional relation filter narrows the
   * set; `direction` controls in/out/both.
   */
  findRelated(
    caseId: string,
    opts: FindRelatedOptions = {},
  ): Array<{caseId: string; edge: CaseEdge}> {
    this.load();
    const direction = opts.direction ?? 'both';
    const relations = opts.relations ? new Set(opts.relations) : null;
    const topK = opts.topK ?? 10;

    const candidates: Array<{caseId: string; edge: CaseEdge}> = [];
    for (const e of this.edges.values()) {
      if (relations && !relations.has(e.relation)) continue;
      if (
        (direction === 'out' || direction === 'both') &&
        e.fromCaseId === caseId &&
        e.toCaseId !== caseId
      ) {
        candidates.push({caseId: e.toCaseId, edge: e});
      }
      if (
        (direction === 'in' || direction === 'both') &&
        e.toCaseId === caseId &&
        e.fromCaseId !== caseId
      ) {
        candidates.push({caseId: e.fromCaseId, edge: e});
      }
    }

    candidates.sort((a, b) => {
      const wa = a.edge.weight ?? -1;
      const wb = b.edge.weight ?? -1;
      if (wa !== wb) return wb - wa;
      return a.edge.edgeId.localeCompare(b.edge.edgeId);
    });
    return candidates.slice(0, topK);
  }

  /** All edges, deterministically ordered by canonical key. Used by
   * the export bundler that joins this with the case library. */
  listEdges(): CaseEdge[] {
    this.load();
    return Array.from(this.edges.values()).sort((a, b) =>
      edgeKey(a).localeCompare(edgeKey(b)),
    );
  }

  /** Total edge count. */
  size(): number {
    this.load();
    return this.edges.size;
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const tmp = `${this.storagePath}.tmp`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      edges: Array.from(this.edges.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}
