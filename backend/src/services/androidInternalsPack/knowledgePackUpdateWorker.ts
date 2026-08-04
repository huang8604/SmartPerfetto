// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {updateAndroidInternalsPack} from './knowledgePackUpdater';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_INTERVAL_MS = 60 * 60 * 1_000;

export interface AndroidInternalsPackUpdateWorkerHandle {
  started: boolean;
  stop(): void;
}

function intervalFromEnvironment(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.SMARTPERFETTO_AIW_PACK_UPDATE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= MINIMUM_INTERVAL_MS
    ? Math.trunc(parsed)
    : DEFAULT_INTERVAL_MS;
}

export function startAndroidInternalsPackUpdateWorker(
  env: NodeJS.ProcessEnv = process.env,
): AndroidInternalsPackUpdateWorkerHandle {
  if (
    env.SMARTPERFETTO_AIW_PACK_ENABLED === '0' ||
    env.SMARTPERFETTO_AIW_PACK_UPDATE_MODE?.toLowerCase() === 'off' ||
    env.NODE_ENV === 'test'
  ) {
    return {started: false, stop() {}};
  }
  let stopped = false;
  const check = (): void => {
    void updateAndroidInternalsPack({
      checkOnly: env.SMARTPERFETTO_AIW_PACK_UPDATE_MODE?.toLowerCase() === 'check',
    }).catch(error => {
      console.warn(
        '[AndroidInternalsPack] Background update failed; retaining current pack:',
        error instanceof Error ? error.message : error,
      );
    });
  };
  const startup = setTimeout(check, 0);
  startup.unref?.();
  const timer = setInterval(() => {
    if (!stopped) check();
  }, intervalFromEnvironment(env));
  timer.unref?.();
  return {
    started: true,
    stop() {
      stopped = true;
      clearTimeout(startup);
      clearInterval(timer);
    },
  };
}
