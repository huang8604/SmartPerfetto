// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Finding, Intent } from '../types';

export type ConclusionSceneId = string;

export type ClusterOutputMode = 'required' | 'optional' | 'none';
export type ClusterFrameListMode = 'none' | 'top' | 'full';

export interface SceneClusterPresentationPolicy {
  outputMode: ClusterOutputMode;
  frameListMode: ClusterFrameListMode;
  maxFramesPerCluster?: number;
  injectClusterFrameAggregation: boolean;
  injectWorkloadDominantMarker: boolean;
}

export interface ConclusionScenePromptHints {
  sceneId: ConclusionSceneId;
  sceneName: string;
  focusLines: string[];
  outputRequirementLines: string[];
  nextStepLine: string;
  requireTopClusters: boolean;
  clusterPolicy: SceneClusterPresentationPolicy;
}

export interface SceneTemplateRecord {
  id: ConclusionSceneId;
  sceneName: string;
  aspectHints: string[];
  keywords: string[];
  focusLines: string[];
  outputRequirementTemplates: string[];
  nextStepLine: string;
  requireTopClusters: boolean;
  clusterOutputMode?: ClusterOutputMode;
  clusterFrameListMode?: ClusterFrameListMode;
  maxFramesPerCluster?: number;
  injectClusterFrameAggregation?: boolean;
  injectWorkloadDominantMarker?: boolean;
}

export interface SceneRouteCandidate {
  sceneId: ConclusionSceneId;
  aspectScore: number;
  goalScore: number;
  findingScore: number;
  totalScore: number;
}

export interface SceneRoutingResult {
  selectedTemplate: SceneTemplateRecord;
  selectedScore: number;
  candidates: SceneRouteCandidate[];
}

export interface BuildScenePromptHintsInput {
  intent: Intent;
  findings: Finding[];
  deepReasonLabel: string;
}