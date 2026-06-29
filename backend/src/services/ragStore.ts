// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * RagStore — local file-backed storage for RAG (Retrieval-Augmented
 * Generation) chunks. Serves Plan 55 (content RAG over blog / AOSP / OEM
 * SDK) and Plan 44 (project memory exposure as a RAG corpus).
 *
 * M0 scope (this file):
 * - JSON file persistence with atomic temp + rename writes
 * - In-memory cache as the source of truth between writes
 * - License gate at insert time for `aosp` / `oem_sdk` source kinds
 * - Token-overlap keyword search (no embeddings yet — M2 may switch to
 *   sqlite-vec when chunk count breaches the BM25 threshold; the
 *   `search()` shape is stable so a driver swap stays local)
 * - Retrieval-level `unsupportedReason` for the three distinguishable
 *   failure modes: empty index, all-blocked, and no-match (the last
 *   intentionally has no unsupportedReason so callers know the query
 *   itself didn't hit, not that the infrastructure failed)
 *
 * @module ragStore
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type RagChunk,
  type RagRetrievalHit,
  type RagRetrievalResult,
  type RagSourceKind,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  legacyKnowledgeFilesystemWritesEnabled,
  type KnowledgeScope,
  getScopedKnowledgeRecord,
  listScopedKnowledgeRecords,
  removeScopedKnowledgeRecord,
  upsertScopedKnowledgeRecord,
} from './scopedKnowledgeStore';

/** Source kinds that require a `license` field at ingestion time. */
const LICENSE_REQUIRED_KINDS: ReadonlySet<RagSourceKind> = new Set([
  'aosp',
  'oem_sdk',
  'kernel_source',
]);

/** All RagSourceKind values. Kept here so getStats() can initialize a
 * complete record without reaching into the type system at runtime. When
 * the union in sparkContracts.ts grows, update this list and getStats()'s
 * initial accumulator will pick up the new kind automatically. */
const ALL_RAG_SOURCE_KINDS: readonly RagSourceKind[] = [
  'androidperformance.com',
  'aosp',
  'oem_sdk',
  'project_memory',
  'world_memory',
  'case_library',
  'app_source',
  'kernel_source',
];

/** Stable on-disk envelope. The schemaVersion is bumped when the layout
 * is no longer backward compatible — readers must skip on mismatch. */
interface StorageEnvelope {
  schemaVersion: 1 | 2;
  chunks: RagChunk[];
}

const KNOWLEDGE_KIND = 'rag_chunk';
const RAG_ROW_SCOPE_PREFIX = 'rag:';

export interface RagStoreSearchOptions {
  /** Maximum hits returned. Defaults to 5. */
  topK?: number;
  /** Restrict the search to a subset of source kinds. */
  kinds?: RagSourceKind[];
  /** Enterprise tenant/workspace scope. Ignored by legacy JSON storage. */
  scope?: KnowledgeScope;
  /** Restrict source-backed chunks to selected codebases. */
  codebaseIds?: string[];
  vendor?: string;
  buildId?: string;
  pathPrefix?: string;
  symbolExact?: string;
  filePathExact?: string;
  languages?: RagChunk['language'][];
}

export interface RagStoreListOptions {
  kind?: RagSourceKind;
  registryOrigin?: RagChunk['registryOrigin'];
  uriPrefix?: string;
  scope?: KnowledgeScope;
}

/** Per-kind index summary returned by `getStats()`. */
export type RagStoreStats = Record<
  RagSourceKind,
  {chunkCount: number; lastIndexedAt?: number}
>;

/** Tokenize: lower-case, keep alphanumerics + underscores, drop tokens
 * shorter than two characters. The token set is intersected with the
 * query token set to score chunks. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 2);
}

/** Build a fresh stats accumulator with every known source kind set to
 * zero. Callers iterate chunks to populate it. */
function emptyStats(): RagStoreStats {
  const stats = {} as RagStoreStats;
  for (const kind of ALL_RAG_SOURCE_KINDS) {
    stats[kind] = {chunkCount: 0};
  }
  return stats;
}

function defaultRegistryOrigin(kind: RagSourceKind): RagChunk['registryOrigin'] {
  switch (kind) {
    case 'androidperformance.com':
    case 'aosp':
    case 'oem_sdk':
      return 'legacy_plan55';
    case 'project_memory':
    case 'world_memory':
      return 'plan44_memory';
    case 'case_library':
      return 'plan54_cases';
    case 'app_source':
    case 'kernel_source':
      return 'codebase_registry';
  }
}

function normalizeChunkForStorage(chunk: RagChunk): RagChunk {
  const registryOrigin = chunk.registryOrigin ?? defaultRegistryOrigin(chunk.kind);
  if ((chunk.kind === 'app_source' || chunk.kind === 'kernel_source') && !chunk.codebaseId) {
    throw new Error(
      `Code-aware source chunk '${chunk.chunkId}' (${chunk.kind}) requires codebaseId`,
    );
  }
  if (registryOrigin === 'codebase_registry' && !chunk.codebaseId) {
    throw new Error(
      `Codebase registry chunk '${chunk.chunkId}' requires codebaseId`,
    );
  }
  return {
    ...chunk,
    registryOrigin,
  };
}

