#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const translated = ['--target', 'windows-x64'];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--zip') translated.push('--asset', args[++i]);
  else translated.push(args[i]);
}

const result = spawnSync(
  process.execPath,
  [path.join(__dirname, 'verify-portable-package.cjs'), ...translated],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
