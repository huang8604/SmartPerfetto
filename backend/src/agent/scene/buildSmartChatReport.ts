// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AgentRuntimeAnalysisResult } from '../core/orchestratorTypes';
import type {
  ConclusionContract,
  ConclusionContractClaimReference,
} from '../core/conclusionContract';
import type { Finding } from '../types';
import type {
  DisplayedScene,
  SceneAnalysisJob,
  SceneReport,
} from './types';
import { selectAnalysisEligibleScenes } from './sceneIntervalBuilder';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../../agentv3/outputLanguage';
import {
  displaySceneType,
  projectDisplayedScene,
  projectSceneVerification,
} from './scenePresentation';
import {renderRequiredLocalizedStrategyTemplate} from '../../agentv3/localizedStrategyTemplate';

export function buildSmartChatReport(input: {
  sessionId: string;
  report: SceneReport;
  totalDurationMs?: number;
  outputLanguage?: OutputLanguage;
}): AgentRuntimeAnalysisResult {
  const { sessionId, report } = input;
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const completedJobs = report.jobs.filter(job => job.state === 'completed');
  const failedJobs = report.jobs.filter(job => job.state === 'failed');
  const analyzedSceneIds = new Set(completedJobs.map(job => job.interval.displayedSceneId));
  const conclusion = buildConclusionMarkdown(report, completedJobs, failedJobs, outputLanguage);
  const findings = buildFindings(report, completedJobs, failedJobs, outputLanguage);
  const confidence = report.partialReport ? 0.68 : Math.min(0.9, 0.72 + completedJobs.length * 0.02);

  return {
    sessionId,
    success: failedJobs.length === 0 || completedJobs.length > 0,
    findings,
    hypotheses: [],
    conclusion,
    conclusionContract: buildConclusionContract(
      report,
      completedJobs,
      analyzedSceneIds,
      outputLanguage,
    ),
    confidence,
    rounds: 1,
    totalDurationMs: input.totalDurationMs ?? report.totalDurationMs,
    partial: report.partialReport || failedJobs.length > 0 ? true : undefined,
    terminationReason: report.partialReport ? 'execution_error' : undefined,
    terminationMessage: report.partialReport
      ? localize(
          outputLanguage,
          '智能分析已生成可用报告，但部分场景深钻失败或被取消。',
          'Smart analysis produced a usable report, but some scene deep dives failed or were cancelled.',
        )
      : undefined,
  };
}

export function buildSmartSceneSelectionReport(input: {
  sessionId: string;
  report: SceneReport;
  totalDurationMs?: number;
  outputLanguage?: OutputLanguage;
}): AgentRuntimeAnalysisResult {
  const { sessionId, report } = input;
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const sceneCounts = countBy(
    report.displayedScenes.map(scene => displaySceneType(scene.sceneType, outputLanguage)),
  );
  const eligibleScenes = selectAnalysisEligibleScenes(report.displayedScenes, { scope: 'all' });
  const orderedCounts = Object.entries(sceneCounts)
    .map(([label, count]) => localize(outputLanguage, `${label} ${count} 次`, `${label}: ${count}`))
    .join(localize(outputLanguage, '、', ', '))
    || localize(outputLanguage, '未检测到可展示场景', 'no displayable scenes');
  const conclusion = renderRequiredLocalizedStrategyTemplate(
    'report-smart-scene-inventory',
    outputLanguage,
    {
      inventorySummary: localize(
      outputLanguage,
      `本次 trace 已先完成轻量场景盘点，共识别 ${report.displayedScenes.length} 个场景，覆盖 ${orderedCounts}。`,
      `A lightweight scene inventory identified ${report.displayedScenes.length} scenes in this trace, covering ${orderedCounts}.`,
      ),
      eligibilitySummary: localize(
      outputLanguage,
      `其中 ${eligibleScenes.length} 个场景可进入深钻；marker/context 仅作为时间线证据展示。`,
      `${eligibleScenes.length} scenes are eligible for deep-dive analysis; marker/context events are shown only as timeline evidence.`,
      ),
      verificationSummary: report.sceneVerification
        ? formatSceneVerificationSummary(
            report.sceneVerification,
            eligibleScenes.length,
            outputLanguage,
          )
        : '',
      timeline: report.displayedScenes.slice(0, 40).map((scene, index) =>
        localize(
          outputLanguage,
          `${index + 1}. ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)} ${scene.processName ? `(${scene.processName})` : ''}，时长 ${formatMs(scene.durationMs)}。`,
          `${index + 1}. ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)} ${scene.processName ? `(${scene.processName})` : ''}; duration ${formatMs(scene.durationMs)}.`,
        ),
      ).join('\n') || localize(outputLanguage, '- 未检测到场景时间线。', '- No scene timeline was detected.'),
      timelineOverflow: report.displayedScenes.length > 40
        ? localize(
            outputLanguage,
            `- 另有 ${report.displayedScenes.length - 40} 个场景未在聊天摘要中展开，可在 Story Sidebar 查看。`,
            `- ${report.displayedScenes.length - 40} additional scenes are available in the Story Sidebar.`,
          )
        : '',
    },
  );

  return {
    sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion,
    conclusionContract: buildSelectionConclusionContract(report, outputLanguage),
    smartScenePreview: {
      reportId: report.reportId,
      scenes: report.displayedScenes.map(scene =>
        projectDisplayedScene(scene, outputLanguage)),
      sceneVerification: projectSceneVerification(
        report.sceneVerification,
        outputLanguage,
      ),
      eligibleSceneCount: eligibleScenes.length,
      sceneTypeCounts: countBy(report.displayedScenes.map(scene => scene.sceneType)),
    },
    confidence: report.displayedScenes.length > 0 ? 0.82 : 0.6,
    rounds: 1,
    totalDurationMs: input.totalDurationMs ?? report.totalDurationMs,
  };
}

