// SPDX-License-Identifier: AGPL-3.0-or-later

import {maskEnvKeys} from '../providerRoutes';

describe('provider effective environment masking', () => {
  it('fully masks sensitive values regardless of key spelling or length', () => {
    expect(maskEnvKeys({
      API_KEY: 'short',
      AUTHORIZATION: 'Bearer secret',
      DB_PASSWORD: 'pw',
      SESSION_COOKIE: 'cookie-value',
      PROVIDER_CREDENTIAL: 'credential-value',
      OPENAI_BASE_URL: 'https://example.test/v1',
    })).toEqual({
      API_KEY: '****',
      AUTHORIZATION: '****',
      DB_PASSWORD: '****',
      SESSION_COOKIE: '****',
      PROVIDER_CREDENTIAL: '****',
      OPENAI_BASE_URL: 'https://example.test/v1',
    });
  });
});
