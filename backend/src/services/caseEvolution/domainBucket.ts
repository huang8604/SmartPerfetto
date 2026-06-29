// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export function bucketPackageDomain(packageName: string | undefined): string {
  const normalized = (packageName || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length >= 2) return sanitizeBucket(parts[1]);
  if (parts.length === 1) return sanitizeBucket(parts[0]);
  return 'unknown';
}

function sanitizeBucket(value: string): string {
  const sanitized = value.replace(/[^a-z0-9_-]+/g, '');
  return sanitized || 'unknown';
}