function buildConclusionMarkdown(
  report: SceneReport,
  completedJobs: SceneAnalysisJob[],
  failedJobs: SceneAnalysisJob[],
  outputLanguage: OutputLanguage,
): string {
  const detectedScenes = report.displayedScenes;
  const analyzedScenes = completedJobs
    .map(job => sceneById(report, job.interval.displayedSceneId))
    .filter((scene): scene is DisplayedScene => !!scene);
  const sceneCounts = countBy(
    detectedScenes.map(scene => displaySceneType(scene.sceneType, outputLanguage)),
  );
  const orderedCounts = Object.entries(sceneCounts)
    .map(([label, count]) => localize(outputLanguage, `${label} ${count} 次`, `${label}: ${count}`))
    .join(localize(outputLanguage, '、', ', '))
    || localize(outputLanguage, '未检测到可展示场景', 'no displayable scenes');
  const topBottlenecks = buildBottleneckRows(report, completedJobs, outputLanguage).slice(0, 5);
  const localizedNarrative = report.summaries?.[outputLanguage]?.trim();
  const legacyChineseNarrative = outputLanguage === 'zh-CN'
    ? report.summary?.trim()
    : undefined;
  const completionSummary = failedJobs.length > 0
    ? localize(
        outputLanguage,
        `其中 ${completedJobs.length} 个场景完成深钻，${failedJobs.length} 个场景深钻失败或被取消。`,
        `${completedJobs.length} scene deep dives completed; ${failedJobs.length} failed or were cancelled.`,
      )
    : localize(
        outputLanguage,
        `其中 ${completedJobs.length} 个场景完成深钻，计划内深钻均已完成。`,
        `${completedJobs.length} scene deep dives completed, covering the full planned scope.`,
      );

  return renderRequiredLocalizedStrategyTemplate(
    'report-smart-analysis',
    outputLanguage,
    {
      overview: localize(
      outputLanguage,
      `本次 trace 还原出 ${detectedScenes.length} 个场景，覆盖 ${orderedCounts}。${completionSummary}`,
      `This trace contains ${detectedScenes.length} reconstructed scenes, covering ${orderedCounts}. ${completionSummary}`,
      ),
      timeline: detectedScenes.slice(0, 30).map((scene, index) =>
        localize(
          outputLanguage,
          `${index + 1}. ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)} ${scene.processName ? `(${scene.processName})` : ''}，时长 ${formatMs(scene.durationMs)}，状态 ${scene.analysisState}`,
          `${index + 1}. ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)} ${scene.processName ? `(${scene.processName})` : ''}; duration ${formatMs(scene.durationMs)}; state ${scene.analysisState}`,
        ),
      ).join('\n') || localize(outputLanguage, '- 未检测到场景时间线。', '- No scene timeline was detected.'),
      timelineOverflow: detectedScenes.length > 30
        ? localize(
            outputLanguage,
            `- 另有 ${detectedScenes.length - 30} 个场景未在聊天摘要中展开，可在 Story Sidebar 查看。`,
            `- ${detectedScenes.length - 30} additional scenes are available in the Story Sidebar.`,
          )
        : '',
      sceneSummaries: analyzedScenes.map(scene => {
        const job = completedJobs.find(item => item.interval.displayedSceneId === scene.id);
        const resultCount = job?.result?.projection?.metrics.display_result_count ?? 0;
        return localize(
          outputLanguage,
          `- ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)}：执行 ${job?.interval.skillId || 'unknown'}，产出 ${resultCount} 组证据，耗时 ${formatMs(job?.result?.durationMs ?? 0)}。`,
          `- ${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)}: ran ${job?.interval.skillId || 'unknown'}, produced ${resultCount} evidence groups in ${formatMs(job?.result?.durationMs ?? 0)}.`,
        );
      }).join('\n') || localize(
        outputLanguage,
        '- 没有场景进入深钻，建议检查 trace 是否包含可识别的启动、滑动、点击、导航、ANR 或设备状态事件。',
        '- No scenes entered deep-dive analysis. Check whether the trace contains recognizable startup, scrolling, tap, navigation, ANR, or device-state events.',
      ),
      narrative: localizedNarrative || legacyChineseNarrative ||
        buildFallbackNarrative(detectedScenes, completedJobs, outputLanguage),
      bottlenecks: topBottlenecks.map((row, index) =>
        localize(
          outputLanguage,
          `${index + 1}. ${row.title}：${row.reason}。证据 ${row.evidenceRef}。`,
          `${index + 1}. ${row.title}: ${row.reason}. Evidence: ${row.evidenceRef}.`,
        ),
      ).join('\n') || localize(
        outputLanguage,
        '- 未发现足够证据形成瓶颈排序。',
        '- There is not enough evidence to rank bottlenecks.',
      ),
      evidenceChain: completedJobs.slice(0, 10).map(job =>
        `- ${job.interval.skillId} / ${job.interval.displayedSceneId}: data:scene_job:${job.jobId}`,
      ).join('\n') || localize(
        outputLanguage,
        '- 当前没有完成的深钻证据。',
        '- No completed deep-dive evidence is available.',
      ),
    },
  );
}

