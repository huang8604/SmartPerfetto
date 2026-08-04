// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {NextFunction, Request, Response} from 'express';
import {resolveFeatureConfig} from '../config';

/**
 * Fail closed for legacy process-global data routes in multi-tenant mode.
 * These handlers predate RequestContext ownership and must not be exposed
 * until they have a workspace-scoped replacement.
 */
export function rejectEnterpriseUnscopedApi(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!resolveFeatureConfig(process.env).enterprise) {
    next();
    return;
  }
  res.status(410).json({
    success: false,
    error: 'This unscoped legacy API is disabled in enterprise mode',
    code: 'ENTERPRISE_WORKSPACE_ROUTE_REQUIRED',
  });
}
