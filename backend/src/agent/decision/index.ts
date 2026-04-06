// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Decision Tree Module
 *
 * Exports all decision tree components for expert-level performance analysis.
 * The decision tree system enables conditional branching based on analysis results,
 * allowing the agent to make expert-like decisions about root cause analysis.
 */

// Core types
export * from './types';

// Executor
export {
  DecisionTreeExecutor,
  SkillExecutorInterface,
  createDecisionTreeExecutor,
} from './decisionTreeExecutor';

// Skill Adapter
export {
  SkillExecutorAdapter,
  createSkillExecutorAdapter,
} from './skillExecutorAdapter';

// Stage Executor (for PipelineExecutor integration)
export {
  DecisionTreeStageExecutor,
  createDecisionTreeStageExecutor,
} from './decisionTreeStageExecutor';

// Decision Trees
export { scrollingDecisionTree } from './trees/scrollingDecisionTree';
export { launchDecisionTree } from './trees/launchDecisionTree';

// Tree registry for easy lookup
import { DecisionTree } from './types';
import { scrollingDecisionTree } from './trees/scrollingDecisionTree';
import { launchDecisionTree } from './trees/launchDecisionTree';

/**
 * Registry of all available decision trees
 */
export const decisionTreeRegistry: Map<string, DecisionTree> = new Map([
  ['scrolling', scrollingDecisionTree],
  ['launch', launchDecisionTree],
]);

/**
 * Get a decision tree by analysis type
 */
export function getDecisionTree(analysisType: string): DecisionTree | undefined {
  return decisionTreeRegistry.get(analysisType);
}

/**
 * List all available decision trees
 */
export function listDecisionTrees(): string[] {
  return Array.from(decisionTreeRegistry.keys());
}