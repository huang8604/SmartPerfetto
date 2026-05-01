// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Spark Contracts
 *
 * Single source of truth for the contract shapes introduced by the Spark
 *施工计划包 (`docs/superpowers/spark/plans/*`). Each plan defines a minimal,
 * forward-compatible contract that downstream services, Skills, MCP tools,
 * UI panels, or reporters can produce or consume.
 *
 * Design rules (apply to every contract below):
 *  - Every result object carries `schemaVersion`, `source`, `createdAt` (or
 *    equivalent provenance) so old sessions and reports remain readable as the
 *    schema evolves.
 *  - Trace timestamps stay in nanoseconds; presentation layers are free to add
 *    a formatted `*_str` field but must never replace the raw ns value.
 *  - Anything an LLM can quote must expose `evidenceRef`, `artifactId`, `sql`,
 *    `skillId`, or an explicit `unsupportedReason`. Missing-data paths must be
 *    visible — never wrapped as a confident conclusion.
 *  - All new fields are optional by default to keep older sessions consumable.
 *
 * Spark mapping: see `docs/superpowers/spark/README.md` "Spark #1-#205 覆盖矩阵".
 *
 * @module sparkContracts
 */

// =============================================================================
// Shared base types (used across all Spark plans)
// =============================================================================

/** Universal time range expressed in nanoseconds (Perfetto canonical unit). */
export interface NsTimeRange {
  /** Inclusive start in nanoseconds since trace start. */
  startNs: number;
  /** Exclusive end in nanoseconds since trace start. */
  endNs: number;
}

/** Provenance fields that every contract must carry. */
export interface SparkProvenance {
  /** Contract version. Bump on breaking changes. */
  schemaVersion: number;
  /** Where the data came from (skill id, MCP tool id, importer id, …). */
  source: string;
  /** Epoch ms timestamp when the artifact was generated. */
  createdAt: number;
  /**
   * Human-readable reason that explains why the result was downgraded. When
   * present the consumer must treat the contract as a low-confidence/blocked
   * artifact rather than a confident conclusion.
   */
  unsupportedReason?: string;
  /** Free-form provenance notes (e.g. trace processor build, host SHA). */
  notes?: string;
}

/** Pointer that lets consumers resolve back to evidence. */
export interface SparkEvidenceRef {
  /** Time range when the evidence is bounded (optional). */
  range?: NsTimeRange;
  /** Skill that emitted the evidence. */
  skillId?: string;
  /** Step within a composite/iterator skill. */
  stepId?: string;
  /** Backing artifact in the session-scoped artifact store. */
  artifactId?: string;
  /** Raw SQL fingerprint or stored procedure id. */
  sql?: string;
  /** External resource (importer, RAG entry, log file). */
  externalRef?: string;
  /** Optional natural-language description for UI tooltips. */
  description?: string;
}

/** Confidence band shared by decision-tree style outputs. */
export type SparkConfidence = 'low' | 'medium' | 'high' | 'unsupported';

/** Per-Spark-number mapping recorded inside each contract for traceability. */
export interface SparkCoverageEntry {
  /** Spark idea number from `docs/spark.md`. */
  sparkId: number;
  /** Plan id (`01`-`57`) consuming the idea. */
  planId: string;
  /** Status word matching `docs/superpowers/spark/TODO.md`. */
  status: 'scaffolded' | 'implemented' | 'unsupported' | 'future';
  /** Brief note explaining what landed for this Spark id. */
  note?: string;
}

// =============================================================================
// Plan 01 — Stdlib Catalog 与 Skill 覆盖率治理 (Spark #1, #21)
// =============================================================================

/**
 * Per-Skill prerequisite usage entry.
 * Reflects how a skill (composite or atomic) declared a stdlib module either
 * via YAML `prerequisites:` or via raw SQL inspected by `sqlIncludeInjector`.
 */
export interface StdlibSkillUsage {
  skillId: string;
  /** YAML-declared prerequisites. */
  declared: string[];
  /** Modules detected via raw SQL `INCLUDE PERFETTO MODULE` scanning. */
  detected: string[];
  /** Modules declared but never used in any SQL step. */
  declaredButUnused: string[];
  /** Modules used in SQL but not declared in YAML. */
  detectedButUndeclared: string[];
}

/**
 * Stdlib module metadata used by the Skill coverage report.
 * Sourced from `perfettoStdlibScanner` (packaged asset + on-disk source).
 */
export interface StdlibModuleEntry {
  module: string;
  /** Brief module summary if surfaced by the stdlib asset. */
  summary?: string;
  /** Number of skills declaring this module as a prerequisite. */
  declaredBySkills: number;
  /** Number of skills using this module via raw SQL. */
  usedBySkills: number;
  /** True if added since the last catalog snapshot — drives the watcher. */
  newSinceLastSnapshot?: boolean;
}

/**
 * StdlibSkillCoverageContract (Plan 01)
 *
 * Output of `analyzeStdlibSkillCoverage(...)`. Surfaced via:
 *  - `npm run validate:skills` summary block
 *  - MCP tool `list_stdlib_modules` (extension)
 *  - Plan doc snapshot when triaging Skill regressions
 */
export interface StdlibSkillCoverageContract extends SparkProvenance {
  /** Total stdlib modules visible from the scanner asset. */
  totalModules: number;
  /** Modules referenced by at least one Skill (declared OR detected). */
  modulesCovered: number;
  /** Skills with at least one undeclared-but-detected stdlib usage. */
  skillsWithDrift: number;
  /** Modules that no Skill references — Skill suggestion target. */
  uncoveredModules: StdlibModuleEntry[];
  /** Per-Skill drift report, used by the watcher. */
  skillUsage: StdlibSkillUsage[];
  /** Modules added in the most recent stdlib snapshot. */
  newlyAddedModules?: StdlibModuleEntry[];
  /** Spark coverage entries explaining what landed in this contract. */
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a fresh provenance block for new contract objects. */
export function makeSparkProvenance(opts: {
  source: string;
  schemaVersion?: number;
  unsupportedReason?: string;
  notes?: string;
}): SparkProvenance {
  return {
    schemaVersion: opts.schemaVersion ?? 1,
    source: opts.source,
    createdAt: Date.now(),
    ...(opts.unsupportedReason ? {unsupportedReason: opts.unsupportedReason} : {}),
    ...(opts.notes ? {notes: opts.notes} : {}),
  };
}

/** Quick guard for "did the producer flag this contract as unsupported?". */
export function isUnsupported(contract: SparkProvenance): boolean {
  return Boolean(contract.unsupportedReason);
}
