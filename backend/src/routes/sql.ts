// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router } from 'express';
import SqlController from '../controllers/sqlController';
// import { authenticate, checkUsage } from '../middleware/auth';

const router = Router();
const sqlController = new SqlController();

// GET /api/sql/tables - Get available Perfetto tables schema (public)
router.get('/tables', sqlController.getTablesSchema);

// POST /api/sql/generate - Generate Perfetto SQL from natural language (auth disabled for development)
router.post('/generate', sqlController.generateSql);

export default router;