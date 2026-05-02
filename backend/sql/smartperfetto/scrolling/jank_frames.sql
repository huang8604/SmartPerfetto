-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.
--
-- smartperfetto.scrolling.jank_frames
--
-- Janky-frame extraction view anchored on FrameTimeline ground truth
-- (Spark #16). Returns ONE ROW PER (process, frame_id) janky frame.
--
-- Codex round 5 caught two over-counting hazards:
--   1. actual_frame_timeline_slice has one row per (frame_id, layer)
--      pair — multi-layer apps would produce duplicate rows per frame.
--   2. The LEFT JOIN to expected_frame_timeline_slice on (upid, name)
--      can cartesian-multiply when more than one expected row exists.
--
-- The CTEs below collapse both sides to a single row per (upid, name)
-- so the exported view honors its "one row per janky frame" promise.
-- Combined jank reasons (e.g., "SurfaceFlinger Scheduling, App
-- Deadline Missed") are joined back via GROUP_CONCAT(DISTINCT ...).

INCLUDE PERFETTO MODULE android.frames.timeline;

CREATE PERFETTO VIEW smartperfetto_scrolling_jank_frames AS
WITH expected_per_frame AS (
  SELECT upid, name, MIN(dur) AS expected_dur_ns
  FROM expected_frame_timeline_slice
  GROUP BY upid, name
),
actual_dedup AS (
  SELECT
    upid,
    name AS frame_id_str,
    MIN(ts) AS start_ts,
    MAX(dur) AS dur_ns,
    -- Pick a representative layer name; multi-layer joins are dropped.
    MIN(layer_name) AS layer_name,
    GROUP_CONCAT(DISTINCT jank_type) AS jank_type
  FROM actual_frame_timeline_slice
  WHERE jank_type IS NOT NULL AND jank_type != 'None'
  GROUP BY upid, name
)
SELECT
  CAST(actual.frame_id_str AS INTEGER) AS frame_id,
  actual.start_ts,
  actual.dur_ns,
  actual.start_ts + actual.dur_ns AS end_ts,
  actual.jank_type,
  process.name AS process_name,
  actual.layer_name,
  expected.expected_dur_ns,
  1 AS is_jank
FROM actual_dedup AS actual
LEFT JOIN process USING (upid)
LEFT JOIN expected_per_frame AS expected
  ON expected.upid = actual.upid AND expected.name = actual.frame_id_str;
