// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Loader
 *
 * 加载 skill 文件，包括普通 skills 和 module expert skills
 *
 * Module Expert Skills:
 * - 位于 skills/modules/ 目录下
 * - 包含 module 和 dialogue 字段
 * - 可以被跨领域专家调用
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition, ModuleLayer, DialogueCapability, SkillStep } from './types';
import { generateRenderingPipelineDetectionSkill } from '../renderingPipelineDetectionSkillGenerator';
import logger from '../../utils/logger';
import { validateSkillConditions, validateFragmentReferences } from './skillValidator';
import {
  VALID_DISPLAY_LAYERS,
  VALID_DISPLAY_LEVELS,
  VALID_DISPLAY_FORMATS,
  VALID_COLUMN_TYPES,
  VALID_COLUMN_FORMATS,
  VALID_CLICK_ACTIONS,
  isValidDisplayLayer,
} from '../../types/dataContract';

// =============================================================================
// Skill Normalization (Backward Compatibility)
// =============================================================================

function firstNonEmptyLine(text: string): string {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines[0] || '';
}

/**
 * Normalize skill YAML variants into a stable runtime shape.
 *
 * Why:
 * - Some legacy skills use `description` + `tags` at top-level instead of `meta`.
 * - Some atomic skills define SQL via `steps` (single atomic step) instead of `sql`.
 * - Some legacy steps omit `type` but include `sql` (should be treated as atomic).
 *
 * The executor assumes `meta.display_name` / `meta.description` exist.
 */