function buildFallbackNarrative(
  scenes: DisplayedScene[],
  jobs: SceneAnalysisJob[],
  outputLanguage: OutputLanguage,
): string {
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  if (!first || !last) {
    return localize(
      outputLanguage,
      '跨场景层面未检测到足够事件；本次报告以可用深钻证据为准。',
      'There are not enough cross-scene events; this report is limited to the available deep-dive evidence.',
    );
  }
  return [
    localize(
      outputLanguage,
      `脚本从 ${displaySceneType(first.sceneType, outputLanguage)} 开始，到 ${displaySceneType(last.sceneType, outputLanguage)} 结束，中间穿插 ${jobs.length} 个已深钻阶段。`,
      `The flow starts with ${displaySceneType(first.sceneType, outputLanguage)} and ends with ${displaySceneType(last.sceneType, outputLanguage)}, with ${jobs.length} deep-dived stages in between.`,
    ),
    localize(
      outputLanguage,
      '优先关注瓶颈排序中的高耗时或异常场景，再回到 Story Sidebar 对齐具体时间窗。',
      'Start with high-duration or anomalous scenes in the bottleneck ranking, then use the Story Sidebar to align the exact time windows.',
    ),
  ].join('\n\n');
}

function formatSceneVerificationSummary(
  verification: NonNullable<SceneReport['sceneVerification']>,
  eligibleSceneCount: number,
  outputLanguage: OutputLanguage,
): string {
  if (outputLanguage === 'zh-CN') {
    return `场景还原复核：${verification.summary}`;
  }
  const warningCount = verification.issues.filter(issue => issue.severity === 'warning').length;
  const badCount = verification.issues.filter(issue => issue.severity === 'bad').length;
  if (verification.status === 'passed') {
    return `Scene reconstruction verification passed: ${verification.checkedSceneCount} scenes checked; ${eligibleSceneCount} eligible for deep dive.`;
  }
  if (verification.status === 'needs_review') {
    return `Scene reconstruction needs review: ${warningCount} warnings, ${badCount} critical conflicts, and ${eligibleSceneCount} scenes eligible for deep dive.`;
  }
  if (verification.status === 'failed') {
    return `Scene reconstruction verification failed after checking ${verification.checkedSceneCount} scenes.`;
  }
  return `Scene reconstruction verification was skipped; ${eligibleSceneCount} scenes remain eligible for deep dive.`;
}

