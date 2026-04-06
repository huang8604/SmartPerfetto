// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import os from 'os';
import { getAdbService } from './adbService';
import {
  AdbCollaborationConfig,
  AdbCollaborationMode,
  AdbContext,
  AdbDevice,
} from './types';
import { getTraceDeviceProfile, matchTraceToDevice } from './traceDeviceMatcher';

function normalizeMode(mode?: string): AdbCollaborationMode {
  const m = (mode || '').trim().toLowerCase();
  if (m === 'off' || m === 'false' || m === '0' || m === 'disabled') return 'off';
  if (m === 'auto') return 'auto';
  if (m === 'read_only' || m === 'readonly' || m === 'read-only') return 'read_only';
  if (m === 'full' || m === 'write' || m === 'rw') return 'full';
  return 'auto';
}

function resolveConfig(input?: AdbCollaborationConfig): {
  mode: AdbCollaborationMode;
  serial?: string;
  requireTraceMatch: boolean;
} {
  const envMode = process.env.SMARTPERFETTO_ADB_MODE;
  const envSerial = process.env.SMARTPERFETTO_ADB_SERIAL;
  const envRequireMatch = process.env.SMARTPERFETTO_ADB_REQUIRE_TRACE_MATCH;

  const mode = normalizeMode(input?.mode || envMode);
  const serial = (input?.serial || envSerial || '').trim() || undefined;
  const requireTraceMatch =
    typeof input?.requireTraceMatch === 'boolean'
      ? input.requireTraceMatch
      : (envRequireMatch ? !['0', 'false', 'no'].includes(envRequireMatch.trim().toLowerCase()) : true);

  return { mode, serial, requireTraceMatch };
}

export async function detectAdbContext(
  config: AdbCollaborationConfig | undefined,
  traceProcessorService: any | undefined,
  traceId: string
): Promise<AdbContext> {
  const resolved = resolveConfig(config);
  const adb = getAdbService();

  const warnings: string[] = [];
  const problems: string[] = [];

  const version = await adb.getVersion();
  const installed = !!version;

  if (!installed) {
    return {
      mode: resolved.mode,
      enabled: false,
      availability: { installed: false, devices: [], problems: ['adb 未安装或不可用'] },
      warnings: [],
    };
  }

  let devices: AdbDevice[] = [];
  try {
    devices = await adb.listDevices();
  } catch (e: any) {
    problems.push(`adb devices 失败: ${e?.message || 'unknown error'}`);
    devices = [];
  }

  const deviceCandidates = devices.filter((d) => d.state === 'device');
  let selectedSerial: string | undefined = undefined;

  if (resolved.serial) {
    const exists = devices.some((d) => d.serial === resolved.serial);
    if (exists) {
      selectedSerial = resolved.serial;
    } else {
      warnings.push(`指定的 adb serial 未找到: ${resolved.serial}`);
    }
  } else if (deviceCandidates.length === 1) {
    selectedSerial = deviceCandidates[0].serial;
  } else if (deviceCandidates.length > 1) {
    warnings.push(`检测到多个设备 (${deviceCandidates.length})，需要指定 adb serial 才能启用协同`);
  } else {
    // No usable device.
  }

  const availability = {
    installed,
    version: version || undefined,
    devices,
    selectedSerial,
    problems: problems.length > 0 ? problems : undefined,
  };

  // Mode=off: we still report availability but don't fetch more.
  if (resolved.mode === 'off') {
    return {
      mode: resolved.mode,
      enabled: false,
      availability,
      warnings,
    };
  }

  let deviceInfo = undefined;
  let traceMatch = undefined;

  if (selectedSerial) {
    try {
      deviceInfo = await adb.getDeviceInfo(selectedSerial);
    } catch (e: any) {
      warnings.push(`获取设备信息失败: ${e?.message || 'unknown error'}`);
    }
  }

  // Compute trace match (best-effort).
  if (deviceInfo) {
    try {
      const traceProfile = await getTraceDeviceProfile(traceProcessorService, traceId);
      traceMatch = matchTraceToDevice(traceProfile, deviceInfo);
    } catch (e: any) {
      warnings.push(`trace/device 匹配失败: ${e?.message || 'unknown error'}`);
    }
  }

  // Decide whether ADB collaboration is enabled.
  let enabled = false;
  if (selectedSerial) {
    if (resolved.mode === 'full' || resolved.mode === 'read_only') {
      enabled = true;
    } else if (resolved.mode === 'auto') {
      if (!resolved.requireTraceMatch) {
        enabled = true;
      } else if (traceMatch?.status === 'match' && traceMatch.confidence >= 0.7) {
        enabled = true;
      } else if (traceMatch?.status === 'mismatch') {
        enabled = false;
        warnings.push('自动模式下检测到 trace/device 不匹配，已禁用 adb 协同');
      } else {
        enabled = false;
        warnings.push('自动模式下无法确认 trace/device 匹配，已禁用 adb 协同（可手动开启 read_only/full）');
      }
    }
  }

  // Provide a hint about host OS (useful for debugging ADB availability).
  if (process.env.NODE_ENV !== 'production') {
    warnings.push(`host=${os.platform()} adb=${adb.getAdbPath()}`);
  }

  return {
    mode: resolved.mode,
    enabled,
    availability,
    deviceInfo,
    traceMatch,
    warnings,
  };
}