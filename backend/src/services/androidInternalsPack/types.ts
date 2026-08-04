// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  BackgroundKnowledgeReference,
  RagRetrievalResult,
} from '../../types/sparkContracts';

export type {BackgroundKnowledgeReference} from '../../types/sparkContracts';

export const ANDROID_INTERNALS_PACK_ID = 'android-internals';
export const ANDROID_INTERNALS_PACK_FORMAT_VERSION = 1;
export const ANDROID_INTERNALS_PACK_SCHEMA_VERSION = 1;
export const ANDROID_INTERNALS_PACK_LICENSE =
  'CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial';

export interface AndroidInternalsPackManifest {
  schemaVersion: 1;
  packId: typeof ANDROID_INTERNALS_PACK_ID;
  packFormatVersion: 1;
  contentVersion: string;
  contentFingerprint: string;
  sourceRevision: string;
  generatedAt: string;
  articleCount: number;
  sectionCount: number;
  chunkCount: number;
  compatibility: {
    smartPerfettoMinVersion: string;
    smartPerfettoMaxVersion: string;
  };
  database: {
    file: 'content.sqlite.gz';
    compression: 'gzip';
    sha256: string;
    uncompressedSha256: string;
    compressedBytes: number;
    uncompressedBytes: number;
  };
  audit: {
    file: 'audit-summary.json';
    sha256: string;
  };
  licenses: {
    expression: typeof ANDROID_INTERNALS_PACK_LICENSE;
    attribution: string;
    copyrightHolder: string;
    files: Record<string, string>;
  };
  revocation: {
    revoked: boolean;
    minimumSafeVersion: string;
    reasonCode?: string | null;
  };
}

export interface AndroidInternalsPackChannel {
  schemaVersion: 1;
  packId: typeof ANDROID_INTERNALS_PACK_ID;
  contentVersion: string;
  contentFingerprint: string;
  sourceRevision: string;
  generatedAt: string;
  minimumSafeVersion: string;
  revokedVersions: string[];
  reasonCode?: string | null;
  targets: {
    manifest: string;
    database: string;
    audit: string;
    licenses: Record<string, string>;
  };
}

export interface AndroidInternalsPackIdentity {
  contentVersion: string;
  contentFingerprint: string;
  sourceRevision: string;
}

export interface AndroidInternalsPackHandle extends AndroidInternalsPackIdentity {
  origin: 'bundled' | 'runtime' | 'pinned';
  directory: string;
  databasePath: string;
  manifest: AndroidInternalsPackManifest;
}

export interface AndroidInternalsPackSearchOptions {
  topK?: number;
}

export interface AndroidInternalsPackStoreLike {
  readonly handle: AndroidInternalsPackHandle;
  search(query: string, options?: AndroidInternalsPackSearchOptions): RagRetrievalResult;
  close(): void;
}

export interface AndroidInternalsPackPointer extends AndroidInternalsPackIdentity {
  installedAt: string;
  origin: 'runtime';
}

export interface AndroidInternalsPackChannelState {
  checkedAt: string;
  contentVersion?: string;
  minimumSafeVersion?: string;
  revokedVersions: string[];
  reasonCode?: string | null;
}

export type AndroidInternalsPackAvailability =
  | 'available'
  | 'disabled'
  | 'not_installed'
  | 'revoked'
  | 'invalid';

export interface AndroidInternalsPackStatus {
  enabled: boolean;
  availability: AndroidInternalsPackAvailability;
  active?: AndroidInternalsPackIdentity & {
    origin: AndroidInternalsPackHandle['origin'];
  };
  bundled?: AndroidInternalsPackIdentity;
  channel?: AndroidInternalsPackChannelState;
  lastError?: string;
  licenseExpression: typeof ANDROID_INTERNALS_PACK_LICENSE;
  attribution?: string;
}

export interface AndroidInternalsPackUpdateResult {
  status: 'installed' | 'up_to_date' | 'disabled' | 'check_only';
  previousVersion?: string;
  contentVersion?: string;
  contentFingerprint?: string;
}

export type AndroidInternalsBackgroundReference = BackgroundKnowledgeReference;