function normalizeSkillDefinition(raw: any, filePath: string): SkillDefinition | null {
  if (!raw || typeof raw !== 'object') return null;

  const skill: any = raw;

  // Normalize triggers variants (legacy YAML may use array form with pattern/confidence objects)
  if (skill.triggers) {
    const t = skill.triggers;

    // Legacy: triggers: [{ pattern: '...', confidence: 0.9 }, ...] OR triggers: ['foo', '(bar|baz)']
    if (Array.isArray(t)) {
      const keywords: string[] = [];
      const patterns: string[] = [];
      const looksLikeRegex = (s: string): boolean => /[\\^$.*+?()[\]{}|]/.test(s);

      for (const item of t) {
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
      if (Object.keys(normalized).length > 0) {
        skill.triggers = normalized;
      }
    } else if (t && typeof t === 'object') {
      // Legacy: triggers: { pattern: '...' }
      if (typeof (t as any).pattern === 'string' && !(t as any).patterns) {
        const p = String((t as any).pattern).trim();
        delete (t as any).pattern;
        if (p) (t as any).patterns = [p];
      }
      // Ensure patterns/keywords are arrays when provided as a single string
      if (typeof (t as any).patterns === 'string') {
        (t as any).patterns = [String((t as any).patterns)];
      }
      if (typeof (t as any).keywords === 'string') {
        (t as any).keywords = [String((t as any).keywords)];
      }
    }
  }

  // Normalize legacy root-level display to output.display (executor reads output.display)
  if (skill.display && typeof skill.display === 'object') {
    if (!skill.output || typeof skill.output !== 'object') {
      skill.output = {};
    }
    if (!skill.output.display) {
      skill.output.display = skill.display;
    }
  }

  // Fill meta if missing (best-effort)
  if (!skill.meta || typeof skill.meta !== 'object') {
    const fallbackDisplayName =
      (typeof skill.display_name === 'string' && skill.display_name.trim()) ||
      (typeof skill.displayName === 'string' && skill.displayName.trim()) ||
      (typeof skill.name === 'string' && skill.name.trim()) ||
      path.basename(filePath).replace(/\.skill\.ya?ml$/i, '');

    const fallbackDescription =
      (typeof skill.description === 'string' && firstNonEmptyLine(skill.description)) ||
      `Skill: ${fallbackDisplayName}`;

    const tags = Array.isArray(skill.tags) ? skill.tags.map(String) : undefined;
    const icon = typeof skill.icon === 'string' && skill.icon.trim() ? String(skill.icon) : undefined;

    skill.meta = {
      display_name: fallbackDisplayName,
      description: fallbackDescription,
      ...(icon ? { icon } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
  } else {
    // Ensure required meta fields exist
    if (!skill.meta.display_name && typeof skill.name === 'string') {
      skill.meta.display_name = skill.name;
    }
    if (!skill.meta.description) {
      const fromTop = typeof skill.description === 'string' ? firstNonEmptyLine(skill.description) : '';
      skill.meta.description = fromTop || `Skill: ${skill.meta.display_name || skill.name || 'unknown'}`;
    }
    // Backfill tags/icon from legacy fields
    if (!Array.isArray(skill.meta.tags) && Array.isArray(skill.tags)) {
      skill.meta.tags = skill.tags.map(String);
    }
    if (!skill.meta.icon && typeof skill.icon === 'string') {
      skill.meta.icon = String(skill.icon);
    }
  }

  // Normalize step variants (type inference, iterator item_skill alias)
  if (Array.isArray(skill.steps)) {
    const toNumber = (v: any): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const normalizeConditionToJsExpr = (expr: string): string => {
      let e = String(expr || '').trim();
      if (!e) return '';
      e = e.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||');
      // Convert SQL-style '=' into JS '==' (but preserve >=, <=, !=, ==).
      e = e.replace(/([^<>=!])=([^=])/g, '$1==$2');
      return e;
    };

    const convertInterpretationToSynthesize = (step: any): any | null => {
      const interp = step?.interpretation;
      if (!interp || typeof interp !== 'object') return null;

      const keyMetrics = Array.isArray((interp as any).key_metrics)
        ? (interp as any).key_metrics
        : Array.isArray((interp as any).keyMetrics)
          ? (interp as any).keyMetrics
          : [];

      const analysisHints = Array.isArray((interp as any).analysis_hints)
        ? (interp as any).analysis_hints
        : Array.isArray((interp as any).analysisHints)
          ? (interp as any).analysisHints
          : [];

      const fields: any[] = [];
      const insights: any[] = [];

      for (const km of keyMetrics) {
        if (!km || typeof km !== 'object') continue;
        const key = typeof (km as any).name === 'string' ? String((km as any).name).trim() : '';
        if (!key) continue;
        const label = typeof (km as any).description === 'string' && String((km as any).description).trim()
          ? String((km as any).description).trim()
          : key;
        fields.push({ key, label });

        const th = (km as any).thresholds;
        if (th && typeof th === 'object') {
          const warning = toNumber((th as any).warning);
          const critical = toNumber((th as any).critical);
          if (typeof critical === 'number') {
            insights.push({
              condition: `${key} >= ${critical}`,
              template: `${label} 偏高：{{${key}}} (≥${critical})`,
            });
          }
          if (typeof warning === 'number') {
            const cond = typeof critical === 'number'
              ? `${key} >= ${warning} && ${key} < ${critical}`
              : `${key} >= ${warning}`;
            insights.push({
              condition: cond,
              template: `${label} 略高：{{${key}}} (≥${warning})`,
            });
          }
        }
      }

      for (const hint of analysisHints) {
        if (!hint || typeof hint !== 'object') continue;
        const condRaw = typeof (hint as any).condition === 'string' ? String((hint as any).condition) : '';
        const template = typeof (hint as any).insight === 'string' ? String((hint as any).insight).trim() : '';
        if (!template) continue;
        const condition = condRaw ? normalizeConditionToJsExpr(condRaw) : undefined;
        insights.push({
          ...(condition ? { condition } : {}),
          template,
        });
      }

      if (fields.length === 0 && insights.length === 0) return null;

      const layer = step?.display && typeof step.display === 'object' ? (step.display as any).layer : undefined;
      const role = layer === 'list' ? 'list' : 'overview';

      return {
        role,
        ...(fields.length > 0 ? { fields } : {}),
        ...(insights.length > 0 ? { insights } : {}),
      };
    };

    const normalizeStep = (step: any): void => {
      if (!step || typeof step !== 'object') return;

      // Legacy: step without type but with sql => atomic
      if (!(step as any).type && typeof (step as any).sql === 'string') {
        (step as any).type = 'atomic';
      }

      // Backward compatibility: iterator may use `skill:` instead of `item_skill:`
      if ((step as any).type === 'iterator' && typeof (step as any).skill === 'string' && typeof (step as any).item_skill !== 'string') {
        (step as any).item_skill = (step as any).skill;
      }

      // Legacy: many skills carry an "interpretation" block which used to be ignored.
      // Convert it into synthesize config so SkillExecutor can generate deterministic summaries.
      if (!(step as any).synthesize && (step as any).interpretation) {
        const synth = convertInterpretationToSynthesize(step);
        if (synth) {
          (step as any).synthesize = synth;
        }
      }

      // Recurse into parallel steps
      if ((step as any).type === 'parallel' && Array.isArray((step as any).steps)) {
        for (const nested of (step as any).steps) {
          normalizeStep(nested);
        }
      }
    };

    for (const step of skill.steps) {
      normalizeStep(step);
    }
  }

  return skill as SkillDefinition;
}

// =============================================================================
// Skill Validation
// =============================================================================

interface ValidationWarning {
  skillName: string;
  stepId?: string;
  field: string;
  message: string;
  value?: any;
}

/**
 * Validate a skill definition's display configurations
 * Returns warnings for invalid values (does not throw)
 */
function validateSkillDisplayConfig(skill: SkillDefinition): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Validate output display config
  if (skill.output?.display) {
    const display = skill.output.display;
    if (display.layer && !isValidDisplayLayer(display.layer)) {
      warnings.push({
        skillName: skill.name,
        field: 'output.display.layer',
        message: `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
        value: display.layer
      });
    }
    if (display.level && !VALID_DISPLAY_LEVELS.includes(display.level as any)) {
      warnings.push({
        skillName: skill.name,
        field: 'output.display.level',
        message: `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
        value: display.level
      });
    }
  }

  // Validate step display configs
  if (skill.steps) {
    for (const step of skill.steps) {
      validateStepDisplay(skill.name, step, warnings);
    }
  }

  return warnings;
}

/**
 * Validate a single column definition from YAML
 */
function validateColumnDefinition(
  skillName: string,
  stepId: string,
  column: any,
  index: number,
  warnings: ValidationWarning[]
): void {
  const prefix = `display.columns[${index}]`;

  if (!column || typeof column !== 'object') {
    warnings.push({
      skillName,
      stepId,
      field: prefix,
      message: 'Column definition must be an object',
      value: column
    });
    return;
  }

  // Name is required
  if (!column.name || typeof column.name !== 'string') {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.name`,
      message: 'Column name is required and must be a string',
      value: column.name
    });
  }

  // Validate type if specified
  if (column.type && !VALID_COLUMN_TYPES.includes(column.type as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.type`,
      message: `Invalid column type. Valid values: ${VALID_COLUMN_TYPES.join(', ')}`,
      value: column.type
    });
  }

  // Validate format if specified
  if (column.format && !VALID_COLUMN_FORMATS.includes(column.format as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.format`,
      message: `Invalid column format. Valid values: ${VALID_COLUMN_FORMATS.join(', ')}`,
      value: column.format
    });
  }

  // Validate clickAction if specified
  if (column.clickAction && !VALID_CLICK_ACTIONS.includes(column.clickAction as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.clickAction`,
      message: `Invalid click action. Valid values: ${VALID_CLICK_ACTIONS.join(', ')}`,
      value: column.clickAction
    });
  }

  // Validate unit if specified
  if (column.unit && !['ns', 'us', 'ms', 's'].includes(column.unit)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.unit`,
      message: `Invalid time unit. Valid values: ns, us, ms, s`,
      value: column.unit
    });
  }

  // Validate width if specified
  if (column.width !== undefined) {
    const validWidths = ['narrow', 'medium', 'wide', 'auto'];
    if (typeof column.width !== 'number' && !validWidths.includes(column.width)) {
      warnings.push({
        skillName,
        stepId,
        field: `${prefix}.width`,
        message: `Invalid width. Must be a number or one of: ${validWidths.join(', ')}`,
        value: column.width
      });
    }
  }
}

/**
 * Recursively validate step display configurations
 */
function validateStepDisplay(
  skillName: string,
  step: SkillStep,
  warnings: ValidationWarning[]
): void {
  // Check if step has display config (could be object or boolean)
  const display = (step as any).display;
  if (display && typeof display === 'object') {
    if (display.layer && !isValidDisplayLayer(display.layer)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.layer',
        message: `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
        value: display.layer
      });
    }
    if (display.level && !VALID_DISPLAY_LEVELS.includes(display.level as any)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.level',
        message: `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
        value: display.level
      });
    }
    if (display.format && !VALID_DISPLAY_FORMATS.includes(display.format as any)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.format',
        message: `Invalid format value. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
        value: display.format
      });
    }

    // Validate columns array if present (Phase 0 - DataEnvelope refactoring)
    if (display.columns && Array.isArray(display.columns)) {
      for (let i = 0; i < display.columns.length; i++) {
        validateColumnDefinition(skillName, step.id, display.columns[i], i, warnings);
      }
    }

    // Validate metadataFields if present
    if (display.metadataFields) {
      if (!Array.isArray(display.metadataFields)) {
        warnings.push({
          skillName,
          stepId: step.id,
          field: 'display.metadataFields',
          message: 'metadataFields must be an array of strings',
          value: display.metadataFields
        });
      } else {
        for (let i = 0; i < display.metadataFields.length; i++) {
          if (typeof display.metadataFields[i] !== 'string') {
            warnings.push({
              skillName,
              stepId: step.id,
              field: `display.metadataFields[${i}]`,
              message: 'Each metadataField must be a string',
              value: display.metadataFields[i]
            });
          }
        }
      }
    }
  }

  // Recursively check nested steps (parallel, conditional)
  if ((step as any).steps) {
    for (const nestedStep of (step as any).steps) {
      validateStepDisplay(skillName, nestedStep, warnings);
    }
  }
  if ((step as any).conditions) {
    for (const condition of (step as any).conditions) {
      if (condition.then && typeof condition.then === 'object') {
        validateStepDisplay(skillName, condition.then as SkillStep, warnings);
      }
    }
    if ((step as any).else && typeof (step as any).else === 'object') {
      validateStepDisplay(skillName, (step as any).else as SkillStep, warnings);
    }
  }
}

