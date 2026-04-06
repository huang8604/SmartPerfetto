// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Analysis Pattern Memory — cross-session long-term memory for analysis insights.
 *
 * After each successful analysis, extracts trace feature fingerprints and key insights,
 * then persists them to disk. On new analyses, matches similar patterns and injects
 * relevant insights into the system prompt.
 *
 * P1 enhancements:
 * - Weighted tag matching (arch/scene weighted higher than finding titles)
 * - Confidence decay over time (exponential decay, not binary TTL)
 * - Negative memory: records what strategies FAILED for similar traces
 *
 * Storage: backend/logs/analysis_patterns.json (200 entry max, 60-day TTL)
 * Negative: backend/logs/analysis_negative_patterns.json (100 entry max, 90-day TTL)
 * Matching: Weighted Jaccard similarity on trace features
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Finding } from '../agent/types';
import type { AnalysisPatternEntry, NegativePatternEntry, FailedApproach } from './types';

const PATTERNS_FILE = path.resolve(__dirname, '../../logs/analysis_patterns.json');
const NEGATIVE_PATTERNS_FILE = path.resolve(__dirname, '../../logs/analysis_negative_patterns.json');
const MAX_PATTERNS = 200;
const MAX_NEGATIVE_PATTERNS = 100;
const PATTERN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const NEGATIVE_PATTERN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — negative memory persists longer
const MIN_MATCH_SCORE = 0.25; // Minimum weighted similarity to consider a match
const MAX_MATCHED_PATTERNS = 3; // Max patterns to inject into prompt
const MAX_MATCHED_NEGATIVE = 3; // Max negative patterns to inject

/**
 * Tag category weights for weighted Jaccard similarity.
 * Higher weight = more influence on similarity score.
 *
 * Rationale: arch + scene determine the analysis path (highest weight).
 * Domain (app family) moderately matters. Finding categories are medium.
 * Individual finding titles have low weight (too specific, may not generalize).
 */
const TAG_WEIGHTS: Record<string, number> = {
  'arch': 3.0,    // Architecture type is the strongest signal
  'scene': 3.0,   // Scene type is equally strong
  'domain': 2.0,  // App family (tencent/google/etc.)
  'cat': 1.5,     // Finding categories (GPU, CPU, etc.)
  'finding': 0.5, // Individual finding titles (too specific)
};
const DEFAULT_WEIGHT = 1.0;

/** Extract the category prefix from a tag (e.g., "arch:FLUTTER" → "arch"). */
function tagCategory(tag: string): string {
  const idx = tag.indexOf(':');
  return idx > 0 ? tag.substring(0, idx) : '';
}

/** Get the weight for a tag based on its category. */
function tagWeight(tag: string): number {
  return TAG_WEIGHTS[tagCategory(tag)] ?? DEFAULT_WEIGHT;
}

/**
 * Confidence decay factor based on pattern age.
 * Uses exponential decay with a half-life of 30 days.
 * A 60-day-old pattern retains 25% of its original confidence.
 */
function confidenceDecay(createdAt: number): number {
  const ageMs = Date.now() - createdAt;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * P1-G10: Combined eviction score for pattern retention.
 * Balances recency (confidence decay) with frequency (match count).
 * A highly-matched old pattern retains priority over a new single-match pattern.
 *
 * Score examples (matchCount, age → score):
 *   (0, 0d) → 1.0,  (10, 0d) → 4.46,  (0, 30d) → 0.5,  (10, 30d) → 2.23
 */
function evictionScore(p: { createdAt: number; matchCount: number }): number {
  return confidenceDecay(p.createdAt) * (1 + Math.log2(1 + p.matchCount));
}

/** Load patterns from disk. */
function loadPatterns(): AnalysisPatternEntry[] {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return [];
    const data = fs.readFileSync(PATTERNS_FILE, 'utf-8');
    return JSON.parse(data) as AnalysisPatternEntry[];
  } catch {
    return [];
  }
}

/** Load negative patterns from disk. */
function loadNegativePatterns(): NegativePatternEntry[] {
  try {
    if (!fs.existsSync(NEGATIVE_PATTERNS_FILE)) return [];
    const data = fs.readFileSync(NEGATIVE_PATTERNS_FILE, 'utf-8');
    return JSON.parse(data) as NegativePatternEntry[];
  } catch {
    return [];
  }
}

/** Save patterns to disk (atomic write). */
async function savePatterns(patterns: AnalysisPatternEntry[]): Promise<void> {
  try {
    const dir = path.dirname(PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = PATTERNS_FILE + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmpFile, PATTERNS_FILE);
  } catch (err) {
    console.warn('[PatternMemory] Failed to save patterns:', (err as Error).message);
  }
}

