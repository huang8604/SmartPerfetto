// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type express from 'express';
import {
  AiDisabledError,
  assertAiFeatureEnabled,
  buildAiDisabledPayload,
  type AiCapabilityFeature,
} from '../services/aiCapabilityPolicy';

export function sendAiDisabledResponse(res: express.Response, error: AiDisabledError): void {
  res.status(403).json(buildAiDisabledPayload(error));
}

export function sendAiDisabledErrorIfPresent(res: express.Response, error: unknown): boolean {
  if (!(error instanceof AiDisabledError)) {
    return false;
  }
  sendAiDisabledResponse(res, error);
  return true;
}

export function requireAiEnabledForHttp(
  res: express.Response,
  feature: AiCapabilityFeature,
): boolean {
  try {
    assertAiFeatureEnabled(feature);
    return true;
  } catch (error) {
    if (error instanceof AiDisabledError) {
      sendAiDisabledResponse(res, error);
      return false;
    }
    throw error;
  }
}
