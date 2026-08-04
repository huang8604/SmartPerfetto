// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type OutputLanguage = 'zh-CN' | 'en';

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'zh-CN';

const OUTPUT_LANGUAGE_ALIASES = new Map<string, OutputLanguage>([
  ['cn', 'zh-CN'],
  ['chinese', 'zh-CN'],
  ['en', 'en'],
  ['english', 'en'],
  ['simplified-chinese', 'zh-CN'],
  ['simplified_chinese', 'zh-CN'],
  ['zh', 'zh-CN'],
]);

function languageFromTag(value: string): OutputLanguage | undefined {
  const tag = value.trim().toLowerCase().replace(/_/g, '-');
  const alias = OUTPUT_LANGUAGE_ALIASES.get(tag);
  if (alias) return alias;
  if (tag.startsWith('en-')) return 'en';
  if (tag.startsWith('zh-')) return 'zh-CN';
  return undefined;
}

export function parseOutputLanguage(value: unknown): OutputLanguage {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_OUTPUT_LANGUAGE;

  if (!normalized.includes(',') && !normalized.includes(';')) {
    const direct = languageFromTag(normalized);
    if (direct) return direct;
  }

  const accepted = normalized
    .split(',')
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const qualityParameter = parameters.find(parameter =>
        parameter.trim().startsWith('q='));
      const parsedQuality = qualityParameter
        ? Number(qualityParameter.trim().slice(2))
        : 1;
      return {
        index,
        language: languageFromTag(tag),
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
      };
    })
    .filter(candidate => candidate.language && candidate.quality > 0)
    .sort((left, right) =>
      right.quality - left.quality || left.index - right.index);

  if (accepted.length > 0) {
    return accepted[0].language as OutputLanguage;
  }

  return DEFAULT_OUTPUT_LANGUAGE;
}

export function outputLanguageDisplayName(language: OutputLanguage): string {
  return language === 'en' ? 'English' : '简体中文';
}

export function localize(language: OutputLanguage, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}
