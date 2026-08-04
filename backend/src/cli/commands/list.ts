// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * List Command
 *
 * Lists all available skills with their details.
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import {
  localize,
  parseOutputLanguage,
} from '../../agentv3/outputLanguage';
import {localizeSkillDefinition} from '../../services/skillLocalization';

// ANSI color codes
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const SKILLS_DIR = path.join(__dirname, '../../../skills');

/**
 * List command
 */
export const listCommand = new Command('list')
  .description('List all available skills')
  .option('-v, --verbose', 'Show detailed information')
  .option('--json', 'Output in JSON format')
  .option('--language <language>', 'Output language: zh-CN or en')
  .action(async (options: {
    verbose?: boolean;
    json?: boolean;
    language?: string;
  }) => {
    try {
      const outputLanguage = parseOutputLanguage(
        options.language ?? process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
      );
      // Dynamic import to avoid loading heavy dependencies
      const { skillRegistry, ensureSkillRegistryInitialized } = await import('../../services/skillEngine/skillLoader');

      // Initialize
      if (!options.json) {
        console.log(colors.gray('Loading skills...'));
      }
      await ensureSkillRegistryInitialized();

      const localizationStatusBySkillId = new Map<string, string>();
      const skills = skillRegistry.getAllSkills().map(skill => {
        const externalAuthored =
          skillRegistry.getSkillOrigin(skill.name)?.origin === 'external_pack';
        localizationStatusBySkillId.set(
          skill.name,
          externalAuthored ? 'external_authored' : 'catalog',
        );
        return localizeSkillDefinition(
          skill,
          outputLanguage,
          {externalAuthored},
        );
      });

      if (options.json) {
        // JSON output
        const output = skills.map(skill => ({
          id: skill.name,
          name: skill.name,
          version: skill.version,
          displayName: skill.meta.display_name,
          description: skill.meta.description,
          category: skill.category,
          type: skill.type,
          stepsCount: skill.steps?.length || 0,
          tags: skill.meta.tags,
          localizationStatus: localizationStatusBySkillId.get(skill.name),
        }));
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // Human-readable output
      console.log(colors.bold(localize(
        outputLanguage,
        '\nSmartPerfetto Skills（技能）\n',
        '\nSmartPerfetto Skills\n',
      )));
      console.log(localize(
        outputLanguage,
        `共找到 ${colors.cyan(String(skills.length))} 个 Skill\n`,
        `Found ${colors.cyan(String(skills.length))} Skills\n`,
      ));

      // Group by type
      const byType = new Map<string, typeof skills>();
      for (const skill of skills) {
        const type = skill.type || 'other';
        if (!byType.has(type)) {
          byType.set(type, []);
        }
        byType.get(type)!.push(skill);
      }

      // Print by type
      for (const [type, typeSkills] of byType.entries()) {
        console.log(colors.bold(`${type.toUpperCase()}:`));

        for (const skill of typeSkills) {
          // Skill header
          console.log(`\n  ${colors.cyan(skill.name)}`);
          console.log(`    ${skill.meta.display_name} v${skill.version}`);
          console.log(`    ${colors.gray(skill.meta.description)}`);

          if (options.verbose) {
            // Steps
            const steps = skill.steps || [];
            console.log(localize(
              outputLanguage,
              `    步骤：${steps.length}`,
              `    Steps: ${steps.length}`,
            ));
            for (const step of steps) {
              console.log(`      - ${(step as any).id}: ${(step as any).name || (step as any).type}`);
            }

            // Keywords
            if (skill.triggers?.keywords) {
              const keywords = Array.isArray(skill.triggers.keywords)
                ? skill.triggers.keywords
                : [...(skill.triggers.keywords.zh || []), ...(skill.triggers.keywords.en || [])];
              console.log(localize(
                outputLanguage,
                `    关键词：${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '...' : ''}`,
                `    Keywords: ${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '...' : ''}`,
              ));
            }

            // Tags
            if (skill.meta.tags) {
              console.log(localize(
                outputLanguage,
                `    标签：${skill.meta.tags.join(', ')}`,
                `    Tags: ${skill.meta.tags.join(', ')}`,
              ));
            }
          }
        }

        console.log('');
      }

      // Vendor overrides summary
      const vendorsDir = path.join(SKILLS_DIR, 'vendors');
      if (fs.existsSync(vendorsDir)) {
        const vendors = fs.readdirSync(vendorsDir).filter(f =>
          fs.statSync(path.join(vendorsDir, f)).isDirectory()
        );

        if (vendors.length > 0) {
          console.log(colors.bold('Vendor Overrides:'));
          for (const vendor of vendors) {
            const vendorPath = path.join(vendorsDir, vendor);
            const overrideFiles = fs.readdirSync(vendorPath).filter(f => f.endsWith('.override.yaml'));
            if (overrideFiles.length > 0) {
              console.log(`  ${colors.cyan(vendor)}: ${overrideFiles.length} override(s)`);
            }
          }
          console.log('');
        }
      }

      // Custom skills
      const customDir = path.join(SKILLS_DIR, 'custom');
      if (fs.existsSync(customDir)) {
        const customFiles = fs.readdirSync(customDir).filter(f => f.endsWith('.skill.yaml'));
        if (customFiles.length > 0) {
          console.log(colors.bold('Custom Skills:'));
          console.log(`  ${customFiles.length} custom skill(s)`);
          console.log('');
        }
      }

    } catch (error: any) {
      console.log(colors.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });
