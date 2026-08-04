// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Stage1 scene reconstruction verifier.
 *
 * The deterministic pass always runs and checks the reconstructed scene graph
 * itself. The LLM pass is optional and best-effort: it receives only a compact
 * evidence packet and never mutates scenes. This keeps Smart preview cheap and
 * reproducible while still giving us a hook for ambiguous vendor traces.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { sceneStoryConfig } from '../../config';
import {createSdkEnv, loadClaudeConfig} from '../../agentv3/claudeConfig';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import {isolatedSceneModelCallOptions} from './isolatedSceneModelCall';
import type {
  DisplayedScene,
  SceneReconstructionVerification,
} from './types';

export interface Stage1VerifierInput {
  scenes: DisplayedScene[];
  traceDurationSec: number;
  enableLlm?: boolean;
}

export async function runSceneStage1Verifier(
  input: Stage1VerifierInput,
): Promise<SceneReconstructionVerification> {
  const deterministic = runDeterministicVerification(input.scenes, input.traceDurationSec);
  const shouldAskLlm =
    input.enableLlm === true &&
    sceneStoryConfig.llmVerify &&
    shouldRunLlmVerifier(deterministic);

  if (!shouldAskLlm) {
    return {
      ...deterministic,
      llm: {
        status: sceneStoryConfig.llmVerify ? 'not_needed' : 'skipped',
        summary: sceneStoryConfig.llmVerify
          ? '确定性复核未发现需要模型二次判断的高风险歧义。'
          : 'LLM 复核未启用；已完成确定性复核。',
      },
    };
  }

  const llm = await runLlmVerifier(input.scenes, deterministic);
  const status = llm.status === 'needs_review' || deterministic.status === 'needs_review'
    ? 'needs_review'
    : deterministic.status;
  return {
    ...deterministic,
    status,
    verifier: 'deterministic+llm',
    summary: llm.summary || deterministic.summary,
    llm,
  };
}

function runDeterministicVerification(
  scenes: DisplayedScene[],
  traceDurationSec: number,
): SceneReconstructionVerification {
  const issues: SceneReconstructionVerification['issues'] = [];
  const lowConfidenceSceneIds: string[] = [];
  const conflictSceneIds: string[] = [];

  for (const scene of scenes) {
    const confidence = typeof scene.confidenceScore === 'number' ? scene.confidenceScore : 0;
    if (confidence > 0 && confidence < 0.65) {
      lowConfidenceSceneIds.push(scene.id);
      issues.push({
        severity: 'warning',
        sceneId: scene.id,
        type: 'low_confidence',
        message: `${scene.sceneType} confidence ${confidence.toFixed(2)} is below Smart preview threshold.`,
      });
    }
    if ((scene.conflicts?.length ?? 0) > 0) {
      conflictSceneIds.push(scene.id);
      for (const conflict of scene.conflicts ?? []) {
        issues.push({
          severity: conflict.severity === 'bad' ? 'bad' : 'warning',
          sceneId: scene.id,
          type: conflict.type,
          message: conflict.message,
        });
      }
    }
    if (scene.sceneType === 'scroll_start' && !scene.parentSceneId) {
      issues.push({
        severity: 'warning',
        sceneId: scene.id,
        type: 'orphan_scroll_marker',
        message: 'scroll_start marker was not linked to an active scroll scene.',
      });
    }
    if (scene.sceneType === 'inertial_scroll' && !scene.parentSceneId) {
      issues.push({
        severity: 'info',
        sceneId: scene.id,
        type: 'unlinked_inertial_scroll',
        message: 'inertial_scroll was not linked to an active scroll scene.',
      });
    }
  }

  if (scenes.length === 0 && traceDurationSec > 0) {
    issues.push({
      severity: 'warning',
      type: 'empty_timeline',
      message: 'No user-visible scenes were reconstructed from a non-empty trace.',
    });
  }

  const actionCount = scenes.filter(scene => scene.analysisEligible !== false && scene.sceneRole !== 'marker' && scene.sceneRole !== 'context').length;
  if (scenes.length > 0 && actionCount === 0) {
    issues.push({
      severity: 'warning',
      type: 'no_deep_dive_candidates',
      message: 'Timeline has scenes, but none are eligible for Smart deep dive.',
    });
  }

  const badIssueCount = issues.filter(issue => issue.severity === 'bad').length;
  const warningIssueCount = issues.filter(issue => issue.severity === 'warning').length;
  const status = badIssueCount > 0 || warningIssueCount > 0 ? 'needs_review' : 'passed';
  const summary = status === 'passed'
    ? `场景还原复核通过：${scenes.length} 个场景，${actionCount} 个可深钻。`
    : `场景还原需要复核：${warningIssueCount} 个 warning，${badIssueCount} 个 bad，${actionCount} 个可深钻场景。`;

  return {
    status,
    verifier: 'deterministic',
    summary,
    checkedSceneCount: scenes.length,
    lowConfidenceSceneIds,
    conflictSceneIds,
    issues,
  };
}