// =============================================================================
// Vendor Override Types
// =============================================================================

export interface VendorOverrideSignature {
  pattern: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface VendorOverride {
  vendor: string;
  extends: string;
  displayName?: string;
  description?: string;
  detection: { signatures: VendorOverrideSignature[] };
  additionalSteps: any[];
  overrideParams?: Record<string, any>;
}

// =============================================================================
// Skill Registry
// =============================================================================

class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private moduleSkills: Map<string, SkillDefinition> = new Map();  // Skills with module metadata
  private fragmentCache: Map<string, string> = new Map();  // SQL fragment path → content
  /** Vendor overrides keyed by base skill ID (from `extends` field) */
  private vendorOverrides: Map<string, VendorOverride[]> = new Map();
  private initialized = false;

  /**
   * 加载所有 skills
   */
  async loadSkills(skillsDir: string): Promise<void> {
    if (this.initialized) return;

    logger.info('SkillLoader', `Loading skills from: ${skillsDir}`);

    // Load SQL fragments first (before skills, so fragment references can be validated)
    this.loadFragments(skillsDir);

    // 加载原子 skills
    const atomicDir = path.join(skillsDir, 'atomic');
    if (fs.existsSync(atomicDir)) {
      await this.loadSkillsFromDir(atomicDir);
    }

    // 加载组合 skills
    const compositeDir = path.join(skillsDir, 'composite');
    if (fs.existsSync(compositeDir)) {
      await this.loadSkillsFromDir(compositeDir);
    }

    // 加载深度分析 skills (Phase 6)
    const deepDir = path.join(skillsDir, 'deep');
    if (fs.existsSync(deepDir)) {
      await this.loadSkillsFromDir(deepDir);
    }

    // 加载系统分析 skills (Phase 6)
    const systemDir = path.join(skillsDir, 'system');
    if (fs.existsSync(systemDir)) {
      await this.loadSkillsFromDir(systemDir);
    }

    // 加载模块专家 skills (Cross-Domain Expert System)
    const modulesDir = path.join(skillsDir, 'modules');
    if (fs.existsSync(modulesDir)) {
      await this.loadModuleSkillsRecursively(modulesDir);
    }

    // 加载 pipeline skills (Pipeline Skill Architecture)
    // Note: Pipeline skills are loaded separately by PipelineSkillLoader
    // but we register them here for skill discovery
    const pipelinesDir = path.join(skillsDir, 'pipelines');
    if (fs.existsSync(pipelinesDir)) {
      await this.loadPipelineSkills(pipelinesDir);
    }

    // 加载 vendor overrides (厂商适配覆盖)
    const vendorsDir = path.join(skillsDir, 'vendors');
    if (fs.existsSync(vendorsDir)) {
      this.loadVendorOverrides(vendorsDir);
    }

    this.initialized = true;
    logger.info('SkillLoader', `Loaded ${this.skills.size} skills (${this.moduleSkills.size} module experts, ${this.vendorOverrides.size} vendor-overridden skills)`);
  }

