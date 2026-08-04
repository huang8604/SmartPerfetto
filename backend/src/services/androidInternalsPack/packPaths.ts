// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';

import {backendDataPath} from '../../runtimePaths';
import {isAndroidInternalsPackContentVersion} from './manifest';

export function androidInternalsPackAssetRoot(): string {
  return process.env.SMARTPERFETTO_AIW_PACK_ASSET_DIR ||
    path.resolve(__dirname, '../../../knowledge/aiw-pack');
}

export function androidInternalsPackRuntimeRoot(): string {
  return backendDataPath('knowledge-packs', 'android-internals');
}

export function androidInternalsPackBundledRoot(): string {
  return path.join(androidInternalsPackAssetRoot(), 'bundled');
}

export function androidInternalsPackVersionsRoot(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'versions');
}

export function androidInternalsPackVersionDirectory(version: string): string {
  if (!isAndroidInternalsPackContentVersion(version)) {
    throw new Error('invalid_aiw_pack_version_path');
  }
  return path.join(androidInternalsPackVersionsRoot(), version);
}

export function androidInternalsPackActivePointerPath(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'active.json');
}

export function androidInternalsPackLastKnownGoodPointerPath(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'last-known-good.json');
}

export function androidInternalsPackChannelStatePath(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'channel-state.json');
}

export function androidInternalsPackStatusErrorPath(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'last-error.json');
}

export function androidInternalsPackTufRoot(): string {
  return path.join(androidInternalsPackRuntimeRoot(), 'tuf');
}
