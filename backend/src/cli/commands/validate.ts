/**
 * Validate Command
 *
 * Validates skill YAML files for syntax and semantic correctness.
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition, SkillStep } from '../../services/skillEngine/types';

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

const SKILLS_DIR = path.join(__dirname, '../../../skills');

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
    const skill = yaml.load(content) as SkillDefinition;

    if (!skill) {
      return {
        file: filePath,
        valid: false,
        errors: ['Failed to parse YAML: empty or invalid content'],
        warnings: [],
      };
    }

    return validateSkillDefinition(skill, filePath);
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
 * Validate command
 */
export const validateCommand = new Command('validate')
  .description('Validate skill YAML files')
  .argument('[skillId]', 'Specific skill ID to validate (optional)')
  .option('-a, --all', 'Validate all skills including vendor overrides')
  .option('-v, --verbose', 'Show detailed validation output')
  .action((skillId: string | undefined, options: { all?: boolean; verbose?: boolean }) => {
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

    // Summary
    console.log(colors.bold('\nSummary:'));
    console.log(`  Files:    ${files.length}`);
    console.log(`  Passed:   ${colors.green(String(validCount))}`);
    console.log(`  Failed:   ${colors.red(String(files.length - validCount))}`);
    console.log(`  Errors:   ${totalErrors > 0 ? colors.red(String(totalErrors)) : '0'}`);
    console.log(`  Warnings: ${totalWarnings > 0 ? colors.yellow(String(totalWarnings)) : '0'}`);

    process.exit(totalErrors > 0 ? 1 : 0);
  });
