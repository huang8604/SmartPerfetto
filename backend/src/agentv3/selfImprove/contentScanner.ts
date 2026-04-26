// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Content scanner for review-agent-generated artifacts.
 *
 * Anything an LLM emits that ends up in the next system prompt or in tool
 * results is a trust-boundary risk: a clever payload can override the next
 * agent's instructions, leak credentials, or smuggle destructive shell/SQL.
 * Everything written under logs/skill_notes/, the negative-pattern memory,
 * and the verifier's learned-misdiagnosis store passes through `scanContent`
 * before it can influence future runs.
 *
 * The patterns deliberately err on the side of false positives — a rejected
 * note is recoverable (review agent retries or human triages); a smuggled
 * jailbreak is not.
 *
 * See docs/self-improving-design.md §9 (Trust Boundary).
 */

export const THREAT_KINDS = [
  'prompt_injection',
  'sys_prompt_override',
  'deception_hide',
  'exfil_curl',
  'sql_destructive',
  'shell_destructive',
] as const;

export type ThreatKind = (typeof THREAT_KINDS)[number];

export interface ThreatMatch {
  kind: ThreatKind;
  pattern: string;
  excerpt: string;
  position: number;
}

const EXCERPT_RADIUS = 60;

interface CompiledRule {
  kind: ThreatKind;
  re: RegExp;
}

/**
 * Each rule's regex is compiled once with the `gi` flags so `matchAll` can
 * iterate without rebuilding on every scan.
 */
const RULES: ReadonlyArray<CompiledRule> = [
  {
    kind: 'prompt_injection',
    // Supports both `ignore X instructions` and modifier chains like
    // `ignore all above instructions` observed in real jailbreak payloads.
    re: /ignore\s+(?:previous|all|above|prior)(?:\s+(?:previous|all|above|prior))*\s+instructions/gi,
  },
  { kind: 'sys_prompt_override', re: /system\s+prompt\s+override/gi },
  { kind: 'deception_hide', re: /do\s+not\s+(tell|inform|notify)\s+the\s+user/gi },
  // curl invocation interpolating a secret env var (likely exfil).
  { kind: 'exfil_curl', re: /\bcurl\b[^\n]*\$\{?\s*\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/gi },
  // Destructive SQL DDL — never legitimate inside a learning artifact.
  { kind: 'sql_destructive', re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/gi },
  // Recursive force-remove or privilege escalation.
  { kind: 'shell_destructive', re: /\b(rm|sudo|chmod|chown)\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/gi },
];

/**
 * Scan `text` for known threat patterns. Returns every match (including
 * duplicates from the same rule) so callers can decide whether to reject,
 * quarantine, or merely log.
 *
 * Empty / non-string input returns no matches; callers should treat
 * non-strings as a separate validation failure upstream.
 */
export function scanContent(text: unknown): ThreatMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches: ThreatMatch[] = [];
  for (const rule of RULES) {
    // matchAll spec copies the regex's lastIndex, so reset to 0 in case a
    // prior `test()` call (from isThreatFree) left it non-zero.
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const start = Math.max(0, m.index - EXCERPT_RADIUS);
      const end = Math.min(text.length, m.index + m[0].length + EXCERPT_RADIUS);
      matches.push({
        kind: rule.kind,
        pattern: rule.re.source,
        excerpt: text.substring(start, end),
        position: m.index,
      });
    }
  }
  return matches;
}

/**
 * Short-circuit existence check — stops at the first match instead of
 * collecting the full list. Use this when only the boolean is needed.
 */
export function isThreatFree(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return true;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) return false;
  }
  return true;
}

/**
 * Pretty-print a list of matches for log/error messages. Each match is
 * collapsed to a single line so JSONL consumers downstream parse cleanly.
 */
export function formatThreats(matches: ReadonlyArray<ThreatMatch>): string {
  if (matches.length === 0) return '';
  return matches
    .map(m => {
      const safeExcerpt = m.excerpt.replace(/\s+/g, ' ').trim();
      return `[${m.kind}@${m.position}] ${safeExcerpt}`;
    })
    .join(' | ');
}
