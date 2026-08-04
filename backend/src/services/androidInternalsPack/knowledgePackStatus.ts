// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import {getDefaultAndroidInternalsPackResolver, readAndroidInternalsPackChannelState} from './androidInternalsPackResolver';
import {androidInternalsPackAssetRoot, androidInternalsPackStatusErrorPath} from './packPaths';
import {
  ANDROID_INTERNALS_PACK_LICENSE,
  type AndroidInternalsPackStatus,
} from './types';

function lastError(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(androidInternalsPackStatusErrorPath(), 'utf8')) as {
      message?: unknown;
    };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

export function getAndroidInternalsPackStatus(): AndroidInternalsPackStatus {
  const enabled = process.env.SMARTPERFETTO_AIW_PACK_ENABLED !== '0';
  if (!enabled) {
    return {
      enabled,
      availability: 'disabled',
      licenseExpression: ANDROID_INTERNALS_PACK_LICENSE,
    };
  }
  const channel = readAndroidInternalsPackChannelState();
  try {
    const active = getDefaultAndroidInternalsPackResolver().resolve();
    if (!active) {
      return {
        enabled,
        availability: channel?.revokedVersions.length ? 'revoked' : 'not_installed',
        channel,
        lastError: lastError(),
        licenseExpression: ANDROID_INTERNALS_PACK_LICENSE,
      };
    }
    return {
      enabled,
      availability: 'available',
      active: {
        contentVersion: active.contentVersion,
        contentFingerprint: active.contentFingerprint,
        sourceRevision: active.sourceRevision,
        origin: active.origin,
      },
      bundled: active.origin === 'bundled'
        ? {
            contentVersion: active.contentVersion,
            contentFingerprint: active.contentFingerprint,
            sourceRevision: active.sourceRevision,
          }
        : undefined,
      channel,
      lastError: lastError(),
      licenseExpression: active.manifest.licenses.expression,
      attribution: active.manifest.licenses.attribution,
    };
  } catch (error) {
    return {
      enabled,
      availability: fs.existsSync(path.join(androidInternalsPackAssetRoot(), '1.root.json'))
        ? 'invalid'
        : 'not_installed',
      channel,
      lastError: error instanceof Error ? error.message : String(error),
      licenseExpression: ANDROID_INTERNALS_PACK_LICENSE,
    };
  }
}
