// SPDX-License-Identifier: AGPL-3.0-or-later

const NUMERIC_ABSOLUTE_TOLERANCE = 1e-3;
const NUMERIC_RELATIVE_TOLERANCE = 1e-6;

export function evidenceValuesMatch(expected: unknown, actual: unknown): boolean {
  if (actual === undefined) return false;
  if (expected === actual) return true;

  const expectedNumber = typeof expected === 'number' ? expected : Number(expected);
  const actualNumber = typeof actual === 'number' ? actual : Number(actual);
  if (Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) {
    const diff = Math.abs(expectedNumber - actualNumber);
    const scale = Math.max(1, Math.abs(expectedNumber), Math.abs(actualNumber));
    return diff <= Math.max(
      NUMERIC_ABSOLUTE_TOLERANCE,
      NUMERIC_RELATIVE_TOLERANCE * scale,
    );
  }

  return String(expected) === String(actual);
}
