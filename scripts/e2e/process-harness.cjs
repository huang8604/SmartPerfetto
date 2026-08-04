// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const {spawn, spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_START_TIMEOUT_MS = 120_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tailFile(filePath, maximumCharacters = 8_000) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(-maximumCharacters);
  } catch {
    return '<log unavailable>';
  }
}

function signalProcessGroup(
  tracked,
  signal,
  platform = process.platform,
  commandRunner = spawnSync,
) {
  const pid = tracked?.child?.pid;
  if (!pid) return;
  try {
    if (platform === 'win32') {
      const args = ['/PID', String(pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const result = commandRunner('taskkill', args, {
        encoding: 'utf8',
        windowsHide: true,
      });
      tracked.windowsTreeSignal = {
        signal,
        status: result.status,
        succeeded: !result.error && result.status === 0,
      };
      if (result.error) throw result.error;
      // A closed parent handle does not prove that its descendants exited.
      // Treat taskkill failure as unresolved even after the tracked child has
      // emitted close; otherwise an orphan trace_processor can be hidden.
      if (result.status !== 0) {
        throw new Error(
          `taskkill failed for PID ${pid}: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`,
        );
      }
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function signalProcessGroupBestEffort(tracked, signal) {
  try {
    signalProcessGroup(tracked, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to send ${signal} to ${tracked.label}: ${message}`);
  }
}

function isProcessGroupAlive(tracked) {
  const pid = tracked?.child?.pid;
  if (!pid) return false;
  if (process.platform === 'win32') {
    return tracked.exitResult === null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(tracked, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(tracked)) return true;
    await delay(100);
  }
  return !isProcessGroupAlive(tracked);
}

class ProcessHarness {
  constructor(artifactDir) {
    this.artifactDir = artifactDir;
    this.processes = [];
    this.receivedSignal = null;
    this.secondSignalReceived = false;
    this.signalEscalationTimer = null;
    this.signalHandler = null;
  }

  start(label, command, args, options, tee = false) {
    const logPath = path.join(this.artifactDir, `${label}.log`);
    const logStream = fs.createWriteStream(logPath, {flags: 'a', mode: 0o600});
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      logStream.write(chunk);
      if (tee) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      logStream.write(chunk);
      if (tee) process.stderr.write(chunk);
    });

    let settle;
    const result = new Promise((resolve) => {
      settle = resolve;
    });
    let settled = false;
    let spawnError = null;
    let tracked = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (tracked) tracked.exitResult = value;
      logStream.end();
      settle(value);
    };
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => finish({code, signal, error: spawnError}));
    tracked = {label, child, result, logPath, exitResult: null};
    this.processes.push(tracked);
    return tracked;
  }

  async waitForHttp(url, label, tracked, validateResponse) {
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.receivedSignal) throw new Error(`Interrupted by ${this.receivedSignal}`);
      if (tracked.exitResult) {
        throw new Error(
          `${label} exited before becoming ready.\n${tailFile(tracked.logPath)}`,
          {cause: tracked.exitResult.error || undefined},
        );
      }
      try {
        const response = await fetch(url, {signal: AbortSignal.timeout(1_500)});
        if (response.ok) return await validateResponse(response);
        lastError = new Error(`${label} returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(200);
    }
    throw new Error(
      `${label} did not become ready within ${SERVICE_START_TIMEOUT_MS} ms: ` +
      `${lastError?.message || 'unknown error'}\n${tailFile(tracked.logPath)}`,
    );
  }

  async stop(tracked) {
    if (!tracked) return;
    signalProcessGroup(tracked, 'SIGTERM');
    const graceful = await waitForProcessGroupExit(tracked, PROCESS_STOP_TIMEOUT_MS);
    if (!graceful) {
      signalProcessGroup(tracked, 'SIGKILL');
      const killed = await waitForProcessGroupExit(tracked, 2_000);
      if (!killed) throw new Error(`${tracked.label} process group did not exit after SIGKILL`);
    }
    await Promise.race([tracked.result, delay(500)]);
  }

  installSignalHandlers() {
    if (this.signalHandler) return;
    this.signalHandler = (signal) => {
      if (this.receivedSignal) {
        if (!this.secondSignalReceived) {
          this.secondSignalReceived = true;
          for (const tracked of this.processes) {
            signalProcessGroupBestEffort(tracked, 'SIGKILL');
          }
        }
        return;
      }
      this.receivedSignal = signal;
      const playwright = this.processes.find((tracked) => tracked.label === 'playwright');
      if (playwright) signalProcessGroupBestEffort(playwright, 'SIGTERM');
      this.signalEscalationTimer = setTimeout(() => {
        for (const tracked of this.processes) {
          signalProcessGroupBestEffort(tracked, 'SIGKILL');
        }
      }, PROCESS_STOP_TIMEOUT_MS);
    };
    if (process.platform !== 'win32') process.on('SIGHUP', this.signalHandler);
    process.on('SIGINT', this.signalHandler);
    process.on('SIGTERM', this.signalHandler);
  }

  disposeSignalHandlers() {
    this.cancelSignalEscalation();
    if (!this.signalHandler) return;
    if (process.platform !== 'win32') process.off('SIGHUP', this.signalHandler);
    process.off('SIGINT', this.signalHandler);
    process.off('SIGTERM', this.signalHandler);
    this.signalHandler = null;
  }

  cancelSignalEscalation() {
    if (this.signalEscalationTimer) clearTimeout(this.signalEscalationTimer);
    this.signalEscalationTimer = null;
  }

  signalExitCode() {
    if (this.receivedSignal === 'SIGHUP') return 129;
    if (this.receivedSignal === 'SIGINT') return 130;
    return this.receivedSignal ? 143 : null;
  }
}

module.exports = {ProcessHarness, signalProcessGroup};