  /**
   * Load SQL fragments from skills/fragments/ directory.
   * Fragments are reusable CTE definitions that can be injected into step SQL.
   */
  private loadFragments(skillsDir: string): void {
    const fragmentsDir = path.join(skillsDir, 'fragments');
    if (!fs.existsSync(fragmentsDir)) return;

    const files = fs.readdirSync(fragmentsDir);
    for (const file of files) {
      if (!file.endsWith('.sql')) continue;
      const filePath = path.join(fragmentsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        const key = `fragments/${file}`;
        this.fragmentCache.set(key, content);
        logger.debug('SkillLoader', `Loaded SQL fragment: ${key}`);
      } catch (error: any) {
        logger.error('SkillLoader', `Failed to load fragment ${file}: ${error.message}`);
      }
    }
    logger.info('SkillLoader', `Loaded ${this.fragmentCache.size} SQL fragments`);
  }

  /** Get a loaded SQL fragment by its path key (e.g., 'fragments/target_threads.sql') */
  getFragment(fragmentPath: string): string | undefined {
    return this.fragmentCache.get(fragmentPath);
  }

  /** Get all loaded fragment path keys */
  getFragmentPaths(): Set<string> {
    return new Set(this.fragmentCache.keys());
  }

  /** Get the full fragment cache (for passing to SkillExecutor) */
  getFragmentCache(): Map<string, string> {
    return this.fragmentCache;
  }

