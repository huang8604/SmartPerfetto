// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { PlanPhase } from './types';

type PlanPhaseIdentity = Pick<PlanPhase, 'id' | 'name' | 'goal'>;

const CONCLUSION_LIKE_PHASE_PATTERN =
  /(结构化结论|结构化报告|综合结论|最终结论|结论输出|输出结论|输出最终报告|最终报告|综合报告|优化建议|structured report|final conclusion|\bconclusion\b|final report|analysis report|final answer|write final answer|overall summary|final summary|recommendations?|optimization recommendations?|synthesis)/i;

const COMPARISON_SYNTHESIS_PHASE_PATTERN =
  /((差异|对比|比较|delta|comparison|compare).*(深钻|深入|根因|定位|归因|综合|复盘|synthesis|root cause|deep dive)|(深钻|深入|根因|定位|归因).*(差异|对比|比较|delta|comparison|compare))/i;

export function isConclusionLikePlanPhase(phase: PlanPhaseIdentity): boolean {
  return CONCLUSION_LIKE_PHASE_PATTERN.test(`${phase.id} ${phase.name} ${phase.goal}`);
}

export function isComparisonSynthesisPlanPhase(phase: PlanPhaseIdentity): boolean {
  return COMPARISON_SYNTHESIS_PHASE_PATTERN.test(`${phase.id} ${phase.name} ${phase.goal}`);
}
