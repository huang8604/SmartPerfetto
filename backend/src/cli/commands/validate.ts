// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Validate Command
 *
 * Validates skill YAML files for syntax and semantic correctness.
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition } from '../../services/skillEngine/types';
import { validateSkillConditions } from '../../services/skillEngine/skillValidator';

// ANSI color codes (fallback for chalk ESM issues)
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface VendorOverrideDefinition {
  extends?: string;
  version?: string;
  meta?: {
    display_name?: string;
    description?: string;
    vendor?: string;
    [key: string]: any;
  };
  vendor_detection?: {
    signatures?: Array<{ pattern?: string; confidence?: string }>;
  };
  additional_steps?: any[];
  thresholds_override?: Record<string, any>;
  override_params?: Record<string, any>;
  additional_diagnostics?: any[];
  additional_output_sections?: any[];
}

const SKILLS_DIR = path.join(__dirname, '../../../skills');
const STRATEGIES_DIR = path.join(__dirname, '../../../strategies');

/**
 * Validate a skill definition
 */
function validateSkillDefinition(skill: SkillDefinition, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!skill.name) {
    errors.push('Missing required field: name');
  }
  if (!skill.version) {
    errors.push('Missing required field: version');
  }
  // NOTE: meta/triggers are best-effort in the current repo (legacy skills exist).
  // The runtime loader normalizes missing meta, so validate treats missing meta as a warning.
  if (!skill.meta) {
    warnings.push('Missing field: meta (will be normalized at load time, but should be filled in YAML)');
  } else {
    if (!skill.meta.display_name) {
      warnings.push('Missing field: meta.display_name');
    }
    if (!skill.meta.description) {
      warnings.push('Missing field: meta.description');
    }
  }
  if (!skill.triggers) {
    warnings.push('Missing field: triggers (optional; add keywords to improve discovery)');
  } else {
    const triggersRaw: any = skill.triggers as any;
    const triggers: any = (() => {
      // Accept legacy trigger array forms to avoid noisy false warnings
      // - [{ pattern: '...', confidence: 0.9 }, ...]
      // - ['keyword', '(regex|pattern)', ...]
      if (Array.isArray(triggersRaw)) {
        const keywords: string[] = [];
        const patterns: string[] = [];
        const looksLikeRegex = (s: string): boolean => /[\\^$.*+?()[\]{}|]/.test(s);

        for (const item of triggersRaw) {
          if (typeof item === 'string') {
            const s = item.trim();
            if (!s) continue;
            if (looksLikeRegex(s)) patterns.push(s);
            else keywords.push(s);
            continue;
          }
          if (item && typeof item === 'object') {
            if (typeof (item as any).pattern === 'string' && String((item as any).pattern).trim()) {
              patterns.push(String((item as any).pattern).trim());
            }
            if (typeof (item as any).keyword === 'string' && String((item as any).keyword).trim()) {
              keywords.push(String((item as any).keyword).trim());
            }
          }
        }

        const normalized: any = {};
        if (keywords.length > 0) normalized.keywords = keywords;
        if (patterns.length > 0) normalized.patterns = patterns;
        return normalized;
      }
      return triggersRaw;
    })();
    const hasKeywords = (() => {
      const k = triggers.keywords;
      if (!k) return false;
      if (typeof k === 'string') return k.trim().length > 0;
      if (Array.isArray(k)) return k.length > 0;
      if (typeof k === 'object') {
        const zh = Array.isArray(k.zh) ? k.zh : [];
        const en = Array.isArray(k.en) ? k.en : [];
        return zh.length > 0 || en.length > 0;
      }
      return false;
    })();
    const hasPatterns = (() => {
      const p = triggers.patterns;
      if (!p) return false;
      if (typeof p === 'string') return p.trim().length > 0;
      if (Array.isArray(p)) return p.length > 0;
      return false;
    })();
    if (!hasKeywords && !hasPatterns) {
      warnings.push('No keywords/patterns defined in triggers');
    }
  }

  // Execution shape validation:
  // - atomic: allow either root-level `sql` OR step-based `steps`
  // - composite/iterator/diagnostic: require `steps`
  const hasSteps = Array.isArray(skill.steps) && skill.steps.length > 0;
  const hasRootSql = typeof (skill as any).sql === 'string' && String((skill as any).sql).trim().length > 0;
  if (skill.type === 'atomic') {
    if (!hasRootSql && !hasSteps) {
      errors.push('Atomic skill must define either `sql` or non-empty `steps`');
    }
  } else {
    if (!hasSteps) {
      errors.push('Missing required field: steps (at least one step is required)');
    }
  }

  // Validate steps
  if (skill.steps) {
    const stepIds = new Set<string>();
    const savedVariables = new Set<string>();
    const executedStepIds = new Set<string>();

    // Treat input params as defined variables for ${...} reference checks
    if (Array.isArray(skill.inputs)) {
      for (const input of skill.inputs) {
        if (input && typeof (input as any).name === 'string') {
          savedVariables.add(String((input as any).name));
        }
      }
    }
    // Common implicit params injected by tooling
    savedVariables.add('start_ts');
    savedVariables.add('end_ts');
    savedVariables.add('package');
    savedVariables.add('vendor');

    for (let i = 0; i < skill.steps.length; i++) {
      const step = skill.steps[i];
      const stepPath = `steps[${i}]`;

      // Required step fields
      if (!step.id) {
        errors.push(`${stepPath}: Missing required field: id`);
      } else {
        if (stepIds.has(step.id)) {
          errors.push(`${stepPath}: Duplicate step id: ${step.id}`);
        }
        stepIds.add(step.id);
        executedStepIds.add(step.id);
      }

      // Validate based on step type
      const stepType = (() => {
        const t = (step as any).type;
        if (typeof t === 'string' && t.trim()) return t;
        if (typeof (step as any).sql === 'string') return 'atomic'; // legacy default
        if (typeof (step as any).skill === 'string') return 'skill';
        return 'unknown';
      })();

      // SQL validation for atomic steps
      if (stepType === 'atomic') {
        const sql = (step as any).sql;
        if (!sql || typeof sql !== 'string') {
          errors.push(`${stepPath}: Missing required field: sql for atomic step`);
        } else {
          // Validate SQL syntax (basic checks)
          const sqlIssues = validateSql(sql);
          errors.push(...sqlIssues.errors.map(e => `${stepPath}: ${e}`));
          warnings.push(...sqlIssues.warnings.map(w => `${stepPath}: ${w}`));

          // Validate variable references
          const varRefs = extractVariableReferences(sql);
          for (const ref of varRefs) {
            const actualRef = String(ref || '').split('|')[0].trim();
            if (actualRef.startsWith('prev.') || actualRef.startsWith('item.')) {
              // These are valid context references
              continue;
            }
            const root = actualRef.split('.')[0];
            if (!savedVariables.has(root)) {
              warnings.push(`${stepPath}: Variable reference '${ref}' may not be defined at this step`);
            }
          }
        }
      }

      // Track saved variables
      if ('save_as' in step && step.save_as) {
        savedVariables.add(step.save_as);
      }

      // Validate iterator source references
      if (stepType === 'iterator' && 'source' in step) {
        // At runtime, iterator `source` can reference either a previous step's `save_as`
        // or a previous step id (context.results[stepId]).
        if ((step as any).source && !savedVariables.has((step as any).source) && !executedStepIds.has((step as any).source)) {
          errors.push(`${stepPath}: iterator source references undefined variable: ${step.source}`);
        }
      }
    }
  }

  // Validate root-level SQL for atomic skills (legacy form)
  if (skill.type === 'atomic' && typeof (skill as any).sql === 'string') {
    const sql = String((skill as any).sql);
    const sqlIssues = validateSql(sql);
    errors.push(...sqlIssues.errors.map(e => `sql: ${e}`));
    warnings.push(...sqlIssues.warnings.map(w => `sql: ${w}`));

    const defined = new Set<string>(['start_ts', 'end_ts', 'package', 'vendor']);
    if (Array.isArray(skill.inputs)) {
      for (const input of skill.inputs) {
        if (input && typeof (input as any).name === 'string') {
          defined.add(String((input as any).name));
        }
      }
    }
    const varRefs = extractVariableReferences(sql);
    for (const ref of varRefs) {
      const actualRef = String(ref || '').split('|')[0].trim();
      if (actualRef.startsWith('prev.') || actualRef.startsWith('item.')) continue;
      const root = actualRef.split('.')[0];
      if (!defined.has(root)) {
        warnings.push(`sql: Variable reference '${ref}' may not be defined (inputs/save_as)`);
      }
    }
  }

  // Validate thresholds
  if (skill.thresholds) {
    for (const [name, threshold] of Object.entries(skill.thresholds)) {
      if (!threshold.levels) {
        warnings.push(`thresholds.${name}: Missing levels definition`);
      }
    }
  }

  // Validate diagnostic rules (in diagnostic steps, not skill-level)
  // V2 diagnostics are defined within DiagnosticStep, not at skill level

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateVendorOverrideDefinition(override: VendorOverrideDefinition, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!override.extends || typeof override.extends !== 'string') {
    errors.push('Missing required field: extends');
  }
  if (!override.version) {
    errors.push('Missing required field: version');
  }

  if (!override.meta) {
    warnings.push('Missing field: meta');
  } else {
    if (!override.meta.display_name) warnings.push('Missing field: meta.display_name');
    if (!override.meta.description) warnings.push('Missing field: meta.description');
    if (!override.meta.vendor) warnings.push('Missing field: meta.vendor');
  }

  const signatures = override.vendor_detection?.signatures;
  if (signatures !== undefined) {
    if (!Array.isArray(signatures)) {
      errors.push('vendor_detection.signatures must be an array');
    } else {
      const validConfidences = new Set(['high', 'medium', 'low']);
      signatures.forEach((sig, index) => {
        if (!sig?.pattern || typeof sig.pattern !== 'string') {
          errors.push(`vendor_detection.signatures[${index}]: Missing required field: pattern`);
        }
        if (sig?.confidence && !validConfidences.has(sig.confidence)) {
          warnings.push(
            `vendor_detection.signatures[${index}]: Unknown confidence '${sig.confidence}' ` +
            `(valid: ${[...validConfidences].join(', ')})`
          );
        }
      });
    }
  } else {
    warnings.push('Missing field: vendor_detection.signatures');
  }

  const hasAdditionalSteps = Array.isArray(override.additional_steps) && override.additional_steps.length > 0;
  const hasThresholdOverrides = !!override.thresholds_override && Object.keys(override.thresholds_override).length > 0;
  const hasOverrideParams = !!override.override_params && Object.keys(override.override_params).length > 0;

  if (!hasAdditionalSteps && !hasThresholdOverrides && !hasOverrideParams) {
    warnings.push('Override defines no additional_steps, thresholds_override, or override_params');
  }

  if (override.additional_steps !== undefined) {
    if (!Array.isArray(override.additional_steps)) {
      errors.push('additional_steps must be an array');
    } else {
      const stepIds = new Set<string>();
      const defined = new Set(['start_ts', 'end_ts', 'package', 'vendor']);

      override.additional_steps.forEach((step, index) => {
        const stepPath = `additional_steps[${index}]`;
        if (!step || typeof step !== 'object') {
          errors.push(`${stepPath}: must be an object`);
          return;
        }

        if (!step.id) {
          errors.push(`${stepPath}: Missing required field: id`);
        } else if (stepIds.has(step.id)) {
          errors.push(`${stepPath}: Duplicate step id: ${step.id}`);
        } else {
          stepIds.add(step.id);
          defined.add(step.id);
        }

        if (!step.name) {
          warnings.push(`${stepPath}: Missing field: name`);
        }

        if (step.save_as) {
          defined.add(String(step.save_as));
        }

        if (step.sql !== undefined) {
          if (typeof step.sql !== 'string' || !step.sql.trim()) {
            errors.push(`${stepPath}: sql must be a non-empty string`);
          } else {
            const sqlIssues = validateSql(step.sql);
            errors.push(...sqlIssues.errors.map(e => `${stepPath}: ${e}`));
            warnings.push(...sqlIssues.warnings.map(w => `${stepPath}: ${w}`));

            for (const ref of extractVariableReferences(step.sql)) {
              const actualRef = String(ref || '').split('|')[0].trim();
              if (actualRef.startsWith('prev.') || actualRef.startsWith('item.')) continue;
              const root = actualRef.split('.')[0];
              if (!defined.has(root)) {
                warnings.push(`${stepPath}: Variable reference '${ref}' may not be defined at this step`);
              }
            }
          }
        }
      });
    }
  }

  if (override.thresholds_override) {
    for (const [name, threshold] of Object.entries(override.thresholds_override)) {
      if (!threshold?.levels) {
        warnings.push(`thresholds_override.${name}: Missing levels definition`);
      }
    }
  }

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Basic SQL validation
 */
