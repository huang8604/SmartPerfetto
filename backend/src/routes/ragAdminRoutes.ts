// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * RAG admin routes — operator-side surface for the Plan 55 RAG
 * store. Lets a curator inspect index population per source kind,
 * delete blocked / stale chunks, and search the index directly
 * (without going through the agent).
 *
 * Endpoints (all under `/api/rag`):
 *   GET    /stats              per-kind chunk counts + last indexed
 *   GET    /chunks/:chunkId    fetch one chunk
 *   DELETE /chunks/:chunkId    remove a chunk (license-blocked
 *                              entries can be evicted permanently
 *                              once the curator decides to)
 *   POST   /search             body `{query, kinds?, topK?}` —
 *                              run a search like the agent would
 *
 * Ingestion endpoints (POST /ingest/blog, /ingest/aosp,
 * /ingest/oem) are intentionally NOT exposed in M2; ingesters are
 * called from operator scripts that supply the fetcher (with
 * authenticated source credentials) directly. M3 may add upload
 * endpoints once an authentication story exists.
 *
 * @module ragAdminRoutes
 */

import {Router, type Router as ExpressRouter} from 'express';

import {RagStore} from '../services/ragStore';
import type {RagSourceKind} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';

const DEFAULT_STORAGE_PATH = backendLogPath('rag_store.json');

let cachedStore: RagStore | null = null;
function getDefaultStore(): RagStore {
  if (!cachedStore) cachedStore = new RagStore(DEFAULT_STORAGE_PATH);
  return cachedStore;
}

/** Test/factory hook. */
export function createRagAdminRoutes(store?: RagStore): ExpressRouter {
  const s = store ?? getDefaultStore();
  const router = Router();

  router.get('/stats', (_req, res) => {
    res.json({success: true, stats: s.getStats()});
  });

  router.get('/chunks/:chunkId', (req, res) => {
    const chunk = s.getChunk(req.params.chunkId);
    if (!chunk) {
      return res.status(404).json({
        success: false,
        error: `Chunk '${req.params.chunkId}' not found`,
      });
    }
    res.json({success: true, chunk});
  });

  router.delete('/chunks/:chunkId', (req, res) => {
    const removed = s.removeChunk(req.params.chunkId);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Chunk '${req.params.chunkId}' not found`,
      });
    }
    res.json({success: true});
  });

  router.post('/search', (req, res) => {
    const {query, kinds, topK} = (req.body ?? {}) as {
      query?: string;
      kinds?: RagSourceKind[];
      topK?: number;
    };
    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        error: '`query` (string) is required',
      });
    }
    const result = s.search(query, {
      ...(kinds ? {kinds} : {}),
      ...(topK ? {topK} : {}),
    });
    res.json({success: true, result});
  });

  return router;
}

const ragAdminRoutes = createRagAdminRoutes();
export default ragAdminRoutes;
