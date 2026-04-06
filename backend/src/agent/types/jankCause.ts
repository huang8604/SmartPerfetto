// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Structured per-frame mechanism record extracted from jank_frame_detail root cause output.
 *
 * These records preserve frame-level mechanism evidence before finding deduplication,
 * so later aggregation can be based on frame samples instead of merged findings.
 */
export interface FrameMechanismRecord {
  /** Stable frame identifier (falls back to interval id/start_ts when missing). */
  frameId: string;
  /** Session identifier if available. */
  sessionId?: string;
  /** Frame index inside session if available. */
  frameIndex?: number;
  /** Process/package name for this frame. */
  processName?: string;
  /** Process ID if available. */
  pid?: number;
  /** Frame analysis start timestamp (ns). */
  startTs: string;
  /** Frame analysis end timestamp (ns). */
  endTs: string;
  /** Scope label used in direct skill execution logs. */
  scopeLabel: string;
  /** Canonical cause type from root_cause/root_cause_summary. */
  causeType: string;
  /** Human-readable primary cause text. */
  primaryCause?: string;
  /** Additional context from root cause step. */
  secondaryInfo?: string;
  /** Confidence emitted by root cause step (numeric or label). */
  confidenceLevel?: number | string;
  /** Frame duration in ms if available. */
  frameDurMs?: number;
  /** Jank type label if available. */
  jankType?: string;
  /** Mechanism group from root cause classification (trigger/supply/amplification). */
  mechanismGroup?: string;
  /** Supply-side constraint category (frequency/scheduling/core placement/etc.). */
  supplyConstraint?: string;
  /** Layer where trigger signal is identified (app_producer/sf_consumer). */
  triggerLayer?: string;
  /** Classified amplification path, if detected. */
  amplificationPath?: string;
  /** Source step that produced the record. */
  sourceStep: 'root_cause' | 'root_cause_summary';
}