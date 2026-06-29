// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { uuidv4 } from '../utils/uuid';
import type { Finding } from '../agent/types';

const SEVERITY_MAP: Record<string, Finding['severity']> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

const SEVERITY_REGEX = /\*?\*?\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*?\*?\s*(.+)/g;
const NEXT_SEVERITY_REGEX = /\*?\*?\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*?\*?\s*/g;

/**
 * Strip fenced code blocks (``` ... ```) from text to prevent extracting
 * false findings from Mermaid diagrams, SQL snippets, etc.
 * E.g., Mermaid nodes like `E["[HIGH] ...]"` contain [SEVERITY] patterns
 * that the regex would incorrectly match as findings.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function maskCodeBlocksForFindingScan(text: string): string {
  return text.replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '));
}

function maskMarkdownTableRowsForFindingScan(text: string): string {
  return text
    .split('\n')
    .map(line => isMarkdownTableRow(line) ? line.replace(/[^\n]/g, ' ') : line)
    .join('\n');
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/.test(trimmed)) return false;

  const cells = trimmed
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);
  if (cells.length >= 3) return true;
  if ((trimmed.startsWith('|') || trimmed.endsWith('|')) && cells.length >= 2) return true;

  return isMarkdownTableSeparatorRow(trimmed);
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function findNextSeverityMarkerIndex(scanText: string, startIndex: number): number | undefined {
  NEXT_SEVERITY_REGEX.lastIndex = startIndex;
  const next = NEXT_SEVERITY_REGEX.exec(scanText);
  return next?.index;
}

/**
 * Extract Finding objects from Claude's free-text analysis output.
 * Scans for lines matching the pattern: **[SEVERITY] Title**
 */
export function extractFindingsFromText(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  // Mask code blocks to avoid extracting findings from Mermaid/SQL/code content
  // while preserving indices so evidence can still be read from the original text.
  const scanText = maskMarkdownTableRowsForFindingScan(maskCodeBlocksForFindingScan(text));

  SEVERITY_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SEVERITY_REGEX.exec(scanText)) !== null) {
    const severity = SEVERITY_MAP[match[1]] ?? 'info';
    const title = match[2].replace(/\*+/g, '').trim();
    const afterTitleStart = match.index + match[0].length;
    const sectionEnd = findNextSeverityMarkerIndex(scanText, afterTitleStart) ?? text.length;
    const afterTitle = text.substring(afterTitleStart, Math.min(sectionEnd, afterTitleStart + 1600));
    const afterTitleWithoutCode = stripCodeBlocks(afterTitle);
    const evidence = extractEvidence(afterTitle) ?? extractInlineHeadingEvidence(title);

    findings.push({
      id: `claude-${uuidv4().slice(0, 8)}`,
      severity,
      title: title.substring(0, 200),
      description: extractDescription(afterTitleWithoutCode) || evidence || title,
      source: 'claude-agent',
      confidence: severityToConfidence(severity),
      evidence: evidence ? [{ text: evidence }] : undefined,
      recommendations: extractRecommendations(afterTitle),
    });
  }

  return findings;
}

/**
 * Extract Finding objects from an invoke_skill tool result.
 */
export function extractFindingsFromSkillResult(skillResult: any): Finding[] {
  const findings: Finding[] = [];
  if (!skillResult?.success) return findings;

  if (Array.isArray(skillResult.diagnostics)) {
    for (const diag of skillResult.diagnostics) {
      findings.push({
        id: `skill-${uuidv4().slice(0, 8)}`,
        severity: mapDiagnosticSeverity(diag.severity || diag.level),
        title: diag.title || diag.condition || 'Skill diagnostic',
        description: diag.description || diag.message || '',
        source: `skill:${skillResult.skillId || 'unknown'}`,
        confidence: diag.confidence ?? 0.8,
        details: diag.details,
      });
    }
  }

  return findings;
}

/**
 * Merge findings from multiple sources, deduplicating by title and sorting by severity.
 */
export function mergeFindings(sources: Finding[][]): Finding[] {
  const merged: Finding[] = [];
  const seenTitles = new Set<string>();

  for (const source of sources) {
    for (const finding of source) {
      const normalizedTitle = finding.title.toLowerCase().trim();
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        merged.push(finding);
      }
    }
  }

  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, warning: 2, medium: 3, low: 4, info: 5,
  };
  merged.sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

  return merged;
}

function extractDescription(text: string): string {
  const descMatch = text.match(/(?:描述[：:]|Description:)\s*(.+?)(?=\n(?:证据|建议|Evidence|Suggestion|\*\*\[)|$)/s);
  if (descMatch) return descMatch[1].trim().substring(0, 500);

  const firstLine = text.split('\n').find(l => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !isListMarkerFragment(trimmed);
  });
  return firstLine?.trim().substring(0, 500) || '';
}