function buildFindings(
  report: SceneReport,
  completedJobs: SceneAnalysisJob[],
  failedJobs: SceneAnalysisJob[],
  outputLanguage: OutputLanguage,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of buildBottleneckRows(report, completedJobs, outputLanguage).slice(0, 8)) {
    findings.push({
      id: `smart-${row.scene.id}`,
      category: row.scene.sceneType,
      type: 'smart_scene_bottleneck',
      severity: row.scene.severity === 'bad' ? 'high' : row.scene.severity === 'warning' ? 'medium' : 'info',
      title: row.title,
      description: row.reason,
      source: 'smart_analysis',
      confidence: 0.72,
      relatedTimestamps: [row.scene.startTs, row.scene.endTs],
      evidence: [{ ref: row.evidenceRef, skillId: row.job.interval.skillId }],
    });
  }
  if (failedJobs.length > 0) {
    findings.push({
      id: 'smart-partial-jobs',
      category: 'smart',
      type: 'partial_analysis',
      severity: 'warning',
      title: localize(outputLanguage, '部分场景深钻未完成', 'Some scene deep dives did not complete'),
      description: localize(
        outputLanguage,
        `${failedJobs.length} 个场景深钻失败，报告已保留可用场景证据。`,
        `${failedJobs.length} scene deep dives failed; the report retains the available scene evidence.`,
      ),
      source: 'smart_analysis',
      confidence: 0.8,
    });
  }
  return findings;
}

