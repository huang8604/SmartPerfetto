/**
 * TraceAgentState (v1)
 *
 * A single-source-of-truth state for goal-driven, experiment-based analysis.
 *
 * This file only defines the durable state shape and deterministic helpers.
 * The actual hypothesis/evidence/experiment loop will be implemented incrementally.
 *
 * Design goals:
 * - JSON-safe (no BigInt/Map/Set)
 * - Versioned + migratable
 * - Strictly scoped to a single (sessionId, traceId)
 */

import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Versioning
// =============================================================================

export const TRACE_AGENT_STATE_VERSION = 1 as const;

// =============================================================================
// Core Types
// =============================================================================

export type TraceAgentDefaultLoopMode = 'hypothesis_experiment';
export type TraceAgentDefaultResponseView = 'conclusion_evidence';

export interface TraceAgentPreferences {
  /** Max experiments to run automatically per user turn */
  maxExperimentsPerTurn: number;
  /** Default orchestration mode (user preference) */
  defaultLoopMode: TraceAgentDefaultLoopMode;
  /** Default UI response view preference */
  defaultResponseView: TraceAgentDefaultResponseView;
  /** Preferred output language */
  language: 'zh';
  /** Quality first (no hard cost/latency constraints) */
  qualityFirst: true;
}

export interface TraceAgentGoalSpec {
  /** User's stated goal (may be refined by intent later) */
  userGoal: string;
  /** Optional: refined/normalized goal from intent understanding */
  normalizedGoal?: string;
  /** Optional: what counts as "done" for this session */
  doneWhen?: string[];
  /** Optional: stop conditions (budget, low info gain, need user input, etc.) */
  stopWhen?: string[];
}

export interface TraceAgentCoverage {
  /** Entities already covered/inspected */
  entities: {
    frames: string[];
    sessions: string[];
  };
  /** Time ranges already covered */
  timeRanges: Array<{ start: string; end: string }>;
  /** Domains already covered (frame/cpu/binder/memory/...) */
  domains: string[];
  /** Packages/process names already covered (best-effort) */
  packages: string[];
}

export interface TraceAgentTurnLogEntry {
  id: string;
  turnIndex: number;
  timestamp: number;
  query: string;
  followUpType?: string;
  intentPrimaryGoal?: string;
  conclusionSummary?: string;
  confidence?: number;
}

