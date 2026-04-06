// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Architecture Detectors Module
 *
 * Exports architecture detection types and the YAML-skill-backed detector.
 * Individual TypeScript detector classes (FlutterDetector, WebViewDetector, etc.)
 * have been removed -- all detection is now handled by the
 * `rendering_pipeline_detection` YAML skill.
 */

// Type exports
export * from './types';

// Main detector (delegates to YAML skill)
export {
  ArchitectureDetector,
  createArchitectureDetector,
  detectArchitectureViaSkill,
} from './architectureDetector';