  /**
   * Run all load-time validations on a skill and log warnings.
   */
  private validateAndLogWarnings(skill: SkillDefinition): void {
    const displayWarnings = validateSkillDisplayConfig(skill);
    for (const warn of displayWarnings) {
      logger.warn(
        'SkillLoader',
        `Validation warning in ${skill.name}${warn.stepId ? `.${warn.stepId}` : ''}: ${warn.field} - ${warn.message} (value: ${warn.value})`
      );
    }

    const condWarnings = validateSkillConditions(skill);
    for (const w of condWarnings) {
      logger.warn('SkillLoader', `[${skill.name}.${w.stepId}] ${w.message}`);
    }

    const fragWarnings = validateFragmentReferences(skill, this.getFragmentPaths());
    for (const w of fragWarnings) {
      logger.warn('SkillLoader', `[${skill.name}.${w.stepId}] ${w.message}`);
    }
  }

  /**
   * 递归加载 modules 目录下的 skills
   * modules/
   *   ├── app/
   *   ├── framework/
   *   ├── kernel/
   *   └── hardware/
   */
  private async loadModuleSkillsRecursively(dir: string): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.loadModuleSkillsRecursively(fullPath);
      } else if (entry.name.endsWith('.skill.yaml') || entry.name.endsWith('.skill.yml')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const loaded = yaml.load(content) as any;
          const skill = normalizeSkillDefinition(loaded, fullPath);

          if (skill && skill.name) {
            this.validateAndLogWarnings(skill);
            this.skills.set(skill.name, skill);

            // Track module skills separately for efficient lookup
            if (skill.module) {
              this.moduleSkills.set(skill.name, skill);
              logger.debug('SkillLoader', `Loaded module skill: ${skill.name} (${skill.module.layer}/${skill.module.component})`);
            } else {
              logger.debug('SkillLoader', `Loaded skill: ${skill.name} (${skill.type})`);
            }
          }
        } catch (error: any) {
          logger.error('SkillLoader', `Failed to load ${fullPath}:`, error.message);
        }
      }
    }
  }

  /**
   * 加载 pipeline skills
   * Pipeline skills are a special type that define rendering pipeline configurations
   */
  private async loadPipelineSkills(dir: string): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      // Skip non-skill files and template files
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;
      if (file.startsWith('_')) continue;

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = yaml.load(content) as SkillDefinition;

        if (skill && skill.name && skill.type === 'pipeline_definition') {
          // Register pipeline skills with a special prefix for discoverability
          this.skills.set(skill.name, skill);
          logger.debug('SkillLoader', `Loaded pipeline skill: ${skill.name}`);
        }
      } catch (error: any) {
        logger.error('SkillLoader', `Failed to load pipeline ${file}:`, error.message);
      }
    }
  }

  /**
   * 加载 vendor overrides
   * vendors/ 下每个厂商子目录包含 *.override.yaml 文件
   * 每个 override 声明 `extends: <base_skill_id>` 和 `additional_steps`
   */
  private loadVendorOverrides(dir: string): void {
    const vendorDirs = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of vendorDirs) {
      if (!entry.isDirectory()) continue;
      const vendorName = entry.name;
      const vendorDir = path.join(dir, vendorName);

      const files = fs.readdirSync(vendorDir);
      for (const file of files) {
        if (!file.endsWith('.override.yaml') && !file.endsWith('.override.yml')) continue;

        const filePath = path.join(vendorDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const raw = yaml.load(content) as any;

          if (!raw || typeof raw !== 'object' || !raw.extends) {
            logger.warn('SkillLoader', `Vendor override ${filePath} missing 'extends' field, skipping`);
            continue;
          }

          // Normalize the base skill ID: "composite/startup_analysis" → "startup_analysis"
          const baseSkillId = String(raw.extends).includes('/')
            ? String(raw.extends).split('/').pop()!
            : String(raw.extends);

          const override: VendorOverride = {
            vendor: raw.meta?.vendor || vendorName,
            extends: baseSkillId,
            displayName: raw.meta?.display_name,
            description: raw.meta?.description,
            detection: {
              signatures: Array.isArray(raw.vendor_detection?.signatures)
                ? raw.vendor_detection.signatures.map((s: any) => ({
                    pattern: String(s.pattern || ''),
                    confidence: s.confidence || 'medium',
                  }))
                : [],
            },
            additionalSteps: Array.isArray(raw.additional_steps) ? raw.additional_steps : [],
            overrideParams: raw.override_params,
          };

          // Store keyed by base skill ID
          const existing = this.vendorOverrides.get(baseSkillId) || [];
          existing.push(override);
          this.vendorOverrides.set(baseSkillId, existing);

          logger.debug('SkillLoader', `Loaded vendor override: ${vendorName}/${file} → extends ${baseSkillId}`);
        } catch (error: any) {
          logger.error('SkillLoader', `Failed to load vendor override ${filePath}: ${error.message}`);
        }
      }
    }

    // Log summary
    let totalOverrides = 0;
    for (const overrides of this.vendorOverrides.values()) {
      totalOverrides += overrides.length;
    }
    logger.info('SkillLoader', `Loaded ${totalOverrides} vendor overrides across ${this.vendorOverrides.size} base skills`);
  }

  /**
   * 获取指定 skill 的特定厂商覆盖
   * @param skillId 基础 skill ID (e.g. "startup_analysis")
   * @param vendor 厂商标识 (e.g. "xiaomi", "pixel")
   * @returns 匹配的 VendorOverride，不存在则返回 undefined
   */
  getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined {
    const overrides = this.vendorOverrides.get(skillId);
    if (!overrides) return undefined;
    return overrides.find(o => o.vendor.toLowerCase() === vendor.toLowerCase());
  }

  /**
   * 获取指定 skill 的所有厂商覆盖
   * @param skillId 基础 skill ID
   * @returns 所有匹配的 VendorOverride 列表
   */
  getVendorOverridesForSkill(skillId: string): VendorOverride[] {
    return this.vendorOverrides.get(skillId) || [];
  }

  /**
   * 获取所有已加载的 vendor override 数量
   */
  getVendorOverrideCount(): number {
    let count = 0;
    for (const overrides of this.vendorOverrides.values()) {
      count += overrides.length;
    }
    return count;
  }

  /**
   * 从目录加载 skills
   */
  private async loadSkillsFromDir(dir: string): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) {
        continue;
      }

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const loaded = yaml.load(content) as any;
        const skill = normalizeSkillDefinition(loaded, filePath);

        if (skill && skill.name) {
          this.validateAndLogWarnings(skill);
          this.skills.set(skill.name, skill);
          logger.debug('SkillLoader', `Loaded skill: ${skill.name} (${skill.type})`);
        }
      } catch (error: any) {
        logger.error('SkillLoader', `Failed to load ${file}:`, error.message);
      }
    }
  }

  /**
   * 获取 skill
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 获取所有 skills
   */
  getAllSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Programmatically insert/override a skill definition.
   * Used for runtime-generated skills where YAML should be the single source of truth.
   */
  upsertSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);

    // Keep moduleSkills map consistent
    if (skill.module) {
      this.moduleSkills.set(skill.name, skill);
    } else {
      this.moduleSkills.delete(skill.name);
    }
  }

  /**
   * 获取所有模块专家 skills
   */
  getAllModuleSkills(): SkillDefinition[] {
    return Array.from(this.moduleSkills.values());
  }

  /**
   * 根据模块层级查找 skills
   */
  findSkillsByLayer(layer: ModuleLayer): SkillDefinition[] {
    return Array.from(this.moduleSkills.values()).filter(
      (skill) => skill.module?.layer === layer
    );
  }

  /**
   * 根据组件名查找 skill
   */
  findSkillByComponent(component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) => skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据层级和组件查找 skill
   */
  findModuleSkill(layer: ModuleLayer, component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) =>
        skill.module?.layer === layer &&
        skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据对话能力查找 skill
   * 查找能够回答特定问题类型的模块
   */
  findSkillByCapability(capabilityId: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find((skill) =>
      skill.dialogue?.capabilities?.some((cap) => cap.id === capabilityId)
    );
  }

  /**
   * 获取所有可用的对话能力
   */
  getAllCapabilities(): Array<{ skillName: string; capability: DialogueCapability }> {
    const capabilities: Array<{ skillName: string; capability: DialogueCapability }> = [];

    for (const skill of this.moduleSkills.values()) {
      if (skill.dialogue?.capabilities) {
        for (const cap of skill.dialogue.capabilities) {
          capabilities.push({ skillName: skill.name, capability: cap });
        }
      }
    }

    return capabilities;
  }

  /**
   * 检查 skill 是否为模块专家
   */
  isModuleSkill(skillName: string): boolean {
    return this.moduleSkills.has(skillName);
  }

  /**
   * 根据关键词匹配 skill
   */
  findMatchingSkill(question: string): SkillDefinition | undefined {
    const lowerQuestion = question.toLowerCase();

    for (const skill of this.skills.values()) {
      if (!skill.triggers) continue;

      // 检查关键词
      const keywords = skill.triggers.keywords;
      if (keywords) {
        let keywordList: string[] = [];

        if (Array.isArray(keywords)) {
          keywordList = keywords;
        } else {
          keywordList = [
            ...(keywords.zh || []),
            ...(keywords.en || []),
          ];
        }

        for (const keyword of keywordList) {
          if (lowerQuestion.includes(keyword.toLowerCase())) {
            return skill;
          }
        }
      }

      // 检查模式
      if (skill.triggers.patterns) {
        for (const pattern of skill.triggers.patterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(question)) {
              return skill;
            }
          } catch {
            // 无效的正则表达式，跳过
          }
        }
      }
    }

    return undefined;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 重新加载所有 skills
   */
  async reload(): Promise<void> {
    this.skills.clear();
    this.vendorOverrides.clear();
    this.initialized = false;
    const skillsDir = path.resolve(__dirname, '../../../skills');
    await this.loadSkills(skillsDir);
  }
}

