// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session Routes
 *
 * API endpoints for session management (persisted sessions)
 *
 * Routes:
 * - GET /api/sessions - List all sessions
 * - GET /api/sessions/export - Export sessions
 * - GET /api/sessions/:id - Get specific session
 * - DELETE /api/sessions/:id - Delete session
 */

import express from 'express';
import { SessionPersistenceService } from '../services/sessionPersistenceService';

const router = express.Router();

// Lazy initialization of service
let _sessionPersistenceService: any = null;

function getSessionPersistenceService() {
  if (!_sessionPersistenceService) {
    _sessionPersistenceService = SessionPersistenceService.getInstance();
  }
  return _sessionPersistenceService;
}

/**
 * GET /api/sessions
 *
 * List all sessions with pagination
 *
 * Query params:
 * - traceId: Filter by trace ID
 * - limit: Number of sessions to return (default: 20)
 * - offset: Number of sessions to skip (default: 0)
 *
 * Response:
 * {
 *   "success": true,
 *   "sessions": [...],
 *   "totalCount": 100,
 *   "hasMore": true
 * }
 */
router.get('/', async (req, res) => {
  try {
    const { traceId, limit, offset } = req.query;

    // Parse and validate pagination parameters
    const parsedLimit = limit ? parseInt(limit as string) : 20;
    const parsedOffset = offset ? parseInt(offset as string) : 0;

    // Validate parsed values
    if (isNaN(parsedLimit) || isNaN(parsedOffset)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pagination parameters'
      });
    }

    // Apply reasonable bounds
    const validatedLimit = Math.max(1, Math.min(1000, parsedLimit));
    const validatedOffset = Math.max(0, parsedOffset);

    const result = getSessionPersistenceService().listSessions({
      traceId: traceId as string | undefined,
      limit: validatedLimit,
      offset: validatedOffset,
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'An unknown error occurred' });
  }
});

/**
 * GET /api/sessions/export
 *
 * Export sessions as JSON
 *
 * Query params:
 * - traceId: Optional trace ID to filter
 *
 * Response: JSON file download
 */
router.get('/export', async (req, res) => {
  try {
    const { traceId } = req.query;

    const jsonData = getSessionPersistenceService().exportSessions(traceId as string | undefined);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sessions-${Date.now()}.json"`);
    res.send(jsonData);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'An unknown error occurred' });
  }
});

/**
 * GET /api/sessions/:id
 *
 * Get specific session by ID
 *
 * Response:
 * {
 *   "success": true,
 *   "session": {...}
 * }
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const session = getSessionPersistenceService().getSession(id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, session });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'An unknown error occurred' });
  }
});

/**
 * DELETE /api/sessions/:id
 *
 * Delete a session
 *
 * Response:
 * {
 *   "success": true,
 *   "deleted": true
 * }
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = getSessionPersistenceService().deleteSession(id);
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'An unknown error occurred' });
  }
});

export default router;