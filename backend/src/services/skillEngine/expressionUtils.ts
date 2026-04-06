// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Expression Utilities
 *
 * Shared helpers for extracting variable references from JS/condition expressions.
 * Used by skillValidator (load-time checks), skillExecutor (runtime evaluation),
 * and CLI validate command.
 */

/**
 * JavaScript built-in identifiers that should be ignored when extracting
 * user-defined variable references from condition expressions.
 */
export const JS_BUILTINS = new Set([
  // Literals & keywords
  'true', 'false', 'null', 'undefined',
  'if', 'else', 'return', 'function', 'var', 'let', 'const',
  'new', 'this', 'typeof', 'instanceof', 'in', 'of',
  'for', 'while', 'do', 'break', 'continue',
  'switch', 'case', 'default',
  'try', 'catch', 'finally', 'throw',
  'async', 'await', 'class', 'extends', 'super',
  'import', 'export', 'void', 'delete', 'yield',
  // Built-in globals
  'NaN', 'Infinity', 'Math', 'JSON', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Map', 'Set',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'console', 'window', 'globalThis',
]);

/**
 * Extract root variable names from a JS-like expression string.
 *
 * Examples:
 *   "performance_summary.data[0]?.app_jank_rate > 10" => ["performance_summary"]
 *   "jank_stats.data.find(j => j.jank_type)"          => ["jank_stats", "j"]
 *   "typeof foo !== 'undefined' && bar > 0"            => ["foo", "bar"]
 *
 * Variables that appear after a `.` (property access) are filtered out.
 * JS keywords and built-in globals are excluded via {@link JS_BUILTINS}.
 */
export function extractRootVariables(expr: string): string[] {
  // Strip string literals to avoid false positives from identifiers inside quotes
  // e.g. status === 'available' → status === ''
  const stripped = expr.replace(/'[^']*'|"[^"]*"/g, '""');

  const varNames = new Set<string>();
  const identifierRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;

  let match;
  while ((match = identifierRegex.exec(stripped)) !== null) {
    const name = match[1];
    if (JS_BUILTINS.has(name)) continue;

    // Skip if preceded by `.` (property access, not a root variable)
    const beforeMatch = stripped.substring(0, match.index);
    const lastChar = beforeMatch.trim().slice(-1);
    if (lastChar === '.') continue;

    varNames.add(name);
  }

  return Array.from(varNames);
}