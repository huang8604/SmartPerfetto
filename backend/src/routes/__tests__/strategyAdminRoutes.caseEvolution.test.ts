// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import strategyAdminRoutes from '../strategyAdminRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', strategyAdminRoutes);
  return app;
}

function adminHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'org_admin')
    .set('X-SmartPerfetto-SSO-Scopes', '*');
}

describe('strategy admin case evolution metrics', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    app = makeApp();
  });

  afterEach(() => {
    restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  });

  it('rejects unauthenticated metrics requests in enterprise mode', async () => {
    const res = await request(app).get('/api/admin/case-evolution/metrics');

    expect(res.status).toBe(401);
  });

  it('returns a failure-tolerant metrics snapshot to authenticated admins', async () => {
    const res = await adminHeaders(
      request(app).get('/api/admin/case-evolution/metrics'),
    ).expect(200);

    expect(res.body.collectedAt).toEqual(expect.any(Number));
    expect(res.body.candidates.byState).toEqual(expect.objectContaining({
      pending_review: expect.any(Number),
      reviewed: expect.any(Number),
      rejected: expect.any(Number),
      archived: expect.any(Number),
    }));
    expect(res.body.flags).toEqual(expect.objectContaining({
      captureEnabled: expect.any(Boolean),
      reviewEnabled: expect.any(Boolean),
    }));
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });
});
