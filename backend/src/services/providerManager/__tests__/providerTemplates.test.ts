// SPDX-License-Identifier: AGPL-3.0-or-later

import { officialTemplates } from '../templates';
import type { ProviderTemplate, ProviderType } from '../types';

function templateFor(type: ProviderType): ProviderTemplate {
  const template = officialTemplates.find(candidate => candidate.type === type);
  if (!template) throw new Error(`Missing provider template: ${type}`);
  return template;
}

function availableModelIds(template: ProviderTemplate): Set<string> {
  return new Set(template.availableModels.map(model => model.id));
}

describe('Provider Manager templates', () => {
  it('keeps every non-empty default model selectable', () => {
    for (const template of officialTemplates) {
      if (template.availableModels.length === 0) continue;
      const ids = availableModelIds(template);
      if (template.defaultModels.primary) {
        expect(ids.has(template.defaultModels.primary)).toBe(true);
      }
      if (template.defaultModels.light) {
        expect(ids.has(template.defaultModels.light)).toBe(true);
      }
    }
  });

  it('uses cost-effective defaults while retaining flagship options', () => {
    const anthropic = templateFor('anthropic');
    expect(anthropic.defaultModels).toEqual({
      primary: 'claude-sonnet-5',
      light: 'claude-haiku-4-5',
    });
    expect(availableModelIds(anthropic).has('claude-fable-5')).toBe(true);

    const openai = templateFor('openai');
    expect(openai.defaultModels).toEqual({
      primary: 'gpt-5.4-mini',
      light: 'gpt-5.4-mini',
    });
    expect(availableModelIds(openai).has('gpt-5.5')).toBe(true);

    const deepseek = templateFor('deepseek');
    expect(deepseek.defaultModels).toEqual({
      primary: 'deepseek-v4-pro',
      light: 'deepseek-v4-flash',
    });

    const huawei = templateFor('huawei');
    expect(huawei.defaultModels).toEqual({
      primary: 'deepseek-v4-pro',
      light: 'deepseek-v4-flash',
    });
  });
});
