// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Deterministic retrieval tokens shared by the legacy scorer and enterprise
 * FTS index. Keep the full identifier for exact-ish matches while also
 * expanding Java/Kotlin/C++ naming conventions into natural-language terms.
 */
export function tokenizeRagText(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const token = value.normalize('NFKC').toLowerCase();
    if (token.length < 2 || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  const normalized = text.normalize('NFKC');
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const runs: Array<{han: boolean; value: string}> = [];
    for (const character of Array.from(match[0])) {
      const han = /^\p{Script=Han}$/u.test(character);
      const previous = runs[runs.length - 1];
      if (previous?.han === han) previous.value += character;
      else runs.push({han, value: character});
    }

    for (const run of runs) {
      if (run.han) {
        const characters = Array.from(run.value);
        if (characters.length === 1) {
          const token = characters[0];
          if (!seen.has(token)) {
            seen.add(token);
            tokens.push(token);
          }
        }
        for (let index = 0; index < characters.length - 1; index++) {
          add(`${characters[index]}${characters[index + 1]}`);
        }
        continue;
      }

      add(run.value);
      for (const underscorePart of run.value.split('_').filter(Boolean)) {
        const camelParts = underscorePart
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z\d])([A-Z])/g, '$1 $2')
          .replace(/([A-Za-z])(\d)/g, '$1 $2')
          .replace(/(\d)([A-Za-z])/g, '$1 $2')
          .split(/\s+/)
          .filter(Boolean);
        for (const part of camelParts) add(part);
      }
    }
  }
  return tokens;
}

export function buildRagSearchTokenText(record: {
  snippet?: string;
  title?: string;
  symbol?: string;
  filePath?: string;
  uri?: string;
}): string {
  return tokenizeRagText([
    record.snippet,
    record.title,
    record.symbol,
    record.filePath,
    record.uri,
  ].filter((value): value is string => typeof value === 'string').join('\n')).join(' ');
}
