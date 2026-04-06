// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Expert System Module
 *
 * Exports all domain experts and the expert registry for
 * intelligent, domain-specific performance analysis.
 *
 * The expert system provides:
 * - Domain-specific analysis strategies
 * - Architecture-aware decision trees
 * - Intent-based routing
 * - Root cause classification
 *
 * Cross-Domain Expert System (New):
 * - Module Experts (YAML Skills) provide specialized data analysis
 * - Cross-Domain Experts (TypeScript) orchestrate multi-turn dialogues
 * - Hypothesis management for root cause verification
 */

// Base types and class
export * from './base';

// Cross-Domain Expert System
export * from './crossDomain';

// Domain experts
export { InteractionExpert, createInteractionExpert } from './interactionExpert';
export { LaunchExpert, createLaunchExpert } from './launchExpert';
export { SystemExpert, createSystemExpert } from './systemExpert';

// Expert registry
import {
  BaseExpertInterface,
  ExpertConfig,
  ExpertRegistry as IExpertRegistry,
  AnalysisIntent,
} from './base';
import { InteractionExpert, createInteractionExpert } from './interactionExpert';
import { LaunchExpert, createLaunchExpert } from './launchExpert';
import { SystemExpert, createSystemExpert } from './systemExpert';

/**
 * Expert Registry Implementation
 *
 * Manages registration and lookup of domain experts.
 * Supports intent-based routing to find the appropriate expert.
 */
class ExpertRegistryImpl implements IExpertRegistry {
  private experts: Map<string, BaseExpertInterface> = new Map();
  private intentToExpert: Map<string, string> = new Map();

  /**
   * Register an expert
   */
  register(expert: BaseExpertInterface): void {
    this.experts.set(expert.config.id, expert);

    // Build intent mapping
    for (const intent of expert.config.handlesIntents) {
      this.intentToExpert.set(intent, expert.config.id);
    }

    console.log(`[ExpertRegistry] Registered expert: ${expert.config.name} (${expert.config.id})`);
  }

  /**
   * Get expert by ID
   */
  get(expertId: string): BaseExpertInterface | undefined {
    return this.experts.get(expertId);
  }

  /**
   * Get expert for a specific intent
   */
  getForIntent(intent: AnalysisIntent): BaseExpertInterface | undefined {
    const expertId = this.intentToExpert.get(intent.category);
    if (expertId) {
      return this.experts.get(expertId);
    }
    return undefined;
  }

  /**
   * List all registered experts
   */
  list(): ExpertConfig[] {
    return Array.from(this.experts.values()).map((e) => e.config);
  }

  /**
   * Check if an expert exists for the given intent
   */
  hasExpertFor(intentCategory: string): boolean {
    return this.intentToExpert.has(intentCategory);
  }

  /**
   * Get all supported intent categories
   */
  getSupportedIntents(): string[] {
    return Array.from(this.intentToExpert.keys());
  }
}

/**
 * Global expert registry instance
 */
export const expertRegistry = new ExpertRegistryImpl();

/**
 * Initialize the expert registry with all domain experts
 */
export function initializeExperts(): void {
  // Create and register all experts
  expertRegistry.register(createInteractionExpert());
  expertRegistry.register(createLaunchExpert());
  expertRegistry.register(createSystemExpert());

  console.log(`[ExpertRegistry] Initialized ${expertRegistry.list().length} experts`);
  console.log(`[ExpertRegistry] Supported intents: ${expertRegistry.getSupportedIntents().join(', ')}`);
}

/**
 * Get the appropriate expert for an intent
 */
export function getExpertForIntent(intent: AnalysisIntent): BaseExpertInterface | undefined {
  return expertRegistry.getForIntent(intent);
}

/**
 * Parse user query to determine analysis intent
 *
 * This is a simple keyword-based intent classifier.
 * In production, this could be enhanced with NLP or LLM.
 */
export function parseAnalysisIntent(query: string): AnalysisIntent {
  const lowerQuery = query.toLowerCase();
  const keywords: string[] = [];

  // First check for high-priority compound phrases that should override simple keywords
  // These are checked first because they contain ambiguous substrings
  const priorityPatterns: { category: AnalysisIntent['category']; phrases: string[] }[] = [
    {
      category: 'ANR',
      phrases: ['anr', '无响应', 'not responding', '卡死', '死锁', 'deadlock', 'application not responding'],
    },
  ];

  // Check priority patterns first
  for (const pattern of priorityPatterns) {
    for (const phrase of pattern.phrases) {
      if (lowerQuery.includes(phrase)) {
        keywords.push(phrase);
        return {
          category: pattern.category,
          originalQuery: query,
          keywords: [...new Set(keywords)],
          confidence: Math.min(1, keywords.length / 2),
        };
      }
    }
  }

  // Define keyword patterns for each category
  const patterns: { category: AnalysisIntent['category']; keywords: string[] }[] = [
    {
      category: 'SCROLLING',
      keywords: ['滑动', '卡顿', 'scroll', 'jank', 'fps', '掉帧', '流畅', 'frame', '帧'],
    },
    {
      category: 'CLICK',
      keywords: ['点击', '响应', 'click', 'tap', 'touch', '交互', '反应慢'],
    },
    {
      category: 'LAUNCH',
      keywords: ['启动', 'launch', 'startup', 'start', '冷启动', '热启动', '温启动', 'ttid', 'ttfd'],
    },
    {
      category: 'CPU',
      keywords: ['cpu', '处理器', '计算', '频率', '调度', 'scheduling', '负载'],
    },
    {
      category: 'MEMORY',
      keywords: ['memory', '内存', 'gc', '垃圾回收', '内存泄漏', 'leak', '堆'],
    },
    {
      category: 'IO',
      keywords: ['io', '磁盘', 'disk', '文件', '网络', 'network', '阻塞', 'blocking'],
    },
    {
      category: 'ANR',
      keywords: ['anr'],  // Main ANR keywords handled above in priority patterns
    },
  ];

  // Find matching category
  let bestMatch: { category: AnalysisIntent['category']; score: number } = {
    category: 'GENERAL',
    score: 0,
  };

  for (const pattern of patterns) {
    let score = 0;
    for (const keyword of pattern.keywords) {
      if (lowerQuery.includes(keyword)) {
        score++;
        keywords.push(keyword);
      }
    }
    if (score > bestMatch.score) {
      bestMatch = { category: pattern.category, score };
    }
  }

  return {
    category: bestMatch.category,
    originalQuery: query,
    keywords: [...new Set(keywords)], // Deduplicate
    confidence: Math.min(1, bestMatch.score / 3), // Normalize confidence
  };
}

/**
 * Export registry type
 */
export { IExpertRegistry as ExpertRegistry };