// Placeholders for future milestones (kept minimal in v1)
export interface TraceAgentHypothesis {
  id: string;
  mechanism: string;
  status: 'proposed' | 'investigating' | 'confirmed' | 'rejected';
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  gaps: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TraceAgentEvidence {
  id: string;
  kind: 'sql' | 'skill' | 'derived';
  title: string;
  digest: string;
  traceId: string;
  createdAt: number;
  /** Provenance (best-effort; JSON-safe) */
  source?: Record<string, any>;
}

export interface TraceAgentExperiment {
  id: string;
  type: 'run_skill' | 'run_sql' | 'repair_sql' | 'ask_user' | 'stop';
  objective: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped';
  createdAt: number;
  updatedAt: number;
  producedEvidenceIds: string[];
  error?: string;
}

export interface TraceAgentContradiction {
  id: string;
  description: string;
  severity: 'minor' | 'major' | 'critical';
  createdAt: number;
  resolvedAt?: number;
  evidenceIds: string[];
  hypothesisIds: string[];
  resolutionExperimentIds: string[];
}

export interface TraceAgentState {
  version: number;
  sessionId: string;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  goal: TraceAgentGoalSpec;
  preferences: TraceAgentPreferences;
  coverage: TraceAgentCoverage;
  turnLog: TraceAgentTurnLogEntry[];
  hypotheses: TraceAgentHypothesis[];
  evidence: TraceAgentEvidence[];
  experiments: TraceAgentExperiment[];
  contradictions: TraceAgentContradiction[];
}

// =============================================================================
// Creation / Migration
// =============================================================================

export function createInitialTraceAgentState(params: {
  sessionId: string;
  traceId: string;
  userGoal: string;
  now?: number;
}): TraceAgentState {
  const now = typeof params.now === 'number' ? params.now : Date.now();

  return {
    version: TRACE_AGENT_STATE_VERSION,
    sessionId: params.sessionId,
    traceId: params.traceId,
    createdAt: now,
    updatedAt: now,
    goal: { userGoal: params.userGoal },
    preferences: {
      maxExperimentsPerTurn: 3,
      defaultLoopMode: 'hypothesis_experiment',
      defaultResponseView: 'conclusion_evidence',
      language: 'zh',
      qualityFirst: true,
    },
    coverage: {
      entities: { frames: [], sessions: [] },
      timeRanges: [],
      domains: [],
      packages: [],
    },
    turnLog: [],
    hypotheses: [],
    evidence: [],
    experiments: [],
    contradictions: [],
  };
}

export function migrateTraceAgentState(
  snapshot: any,
  expected: { sessionId: string; traceId: string }
): TraceAgentState {
  // If invalid, return a fresh state.
  if (!snapshot || typeof snapshot !== 'object') {
    return createInitialTraceAgentState({
      sessionId: expected.sessionId,
      traceId: expected.traceId,
      userGoal: '',
    });
  }

  // Trace scoping guard: never accept cross-trace state.
  const snapSessionId = String((snapshot as any).sessionId || '');
  const snapTraceId = String((snapshot as any).traceId || '');
  if (snapSessionId && snapSessionId !== expected.sessionId) {
    return createInitialTraceAgentState({
      sessionId: expected.sessionId,
      traceId: expected.traceId,
      userGoal: '',
    });
  }
  if (snapTraceId && snapTraceId !== expected.traceId) {
    return createInitialTraceAgentState({
      sessionId: expected.sessionId,
      traceId: expected.traceId,
      userGoal: '',
    });
  }

  const version = Number((snapshot as any).version || 0);

  // v1: normalize and fill defaults
  if (version === 1) {
    const now = Date.now();
    const state: TraceAgentState = {
      version: 1,
      sessionId: expected.sessionId,
      traceId: expected.traceId,
      createdAt: Number((snapshot as any).createdAt || now),
      updatedAt: Number((snapshot as any).updatedAt || now),
      goal: {
        userGoal: String((snapshot as any).goal?.userGoal || ''),
        normalizedGoal: (snapshot as any).goal?.normalizedGoal ? String((snapshot as any).goal.normalizedGoal) : undefined,
        doneWhen: Array.isArray((snapshot as any).goal?.doneWhen) ? (snapshot as any).goal.doneWhen.map(String) : undefined,
        stopWhen: Array.isArray((snapshot as any).goal?.stopWhen) ? (snapshot as any).goal.stopWhen.map(String) : undefined,
      },
      preferences: {
        maxExperimentsPerTurn: Number((snapshot as any).preferences?.maxExperimentsPerTurn || 3),
        defaultLoopMode: 'hypothesis_experiment',
        defaultResponseView: 'conclusion_evidence',
        language: 'zh',
        qualityFirst: true,
      },
      coverage: {
        entities: {
          frames: Array.isArray((snapshot as any).coverage?.entities?.frames) ? (snapshot as any).coverage.entities.frames.map(String) : [],
          sessions: Array.isArray((snapshot as any).coverage?.entities?.sessions) ? (snapshot as any).coverage.entities.sessions.map(String) : [],
        },
        timeRanges: Array.isArray((snapshot as any).coverage?.timeRanges)
          ? (snapshot as any).coverage.timeRanges
              .map((r: any) => ({ start: String(r?.start || ''), end: String(r?.end || '') }))
              .filter((r: any) => r.start && r.end)
          : [],
        domains: Array.isArray((snapshot as any).coverage?.domains) ? (snapshot as any).coverage.domains.map(String) : [],
        packages: Array.isArray((snapshot as any).coverage?.packages) ? (snapshot as any).coverage.packages.map(String) : [],
      },
      turnLog: Array.isArray((snapshot as any).turnLog)
        ? (snapshot as any).turnLog.map((t: any) => ({
            id: String(t?.id || uuidv4()),
            turnIndex: Number(t?.turnIndex || 0),
            timestamp: Number(t?.timestamp || now),
            query: String(t?.query || ''),
            followUpType: t?.followUpType ? String(t.followUpType) : undefined,
            intentPrimaryGoal: t?.intentPrimaryGoal ? String(t.intentPrimaryGoal) : undefined,
            conclusionSummary: t?.conclusionSummary ? String(t.conclusionSummary) : undefined,
            confidence: typeof t?.confidence === 'number' ? t.confidence : undefined,
          }))
        : [],
      hypotheses: Array.isArray((snapshot as any).hypotheses) ? (snapshot as any).hypotheses : [],
      evidence: Array.isArray((snapshot as any).evidence) ? (snapshot as any).evidence : [],
      experiments: Array.isArray((snapshot as any).experiments) ? (snapshot as any).experiments : [],
      contradictions: Array.isArray((snapshot as any).contradictions) ? (snapshot as any).contradictions : [],
    };

    // Ensure preferences respect current defaults (user-configured fields may be added later).
    state.preferences.maxExperimentsPerTurn = clampInt(state.preferences.maxExperimentsPerTurn, 1, 10, 3);
    state.updatedAt = now;
    return state;
  }

  // Unknown/older version: start fresh (future: add migrations here).
  return createInitialTraceAgentState({
    sessionId: expected.sessionId,
    traceId: expected.traceId,
    userGoal: '',
  });
}

// =============================================================================
// Utilities
// =============================================================================

export function summarizeTraceAgentState(state: TraceAgentState): {
  version: number;
  goal: string;
  maxExperimentsPerTurn: number;
  turns: number;
  updatedAt: number;
} {
  return {
    version: state.version,
    goal: state.goal.normalizedGoal || state.goal.userGoal || '',
    maxExperimentsPerTurn: state.preferences.maxExperimentsPerTurn,
    turns: Array.isArray(state.turnLog) ? state.turnLog.length : 0,
    updatedAt: state.updatedAt,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const v = Math.floor(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