function shouldRunLlmVerifier(result: SceneReconstructionVerification): boolean {
  if (result.status === 'failed') return false;
  if (result.issues.some(issue => issue.severity === 'bad')) return true;
  if (result.lowConfidenceSceneIds.length >= 2) return true;
  if (result.conflictSceneIds.length > 0) return true;
  if (result.issues.some(issue => issue.type === 'empty_timeline' || issue.type === 'no_deep_dive_candidates')) return true;
  return false;
}

async function runLlmVerifier(
  scenes: DisplayedScene[],
  deterministic: SceneReconstructionVerification,
): Promise<NonNullable<SceneReconstructionVerification['llm']>> {
  const prompt = buildVerifierPrompt(scenes, deterministic);
  if (!prompt) {
    return {
      status: 'skipped',
      summary: 'LLM 复核模板未注册；已保留确定性复核结果。',
    };
  }
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { stream?.close(); } catch { /* ignore */ }
  }, sceneStoryConfig.llmVerifyTimeoutMs);

  try {
    const sdkEnv = createSdkEnv();
    stream = sdkQuery({
      prompt,
      options: {
        ...isolatedSceneModelCallOptions({
          model: loadClaudeConfig().lightModel,
          env: sdkEnv,
          stderr: (data: string) => {
            console.warn(`[SceneStage1Verifier] SDK stderr: ${data.trimEnd()}`);
          },
        }),
      },
    });

    let raw = '';
    for await (const msg of stream) {
      if (timedOut) break;
      if ((msg as any).type === 'result' && (msg as any).subtype === 'success') {
        raw = (msg as any).result || '';
      }
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return { status: timedOut ? 'failed' : 'skipped', error: timedOut ? 'LLM verifier timed out' : 'LLM verifier returned empty output' };
    }
    const parsed = parseVerifierJson(trimmed);
    return {
      status: parsed.status,
      summary: parsed.summary,
      raw: trimmed,
    };
  } catch (error: any) {
    return {
      status: 'failed',
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* ignore */ }
  }
}

function buildVerifierPrompt(
  scenes: DisplayedScene[],
  deterministic: SceneReconstructionVerification,
): string | undefined {
  const template = loadPromptTemplate('scene-reconstruction-verifier');
  if (!template) return undefined;

  const sceneLines = scenes.slice(0, 80).map((scene, index) => {
    const children = scene.childSceneIds?.length ? ` children=${scene.childSceneIds.join(',')}` : '';
    const parent = scene.parentSceneId ? ` parent=${scene.parentSceneId}` : '';
    const conflicts = scene.conflicts?.length ? ` conflicts=${scene.conflicts.map(c => c.type).join(',')}` : '';
    return [
      `${index + 1}. id=${scene.id}`,
      `type=${scene.sceneType}`,
      `role=${scene.sceneRole ?? 'action'}`,
      `eligible=${scene.analysisEligible !== false}`,
      `confidence=${scene.confidenceScore ?? 'unknown'}`,
      `range=${scene.startTs}-${scene.endTs}`,
      `durMs=${scene.durationMs}`,
      `app=${scene.processName ?? 'unknown'}`,
      `source=${scene.sourceStepId}`,
      `${parent}${children}${conflicts}`,
    ].join(' ');
  });

  const issueLines = deterministic.issues.slice(0, 30).map(issue =>
    `- ${issue.severity} ${issue.type}${issue.sceneId ? ` scene=${issue.sceneId}` : ''}: ${issue.message}`,
  );

  return renderTemplate(template, {
    deterministicSummary: deterministic.summary,
    deterministicIssues: issueLines.join('\n') || '- none',
    scenes: sceneLines.join('\n') || '- none',
  });
}

function parseVerifierJson(raw: string): { status: 'passed' | 'needs_review'; summary: string } {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  try {
    const parsed = JSON.parse(jsonText);
    const status = parsed?.status === 'needs_review' ? 'needs_review' : 'passed';
    const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'LLM 复核完成。';
    return { status, summary };
  } catch {
    return {
      status: raw.includes('needs_review') || raw.includes('需要') ? 'needs_review' : 'passed',
      summary: raw.slice(0, 300),
    };
  }
}
