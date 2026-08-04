// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from "@jest/globals";
import {
  createDataEnvelope,
  type DataEnvelope,
} from "../../../types/dataContract";
import { projectStateTimelineRunResult } from "../stateTimelineRunProjection";

function createStateTimelineEnvelope(value: string) {
  return createDataEnvelope(
    { columns: ["status"], rows: [[value]] },
    {
      type: "skill_result",
      source: "state_timeline:app_state_lane",
      skillId: "state_timeline",
      stepId: "app_state_lane",
      title: "App state lane",
    },
  );
}

describe("projectStateTimelineRunResult", () => {
  it.each(["completed", "failed"] as const)(
    "does not append data or track_data after the run is %s",
    (status) => {
      const emittedEventTypes: string[] = [];
      const updateArtifacts = jest.fn((_envelopes: DataEnvelope[]) => true);
      const envelope = createStateTimelineEnvelope(status);

      const projected = projectStateTimelineRunResult({
        envelopes: [envelope],
        isStaleRun: () => false,
        isRunCancelled: () => false,
        isRunActive: () => false,
        updateArtifacts,
        emitData: () => emittedEventTypes.push("data"),
        emitTrackData: () => emittedEventTypes.push("track_data"),
      });

      expect(projected).toBe(false);
      expect(updateArtifacts).not.toHaveBeenCalled();
      expect(emittedEventTypes).toEqual([]);
    },
  );

  it("does not append data or track_data when the result belongs to a stale run", () => {
    const emittedEventTypes: string[] = [];
    const updateArtifacts = jest.fn((_envelopes: DataEnvelope[]) => true);
    const envelope = createStateTimelineEnvelope("stale");

    const projected = projectStateTimelineRunResult({
      envelopes: [envelope],
      isStaleRun: () => true,
      isRunCancelled: () => false,
      isRunActive: () => true,
      updateArtifacts,
      emitData: () => emittedEventTypes.push("data"),
      emitTrackData: () => emittedEventTypes.push("track_data"),
    });

    expect(projected).toBe(false);
    expect(updateArtifacts).not.toHaveBeenCalled();
    expect(emittedEventTypes).toEqual([]);
  });

  it("does not append data or track_data when a late result resolves after cancellation", async () => {
    const terminalEventTypes = ["analysis_cancelled", "end"];
    const updateArtifacts = jest.fn((_envelopes: DataEnvelope[]) => true);
    const envelope = createStateTimelineEnvelope("cancelled");

    const projected = await Promise.resolve([envelope]).then((envelopes) =>
      projectStateTimelineRunResult({
        envelopes,
        isStaleRun: () => false,
        isRunCancelled: () => true,
        updateArtifacts,
        emitData: () => terminalEventTypes.push("data"),
        emitTrackData: () => terminalEventTypes.push("track_data"),
      }),
    );

    expect(projected).toBe(false);
    expect(updateArtifacts).not.toHaveBeenCalled();
    expect(terminalEventTypes).toEqual(["analysis_cancelled", "end"]);
  });

  it.each(["pending", "running"] as const)(
    "projects artifacts and events while the run is %s",
    (status) => {
      const emittedEventTypes: string[] = [];
      const updateArtifacts = jest.fn((_envelopes: DataEnvelope[]) => true);
      const envelope = createStateTimelineEnvelope(status);

      const projected = projectStateTimelineRunResult({
        envelopes: [envelope],
        isStaleRun: () => false,
        isRunCancelled: () => false,
        isRunActive: () => true,
        updateArtifacts,
        emitData: (emittedEnvelope) => {
          expect(emittedEnvelope).toBe(envelope);
          emittedEventTypes.push("data");
        },
        emitTrackData: () => emittedEventTypes.push("track_data"),
      });

      expect(projected).toBe(true);
      expect(updateArtifacts).toHaveBeenCalledWith([envelope]);
      expect(emittedEventTypes).toEqual(["data", "track_data"]);
    },
  );

  it("keeps projecting for existing callers that omit the active-run gate", () => {
    const envelope = createStateTimelineEnvelope("legacy");
    const updateArtifacts = jest.fn((_envelopes: DataEnvelope[]) => false);
    const emitData = jest.fn((_envelope: DataEnvelope) => undefined);
    const emitTrackData = jest.fn();

    const projected = projectStateTimelineRunResult({
      envelopes: [envelope],
      isStaleRun: () => false,
      isRunCancelled: () => false,
      updateArtifacts,
      emitData,
      emitTrackData,
    });

    expect(projected).toBe(true);
    expect(updateArtifacts).toHaveBeenCalledWith([envelope]);
    expect(emitData).toHaveBeenCalledWith(envelope);
    expect(emitTrackData).not.toHaveBeenCalled();
  });
});
