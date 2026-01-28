/**
 * Teaching Module Configuration
 *
 * Centralized configuration for the teaching pipeline feature.
 * These values were previously hardcoded throughout the codebase.
 *
 * Configuration categories:
 * - Default values for fallback scenarios
 * - Limits for SQL queries and data processing
 * - Display settings for frontend presentation
 * - Timeouts for async operations
 *
 * @module config/teaching
 */

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default pipeline configuration when detection fails or returns incomplete data.
 *
 * Rationale:
 * - ANDROID_VIEW_STANDARD_BLAST: Most common rendering pipeline on modern Android
 * - confidence 0.5: Neutral confidence indicating uncertain detection
 * - doc_path: Points to standard Android View documentation
 */
export const TEACHING_DEFAULTS = {
  /** Default pipeline ID when detection fails */
  pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',

  /** Default confidence when parsing fails (0.5 = uncertain) */
  confidence: 0.5,

  /** Default documentation path */
  docPath: 'rendering_pipelines/android_view_standard.md',

  /** Default icon for unknown pipeline types */
  icon: '📱',

  /** Default family classification */
  family: 'android_view',
} as const;

// =============================================================================
// Processing Limits
// =============================================================================

/**
 * Limits for SQL queries and data processing to prevent unbounded results.
 *
 * Rationale:
 * - maxActiveProcesses: 10 covers most apps, prevents huge result sets
 * - maxCandidates: 10 keeps detection focused, avoids noise
 * - maxPinInstructions: 50 supports complex pipelines while limiting memory
 * - maxKeySlices: 20 provides comprehensive coverage without overwhelming UI
 * - summaryLength: 500 chars fits in typical UI panels
 */
export const TEACHING_LIMITS = {
  /** Maximum active rendering processes to return from SQL */
  maxActiveProcesses: 10,

  /** Maximum pipeline candidates from detection */
  maxCandidates: 10,

  /** Maximum pin instructions per pipeline */
  maxPinInstructions: 50,

  /** Maximum key slices to extract from documentation */
  maxKeySlices: 20,

  /** Maximum summary length in characters */
  summaryLength: 500,

  /** Maximum mermaid blocks to render */
  maxMermaidBlocks: 5,

  /** Maximum thread roles to display */
  maxThreadRoles: 20,

  /** SQL result row limit for safety */
  sqlRowLimit: 1000,
} as const;

// =============================================================================
// Display Configuration
// =============================================================================

/**
 * Display configuration for frontend presentation.
 *
 * These values control how many items are shown in various UI components.
 * Separate from processing limits as UI may show subset of available data.
 */
export const TEACHING_DISPLAY = {
  /** Number of top candidates to show in detection result */
  candidatesToShow: 3,

  /** Number of active processes to show in summary */
  processesToShow: 5,

  /** Number of tracks to log for debugging */
  tracksToDebug: 50,

  /** Number of features to show in detection panel */
  featuresToShow: 10,

  /** Number of recent analyses to show in history */
  historyToShow: 10,
} as const;

// =============================================================================
// Timeout Configuration
// =============================================================================

/**
 * Timeout configuration for async operations.
 *
 * Rationale:
 * - skillExecution: 30s allows for complex multi-step skills
 * - sqlQuery: 10s prevents hung queries from blocking
 * - documentParsing: 5s sufficient for most markdown files
 * - mermaidRendering: 5s allows for complex diagrams
 */
export const TEACHING_TIMEOUTS = {
  /** Skill execution timeout in milliseconds */
  skillExecution: 30000,

  /** SQL query timeout in milliseconds */
  sqlQuery: 10000,

  /** Document parsing timeout in milliseconds */
  documentParsing: 5000,

  /** Mermaid rendering timeout in milliseconds */
  mermaidRendering: 5000,

  /** API response timeout in milliseconds */
  apiResponse: 60000,
} as const;

// =============================================================================
// SQL Step IDs
// =============================================================================

/**
 * Step IDs used to extract results from skill execution.
 *
 * These must match the `id` fields in rendering_pipeline_detection.skill.yaml
 */
export const TEACHING_STEP_IDS = {
  /** Pipeline detection result step */
  pipelineDetection: 'pipeline_detection',

  /** Active rendering processes step */
  activeProcesses: 'active_rendering_processes',

  /** Frame timeline detection step */
  frameTimeline: 'frame_timeline_detection',

  /** Compose detection step */
  composeDetection: 'compose_detection',
} as const;

// =============================================================================
// Confidence Thresholds
// =============================================================================

/**
 * Confidence thresholds for pipeline detection quality.
 *
 * Rationale:
 * - high (0.8): Strong confidence, primary pipeline reliable
 * - medium (0.5): Acceptable confidence, may need manual verification
 * - low (0.3): Weak confidence, fallback recommended
 * - minimum (0.1): Below this, detection is unreliable
 */
export const CONFIDENCE_THRESHOLDS = {
  /** High confidence - detection is reliable */
  high: 0.8,

  /** Medium confidence - detection acceptable */
  medium: 0.5,

  /** Low confidence - consider fallback */
  low: 0.3,

  /** Minimum threshold - below this is unreliable */
  minimum: 0.1,
} as const;

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * Feature flags for gradual rollout and testing.
 *
 * These can be overridden via environment variables for easy rollback.
 */
export const TEACHING_FEATURES = {
  /** Use column-name based SQL result validation (safer) */
  useSqlValidation: process.env.TEACHING_USE_SQL_VALIDATION !== 'false',

  /** Use type transformation layer for snake_case → camelCase */
  useTypeTransforms: process.env.TEACHING_USE_TYPE_TRANSFORMS !== 'false',

  /** Use local mermaid rendering instead of mermaid.ink */
  useLocalMermaid: process.env.TEACHING_USE_LOCAL_MERMAID !== 'false',

  /** Enable detailed logging for debugging */
  debugLogging: process.env.TEACHING_DEBUG === 'true',

  /** Enable caching for parsed documents */
  enableCaching: process.env.TEACHING_ENABLE_CACHE !== 'false',
} as const;

// =============================================================================
// Exported Configuration Object
// =============================================================================

/**
 * Complete teaching module configuration.
 *
 * Usage:
 * ```typescript
 * import { TEACHING_CONFIG } from './config/teaching.config';
 *
 * const limit = TEACHING_CONFIG.limits.maxActiveProcesses;
 * const timeout = TEACHING_CONFIG.timeouts.sqlQuery;
 * ```
 */
export const TEACHING_CONFIG = {
  defaults: TEACHING_DEFAULTS,
  limits: TEACHING_LIMITS,
  display: TEACHING_DISPLAY,
  timeouts: TEACHING_TIMEOUTS,
  stepIds: TEACHING_STEP_IDS,
  confidence: CONFIDENCE_THRESHOLDS,
  features: TEACHING_FEATURES,
} as const;

// Type export for external use
export type TeachingConfig = typeof TEACHING_CONFIG;