function isListMarkerFragment(text: string): boolean {
  return /^(?:[-*+]|\d+[.)])\s*\*{0,2}$/.test(text);
}

function extractEvidence(text: string): string | undefined {
  const labelPrefix = String.raw`\*{0,2}`;
  const labelSuffix = String.raw`\*{0,2}\s*[：:]`;
  // Try explicit "证据:" or "Evidence:" label first
  const explicit = text.match(new RegExp(
    `(?:${labelPrefix}证据(?:类型\\s*[/／]\\s*置信度|来源|链)?${labelSuffix}|${labelPrefix}Evidence(?:\\s*(?:Type\\s*[/／]\\s*Confidence|Sources?|Chain))?${labelSuffix})\\s*(.+?)(?=\\n(?:建议|Suggestion|Recommendation|${labelPrefix}\\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\\])|$)`,
    'is',
  ));
  if (explicit) return explicit[1].trim().substring(0, 500);

  // Also match "根因推理链:" format (used by strategy-compliant conclusions)
  const rootCause = text.match(new RegExp(
    `(?:${labelPrefix}根因推理链${labelSuffix}|${labelPrefix}根因${labelSuffix}|${labelPrefix}Root\\s+Cause(?:\\s+Chain)?${labelSuffix})\\s*(.+?)(?=\\n(?:建议|结论|Suggestion|Recommendation|${labelPrefix}\\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\\])|$)`,
    'is',
  ));
  if (rootCause) return rootCause[1].trim().substring(0, 500);

  const fencedMetricBlock = text.match(/^\s*```[^\n]*\n([\s\S]{20,1200}?)\n```/);
  if (fencedMetricBlock && looksLikeEvidenceMetricBlock(fencedMetricBlock[1])) {
    return fencedMetricBlock[1].trim().substring(0, 500);
  }

  const markdownTable = extractMarkdownTableEvidence(text);
  if (markdownTable) return markdownTable;

  return undefined;
}

function extractInlineHeadingEvidence(title: string): string | undefined {
  const inline = title.match(/\s+[—-]\s+(.{20,})$/s);
  if (!inline) return undefined;

  const evidence = inline[1].trim();
  if (!looksLikeEvidenceMetricBlock(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function extractMarkdownTableEvidence(text: string): string | undefined {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim().length === 0) start += 1;
  if (start >= lines.length || !isMarkdownTableRow(lines[start])) return undefined;

  const separator = start + 1;
  if (!isMarkdownTableSeparatorRow(lines[separator] ?? '')) return undefined;

  const evidenceLines = [lines[start].trimEnd(), lines[separator].trimEnd()];
  let cursor = separator + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim().length === 0) break;
    if (!isMarkdownTableRow(line)) break;
    evidenceLines.push(line.trimEnd());
  }

  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;
  if (isCausalEvidenceLine(lines[cursor] ?? '')) {
    evidenceLines.push('');
    evidenceLines.push(lines[cursor].trim());
  }

  const evidence = evidenceLines.join('\n').trim();
  if (!looksLikeEvidenceMetricBlock(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function isCausalEvidenceLine(line: string): boolean {
  return /^\*{0,2}(?:因果链|根因推理链|证据|Evidence|Root\s+Cause(?:\s+Chain)?)\*{0,2}\s*[：:]/i
    .test(line.trim());
}

function looksLikeEvidenceMetricBlock(text: string): boolean {
  return /(?:帧耗时|掉帧|VSync|vsync_missed|MainThread|RenderThread|Choreographer|CPU\s*频率|CPU频率|Binder|GC|IO|FPS|frame\s*duration|evidence_ref_id|source_ref|\d+(?:\.\d+)?\s*(?:ms|%|GHz)|\d+\s*帧)/i
    .test(text);
}

function extractRecommendations(text: string): Finding['recommendations'] | undefined {
  const match = text.match(/(?:建议[：:]|Suggestion:|Recommendation:)\s*(.+?)(?=\n\*\*\[|$)/s);
  if (!match) return undefined;

  const lines = match[1].split('\n').filter(l => l.trim().length > 0);
  return lines.slice(0, 5).map((line, i) => ({
    id: `rec-${uuidv4().slice(0, 6)}`,
    text: line.replace(/^[-\d.)\s]+/, '').trim(),
    priority: i + 1,
  }));
}

function severityToConfidence(severity: Finding['severity']): number {
  const map: Record<string, number> = {
    critical: 0.95, high: 0.85, medium: 0.7, low: 0.6, warning: 0.7, info: 0.5,
  };
  return map[severity] ?? 0.5;
}

function mapDiagnosticSeverity(level: string | undefined): Finding['severity'] {
  if (!level) return 'info';
  const lower = level.toLowerCase();
  if (lower === 'error' || lower === 'critical') return 'critical';
  if (lower === 'warning' || lower === 'high') return 'high';
  if (lower === 'medium') return 'medium';
  if (lower === 'low') return 'low';
  return 'info';
}
