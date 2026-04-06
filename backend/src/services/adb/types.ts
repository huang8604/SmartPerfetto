// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type AdbDeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'bootloader'
  | 'recovery'
  | 'sideload'
  | 'unknown';

export interface AdbDevice {
  serial: string;
  state: AdbDeviceState;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
  extra?: Record<string, string>;
}

export interface AdbDeviceInfo {
  serial: string;
  manufacturer?: string;
  brand?: string;
  model?: string;
  device?: string;
  product?: string;
  buildFingerprint?: string;
  buildId?: string;
  androidVersion?: string;
  sdkInt?: number;
  isEmulator?: boolean;
  isRooted?: boolean;
  props?: Record<string, string>;
}

export type AdbCollaborationMode = 'off' | 'auto' | 'read_only' | 'full';

export interface AdbCollaborationConfig {
  mode?: AdbCollaborationMode;
  serial?: string;
  /**
   * Whether to require a trace↔device match to enable ADB in `auto` mode.
   * Defaults to true.
   */
  requireTraceMatch?: boolean;
}

export interface AdbAvailability {
  installed: boolean;
  version?: string;
  devices: AdbDevice[];
  selectedSerial?: string;
  problems?: string[];
}

export interface TraceDeviceProfile {
  buildFingerprint?: string;
  manufacturer?: string;
  brand?: string;
  model?: string;
  device?: string;
  product?: string;
  androidVersion?: string;
  sdkInt?: number;
  buildId?: string;
}

export interface TraceDeviceMatch {
  status: 'unknown' | 'match' | 'mismatch';
  confidence: number; // 0..1
  reasons: string[];
  trace: TraceDeviceProfile;
  device?: Pick<
    AdbDeviceInfo,
    | 'serial'
    | 'buildFingerprint'
    | 'manufacturer'
    | 'brand'
    | 'model'
    | 'device'
    | 'product'
    | 'androidVersion'
    | 'sdkInt'
    | 'buildId'
  >;
}

export interface AdbContext {
  mode: AdbCollaborationMode;
  enabled: boolean;
  availability: AdbAvailability;
  deviceInfo?: AdbDeviceInfo;
  traceMatch?: TraceDeviceMatch;
  warnings: string[];
}