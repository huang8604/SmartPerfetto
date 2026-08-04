// SPDX-License-Identifier: AGPL-3.0-or-later

import express from 'express';
import request from 'supertest';
import {rejectEnterpriseUnscopedApi} from '../enterpriseRouteBoundary';

describe('enterprise route boundary', () => {
  const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;

  afterEach(() => {
    if (originalEnterprise === undefined) delete process.env.SMARTPERFETTO_ENTERPRISE;
    else process.env.SMARTPERFETTO_ENTERPRISE = originalEnterprise;
  });

  function makeApp() {
    const app = express();
    app.get('/legacy', rejectEnterpriseUnscopedApi, (_req, res) => res.json({success: true}));
    return app;
  }

  it('disables process-global legacy routes in enterprise mode', async () => {
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    const response = await request(makeApp()).get('/legacy');
    expect(response.status).toBe(410);
    expect(response.body.code).toBe('ENTERPRISE_WORKSPACE_ROUTE_REQUIRED');
  });

  it('preserves local single-user compatibility', async () => {
    delete process.env.SMARTPERFETTO_ENTERPRISE;
    await request(makeApp()).get('/legacy').expect(200, {success: true});
  });
});