function backfillChunk(chunk: RagChunk): RagChunk {
  if (chunk.registryOrigin) return chunk;
  if (chunk.kind === 'app_source' || chunk.kind === 'kernel_source') {
    return {
      ...chunk,
      unsupportedReason: chunk.unsupportedReason ?? 'pre_v3_2_invalid_kind_origin_combo',
    };
  }
  return {
    ...chunk,
    registryOrigin: defaultRegistryOrigin(chunk.kind),
  };
}

/**
 * Local file-backed RAG store. Single instance per storage path is
 * enough for M0 — concurrent writers in the same process serialize via
 * the synchronous persistence path; cross-process writers are not
 * supported (caller's responsibility to coordinate).
 */
export class RagStore {
  private readonly storagePath: string;
  private readonly chunks = new Map<string, RagChunk>();
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
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.chunks)) {
        // Schema mismatch: leave in-memory empty; do not delete the file
        // so the operator can inspect it.
        return;
      }
      for (const c of parsed.chunks) {
        this.chunks.set(c.chunkId, backfillChunk(c));
      }
    } catch {
      // Corrupted JSON: same policy as schema mismatch — empty cache,
      // file preserved for inspection.
    }
  }

  /**
   * Add or replace a chunk. Throws when the kind requires a license and
   * the chunk lacks one — the caller is expected to surface this back
   * to the operator rather than silently dropping the chunk.
   */
  addChunk(chunk: RagChunk, scope?: KnowledgeScope): void {
    this.load();
    const normalized = normalizeChunkForStorage(chunk);
    if (LICENSE_REQUIRED_KINDS.has(chunk.kind) && !chunk.license) {
      throw new Error(
        `License required for source kind '${chunk.kind}' but missing on chunk '${chunk.chunkId}'`,
      );
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.chunks.set(normalized.chunkId, normalized);
    }
    if (enterpriseKnowledgeDbWritesEnabled()) {
      upsertScopedKnowledgeRecord(
        KNOWLEDGE_KIND,
        normalized.chunkId,
        ragRowScope(normalized.kind),
        normalized,
        scope,
        {createdAt: normalized.indexedAt, updatedAt: normalized.indexedAt},
      );
    }
  }

  /** Remove a chunk. Returns whether anything was actually removed. */
  removeChunk(chunkId: string, scope?: KnowledgeScope): boolean {
    let removed = false;
    if (enterpriseKnowledgeDbWritesEnabled()) {
      removed = removeScopedKnowledgeRecord(KNOWLEDGE_KIND, chunkId, scope) || removed;
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.load();
      const had = this.chunks.delete(chunkId);
      if (had) this.persist();
      removed = had || removed;
    }
    return removed;
  }

  /** Get a chunk by id, or undefined when absent. */
  getChunk(chunkId: string, scope?: KnowledgeScope): RagChunk | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      return getScopedKnowledgeRecord<RagChunk>(
        KNOWLEDGE_KIND,
        chunkId,
        scope,
      )?.record;
    }
    this.load();
    return this.chunks.get(chunkId);
  }

  /** List chunks for rebuild/maintenance callers without changing search semantics. */
  listChunks(opts: RagStoreListOptions = {}): RagChunk[] {
    this.load();
    let chunks = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<RagChunk>(
          KNOWLEDGE_KIND,
          opts.scope,
          {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
        ).map(row => row.record)
      : Array.from(this.chunks.values());
    if (opts.kind) chunks = chunks.filter(chunk => chunk.kind === opts.kind);
    if (opts.registryOrigin) {
      chunks = chunks.filter(chunk => chunk.registryOrigin === opts.registryOrigin);
    }
    const uriPrefix = opts.uriPrefix;
    if (uriPrefix) {
      chunks = chunks.filter(chunk => chunk.uri.startsWith(uriPrefix));
    }
    chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    return chunks;
  }

  /** Per-kind chunk counts plus the freshest indexedAt seen for each. */
  getStats(scope?: KnowledgeScope): RagStoreStats {
    this.load();
    const stats = emptyStats();
    const chunks = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<RagChunk>(
          KNOWLEDGE_KIND,
          scope,
          {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
        ).map(row => row.record)
      : Array.from(this.chunks.values());
    for (const c of chunks) {
      const s = stats[c.kind];
      s.chunkCount++;
      if (s.lastIndexedAt === undefined || c.indexedAt > s.lastIndexedAt) {
        s.lastIndexedAt = c.indexedAt;
      }
    }
    return stats;
  }

  /**
   * Keyword search. Hits are ranked by token-overlap fraction relative
   * to the query token set. Chunks carrying `unsupportedReason` are
   * excluded — they live on for audit but the agent must not see them.
   *
   * Three retrieval-level failure modes carry an `unsupportedReason`:
   * (1) the index is empty; (2) every chunk in the probed kinds is
   * blocked / out of scope; the third — a legitimate zero-match query —
   * intentionally returns an empty `results` array with NO
   * `unsupportedReason`, so the agent can tell "I didn't find anything"
   * apart from "the infrastructure refused to answer".
   */
  search(query: string, opts: RagStoreSearchOptions = {}): RagRetrievalResult {
    this.load();
    const topK = opts.topK ?? 5;
    const kindFilter = opts.kinds ? new Set(opts.kinds) : null;
    const chunks = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<RagChunk>(
          KNOWLEDGE_KIND,
          opts.scope,
          {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
        ).map(row => row.record)
      : Array.from(this.chunks.values());
    const codebaseFilter = opts.codebaseIds ? new Set(opts.codebaseIds) : null;
    const languageFilter = opts.languages ? new Set(opts.languages) : null;

    const probed = opts.kinds
      ? [...opts.kinds]
      : Array.from(new Set(chunks.map(c => c.kind)));

    const queryTokens = new Set(tokenize(query));
    const candidates: Array<{chunk: RagChunk; score: number; tier: number}> = [];
    let eligibleSeen = 0;

    for (const chunk of chunks) {
      if (kindFilter && !kindFilter.has(chunk.kind)) continue;
      if (chunk.unsupportedReason) continue;
      if (codebaseFilter && (!chunk.codebaseId || !codebaseFilter.has(chunk.codebaseId))) continue;
      if (opts.vendor && chunk.vendor !== opts.vendor) continue;
      if (opts.buildId && chunk.buildId !== opts.buildId) continue;
      if (opts.pathPrefix && !(chunk.filePath ?? chunk.uri).startsWith(opts.pathPrefix)) continue;
      if (opts.symbolExact && chunk.symbol !== opts.symbolExact) continue;
      if (opts.filePathExact && (chunk.filePath ?? chunk.uri) !== opts.filePathExact) continue;
      if (languageFilter && (!chunk.language || !languageFilter.has(chunk.language))) continue;
      eligibleSeen++;
      const chunkTokens = new Set([
        ...tokenize(chunk.snippet),
        ...tokenize(chunk.title ?? ''),
        ...tokenize(chunk.symbol ?? ''),
        ...tokenize(chunk.filePath ?? ''),
      ]);
      let overlap = 0;
      for (const t of queryTokens) {
        if (chunkTokens.has(t)) overlap++;
      }
      const exactSymbol = Boolean(opts.symbolExact && chunk.symbol === opts.symbolExact);
      const exactFile = Boolean(opts.filePathExact && (chunk.filePath ?? chunk.uri) === opts.filePathExact);
      const pathPrefix = Boolean(opts.pathPrefix && (chunk.filePath ?? chunk.uri).startsWith(opts.pathPrefix));
      const tier = exactSymbol || exactFile ? 3 : pathPrefix ? 2 : 1;
      if (overlap === 0 && tier === 1) continue;
      const score = overlap / Math.max(queryTokens.size, 1);
      candidates.push({chunk, score, tier});
    }

    candidates.sort((a, b) => (b.tier - a.tier) || (b.score - a.score));
    const top = candidates.slice(0, topK);
    const results: RagRetrievalHit[] = top.map(c => ({
      chunkId: c.chunk.chunkId,
      score: c.score,
      chunk: c.chunk,
    }));

    let unsupportedReason: string | undefined;
    if (chunks.length === 0) {
      unsupportedReason = 'index empty';
    } else if (eligibleSeen === 0) {
      // Either every chunk in the probed kinds is blocked, or the kind
      // filter excluded every chunk. Both deserve a clear signal so the
      // agent does not invent content.
      unsupportedReason = kindFilter
        ? 'no eligible chunks for the requested kinds'
        : 'all chunks blocked by unsupportedReason';
    }
    // legitimate zero-match (eligibleSeen > 0, results empty) gets no
    // unsupportedReason — the index works, the query just didn't hit.

    return {
      ...makeSparkProvenance({
        source: 'ragStore.search',
        ...(unsupportedReason ? {unsupportedReason} : {}),
      }),
      query,
      results,
      probed,
      retrievedAt: Date.now(),
    };
  }

  /** Flush in-memory chunks to disk. Call once after a bulk ingest loop. */
  flush(): void {
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.persist();
    }
  }

  /** Atomic write: temp file + rename so a crashed process leaves the
   * existing on-disk file intact. */
  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5 cross-process
    // collision guard. Single-process is the documented contract, but a
    // unique suffix costs nothing and removes the foot-gun.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 2,
      chunks: Array.from(this.chunks.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}

/** Whether the given source kind needs a `license` field at ingest time. */
export function ragStoreRequiresLicense(kind: RagSourceKind): boolean {
  return LICENSE_REQUIRED_KINDS.has(kind);
}

function ragRowScope(kind: RagSourceKind): string {
  return `${RAG_ROW_SCOPE_PREFIX}${kind}`;
}
