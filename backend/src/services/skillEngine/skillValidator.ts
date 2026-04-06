// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Validator
 *
 * Centralized validation logic for the Skill Engine:
 *
 * 1. **validateSkillInputs()** — Runtime parameter validation against SkillInput declarations.
 *    Catches missing required params, type mismatches, and undeclared params.
 *
 * 2. **validateSkillConditions()** — Load-time condition expression checking.
 *    Verifies that all variables referenced in step `condition` fields resolve to
 *    declared inputs, prior step IDs, save_as variables, or implicit context params.
 *
 * 3. **validateFragmentReferences()** — Load-time fragment path validation.
 *    Ensures that all `sql_fragments` paths in AtomicStep definitions point to
 *    files that exist in the fragment cache.
 */

import {
  SkillDefinition,
  SkillInput,
  SkillInputValidationError,
  ValidatedParams,
} from './types';
import { extractRootVariables } from './expressionUtils';

// =============================================================================
// Validation Types
// =============================================================================

/** Warning produced by load-time validation (conditions, fragments, etc.) */
export interface SkillValidationWarning {
  stepId: string;
  message: string;
}

// =============================================================================
// 1. Runtime Input Validation
// =============================================================================

/**
 * Validate runtime parameters against a skill's declared inputs.
 *
 * - Required params that are missing → error
 * - Missing params with defaults → filled with coerced default
 * - Type coercion: number/integer/boolean/timestamp/duration/string
 * - Undeclared params (not in inputs) → warning
 * - If skill has no inputs declaration, params are passed through as-is
 */
export function validateSkillInputs(
  _skillId: string,
  inputs: SkillInput[] | undefined,
  params: Record<string, any>,
): ValidatedParams {
  // No inputs declared → pass through unchanged (backward compatible)
  if (!inputs || inputs.length === 0) {
    return { params: { ...params }, errors: [], warnings: [] };
  }

  const errors: SkillInputValidationError[] = [];
  const warnings: SkillInputValidationError[] = [];
  const validated: Record<string, any> = { ...params };
  const declaredNames = new Set(inputs.map(i => i.name));

  for (const input of inputs) {
    const { name, type, required } = input;
    let value = validated[name];

    // Missing value handling
    if (value === undefined || value === null) {
      if (input.default !== undefined) {
        value = coerceValue(name, input.default, type, errors);
        if (value !== undefined) {
          validated[name] = value;
        }
        continue;
      }
      if (required) {
        errors.push({
          paramName: name,
          message: `Required parameter missing`,
          severity: 'error',
        });
      }
      continue;
    }

    // Type coercion
    const coerced = coerceValue(name, value, type, errors);
    if (coerced !== undefined) {
      validated[name] = coerced;
    }
    // If coercion failed, the error was already pushed; keep original value
  }

  // Detect undeclared params
  for (const key of Object.keys(params)) {
    if (!declaredNames.has(key)) {
      warnings.push({
        paramName: key,
        message: `Undeclared parameter (not in skill inputs)`,
        severity: 'warning',
      });
    }
  }

  return { params: validated, errors, warnings };
}

/**
 * Coerce a value to the declared type. Returns the coerced value or undefined on failure.
 * On failure, pushes an error into the `errors` array.
 */