function validateSql(sql: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Heuristic warnings (keep validator usable; avoid false positives)
  if (sql.toUpperCase().includes('GROUP_CONCAT') && !sql.toLowerCase().includes('group by')) {
    warnings.push('GROUP_CONCAT used without GROUP BY (may be OK if query returns a single aggregated row)');
  }

  // Check for unbalanced parentheses (ignore parentheses inside string literals)
  const stripSingleQuotedStrings = (s: string): string => {
    let out = '';
    let inSingle = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\'') {
        if (inSingle && s[i + 1] === '\'') {
          // Escaped quote inside string: ''
          i++;
          continue;
        }
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle) out += ch;
    }
    return out;
  };
  const sqlForParens = stripSingleQuotedStrings(sql);
  const openParens = (sqlForParens.match(/\(/g) || []).length;
  const closeParens = (sqlForParens.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    errors.push(`Unbalanced parentheses: ${openParens} open, ${closeParens} close`);
  }

  // Check for unterminated strings
  const singleQuotes = (sql.match(/'/g) || []).length;
  if (singleQuotes % 2 !== 0) {
    errors.push('Unterminated string literal (odd number of single quotes)');
  }

  return { errors, warnings };
}

/**
 * Contract validation: input declarations, condition references, iterator sources
 */
function validateContracts(skill: SkillDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Input declarations completeness
  if (Array.isArray(skill.inputs)) {
    const validTypes = new Set(['string', 'number', 'integer', 'boolean', 'timestamp', 'duration', 'array', 'object']);
    for (const input of skill.inputs) {
      if (!input.name) {
        errors.push(`inputs: Input missing name`);
        continue;
      }
      if (input.type && !validTypes.has(input.type)) {
        warnings.push(`inputs.${input.name}: Unknown type '${input.type}' (valid: ${[...validTypes].join(', ')})`);
      }
      if (input.required && !input.description) {
        warnings.push(`inputs.${input.name}: Required input missing description`);
      }
    }
  }

  // 2. Condition variable reference checks
  const condWarnings = validateSkillConditions(skill);
  for (const w of condWarnings) {
    warnings.push(`${w.stepId}: ${w.message}`);
  }

  return { errors, warnings };
}

/**
 * Extract variable references from SQL
 */
function extractVariableReferences(sql: string): string[] {
  const regex = /\$\{([^}]+)\}/g;
  const refs: string[] = [];
  let match;

  while ((match = regex.exec(sql)) !== null) {
    refs.push(match[1]);
  }

  return refs;
}

/**
 * Validate a single skill file
 */
function validateFile(filePath: string): ValidationResult {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as SkillDefinition | VendorOverrideDefinition;

    if (!parsed) {
      return {
        file: filePath,
        valid: false,
        errors: ['Failed to parse YAML: empty or invalid content'],
        warnings: [],
      };
    }

    if (/\.override\.ya?ml$/.test(filePath)) {
      return validateVendorOverrideDefinition(parsed as VendorOverrideDefinition, filePath);
    }

    return validateSkillDefinition(parsed as SkillDefinition, filePath);
  } catch (error: any) {
    return {
      file: filePath,
      valid: false,
      errors: [`Failed to parse YAML: ${error.message}`],
      warnings: [],
    };
  }
}

