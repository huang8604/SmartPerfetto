// backend/src/services/providerManager/index.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'path';
import { ProviderService } from './providerService';
import { officialTemplates } from './templates';

export type { ProviderConfig, ProviderCreateInput, ProviderUpdateInput, OfficialProviderTemplate, ModelOption, TestResult, ProviderType } from './types';
export { ProviderService } from './providerService';
export { ProviderStore } from './providerStore';
export { officialTemplates } from './templates';

const dataDir = process.env.PROVIDER_DATA_DIR_OVERRIDE || path.resolve(process.cwd(), 'data');
const PROVIDERS_FILE = path.join(dataDir, 'providers.json');

let instance: ProviderService | null = null;

export function getProviderService(): ProviderService {
  if (!instance) {
    instance = new ProviderService(PROVIDERS_FILE);
    const active = instance.list().find(p => p.isActive);
    if (active) {
      console.log(`[ProviderManager] Active: "${active.name}" (${active.type}, ${active.models.primary})`);
    } else {
      console.log('[ProviderManager] No active provider configured, using env fallback');
    }
  }
  return instance;
}