function coerceValue(
  name: string,
  value: any,
  type: SkillInput['type'],
  errors: SkillInputValidationError[],
): any {
  switch (type) {
    case 'number':
    case 'timestamp':
    case 'duration': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      if (isNaN(n)) {
        errors.push({
          paramName: name,
          message: `Expected ${type}, got non-numeric value: ${JSON.stringify(value)}`,
          severity: 'error',
        });
        return undefined;
      }
      return n;
    }

    case 'integer': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      const i = parseInt(String(value), 10);
      if (isNaN(i)) {
        errors.push({
          paramName: name,
          message: `Expected integer, got: ${JSON.stringify(value)}`,
          severity: 'error',
        });
        return undefined;
      }
      return i;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase().trim();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      errors.push({
        paramName: name,
        message: `Expected boolean, got: ${JSON.stringify(value)}`,
        severity: 'error',
      });
      return undefined;
    }

    case 'string': {
      if (typeof value === 'string') return value;
      // Soft coerce non-strings
      return String(value);
    }

    case 'array': {
      if (Array.isArray(value)) return value;
      errors.push({
        paramName: name,
        message: `Expected array, got ${typeof value}`,
        severity: 'error',
      });
      return undefined;
    }

    case 'object': {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      errors.push({
        paramName: name,
        message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`,
        severity: 'error',
      });
      return undefined;
    }

    default:
      // Unknown type, pass through
      return value;
  }
}

// =============================================================================
// 2. Load-time Condition Validation
// =============================================================================

/**
 * Implicit parameters always available in the execution context,
 * injected by the runtime (not declared in skill inputs).
 */
const IMPLICIT_PARAMS = new Set([
  'package', 'vendor', 'start_ts', 'end_ts', 'item',
  // Iterator context variables
  'currentItem', 'currentItemIndex',
]);

/**
 * Validate all condition expressions in a skill definition.
 *
 * For each step's `condition` field, extracts root variables and checks that
 * every variable resolves to one of:
 *   - A declared input parameter
 *   - An implicit runtime parameter (package, vendor, start_ts, etc.)
 *   - A context dependency (skill.context[])
 *   - A prior step ID (context.results[stepId])
 *   - A prior step's save_as variable
 *   - A JS built-in (filtered by extractRootVariables)
 *
 * Also validates iterator step `source` references.
 */
export function validateSkillConditions(skill: SkillDefinition): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];

  if (!skill.steps || skill.steps.length === 0) return warnings;

  // Build the set of known variable sources
  const declaredInputs = new Set(
    (skill.inputs || []).map(i => i.name)
  );
  const contextDeps = new Set(skill.context || []);
  const availableStepIds = new Set<string>();
  const availableSaveAs = new Set<string>();

  for (const step of skill.steps) {
    const stepAny = step as any;

    // Check condition expression if present
    if (typeof stepAny.condition === 'string' && stepAny.condition.trim()) {
      const vars = extractRootVariables(stepAny.condition);
      for (const v of vars) {
        if (
          declaredInputs.has(v) ||
          IMPLICIT_PARAMS.has(v) ||
          contextDeps.has(v) ||
          availableStepIds.has(v) ||
          availableSaveAs.has(v)
        ) {
          continue;
        }
        warnings.push({
          stepId: step.id,
          message: `Condition references unknown variable '${v}' in expression: ${stepAny.condition}`,
        });
      }
    }

    // Validate iterator source reference
    if (stepAny.type === 'iterator' && typeof stepAny.source === 'string') {
      const src = stepAny.source;
      if (
        !availableStepIds.has(src) &&
        !availableSaveAs.has(src) &&
        !declaredInputs.has(src) &&
        !IMPLICIT_PARAMS.has(src)
      ) {
        warnings.push({
          stepId: step.id,
          message: `Iterator source '${src}' references undefined step or variable`,
        });
      }
    }

    // Accumulate step ID and save_as for subsequent steps
    if (step.id) {
      availableStepIds.add(step.id);
    }
    if (typeof stepAny.save_as === 'string') {
      availableSaveAs.add(stepAny.save_as);
    }

    // Also accumulate from nested parallel steps
    if (stepAny.type === 'parallel' && Array.isArray(stepAny.steps)) {
      for (const nested of stepAny.steps) {
        if (nested.id) availableStepIds.add(nested.id);
        if (typeof nested.save_as === 'string') availableSaveAs.add(nested.save_as);
      }
    }
  }

  return warnings;
}

// =============================================================================
// 3. Fragment Reference Validation
// =============================================================================

/**
 * Validate that all sql_fragments references in a skill definition
 * point to fragments that exist in the loaded fragment cache.
 */
export function validateFragmentReferences(
  skill: SkillDefinition,
  availableFragments: Set<string>,
): SkillValidationWarning[] {
  const warnings: SkillValidationWarning[] = [];

  if (!skill.steps) return warnings;

  function checkStepFragments(stepAny: any, stepId: string): void {
    if (!Array.isArray(stepAny.sql_fragments)) return;
    for (const fragPath of stepAny.sql_fragments) {
      if (!availableFragments.has(fragPath)) {
        warnings.push({
          stepId,
          message: `SQL fragment '${fragPath}' not found in fragments directory`,
        });
      }
    }
  }

  for (const step of skill.steps) {
    const stepAny = step as any;
    checkStepFragments(stepAny, step.id);

    // Check nested parallel steps
    if (stepAny.type === 'parallel' && Array.isArray(stepAny.steps)) {
      for (const nested of stepAny.steps) {
        checkStepFragments(nested, nested.id || step.id);
      }
    }
  }

  return warnings;
}