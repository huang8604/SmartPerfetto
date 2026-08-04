// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router } from 'express';
import { requireRequestContext } from '../middleware/auth';
import { createSkillPackController } from '../controllers/skillPackController';
import { hasRbacPermission, sendForbidden } from '../services/rbac';

export function createSkillPackRoutes(): Router {
  const router = Router();
  const controller = createSkillPackController();

  router.use((req, res, next) => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'runtime:manage')) {
      sendForbidden(res, 'Skill pack management requires runtime:manage permission');
      return;
    }
    next();
  });

  router.get('/', controller.list);
  router.post('/preview', controller.preview);
  router.post('/install', controller.install);
  router.patch('/:packId', controller.setEnabled);
  router.delete('/:packId', controller.remove);

  return router;
}

export default createSkillPackRoutes();