function buildConclusionContract(
  report: SceneReport,
  completedJobs: SceneAnalysisJob[],
  analyzedSceneIds: Set<string>,
  outputLanguage: OutputLanguage,
): ConclusionContract {
  const evidenceChain = completedJobs.slice(0, 20).map(job => ({
    conclusionId: `smart-${job.interval.displayedSceneId}`,
    text: `${sceneById(report, job.interval.displayedSceneId)?.sourceStepId || 'clean_timeline'} ${job.interval.skillId}`,
  }));
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'initial_report',
    conclusions: [
      {
        rank: 1,
        statement: localize(
          outputLanguage,
          `智能分析检测到 ${report.displayedScenes.length} 个脚本阶段，并完成 ${completedJobs.length} 个场景深钻。`,
          `Smart analysis detected ${report.displayedScenes.length} flow stages and completed ${completedJobs.length} scene deep dives.`,
        ),
        confidencePercent: report.partialReport ? 68 : 82,
      },
    ],
    clusters: Array.from(analyzedSceneIds).slice(0, 20).map(sceneId => ({
      cluster: sceneId,
      description: displaySceneType(
        sceneById(report, sceneId)?.sceneType || 'scene',
        outputLanguage,
      ),
    })),
    evidenceChain,
    claims: completedJobs.slice(0, 20).map(job => {
      const scene = sceneById(report, job.interval.displayedSceneId);
      const ref = buildSceneClaimReference(scene);
      return {
        conclusionId: `smart-${job.interval.displayedSceneId}`,
        text: localize(
          outputLanguage,
          `${displaySceneType(scene?.sceneType || 'scene', outputLanguage)} ${job.interval.skillId} 深钻结果来自 ${ref.sourceRef} 场景窗口。`,
          `${displaySceneType(scene?.sceneType || 'scene', outputLanguage)} ${job.interval.skillId} deep-dive results come from the ${ref.sourceRef} scene window.`,
        ),
        kind: 'categorical',
        references: [ref],
        supportLevel: 'verified',
      };
    }),
    uncertainties: report.partialReport
      ? [localize(
          outputLanguage,
          '部分场景深钻失败或被取消，结论以已完成证据为准。',
          'Some scene deep dives failed or were cancelled; conclusions are limited to completed evidence.',
        )]
      : [],
    nextSteps: [localize(
      outputLanguage,
      '在 Story Sidebar 中查看对应时间窗，并优先处理瓶颈排序靠前的场景。',
      'Inspect the corresponding windows in the Story Sidebar and prioritize the highest-ranked bottleneck scenes.',
    )],
    metadata: {
      sceneId: 'smart',
      confidencePercent: report.partialReport ? 68 : 82,
      rounds: 1,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

function buildSelectionConclusionContract(
  report: SceneReport,
  outputLanguage: OutputLanguage,
): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'initial_report',
    conclusions: [
      {
        rank: 1,
        statement: localize(
          outputLanguage,
          `智能分析已完成场景盘点，识别到 ${report.displayedScenes.length} 个候选场景，等待用户选择深钻范围。`,
          `Smart analysis completed the scene inventory and found ${report.displayedScenes.length} candidate scenes; select a deep-dive scope to continue.`,
        ),
        confidencePercent: report.displayedScenes.length > 0 ? 82 : 60,
      },
    ],
    clusters: [],
    evidenceChain: report.displayedScenes.slice(0, 20).map(scene => ({
      conclusionId: 'smart-selection-preview',
      text: `${scene.sourceStepId} ${scene.sceneType} ${formatRange(scene)}`,
    })),
    claims: [],
    uncertainties: report.displayedScenes.length > 0
      ? []
      : [localize(
          outputLanguage,
          '当前 trace 未识别出可展示的启动、滑动、点击、导航、ANR 或设备状态场景。',
          'No displayable startup, scrolling, tap, navigation, ANR, or device-state scenes were identified in this trace.',
        )],
    nextSteps: [localize(
      outputLanguage,
      '在智能分析选择条中选择“全部”或某一类场景后再开始深钻。',
      'Choose “All” or a scene category in the smart-analysis selector to start the deep dive.',
    )],
    metadata: {
      sceneId: 'smart',
      confidencePercent: report.displayedScenes.length > 0 ? 82 : 60,
      rounds: 1,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

function buildSceneClaimReference(scene: DisplayedScene | undefined): ConclusionContractClaimReference {
  if (!scene) return { sourceRef: 'clean_timeline' };
  const ref: ConclusionContractClaimReference = { sourceRef: scene.sourceStepId || 'clean_timeline' };
  const eventKey = firstPresentKey(scene.metadata, ['event', 'event_type', 'startup_type', 'gesture_type']);
  const column = eventKey || defaultSceneEvidenceColumn(scene);
  const value = eventKey ? scene.metadata[eventKey] : scene.sceneType;
  if (isClaimScalar(value)) {
    ref.column = column;
    ref.value = value;
    ref.rowSelector = { [column]: value };
    const ts = scene.metadata.ts;
    if (isClaimScalar(ts)) ref.rowSelector.ts = ts;
  }
  return ref;
}

function defaultSceneEvidenceColumn(scene: DisplayedScene): string {
  if (scene.sourceStepId === 'user_gestures') return 'gesture_type';
  if (scene.sourceStepId === 'inertial_scrolls') return 'category';
  return 'event';
}

function firstPresentKey(record: Record<string, unknown>, keys: string[]): string | undefined {
  return keys.find(key => record[key] !== undefined && record[key] !== null);
}

function isClaimScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function buildBottleneckRows(
  report: SceneReport,
  jobs: SceneAnalysisJob[],
  outputLanguage: OutputLanguage,
): Array<{
  scene: DisplayedScene;
  job: SceneAnalysisJob;
  title: string;
  reason: string;
  evidenceRef: string;
}> {
  return jobs
    .map(job => {
      const scene = sceneById(report, job.interval.displayedSceneId);
      if (!scene) return null;
      const projection = job.result?.projection;
      const resultCount = projection?.metrics.display_result_count ?? 0;
      const omitted = projection?.omittedRowCount ?? 0;
      return {
        scene,
        job,
        title: `${displaySceneType(scene.sceneType, outputLanguage)} ${formatRange(scene)}`,
        reason: localize(
          outputLanguage,
          `场景时长 ${formatMs(scene.durationMs)}，深钻技能 ${job.interval.skillId} 产出 ${resultCount} 组结果${omitted > 0 ? `，聊天摘要截断 ${omitted} 组` : ''}`,
          `Scene duration ${formatMs(scene.durationMs)}; deep-dive skill ${job.interval.skillId} produced ${resultCount} result groups${omitted > 0 ? `, with ${omitted} omitted from the chat summary` : ''}`,
        ),
        evidenceRef: projection?.evidenceRefs[0] || `data:scene_job:${job.jobId}`,
      };
    })
    .filter((row): row is NonNullable<typeof row> => !!row)
    .sort((a, b) => severityScore(b.scene) - severityScore(a.scene));
}

function sceneById(report: SceneReport, sceneId: string): DisplayedScene | undefined {
  return report.displayedScenes.find(scene => scene.id === sceneId);
}

function formatRange(scene: DisplayedScene): string {
  return `[${formatNs(scene.startTs)} - ${formatNs(scene.endTs)}]`;
}

function formatNs(value: string): string {
  const ns = Number(value);
  if (!Number.isFinite(ns)) return value;
  return `${(ns / 1_000_000_000).toFixed(3)}s`;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '0ms';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function severityScore(scene: DisplayedScene): number {
  const base = scene.severity === 'bad' ? 10_000 : scene.severity === 'warning' ? 5_000 : 0;
  return base + Math.max(0, scene.durationMs || 0);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}