// 单例
export const skillRegistry = new SkillRegistry();

// =============================================================================
// 辅助函数
// =============================================================================

// Promise-based lock to prevent concurrent initialization
let initializationPromise: Promise<void> | null = null;

/**
 * 确保 skill registry 已初始化
 * NOTE: This function is safe to call concurrently - it will only initialize once
 */
export async function ensureSkillRegistryInitialized(): Promise<void> {
  // Fast path: already initialized
  if (skillRegistry.isInitialized()) return;

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization (only one caller will reach here)
  const skillsDir = path.resolve(__dirname, '../../../skills');
  initializationPromise = (async () => {
    await skillRegistry.loadSkills(skillsDir);

    // Runtime-generated skills (YAML-driven single source of truth)
    try {
      const generated = await generateRenderingPipelineDetectionSkill();
      skillRegistry.upsertSkill(generated);
      logger.debug('SkillLoader', `Overrode skill with YAML-driven generator: ${generated.name} (v${generated.version})`);
    } catch (error: any) {
      logger.warn(
        'SkillLoader',
        `Failed to generate YAML-driven rendering pipeline detection skill: ${error?.message || error}`
      );
    }
  })();

  try {
    await initializationPromise;
  } finally {
    // Clear the promise after completion (success or failure)
    // This allows retry on failure
    if (!skillRegistry.isInitialized()) {
      initializationPromise = null;
    }
  }
}

/**
 * 获取默认的 skills 目录
 */
export function getSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}