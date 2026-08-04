// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * OemSdkKnowledgeIngester — pulls vendor-published SDK / tuning
 * docs and writes them to a `RagStore` under the `oem_sdk` source
 * kind. Plan 55 M2 entry layer.
 *
 * Like AOSP, OEM SDK docs require an explicit license string at
 * ingestion. Unlike AOSP, the typical license is `proprietary` —
 * the agent must surface "source unavailable" if license policy
 * later blocks retrieval (§5.2 contract).
 *
 * M2 scope:
 * - Pluggable fetcher; production wiring is operator-driven (the
 *   admin route lets curators upload pre-redacted vendor docs).
 * - Markdown / plain-text ingestion only for M2. PDF parsing is
 *   intentionally out of scope — operators should pre-extract.
 * - vendor field carried on every chunk via a deterministic
 *   `vendor::path` URI prefix so retrieval can scope by vendor.
 *
 * @module oemSdkKnowledgeIngester
 */

import {createHash} from 'crypto';

import type {RagStore} from './ragStore';
import type {RagChunk} from '../types/sparkContracts';

export interface OemSdkDocument {
  /** Vendor identifier — `mtk`, `qualcomm`, `samsung`, etc. */
  vendor: string;
  /** Document path or url, e.g. `tuning/cpu-freq-floor.md`. */
  docPath: string;
  /** Markdown / plain-text content. */
  content: string;
  /** Approximate epoch-ms timestamp when the doc was captured. */
  fetchedAt: number;
  /** License — `proprietary` is typical; explicit non-empty string
   *  required. */
  license: string;
  /** Optional title; falls back to last path segment. */
  title?: string;
  /** Optional author / curator. */
  author?: string;
}

export interface OemSdkFetcher {
  fetchDocs(opts?: {vendor?: string}): Promise<OemSdkDocument[]>;
}

export interface OemSdkIngestOptions {
  /** Maximum characters per chunk. Defaults to 1500 (matches blog). */
  maxChunkChars?: number;
  /** Restrict to a vendor (forwarded to fetcher). */
  vendor?: string;
}

export interface OemSdkIngestError {
  vendor: string;
  docPath: string;
  reason: string;
}

export interface OemSdkIngestResult {
  docsProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  errors: OemSdkIngestError[];
}

const DEFAULT_MAX_CHUNK_CHARS = 1500;

/** Compose a stable URI from vendor + docPath so retrieval can
 * filter by vendor via prefix match. */
function uriFor(vendor: string, docPath: string): string {
  return `oem://${vendor}/${docPath.replace(/^\//, '')}`;
}

function makeChunkId(uri: string, offset: number): string {
  return createHash('sha256')
    .update(`${uri}|${offset}`)
    .digest('hex')
    .slice(0, 16);
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** Paragraph-based chunker; same shape as the blog ingester's. */
function chunkText(text: string, maxChars: number): Array<{text: string; offset: number}> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const out: Array<{text: string; offset: number}> = [];
  let cursor = 0;
  let buf = '';
  let bufStart = 0;
  for (const p of paragraphs) {
    if (buf.length === 0) {
      buf = p;
      bufStart = cursor;
    } else if (buf.length + 2 + p.length <= maxChars) {
      buf += '\n\n' + p;
    } else {
      out.push({text: buf, offset: bufStart});
      buf = p;
      bufStart = cursor;
    }
    cursor += p.length + 2;
  }
  if (buf.length > 0) out.push({text: buf, offset: bufStart});
  return out;
}

export class OemSdkKnowledgeIngester {
  constructor(
    private readonly store: RagStore,
    private readonly fetcher: OemSdkFetcher,
  ) {}

  async ingest(opts: OemSdkIngestOptions = {}): Promise<OemSdkIngestResult> {
    const maxChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
    const result: OemSdkIngestResult = {
      docsProcessed: 0,
      chunksAdded: 0,
      chunksSkipped: 0,
      errors: [],
    };

    let docs: OemSdkDocument[];
    try {
      docs = await this.fetcher.fetchDocs({vendor: opts.vendor});
    } catch (err) {
      result.errors.push({
        vendor: '<fetcher>',
        docPath: '<fetcher>',
        reason: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    for (const doc of docs) {
      result.docsProcessed++;
      if (!doc.license || doc.license.trim().length === 0) {
        result.errors.push({
          vendor: doc.vendor,
          docPath: doc.docPath,
          reason: 'license required for kind=oem_sdk; entry rejected',
        });
        result.chunksSkipped++;
        continue;
      }
      if (!doc.vendor || doc.vendor.trim().length === 0) {
        result.errors.push({
          vendor: '<missing>',
          docPath: doc.docPath,
          reason: 'vendor field required',
        });
        result.chunksSkipped++;
        continue;
      }
      try {
        const uri = uriFor(doc.vendor, doc.docPath);
        const packed = chunkText(doc.content, maxChars);
        const documentChunks: RagChunk[] = [];
        for (const p of packed) {
          const chunk: RagChunk = {
            chunkId: makeChunkId(uri, p.offset),
            kind: 'oem_sdk',
            uri,
            title: doc.title ?? doc.docPath.split('/').pop(),
            snippet: p.text,
            tokenCount: estimateTokenCount(p.text),
            license: doc.license,
            indexedAt: doc.fetchedAt,
            verifiedAt: doc.fetchedAt,
            author: doc.author,
          };
          documentChunks.push(chunk);
        }
        this.store.addChunks(documentChunks);
        result.chunksAdded += documentChunks.length;
      } catch (err) {
        result.errors.push({
          vendor: doc.vendor,
          docPath: doc.docPath,
          reason: err instanceof Error ? err.message : String(err),
        });
        result.chunksSkipped++;
      }
    }
    return result;
  }
}

export const __TEST_ONLY__ = {chunkText, makeChunkId, uriFor};
