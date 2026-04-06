// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { AdbDevice, AdbDeviceInfo, AdbDeviceState } from './types';

const execFileAsync = promisify(execFile);

export interface AdbExecOptions {
  serial?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface AdbExecResult {
  stdout: string;
  stderr: string;
}

function normalizeAdbNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('* daemon ') || trimmed.startsWith('* daemon')) return false;
      if (trimmed.includes('adb server version') && trimmed.includes("doesn't match")) return false;
      if (trimmed.includes('daemon started successfully')) return false;
      return true;
    })
    .join('\n');
}

function parseDeviceState(raw: string): AdbDeviceState {
  const s = raw.trim().toLowerCase();
  if (s === 'device') return 'device';
  if (s === 'offline') return 'offline';
  if (s === 'unauthorized') return 'unauthorized';
  if (s === 'bootloader') return 'bootloader';
  if (s === 'recovery') return 'recovery';
  if (s === 'sideload') return 'sideload';
  return 'unknown';
}

function parseAdbDevicesOutput(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  const lines = normalizeAdbNoise(output)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('List of devices attached')) continue;
    if (line.startsWith('List of device attached')) continue;
    if (line.startsWith('List of devices')) continue;
    if (line.startsWith('adb')) continue;

    // Format: <serial>\t<state> <kv...>
    const tabParts = line.split(/\s+/);
    if (tabParts.length < 2) continue;

    const serial = tabParts[0];
    const state = parseDeviceState(tabParts[1]);

    // Remaining tokens: key:value
    const extra: Record<string, string> = {};
    for (const token of tabParts.slice(2)) {
      const idx = token.indexOf(':');
      if (idx <= 0) continue;
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      if (!key || !value) continue;
      extra[key] = value;
    }

    devices.push({
      serial,
      state,
      product: extra.product,
      model: extra.model,
      device: extra.device,
      transportId: extra.transport_id || extra.transportId,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    });
  }

  return devices;
}

function parseGetpropOutput(output: string): Record<string, string> {
  const props: Record<string, string> = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(/^\[(.+?)\]: \[(.*)\]$/);
    if (!m) continue;
    const key = m[1]?.trim();
    const value = m[2] ?? '';
    if (!key) continue;
    props[key] = value;
  }
  return props;
}

export class AdbService {
  private adbPath: string;

  constructor(opts?: { adbPath?: string }) {
    this.adbPath = opts?.adbPath || process.env.ADB_PATH || 'adb';
  }

  getAdbPath(): string {
    return this.adbPath;
  }

  private async execAdb(args: string[], options: AdbExecOptions = {}): Promise<AdbExecResult> {
    const fullArgs = options.serial ? ['-s', options.serial, ...args] : args;
    const timeout = options.timeoutMs ?? 8000;
    const maxBuffer = options.maxBufferBytes ?? 10 * 1024 * 1024;
    try {
      const { stdout, stderr } = await execFileAsync(this.adbPath, fullArgs, {
        timeout,
        maxBuffer,
      });
      return {
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      };
    } catch (error: any) {
      // Preserve stdout/stderr from execFile errors for debugging.
      const stdout = error?.stdout?.toString?.() ?? '';
      const stderr = error?.stderr?.toString?.() ?? '';
      const message = error?.message ? String(error.message) : 'adb command failed';
      const wrapped = new Error(message) as any;
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      wrapped.code = error?.code;
      throw wrapped;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const { stdout, stderr } = await this.execAdb(['version'], { timeoutMs: 3000 });
      const merged = normalizeAdbNoise([stdout, stderr].filter(Boolean).join('\n')).trim();
      const firstLine = merged.split('\n')[0]?.trim();
      return firstLine || null;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      return null;
    }
  }

  async isInstalled(): Promise<boolean> {
    const v = await this.getVersion();
    return !!v;
  }

  async listDevices(): Promise<AdbDevice[]> {
    const { stdout, stderr } = await this.execAdb(['devices', '-l'], { timeoutMs: 5000 });
    const merged = [stdout, stderr].filter(Boolean).join('\n');
    return parseAdbDevicesOutput(merged);
  }

  async shell(serial: string, command: string, options: AdbExecOptions = {}): Promise<string> {
    const { stdout, stderr } = await this.execAdb(['shell', command], {
      serial,
      timeoutMs: options.timeoutMs ?? 8000,
      maxBufferBytes: options.maxBufferBytes,
    });
    const merged = [stdout, stderr].filter(Boolean).join('\n');
    return merged.trim();
  }

  async getAllProps(serial: string): Promise<Record<string, string>> {
    const out = await this.shell(serial, 'getprop', { timeoutMs: 8000, maxBufferBytes: 10 * 1024 * 1024 });
    return parseGetpropOutput(out);
  }

  async getDeviceInfo(serial: string): Promise<AdbDeviceInfo> {
    const props = await this.getAllProps(serial);
    const manufacturer = props['ro.product.manufacturer'];
    const brand = props['ro.product.brand'];
    const model = props['ro.product.model'];
    const device = props['ro.product.device'];
    const product = props['ro.product.name'] || props['ro.product.product.name'];
    const buildFingerprint = props['ro.build.fingerprint'];
    const buildId = props['ro.build.id'];
    const androidVersion = props['ro.build.version.release'];
    const sdkIntRaw = props['ro.build.version.sdk'];
    const sdkInt = sdkIntRaw ? Number.parseInt(sdkIntRaw, 10) : undefined;

    const isEmulator =
      props['ro.kernel.qemu'] === '1' ||
      props['ro.boot.qemu'] === '1' ||
      serial.startsWith('emulator-');

    // Root detection is best-effort and non-fatal.
    let isRooted: boolean | undefined = undefined;
    try {
      const idOut = await this.shell(serial, 'id', { timeoutMs: 3000 });
      if (idOut.includes('uid=0(') || idOut.includes('uid=0 ')) {
        isRooted = true;
      } else {
        // Try su if present (may fail/hang on non-rooted devices).
        try {
          const suOut = await this.shell(serial, 'su -c id', { timeoutMs: 3000 });
          isRooted = suOut.includes('uid=0(') || suOut.includes('uid=0 ');
        } catch {
          isRooted = false;
        }
      }
    } catch {
      // Unknown; leave undefined.
    }

    return {
      serial,
      manufacturer,
      brand,
      model,
      device,
      product,
      buildFingerprint,
      buildId,
      androidVersion,
      sdkInt: Number.isFinite(sdkInt as any) ? (sdkInt as number) : undefined,
      isEmulator,
      isRooted,
      props,
    };
  }

  async pull(serial: string, remotePath: string, localPath: string, options: AdbExecOptions = {}): Promise<void> {
    await this.execAdb(['pull', remotePath, localPath], { serial, timeoutMs: options.timeoutMs ?? 120000 });
  }

  async push(serial: string, localPath: string, remotePath: string, options: AdbExecOptions = {}): Promise<void> {
    await this.execAdb(['push', localPath, remotePath], { serial, timeoutMs: options.timeoutMs ?? 120000 });
  }
}

let singleton: AdbService | null = null;

export function getAdbService(): AdbService {
  if (!singleton) singleton = new AdbService();
  return singleton;
}