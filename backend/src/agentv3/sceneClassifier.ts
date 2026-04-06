// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Keyword-based scene classifier for progressive prompt disclosure.
 * Classifies user queries into scene types to inject only relevant
 * analysis strategies into the system prompt, saving ~3500 tokens
 * for non-scrolling queries.
 *
 * Keywords and compound patterns are loaded from external strategy files
 * (`backend/strategies/*.strategy.md`), not hardcoded here.
 *
 * Pure keyword matching — no LLM calls, <1ms execution.
 */

import { getRegisteredScenes } from './strategyLoader';

export type SceneType = string;

/**
 * Classify a user query into a scene type for prompt strategy injection.
 * Returns 'general' when no specific scene is matched — Claude will use
 * list_skills to self-discover appropriate analysis tools.
 *
 * Scenes are matched by priority (lower = higher priority):
 *   ANR (1) → startup (2) → scrolling (3) → interaction (4) → overview (5) → general (99)
 */
export function classifyScene(query: string): SceneType {
  const scenes = getRegisteredScenes();
  const lower = query.toLowerCase();

  // Sort by priority (ascending), exclude 'general' from active matching
  const sorted = scenes
    .filter(s => s.scene !== 'general')
    .sort((a, b) => a.priority - b.priority);

  for (const scene of sorted) {
    // Compound patterns first (more specific)
    if (scene.compoundPatterns.length > 0 && scene.compoundPatterns.some(p => p.test(query))) {
      return scene.scene;
    }
    // Then keyword matching
    if (scene.keywords.some(k => lower.includes(k))) {
      return scene.scene;
    }
  }

  return 'general';
}