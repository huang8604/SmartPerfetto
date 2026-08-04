// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {bootstrap} from '../bootstrap';
import {getAndroidInternalsPackStatus} from '../../services/androidInternalsPack/knowledgePackStatus';
import {updateAndroidInternalsPack} from '../../services/androidInternalsPack/knowledgePackUpdater';

export interface KnowledgePackCommandArgs {
  envFile?: string;
  sessionDir?: string;
  format?: 'text' | 'json';
}

export async function runKnowledgePackStatusCommand(
  args: KnowledgePackCommandArgs,
): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false});
  const status = getAndroidInternalsPackStatus();
  if (args.format === 'json') {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`Android Internals Knowledge Pack: ${status.availability}`);
    if (status.active) {
      console.log(`version      ${status.active.contentVersion}`);
      console.log(`fingerprint  ${status.active.contentFingerprint}`);
      console.log(`source       ${status.active.sourceRevision}`);
      console.log(`origin       ${status.active.origin}`);
    }
    console.log(`license      ${status.licenseExpression}`);
    if (status.attribution) console.log(`attribution  ${status.attribution}`);
    if (status.lastError) console.log(`last error   ${status.lastError}`);
  }
  return status.availability === 'available' || status.availability === 'disabled' ? 0 : 1;
}

export async function runKnowledgePackUpdateCommand(
  args: KnowledgePackCommandArgs & {checkOnly?: boolean},
): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false});
  try {
    const result = await updateAndroidInternalsPack({checkOnly: args.checkOnly});
    if (args.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Knowledge Pack update: ${result.status}`);
      if (result.previousVersion) console.log(`previous  ${result.previousVersion}`);
      if (result.contentVersion) console.log(`current   ${result.contentVersion}`);
      if (result.contentFingerprint) console.log(`hash      ${result.contentFingerprint}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.format === 'json') {
      console.log(JSON.stringify({status: 'error', error: message}, null, 2));
    } else {
      console.error(`Knowledge Pack update failed: ${message}`);
    }
    return 1;
  }
}
