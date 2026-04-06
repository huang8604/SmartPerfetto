// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router } from 'express';
import {
  startSession,
  analyzeWithAI,
  getProactiveInsights,
  predictIssues,
  getSession,
  updatePreferences,
  deleteSession,
  executeQuery,
  getSmartSummary,
  getLearningStats,
  getLearningReport,
  triggerLearning,
} from '../controllers/advancedAIController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Session management
router.post('/session/start', startSession);
router.get('/session/:sessionId', getSession);
router.put('/session/:sessionId/preferences', updatePreferences);
router.delete('/session/:sessionId', deleteSession);

// AI analysis
router.post('/analyze', analyzeWithAI);

// Proactive features
router.get('/insights/:traceId', getProactiveInsights);
router.get('/predict/:traceId', predictIssues);
router.get('/summary/:traceId', getSmartSummary);

// Query execution
router.post('/query', executeQuery);

// SQL Learning system
router.get('/learning/stats', getLearningStats);
router.get('/learning/report', getLearningReport);
router.post('/learning/train', triggerLearning);

export default router;