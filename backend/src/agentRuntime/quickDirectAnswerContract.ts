// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract } from '../agent/core/conclusionContract';

export interface QuickDirectAnswerBase {
  conclusion: string;
  confidence: number;
}

export interface QuickStructuredDirectAnswer extends QuickDirectAnswerBase {
  conclusionContract: ConclusionContract;
}