/** Save negative patterns to disk (atomic write). */
async function saveNegativePatterns(patterns: NegativePatternEntry[]): Promise<void> {
  try {
    const dir = path.dirname(NEGATIVE_PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = NEGATIVE_PATTERNS_FILE + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmpFile, NEGATIVE_PATTERNS_FILE);
  } catch (err) {
    console.warn('[PatternMemory] Failed to save negative patterns:', (err as Error).message);
  }
}

/**
 * Weighted Jaccard similarity between two tag sets.
 * Each tag contributes its category weight to the intersection/union calculation.
 */
function weightedJaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionWeight = 0;
  let unionWeight = 0;

  const allTags = new Set([...setA, ...setB]);
  for (const tag of allTags) {
    const w = tagWeight(tag);
    const inA = setA.has(tag);
    const inB = setB.has(tag);
    unionWeight += w;
    if (inA && inB) intersectionWeight += w;
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

/**
 * Extract trace feature fingerprint from analysis context.
 * Used for similarity matching across sessions.
 */
export function extractTraceFeatures(context: {
  architectureType?: string;
  sceneType?: string;
  packageName?: string;
  findingTitles?: string[];
  findingCategories?: string[];
}): string[] {
  const features: string[] = [];

  if (context.architectureType) features.push(`arch:${context.architectureType}`);
  if (context.sceneType) features.push(`scene:${context.sceneType}`);
  if (context.packageName) {
    // Extract app domain from package name (e.g. "com.tencent.mm" → "tencent")
    const parts = context.packageName.split('.');
    if (parts.length >= 2) features.push(`domain:${parts[1]}`);
  }

  // Add finding categories and key titles as features
  if (context.findingCategories) {
    for (const cat of new Set(context.findingCategories)) {
      features.push(`cat:${cat}`);
    }
  }
  if (context.findingTitles) {
    for (const title of context.findingTitles.slice(0, 5)) {
      // Normalize: take first significant words
      const normalized = title.replace(/[^\w\u4e00-\u9fff]/g, ' ').trim().substring(0, 30);
      if (normalized) features.push(`finding:${normalized}`);
    }
  }

  return features;
}

/**
 * Extract key insights from analysis findings and conclusion.
 * These are the patterns worth remembering across sessions.
 */
export function extractKeyInsights(
  findings: Finding[],
  conclusion: string,
): string[] {
  const insights: string[] = [];

  // Extract CRITICAL/HIGH findings with root cause as insights
  const important = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  for (const f of important.slice(0, 5)) {
    const insight = `${f.title}: ${f.description?.substring(0, 150) || ''}`;
    insights.push(insight);
  }

  // Extract key patterns from conclusion (look for root cause statements)
  const rootCauseMatch = conclusion.match(/根因[：:]\s*([^\n]{10,150})/);
  if (rootCauseMatch) {
    insights.push(`根因: ${rootCauseMatch[1]}`);
  }

  return insights;
}

/**
 * Save an analysis pattern to persistent storage.
 * Call after a successful analysis to build long-term memory.
 */
export async function saveAnalysisPattern(
  features: string[],
  insights: string[],
  sceneType: string,
  architectureType?: string,
  confidence?: number,
): Promise<void> {
  if (features.length === 0 || insights.length === 0) return;

  const patterns = loadPatterns();

  // Deduplicate: check if a very similar pattern already exists (>70% similarity)
  const existingIdx = patterns.findIndex(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

  if (existingIdx >= 0) {
    // Update existing pattern: merge insights, bump match count
    const existing = patterns[existingIdx];
    const uniqueInsights = new Set([...existing.keyInsights, ...insights]);
    existing.keyInsights = Array.from(uniqueInsights).slice(0, 10);
    existing.matchCount++;
    existing.createdAt = Date.now(); // Refresh timestamp
    if (confidence !== undefined) existing.confidence = confidence;
  } else {
    // Create new pattern
    const id = `pat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    patterns.push({
      id,
      traceFeatures: features,
      sceneType,
      keyInsights: insights.slice(0, 10),
      architectureType,
      confidence: confidence ?? 0.5,
      createdAt: Date.now(),
      matchCount: 0,
    });
  }

  // Prune expired + enforce max size (P1-G10: frequency-aware eviction)
  const cutoff = Date.now() - PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => evictionScore(b) - evictionScore(a))
    .slice(0, MAX_PATTERNS);

  await savePatterns(active);
}

/**
 * Save a negative pattern — records what strategies FAILED for similar traces.
 * Call after watchdog triggers, verification failures, or persistent tool errors.
 */
export async function saveNegativePattern(
  features: string[],
  failedApproaches: FailedApproach[],
  sceneType: string,
  architectureType?: string,
): Promise<void> {
  if (features.length === 0 || failedApproaches.length === 0) return;

  const patterns = loadNegativePatterns();

  // Deduplicate: merge into existing pattern if >70% similar
  const existingIdx = patterns.findIndex(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

  if (existingIdx >= 0) {
    const existing = patterns[existingIdx];
    // Merge approaches, dedup by type+approach key
    const existingKeys = new Set(existing.failedApproaches.map(a => `${a.type}:${a.approach}`));
    for (const approach of failedApproaches) {
      const key = `${approach.type}:${approach.approach}`;
      if (!existingKeys.has(key)) {
        existing.failedApproaches.push(approach);
        existingKeys.add(key);
      }
    }
    // Cap at 10 approaches per pattern
    existing.failedApproaches = existing.failedApproaches.slice(-10);
    existing.matchCount++;
    existing.createdAt = Date.now();
  } else {
    const id = `neg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    patterns.push({
      id,
      traceFeatures: features,
      sceneType,
      failedApproaches: failedApproaches.slice(0, 10),
      architectureType,
      createdAt: Date.now(),
      matchCount: 0,
    });
  }

  // Prune expired + enforce max size (P1-G10: frequency-aware eviction)
  const cutoff = Date.now() - NEGATIVE_PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => evictionScore(b) - evictionScore(a))
    .slice(0, MAX_NEGATIVE_PATTERNS);

  await saveNegativePatterns(active);
}

/**
 * Find patterns similar to the current trace features.
 * Returns matched patterns sorted by effective score (similarity × decay).
 */
export function matchPatterns(features: string[]): Array<AnalysisPatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadPatterns();
  const cutoff = Date.now() - PATTERN_TTL_MS;

  return patterns
    .filter(p => p.createdAt >= cutoff)
    .map(p => {
      const rawSimilarity = weightedJaccardSimilarity(p.traceFeatures, features);
      const decay = confidenceDecay(p.createdAt);
      // P2-G20: matchCount as log-scaled gain factor — frequently matched patterns rank higher
      // log2(1 + matchCount) gives: 0→1.0, 1→1.0, 2→1.58, 5→2.58, 10→3.46
      const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
      return {
        ...p,
        score: rawSimilarity * decay * frequencyGain,
      };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_PATTERNS);
}

/**
 * Find negative patterns similar to the current trace features.
 * Negative patterns persist longer (90 days) and use the same weighted matching.
 */
export function matchNegativePatterns(features: string[]): Array<NegativePatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadNegativePatterns();
  const cutoff = Date.now() - NEGATIVE_PATTERN_TTL_MS;

  return patterns
    .filter(p => p.createdAt >= cutoff)
    .map(p => {
      const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
      return {
        ...p,
        score: weightedJaccardSimilarity(p.traceFeatures, features) * confidenceDecay(p.createdAt) * frequencyGain,
      };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_NEGATIVE);
}

/**
 * Build a system prompt section from matched patterns.
 * Provides cross-session context to Claude.
 */
export function buildPatternContextSection(features: string[]): string | undefined {
  const matches = matchPatterns(features);
  if (matches.length === 0) return undefined;

  const lines = matches.map((m, i) => {
    const insightText = m.keyInsights.slice(0, 3).map(ins => `  - ${ins}`).join('\n');
    const decayPct = (confidenceDecay(m.createdAt) * 100).toFixed(0);
    return `${i + 1}. **${m.sceneType}${m.architectureType ? ` (${m.architectureType})` : ''}** (相似度 ${(m.score * 100).toFixed(0)}%, 信心 ${decayPct}%, 匹配 ${m.matchCount + 1} 次)\n${insightText}`;
  });

  return `## 历史分析经验（跨会话记忆）

以下是过往类似 trace 的分析经验，供参考（不一定适用于当前 trace）：

${lines.join('\n\n')}

> 这些经验来自之前的分析会话。如果当前 trace 的数据与历史经验矛盾，以当前数据为准。`;
}

/**
 * Build a system prompt section from matched negative patterns.
 * Warns Claude about strategies that previously FAILED for similar traces.
 */
export function buildNegativePatternSection(features: string[]): string | undefined {
  const matches = matchNegativePatterns(features);
  if (matches.length === 0) return undefined;

  const lines: string[] = [];
  for (const m of matches) {
    for (const a of m.failedApproaches.slice(0, 3)) {
      const workaround = a.workaround ? ` → 替代方案: ${a.workaround}` : '';
      lines.push(`- **避免**: ${a.approach} — ${a.reason}${workaround}`);
    }
  }

  // Deduplicate lines
  const uniqueLines = [...new Set(lines)].slice(0, 6);
  if (uniqueLines.length === 0) return undefined;

  return `## 历史踩坑记录（避免重复失败）

以下策略在类似 trace 的分析中**失败过**，请优先尝试其他方案：

${uniqueLines.join('\n')}

> 这些是跨会话积累的失败经验。如果没有替代方案，可以谨慎尝试，但请准备 fallback 策略。`;
}