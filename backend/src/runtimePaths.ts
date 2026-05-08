// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';

export function backendDataPath(...segments: string[]): string {
  const root = process.env.SMARTPERFETTO_BACKEND_DATA_DIR || path.resolve(process.cwd(), 'data');
  return path.join(root, ...segments);
}

export function backendLogPath(...segments: string[]): string {
  const root = process.env.SMARTPERFETTO_BACKEND_LOG_DIR || path.resolve(process.cwd(), 'logs');
  return path.join(root, ...segments);
}
