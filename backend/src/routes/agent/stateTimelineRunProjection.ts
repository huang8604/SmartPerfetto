// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DataEnvelope } from "../../types/dataContract";

export interface StateTimelineRunProjectionInput {
  readonly envelopes: DataEnvelope[];
  readonly isStaleRun: () => boolean;
  readonly isRunCancelled: () => boolean;
  readonly isRunActive?: () => boolean;
  readonly updateArtifacts: (envelopes: DataEnvelope[]) => boolean;
  readonly emitData: (envelope: DataEnvelope) => void;
  readonly emitTrackData: () => void;
}

export function projectStateTimelineRunResult(
  input: StateTimelineRunProjectionInput,
): boolean {
  if (
    input.isStaleRun() ||
    input.isRunCancelled() ||
    input.isRunActive?.() === false ||
    input.envelopes.length === 0
  )
    return false;

  const changed = input.updateArtifacts(input.envelopes);
  for (const envelope of input.envelopes) {
    input.emitData(envelope);
  }
  if (changed) input.emitTrackData();
  return true;
}
