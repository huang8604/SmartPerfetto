// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { DataEnvelope } from '../../types/dataContract';

function stableEnvelopeContentHash(env: DataEnvelope): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      source: env.meta?.source,
      skillId: env.meta?.skillId,
      stepId: env.meta?.stepId,
      title: env.display?.title,
      data: env.data,
    }, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
    .digest('hex')
    .slice(0, 12);
}

export function dataEnvelopeRefId(env: DataEnvelope, duplicateEvidenceRefIds: Set<string> = new Set()): string {
  if (env.meta?.evidenceRefId) {
    if (duplicateEvidenceRefIds.has(env.meta.evidenceRefId) && env.meta.sourceToolCallId) {
      return `${env.meta.evidenceRefId}:tool:${env.meta.sourceToolCallId}`;
    }
    return env.meta.evidenceRefId;
  }
  const source = env.meta?.source || env.meta?.skillId || 'data_envelope';
  const stepId = env.meta?.stepId || 'step';
  const timestamp = env.meta?.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
    return `data:${source}:${stepId}:${timestamp}`;
  }
  return `data:${source}:${stepId}:${stableEnvelopeContentHash(env)}`;
}
