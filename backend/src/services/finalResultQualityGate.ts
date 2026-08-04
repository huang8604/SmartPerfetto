// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AgentRuntimeAnalysisResult } from '../agent/core/orchestratorTypes';
import {
  QUICK_TRIAGE_MAX_CHINESE_CHARS,
  QUICK_TRIAGE_MAX_CLAIMS,
} from '../agentv3/quickAnswerContract';
import { assessFinalReportContractCompleteness } from './finalReportContractGate';

export type FinalResultQualityIssueCode =
  | 'empty_conclusion'
  | 'plan_summary_fallback'
  | 'process_narration_conclusion'
  | 'missing_final_report_heading'
  | 'sparse_unverified_conclusion'
  | 'quick_full_report_shape'
  | 'quick_verifier_failed'
  | 'scene_contract_incomplete'
  | 'comparison_identity_incomplete'
  | 'kernel_blocking_claim_boundary';

export interface FinalResultQualityIssue {
  code: FinalResultQualityIssueCode;
  message: string;
}

export interface FinalResultComparisonIdentity {
  currentPackageName?: string;
  referencePackageName?: string;
}

const FINAL_RESULT_QUALITY_GATE_MESSAGE =
  '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论；本次结果已标记为 partial，避免把降级文本当作正常完成。';

const ANALYSIS_QUERY_MARKERS = [
  '分析',
  '诊断',
  '为什么',
  '原因',
  '根因',
  '卡顿',
  '掉帧',
  '慢',
  '耗时高',
  '瓶颈',
  '性能问题',
  'analyze',
  'diagnose',
  'why',
  'root cause',
  'performance issue',
  'slow',
  'bottleneck',
  'jank',
  'anr',
];

const DEEP_ANALYSIS_QUERY_MARKERS = [
  '分析',
  '诊断',
  '为什么',
  '原因',
  '根因',
  '性能问题',
  'analyze',
  'diagnose',
  'why',
  'root cause',
  'performance issue',
];

const FACTUAL_QUERY_MARKERS = [
  '哪个',
  '哪一',
  '是什么',
  '多少',
  '列出',
  'package',
  'pid',
  'tid',
  'what',
  'which',
  'how many',
];

function normalizeTextForQualityCheck(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length || 0;
}

function collectMarkdownSections(text: string): Array<{ heading: string; body: string }> {
  const headingPattern = /(^|\n)\s*#{1,3}\s+([^\n]+)/g;
  const matches = [...text.matchAll(headingPattern)];
  return matches.map((match, index) => {
    const headingStart = (match.index || 0) + match[1].length;
    const bodyStart = headingStart + match[0].slice(match[1].length).length;
    const nextStart = matches[index + 1]?.index ?? text.length;
    return {
      heading: match[2].trim(),
      body: text.slice(bodyStart, nextStart).trim(),
    };
  });
}

function isFallbackSummaryHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/[：:]\s*$/, '').toLowerCase();
  return normalized === '综合结论' ||
    normalized === '分阶段证据摘要' ||
    normalized === 'final conclusion' ||
    normalized === 'evidence summary by phase';
}

function isHeadingLine(line: string, labelPattern: string): boolean {
  return new RegExp(
    `^\\s*(?:#{1,3}\\s*)?(?:${labelPattern})(?:\\s*[：:])?\\s*$`,
    'i',
  ).test(line);
}

function matchHeadingWithTail(line: string, labelPattern: string): string | undefined {
  const match = line.match(new RegExp(
    `^\\s*(?:#{1,6}\\s*)?(?:${labelPattern})(?:\\s*[：:])?\\s*(.*)$`,
    'i',
  ));
  return match ? match[1].trim() : undefined;
}

function looksLikePhaseSummaryEntry(line: string): boolean {
  return /^\s*(?:[-*]\s*|\d+[.)、]\s*)?[^：:\n]{1,80}[：:]\s+\S/.test(line);
}

