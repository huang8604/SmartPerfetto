// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  downloadPublicHttpUrl,
  publicHttpAddressAllowed,
  sanitizedPublicHttpUrl,
  setPublicHttpDownloadForTests,
} from '../publicHttpDownload';
import {PassThrough} from 'stream';

describe('public HTTP download boundary', () => {
  afterEach(() => setPublicHttpDownloadForTests());
  it.each([
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '2001:db8::1',
  ])('rejects non-public address %s', address => {
    expect(publicHttpAddressAllowed(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'allows public address %s',
    address => expect(publicHttpAddressAllowed(address)).toBe(true),
  );

  it('removes credentials and query material from log-safe URLs', () => {
    const url = new URL('https://user:secret@example.com/traces/a.trace?token=secret#fragment');
    expect(sanitizedPublicHttpUrl(url)).toBe('https://example.com/traces/a.trace');
  });

  it('enforces an absolute response-body deadline even when bytes keep arriving', async () => {
    const body = new PassThrough();
    setPublicHttpDownloadForTests(async url => ({
      status: 200,
      statusText: 'OK',
      headers: {get: () => null},
      body: body as any,
      finalUrl: url,
    }));
    const response = await downloadPublicHttpUrl(new URL('https://example.test/a.trace'), 20);
    const error = new Promise<Error>(resolve => response.body.once('error', resolve));
    const ticker = setInterval(() => body.write('x'), 2);

    await expect(error).resolves.toMatchObject({message: 'Trace URL response deadline exceeded'});
    clearInterval(ticker);
  });
});
