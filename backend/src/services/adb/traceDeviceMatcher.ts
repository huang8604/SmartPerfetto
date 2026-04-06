// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { AdbDeviceInfo, TraceDeviceMatch, TraceDeviceProfile } from './types';

type TraceProcessorServiceLike = {
  query: (traceId: string, sql: string) => Promise<{ columns: string[]; rows: any[][]; error?: string }>;
};

const METADATA_KEYS = [
  'android_build_fingerprint',
  'android_device_manufacturer',
  'android_device_brand',
  'android_device_model',
  'android_device_device',
  'android_device_product',
  'android_build_id',
  'android_sdk_version',
  'android_version',
  'android_build_version',
];

function normalizeString(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

async function queryMetadata(
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<Record<string, string>> {
  const quoted = METADATA_KEYS.map((k) => `'${k}'`).join(',');

  const attempts = [
    `SELECT name, COALESCE(str_value, CAST(int_value AS STRING)) AS value FROM metadata WHERE name IN (${quoted})`,
    `SELECT name, value FROM metadata WHERE name IN (${quoted})`,
  ];

  for (const sql of attempts) {
    try {
      const res = await tps.query(traceId, sql);
      if (res.error) throw new Error(res.error);
      const nameIdx = res.columns.findIndex((c) => c === 'name');
      const valueIdx = res.columns.findIndex((c) => c === 'value');
      if (nameIdx < 0 || valueIdx < 0) continue;
      const out: Record<string, string> = {};
      for (const row of res.rows) {
        const name = row[nameIdx];
        const value = row[valueIdx];
        if (typeof name === 'string' && (typeof value === 'string' || typeof value === 'number')) {
          out[name] = String(value);
        }
      }
      return out;
    } catch {
      // Try next attempt
    }
  }

  return {};
}

export async function getTraceDeviceProfile(
  traceProcessorService: TraceProcessorServiceLike | undefined,
  traceId: string
): Promise<TraceDeviceProfile> {
  if (!traceProcessorService) return {};

  const meta = await queryMetadata(traceProcessorService, traceId);

  const sdkIntRaw = pickFirstNonEmpty(meta['android_sdk_version']);
  const sdkInt = sdkIntRaw ? Number.parseInt(sdkIntRaw, 10) : undefined;

  return {
    buildFingerprint: pickFirstNonEmpty(meta['android_build_fingerprint']),
    manufacturer: pickFirstNonEmpty(meta['android_device_manufacturer']),
    brand: pickFirstNonEmpty(meta['android_device_brand']),
    model: pickFirstNonEmpty(meta['android_device_model']),
    device: pickFirstNonEmpty(meta['android_device_device']),
    product: pickFirstNonEmpty(meta['android_device_product']),
    buildId: pickFirstNonEmpty(meta['android_build_id']),
    sdkInt: Number.isFinite(sdkInt as any) ? (sdkInt as number) : undefined,
    androidVersion: pickFirstNonEmpty(meta['android_version'], meta['android_build_version']),
  };
}

export function matchTraceToDevice(trace: TraceDeviceProfile, device: AdbDeviceInfo): TraceDeviceMatch {
  const reasons: string[] = [];
  let confidence = 0;
  let status: TraceDeviceMatch['status'] = 'unknown';

  const traceFp = normalizeString(trace.buildFingerprint);
  const deviceFp = normalizeString(device.buildFingerprint);

  if (traceFp && deviceFp) {
    if (traceFp === deviceFp) {
      status = 'match';
      confidence = 1;
      reasons.push('build_fingerprint 一致');
    } else {
      status = 'mismatch';
      confidence = 0.05;
      reasons.push('build_fingerprint 不一致');
    }
  } else {
    // Fallback: compare manufacturer + model + sdk
    const traceModel = normalizeString(trace.model);
    const deviceModel = normalizeString(device.model);
    const traceManu = normalizeString(trace.manufacturer);
    const deviceManu = normalizeString(device.manufacturer);

    let matches = 0;
    if (traceModel && deviceModel && traceModel === deviceModel) {
      matches += 1;
      reasons.push('model 一致');
    }
    if (traceManu && deviceManu && traceManu === deviceManu) {
      matches += 1;
      reasons.push('manufacturer 一致');
    }
    if (typeof trace.sdkInt === 'number' && typeof device.sdkInt === 'number' && trace.sdkInt === device.sdkInt) {
      matches += 1;
      reasons.push('sdkInt 一致');
    }

    if (matches >= 2) {
      status = 'match';
      confidence = 0.75;
    } else if (matches === 1) {
      status = 'unknown';
      confidence = 0.4;
    } else {
      status = 'unknown';
      confidence = 0.2;
      reasons.push('trace/device 信息不足，无法确认匹配');
    }
  }

  return {
    status,
    confidence,
    reasons,
    trace,
    device: {
      serial: device.serial,
      buildFingerprint: device.buildFingerprint,
      manufacturer: device.manufacturer,
      brand: device.brand,
      model: device.model,
      device: device.device,
      product: device.product,
      androidVersion: device.androidVersion,
      sdkInt: device.sdkInt,
      buildId: device.buildId,
    },
  };
}