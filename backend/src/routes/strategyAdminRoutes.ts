// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Strategy admin endpoints.
 *
 * Exposes a hot-reload endpoint so strategy auto-patches can take effect on
 * a running production backend without a restart. In dev mode strategies are
 * read on every access (DEV_MODE skip cache), so this endpoint is essentially
 * a no-op there — it still provides an explicit signal that future runs
 * should re-parse from disk.
 *
 * See docs/self-improving-design.md §11–12.
 */

import express from 'express';
import { invalidateStrategyCache } from '../agentv3/strategyLoader';
import { authenticate } from '../middleware/auth';

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/admin/strategies/reload
 *
 * Drops the in-process strategy / template / phase-hints cache so the next
 * `analyze()` re-reads `.strategy.md` and `.template.md` from disk.
 *
 * Safe to call any time — already-running analyses snapshot their strategy
 * version at start and are not retroactively affected.
 */
router.post('/strategies/reload', (_req, res) => {
  try {
    invalidateStrategyCache();
    res.json({ success: true, reloadedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[StrategyAdmin] Reload failed:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to reload strategy cache' });
  }
});

export default router;