function countPhaseSummaryEntries(text: string): number {
  const lines = text.split(/\r?\n/);
  let inPhaseSummary = false;
  let count = 0;
  for (const line of lines) {
    const phaseSummaryTail = matchHeadingWithTail(line, '分阶段证据摘要|Evidence Summary By Phase');
    if (phaseSummaryTail !== undefined) {
      inPhaseSummary = true;
      if (looksLikePhaseSummaryEntry(phaseSummaryTail)) count++;
      continue;
    }
    if (!inPhaseSummary) continue;
    if (/^\s*#{1,6}\s+\S/.test(line)) break;
    if (looksLikePhaseSummaryEntry(line)) {
      count++;
    }
  }
  return count;
}

function hasEvidenceReferenceText(text: string): boolean {
  return countMatches(
    text,
    /(?:\bart-\d+\b|\bdata:[a-z0-9_:-]+\b|\bevidence[_-]?ref\b|\bsource_tool_call_id\b|证据\s*ID)/gi,
  ) > 0;
}

function hasConcreteEvidenceText(text: string): boolean {
  if (hasEvidenceReferenceText(text)) return true;

  const metricCount = countMatches(
    text,
    /\b(?:TTID|dur(?:ation)?|self_ms|total_ms|Running|Runnable|blocked|binder|GC|CPU|Q[1-4][ab]?)\b|(?:\d+(?:\.\d+)?\s*(?:ms|s|%|fps|MB|GHz|MHz))/gi,
  );
  return metricCount >= 3;
}

function hasReportStructureMarker(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(text) ||
    /(^|\n)\s{0,3}\*\*[^*\n]{2,80}\*\*/.test(text) ||
    /(^|\n)\s{0,3}\|/.test(text);
}

export function hasDeliverableFinalReportHeading(text: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,3}\s*)?(?:(?:[^\n#]{0,40})?分析报告|综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause)(?=\s|[：:。.!！?\n]|$)/i.test(text);
}

export function stripLeadingProcessNarrationFromFinalReport(text: string): string {
  const conclusion = text.trim();
  if (!looksLikeProcessNarrationConclusion(conclusion)) return conclusion;

  const heading = conclusion.match(
    /(^|\n)\s{0,3}(?:#{1,3}\s*)?(?:(?:[^\n#]{0,40})?分析报告|综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause)(?=\s|[：:。.!！?\n]|$)/i,
  );
  if (heading?.index === undefined) return conclusion;
  const headingStart = heading.index + (heading[1]?.length ?? 0);
  return conclusion.slice(headingStart).trim();
}

export function looksLikeProcessNarrationConclusion(conclusion: string): boolean {
  const text = normalizeTextForQualityCheck(conclusion);
  if (!text) return false;

  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(text) ||
    /(?:现在|接下来|下一步).{0,40}(?:完成|进入|继续).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(text) ||
    /(?:现在完成|现在进入|进入|继续执行).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(text) ||
    /(?:update_plan_phase|submit_plan|resolve_hypothesis|阶段状态更新|执行剩余阶段|继续执行剩余阶段|OpenAI plan|provider 未主动结束 stream|plan 未完成|plan 已完成)/i.test(text);
}

function collectIndependentEvidenceSectionText(text: string): string {
  const lines = text.split(/\r?\n/);
  const sections: string[] = [];
  let collecting = false;
  const independentHeadingPattern =
    '关键证据链|证据链|关键证据|根因拆解|优化建议|风险与不确定性|Evidence Chain|Key Evidence|Root Cause|Recommendations|Risks';

  for (const line of lines) {
    if (matchHeadingWithTail(line, '综合结论|Final Conclusion') !== undefined ||
        matchHeadingWithTail(line, '分阶段证据摘要|Evidence Summary By Phase') !== undefined) {
      collecting = false;
      continue;
    }

    const independentTail = matchHeadingWithTail(line, independentHeadingPattern);
    if (independentTail !== undefined) {
      collecting = true;
      if (independentTail) sections.push(independentTail);
      continue;
    }

    if (collecting && (
      /^\s*#{1,6}\s+\S/.test(line) ||
      /^\s*\S.{0,60}[：:]\s*$/.test(line)
    )) {
      collecting = false;
      continue;
    }

    if (collecting) sections.push(line);
  }

  return sections.join('\n').trim();
}

export function looksLikePhaseSummaryFallback(conclusion: string): boolean {
  const text = conclusion.trim();
  if (!text) return false;

  const hasConclusionHeading = /(^|\n)\s*(?:#{1,3}\s*)?(综合结论|Final Conclusion)(?:\s*[：:])?/i.test(text);
  const hasPhaseSummaryHeading = /(^|\n)\s*(?:#{1,3}\s*)?(分阶段证据摘要|Evidence Summary By Phase)(?:\s*[：:])?/i.test(text);
  if (!hasConclusionHeading || !hasPhaseSummaryHeading) return false;

  if (countPhaseSummaryEntries(text) < 1) return false;

  const nonFallbackSections = collectMarkdownSections(text)
    .filter(section => !isFallbackSummaryHeading(section.heading));
  const independentEvidenceText = collectIndependentEvidenceSectionText(text);
  if (independentEvidenceText && hasConcreteEvidenceText(independentEvidenceText)) {
    return false;
  }
  if (nonFallbackSections.length === 0) return true;

  return !hasConcreteEvidenceText(
    nonFallbackSections.map(section => `${section.heading}\n${section.body}`).join('\n\n'),
  );
}

function looksLikeAnalysisQuery(query: string | undefined): boolean {
  const normalized = normalizeTextForQualityCheck(String(query || '')).toLowerCase();
  if (!normalized) return true;
  const asksFactualQuestion = FACTUAL_QUERY_MARKERS.some(marker => normalized.includes(marker));
  const asksDeepAnalysis = DEEP_ANALYSIS_QUERY_MARKERS.some(marker => normalized.includes(marker));
  if (asksFactualQuestion && !asksDeepAnalysis) return false;
  return ANALYSIS_QUERY_MARKERS.some(marker => normalized.includes(marker));
}

function hasSupportedClaimVerification(result: AgentRuntimeAnalysisResult): boolean {
  const status = result.claimVerificationResult?.status;
  if (status === 'passed') return true;
  if (status !== 'partial') return false;
  return result.claimVerificationResult?.claimResults?.some(claim =>
    claim.status === 'verified' || claim.status === 'partial' || claim.status === 'inference'
  ) === true;
}

function conclusionContractHasEvidence(result: AgentRuntimeAnalysisResult): boolean {
  const contract = result.conclusionContract;
  if (!contract) return false;
  if (Array.isArray(contract.evidenceChain) && contract.evidenceChain.length > 0) return true;
  return Array.isArray(contract.claims) &&
    contract.claims.some(claim =>
      (Array.isArray(claim.references) && claim.references.length > 0) ||
      (Array.isArray(claim.artifactRefs) && claim.artifactRefs.length > 0) ||
      (Array.isArray(claim.relationRefs) && claim.relationRefs.length > 0)
    );
}

function hasEvidenceBackedArtifacts(result: AgentRuntimeAnalysisResult): boolean {
  return Boolean(
    conclusionContractHasEvidence(result) ||
    (Array.isArray(result.claimSupport) && result.claimSupport.some(claim =>
      claim.supportLevel === 'verified' ||
      claim.supportLevel === 'partial' ||
      claim.supportLevel === 'inference'
    )) ||
    hasSupportedClaimVerification(result),
  );
}

function isQuickRunResult(result: AgentRuntimeAnalysisResult): boolean {
  return result.quickRun?.resolvedMode === 'quick';
}

function removeNegatedFullReportBoundaryText(text: string): string {
  return text
    .replace(
      /(?:不(?:等同于|是|代表|应被视为)|并非|不能(?:作为|当作)?|不可(?:作为|当作)?|不是).{0,24}(?:完整|全面|全景).{0,40}(?:诊断|分析|报告)/g,
      '',
    )
    .replace(
      /(?:not|isn't|doesn't|should\s+not|cannot|can't).{0,30}(?:full|complete|comprehensive).{0,50}(?:diagnosis|analysis|report)/gi,
      '',
    );
}

function looksLikeOverExpandedQuickReport(
  result: AgentRuntimeAnalysisResult,
  conclusion: string,
): boolean {
  if (!isQuickRunResult(result)) return false;
  const reportShapeText = removeNegatedFullReportBoundaryText(conclusion);
  const headingCount = countMatches(reportShapeText, /(^|\n)\s{0,3}#{1,3}\s+\S/g);
  const claimCount = result.conclusionContract?.claims?.length ?? 0;
  const hasFullReportLanguage =
    /(?:完整|全面|全景).{0,16}(?:诊断|分析|报告)|(?:full|complete|comprehensive).{0,20}(?:diagnosis|analysis|report)/i.test(reportShapeText) ||
    /(^|\n)\s{0,3}#{1,3}\s*[^\n]{0,40}(?:完整诊断报告|完整分析报告|综合诊断报告|Full Report|Comprehensive Report)/i.test(reportShapeText);
  const triageOverBudget = result.quickRun?.profile === 'triage' &&
    reportShapeText.length > QUICK_TRIAGE_MAX_CHINESE_CHARS * 2;
  const triageContractOverrun = result.quickRun?.profile === 'triage' &&
    (headingCount > 2 || claimCount > QUICK_TRIAGE_MAX_CLAIMS);
  return hasFullReportLanguage || triageOverBudget || triageContractOverrun || headingCount >= 6 || reportShapeText.length > 3600;
}

function assessKernelBlockingClaimBoundary(conclusion: string): FinalResultQualityIssue | undefined {
  const text = normalizeTextForQualityCheck(conclusion);
  const lower = text.toLowerCase();

  const mentionsUninterruptibleState = /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|uninterruptible\s+sleep)/i.test(text);
  const claimsDStateAsIoRootCause =
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|uninterruptible\s+sleep).{0,80}(?:io|i\/o|磁盘|存储|disk|storage).{0,80}(?:根因|证明|导致|阻塞|等待|瓶颈|卡顿|慢)/i.test(text) ||
    /(?:io|i\/o|磁盘|存储|disk|storage).{0,80}(?:根因|证明|导致|阻塞|等待|瓶颈|卡顿|慢).{0,80}(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|uninterruptible\s+sleep)/i.test(text);
  const hasDStateIoEvidence =
    /io_wait\s*(?:=|为|是)?\s*1/i.test(text) ||
    /(?:filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|ext4|f2fs|erofs|ufshcd|mmc_|dm_|fsync)/i.test(text) ||
    /(?:sqlite|file\s*i\/?o|文件\s*i\/?o|数据库|sharedpreferences).{0,40}(?:slice|trace|stack|调用栈|证据|耗时|ms)/i.test(text);
  const qualifiesDStateBoundary =
    /(?:候选|不能|不可|不等于|无法|证据不足|ambiguous|candidate|not enough)/i.test(text);
  if (mentionsUninterruptibleState && claimsDStateAsIoRootCause && !hasDStateIoEvidence && !qualifiesDStateBoundary) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} D/DK 只能说明不可中断等待；没有 io_wait=1、IO/page-cache blocked_function 或 app-level 文件/数据库证据时，不能直接写成磁盘 IO 根因。`,
    };
  }

  const mentionsPollWait = /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)/i.test(text);
  const claimsPollAsIo =
    /(?:io|i\/o|磁盘|存储|文件\s*i\/?o|io_wait|io wait|disk|storage).{0,50}(?:根因|导致|阻塞|等待|瓶颈|卡顿|慢)/i.test(text) ||
    /(?:根因|导致|阻塞|等待|瓶颈|卡顿|慢).{0,50}(?:io|i\/o|磁盘|存储|文件\s*i\/?o|io_wait|io wait|disk|storage)/i.test(text);
  const qualifiesPollBoundary =
    /(?:不是|并非|不能|不可|不应|无法|ambiguous|idle|空闲|等待事件|poll_idle|可疑|候选|不等于).{0,70}(?:io|i\/o|磁盘|存储|disk|storage|root cause|根因)/i.test(text) ||
    /(?:io|i\/o|磁盘|存储|disk|storage).{0,70}(?:证据不足|不能直接|不等于|候选|ambiguous|idle|空闲)/i.test(text);
  if (mentionsPollWait && claimsPollAsIo && !qualifiesPollBoundary) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} epoll/poll 类 blocked_function 通常表示等待事件或空闲，不能直接写成 IO 根因；需要 io_wait=1、IO/page-cache 函数族或 app-level 文件/数据库证据补强。`,
    };
  }

  const mentionsBlockedFunction =
    lower.includes('blocked_function') ||
    lower.includes('sched_blocked_reason') ||
    /\bwchan\b/i.test(text);
  const claimsBlockedFunctionAsFullStack =
    /(?:blocked_function|sched_blocked_reason|wchan).{0,120}(?:完整|full).{0,40}(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack)/i.test(text) ||
    /(?:完整|full).{0,40}(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack).{0,120}(?:blocked_function|sched_blocked_reason|wchan)/i.test(text);
  const qualifiesSingleFrameBoundary =
    /(?:不是|并非|不能|无法|not|single[- ]frame|单帧|wchan).{0,100}(?:完整|full|stack|调用栈|内核栈|堆栈|callstack)/i.test(text) ||
    /(?:完整|full|stack|调用栈|内核栈|堆栈|callstack).{0,100}(?:不是|并非|不能|无法|not|single[- ]frame|单帧|wchan)/i.test(text);
  if (mentionsBlockedFunction && claimsBlockedFunctionAsFullStack && !qualifiesSingleFrameBoundary) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} blocked_function 来自 sched_blocked_reason 的 kernel wchan 单帧，不是完整内核调用栈；完整 off-CPU 栈需要 linux.perf / sched_switch 事件采样。`,
    };
  }

  return undefined;
}

export function assessFinalResultQuality(input: {
  result: AgentRuntimeAnalysisResult;
  query?: string;
  sceneType?: string;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): FinalResultQualityIssue | undefined {
  const { result, query, sceneType, comparisonIdentity } = input;
  if (!result.success) return undefined;

  const conclusion = result.conclusion.trim();
  if (result.partial === true) {
    if (looksLikeAnalysisQuery(query)) {
      return assessKernelBlockingClaimBoundary(conclusion);
    }
    return undefined;
  }

  if (!conclusion) {
    return {
      code: 'empty_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikePhaseSummaryFallback(conclusion)) {
    return {
      code: 'plan_summary_fallback',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikeProcessNarrationConclusion(conclusion)) {
    return {
      code: 'process_narration_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (isQuickRunResult(result) && result.claimVerificationResult?.status === 'failed') {
    return {
      code: 'quick_verifier_failed',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} 快速模式当前断言未通过证据核对；不能作为已核验快速答案交付。`,
    };
  }

  if (looksLikeOverExpandedQuickReport(result, conclusion)) {
    return {
      code: 'quick_full_report_shape',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} 快速模式只能交付局部事实或快速 triage；当前输出呈现完整报告形态，应切换完整模式重新分析。`,
    };
  }

  if (
    !isQuickRunResult(result) &&
    looksLikeAnalysisQuery(query) &&
    hasReportStructureMarker(conclusion) &&
    !hasDeliverableFinalReportHeading(conclusion)
  ) {
    return {
      code: 'missing_final_report_heading',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  const hasFindings = Array.isArray(result.findings) && result.findings.length > 0;
  if (
    looksLikeAnalysisQuery(query) &&
    conclusion.length < 280 &&
    !hasFindings &&
    !hasEvidenceBackedArtifacts(result) &&
    !hasEvidenceReferenceText(conclusion)
  ) {
    return {
      code: 'sparse_unverified_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikeAnalysisQuery(query)) {
    const kernelBlockingIssue = assessKernelBlockingClaimBoundary(conclusion);
    if (kernelBlockingIssue) return kernelBlockingIssue;
  }

  const comparisonIdentityIssue = assessFinalResultComparisonIdentity(
    conclusion,
    comparisonIdentity,
  );
  if (comparisonIdentityIssue) return comparisonIdentityIssue;

  if (!isQuickRunResult(result) && looksLikeAnalysisQuery(query)) {
    const contractIssue = assessFinalReportContractCompleteness({
      conclusion,
      query,
      sceneType,
      contractSceneId: result.conclusionContract?.metadata?.sceneId,
      caseRecommendations: result.conclusionContract?.caseRecommendations as Array<Record<string, unknown>> | undefined,
    });
    if (contractIssue) {
      const missingText = contractIssue.missingLabels.join('、');
      return {
        code: 'scene_contract_incomplete',
        message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} ` +
          `缺失 ${contractIssue.sceneType} 场景 Final Report Contract 要求的结构：${missingText}。`,
      };
    }
  }

  return undefined;
}

