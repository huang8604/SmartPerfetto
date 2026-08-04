// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router, type RequestHandler } from 'express';
import { requireRequestContext } from '../middleware/auth';
import { createBatchTraceController } from '../controllers/batchTraceController';
import { hasRbacPermission, sendForbidden, type RbacPermission } from '../services/rbac';

function requirePermission(permission: RbacPermission): RequestHandler {
  return (req, res, next) => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, permission)) {
      sendForbidden(res, `Batch trace route requires ${permission} permission`);
      return;
    }
    next();
  };
}

export function createBatchTraceRoutes(): Router {
  const router = Router({ mergeParams: true });
  const controller = createBatchTraceController();

  router.post('/', requirePermission('agent:run'), controller.create);
  router.get('/', requirePermission('report:read'), controller.list);
  router.get('/:runId', requirePermission('report:read'), controller.get);
  router.get('/:runId/report/export', requirePermission('report:read'), controller.exportReport);
  router.post('/:runId/promote-snapshots', requirePermission('analysis_result:create'), controller.promoteSnapshots);
  router.post('/:runId/comparisons', requirePermission('comparison:create'), controller.createComparison);

  return router;
}

export default createBatchTraceRoutes();
