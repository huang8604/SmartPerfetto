// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type CodeAwareMode = 'off' | 'metadata_only' | 'provider_send';

export const MAX_CODEBASE_IDS_PER_ANALYSIS = 32;
export const MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS = 32;

export function codeAwareFeatureEnabled(): boolean {
  return process.env.SMARTPERFETTO_CODE_AWARE !== 'off';
}

export function normalizeCodeAwareMode(value: unknown): CodeAwareMode {
  if (!codeAwareFeatureEnabled()) return 'off';
  if (value === 'provider_send' || value === 'metadata_only' || value === 'off') return value;
  return 'metadata_only';
}