export function assessFinalResultComparisonIdentity(
  conclusion: string,
  identity: FinalResultComparisonIdentity | undefined,
): FinalResultQualityIssue | undefined {
  if (!identity) return undefined;

  const packageNames = [...new Set([
    identity.currentPackageName?.trim(),
    identity.referencePackageName?.trim(),
  ].filter((packageName): packageName is string => Boolean(packageName)))];
  const missingPackageNames = packageNames.filter(packageName => !conclusion.includes(packageName));
  if (missingPackageNames.length === 0) return undefined;

  return {
    code: 'comparison_identity_incomplete',
    message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} ` +
      `双 Trace 对比结论必须显式写出两侧完整包名，不能只使用左侧/右侧或业务别名；缺失：${missingPackageNames.join('、')}。`,
  };
}

export function applyFinalResultQualityGate(input: {
  result: AgentRuntimeAnalysisResult;
  query?: string;
  sceneType?: string;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): FinalResultQualityIssue | undefined {
  const issue = assessFinalResultQuality(input);
  if (!issue) return undefined;

  input.result.partial = true;
  input.result.confidence = Math.min(input.result.confidence || 0, 0.55);
  input.result.terminationReason = input.result.terminationReason ?? 'plan_incomplete';
  input.result.terminationMessage = input.result.terminationMessage
    ? `${input.result.terminationMessage}\n\n${issue.message}`
    : issue.message;
  return issue;
}
