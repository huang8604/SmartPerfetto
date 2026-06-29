// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { classifyScene, type SceneType } from '../agentv3/sceneClassifier';
import { getFinalReportContract, type FinalReportContractRequirement } from '../agentv3/strategyLoader';

export interface FinalReportContractCompletenessInput {
  conclusion: string;
  query?: string;
  sceneType?: SceneType;
  contractSceneId?: string;
  caseRecommendations?: Array<Record<string, unknown>>;
}

export interface FinalReportContractCompletenessResult {
  sceneType: SceneType;
  missingLabels: string[];
}

function patternMatches(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

function requirementSatisfied(text: string, requirement: FinalReportContractRequirement): boolean {
  if (requirement.patternGroups.length > 0) {
    return requirement.patternGroups.every(group => group.some(pattern => patternMatches(text, pattern)));
  }
  return requirement.patterns.some(pattern => patternMatches(text, pattern));
}

function requirementApplies(input: FinalReportContractCompletenessInput, requirement: FinalReportContractRequirement): boolean {
  if (requirement.id === 'case_recommendations') {
    return hasStrongCaseRecommendation(input.caseRecommendations) ||
      requirement.triggerPatterns.some(pattern => patternMatches(input.query || '', pattern));
  }
  if (requirement.triggerPatterns.length === 0) return true;
  return requirement.triggerPatterns.some(pattern => patternMatches(input.query || '', pattern));
}

function hasStrongCaseRecommendation(recommendations: Array<Record<string, unknown>> | undefined): boolean {
  return (recommendations ?? []).some(hit =>
    String(hit.matchStrength ?? hit.match_strength ?? '').toLowerCase() === 'strong'
  );
}

function normalizeSceneType(value: string | undefined): SceneType | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'jank' || normalized === 'scroll' || normalized === 'scrolling') return 'scrolling';
  if (normalized === 'click_response' || normalized === 'tap_response' || normalized === 'touch_response') {
    return 'interaction';
  }
  if (normalized === 'cold_start' || normalized === 'warm_start' || normalized === 'hot_start') return 'startup';
  return normalized;
}

export function assessFinalReportContractCompleteness(
  input: FinalReportContractCompletenessInput,
): FinalReportContractCompletenessResult | undefined {
  const sceneType =
    normalizeSceneType(input.sceneType) ||
    normalizeSceneType(input.contractSceneId) ||
    classifyScene(input.query || '');
  const contract = getFinalReportContract(sceneType);
  if (!contract || contract.requiredSections.length === 0) return undefined;

  const missingLabels = contract.requiredSections
    .filter(requirement => requirement.required !== false)
    .filter(requirement => requirementApplies(input, requirement))
    .filter(requirement => !requirementSatisfied(input.conclusion, requirement))
    .map(requirement => requirement.label || requirement.id);

  if (missingLabels.length === 0) return undefined;
  return { sceneType, missingLabels };
}