/**
 * Find all skill files
 */
function findSkillFiles(dir: string, pattern: string | RegExp): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findSkillFiles(fullPath, pattern));
    } else if (entry.isFile() && entry.name.match(pattern)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Validate strategy files: check that all invoke_skill("xxx") references
 * point to skills that exist in the skill registry.
 *
 * Returns the number of missing skill references (0 = all good).
 */
function validateStrategySkillReferences(): number {
  if (!fs.existsSync(STRATEGIES_DIR)) {
    console.log(colors.yellow('No strategies directory found.'));
    return 0;
  }

  // Build skill name set from YAML files on disk (no runtime loader needed)
  const skillNames = new Set<string>();
  const skillDirs = ['atomic', 'composite', 'deep', 'system', 'modules', 'pipelines'];
  for (const dir of skillDirs) {
    const dirPath = path.join(SKILLS_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;
    const skillFiles = findSkillFiles(dirPath, /\.skill\.ya?ml$/);
    for (const file of skillFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const skill = yaml.load(content) as any;
        if (skill?.name) skillNames.add(skill.name);
      } catch { /* skip unparseable files */ }
    }
  }

  console.log(colors.bold('\nStrategy → Skill Reference Validation\n'));
  console.log(`Skill registry: ${skillNames.size} skills loaded from YAML.\n`);

  // Parse strategy files for invoke_skill("xxx") references
  const strategyFiles = fs.readdirSync(STRATEGIES_DIR)
    .filter(f => f.endsWith('.strategy.md'));

  if (strategyFiles.length === 0) {
    console.log(colors.yellow('No strategy files found.'));
    return 0;
  }

  let totalMissing = 0;

  for (const file of strategyFiles) {
    const filePath = path.join(STRATEGIES_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract all unique skill names referenced
    const referencedSkills = new Set<string>();
    const invokeSkillPattern = /invoke_skill\("([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = invokeSkillPattern.exec(content)) !== null) {
      referencedSkills.add(match[1]);
    }

    if (referencedSkills.size === 0) {
      console.log(`${colors.gray('SKIP')} ${file} (no invoke_skill references)`);
      continue;
    }

    const missing = [...referencedSkills].filter(name => !skillNames.has(name));
    if (missing.length === 0) {
      console.log(`${colors.green('PASS')} ${file} (${referencedSkills.size} skill refs OK)`);
    } else {
      console.log(`${colors.red('FAIL')} ${file}`);
      for (const name of missing) {
        console.log(`  ${colors.red('ERROR:')} invoke_skill("${name}") — skill not found in registry`);
      }
      totalMissing += missing.length;
    }
  }

  console.log(colors.bold('\nStrategy Validation Summary:'));
  console.log(`  Strategy files: ${strategyFiles.length}`);
  console.log(`  Missing skills: ${totalMissing > 0 ? colors.red(String(totalMissing)) : colors.green('0')}`);

  return totalMissing;
}

/**
 * Validate command
 */
export const validateCommand = new Command('validate')
  .description('Validate skill YAML files and strategy references')
  .argument('[skillId]', 'Specific skill ID to validate (optional)')
  .option('-a, --all', 'Validate all skills including vendor overrides')
  .option('-c, --contracts', 'Run contract checks (input types, condition refs, iterator sources)')
  .option('-s, --strategies', 'Validate strategy files: check invoke_skill references exist in skill registry')
  .option('-v, --verbose', 'Show detailed validation output')
  .action((skillId: string | undefined, options: { all?: boolean; contracts?: boolean; strategies?: boolean; verbose?: boolean }) => {
    // Strategy-only mode: just validate strategy → skill references
    if (options.strategies && !skillId && !options.contracts) {
      console.log(colors.bold('\nSmartPerfetto Strategy Validator\n'));
      const missing = validateStrategySkillReferences();
      process.exit(missing > 0 ? 1 : 0);
    }

    console.log(colors.bold('\nSmartPerfetto Skill Validator\n'));

    let files: string[] = [];

    if (skillId) {
      // Validate specific skill
      const possiblePaths = [
        path.join(SKILLS_DIR, 'composite', `${skillId}.skill.yaml`),
        path.join(SKILLS_DIR, 'atomic', `${skillId}.skill.yaml`),
        path.join(SKILLS_DIR, 'custom', `${skillId}.skill.yaml`),
      ];

      const foundPath = possiblePaths.find(p => fs.existsSync(p));
      if (foundPath) {
        files.push(foundPath);
      } else {
        console.log(colors.red(`Skill not found: ${skillId}`));
        process.exit(1);
      }
    } else {
      // Validate all skills
      files = findSkillFiles(path.join(SKILLS_DIR, 'composite'), /\.skill\.ya?ml$/);
      files.push(...findSkillFiles(path.join(SKILLS_DIR, 'atomic'), /\.skill\.ya?ml$/));

      if (options.all) {
        files.push(...findSkillFiles(path.join(SKILLS_DIR, 'vendors'), /\.override\.ya?ml$/));
        files.push(...findSkillFiles(path.join(SKILLS_DIR, 'custom'), /\.skill\.ya?ml$/));
      }
    }

    if (files.length === 0) {
      console.log(colors.yellow('No skill files found.'));
      process.exit(0);
    }

    console.log(`Found ${files.length} skill file(s) to validate.\n`);

    let totalErrors = 0;
    let totalWarnings = 0;
    let validCount = 0;

    for (const file of files) {
      const result = validateFile(file);

      // Run contract validation when --contracts is specified
      if (options.contracts) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const skill = yaml.load(content) as SkillDefinition;
          if (skill) {
            const contracts = validateContracts(skill);
            result.errors.push(...contracts.errors);
            result.warnings.push(...contracts.warnings);
            if (contracts.errors.length > 0) {
              result.valid = false;
            }
          }
        } catch { /* parse error already captured */ }
      }

      const relativePath = path.relative(SKILLS_DIR, file);

      if (result.valid) {
        console.log(`${colors.green('PASS')} ${relativePath}`);
        validCount++;
      } else {
        console.log(`${colors.red('FAIL')} ${relativePath}`);
      }

      if (options.verbose || result.errors.length > 0) {
        for (const error of result.errors) {
          console.log(`  ${colors.red('ERROR:')} ${error}`);
        }
      }

      if (options.verbose || result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`  ${colors.yellow('WARNING:')} ${warning}`);
        }
      }

      totalErrors += result.errors.length;
      totalWarnings += result.warnings.length;

      if (result.errors.length > 0 || result.warnings.length > 0) {
        console.log('');
      }
    }

    // Run strategy validation when --strategies is specified (combined with skill validation)
    if (options.strategies) {
      totalErrors += validateStrategySkillReferences();
    }

    // Summary
    console.log(colors.bold('\nSummary:'));
    console.log(`  Files:    ${files.length}`);
    console.log(`  Passed:   ${colors.green(String(validCount))}`);
    console.log(`  Failed:   ${colors.red(String(files.length - validCount))}`);
    console.log(`  Errors:   ${totalErrors > 0 ? colors.red(String(totalErrors)) : '0'}`);
    console.log(`  Warnings: ${totalWarnings > 0 ? colors.yellow(String(totalWarnings)) : '0'}`);

    process.exit(totalErrors > 0 ? 1 : 0);
  });
