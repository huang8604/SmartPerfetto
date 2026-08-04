// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

jest.mock('commander', () => ({
  Command: class {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    action() { return this; }
  },
}));

import {
  validateStrategyFrontmatter,
  type StrategyFrontmatterValidationContext,
} from '../commands/validate';

function frontmatter(yamlBody: string): string {
  return `---\n${yamlBody.trim()}\n---\n\nBody`;
}

function validationContext(): StrategyFrontmatterValidationContext {
  return {
    knownScenes: new Set([
      'scrolling',
      'pipeline',
      'startup',
      'touch_tracking',
      'scroll_response',
      'interaction',
    ]),
    seenVerifierMisdiagnosisIds: new Map(),
  };
}

describe('validateStrategyFrontmatter verifier_misdiagnosis_patterns', () => {
  it('accepts valid scene-scoped and global verifier rules', () => {
    const content = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: valid_scene_rule
    type: known_misdiagnosis
    scenes: [scrolling, pipeline]
    severity: info
    patterns:
      - 'Buffer Stuffing.*critical'
    message: 'Buffer Stuffing needs pipeline attribution'
  - id: valid_global_rule
    type: known_misdiagnosis
    global: true
    patterns:
      - 'single frame'
    message: 'Single frame should not be critical by itself'
`);

    expect(validateStrategyFrontmatter(content, 'valid.strategy.md', validationContext())).toEqual([]);
  });

  it('rejects invalid regex, missing message, invalid severity, invalid type, and unknown scenes', () => {
    const content = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: broken_rule
    type: severity_mismatch
    scenes: [scrolling, typo_scene]
    severity: error
    patterns:
      - '('
`);

    const errors = validateStrategyFrontmatter(content, 'broken.strategy.md', validationContext());
    expect(errors.join('\n')).toContain('type must be known_misdiagnosis');
    expect(errors.join('\n')).toContain('message must be a non-empty string');
    expect(errors.join('\n')).toContain('severity must be one of warning, info');
    expect(errors.join('\n')).toContain('is not a valid JavaScript regex');
    expect(errors.join('\n')).toContain('references unknown or contract-only scene "typo_scene"');
  });

  it('rejects duplicate ids across files and ambiguous global-plus-scenes scope', () => {
    const context = validationContext();
    const first = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: duplicated_rule
    type: known_misdiagnosis
    scenes: [scrolling]
    patterns: ['VSync']
    message: 'First rule'
`);
    const duplicate = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: duplicated_rule
    type: known_misdiagnosis
    global: true
    scenes: [pipeline]
    patterns: ['VSync']
    message: 'Duplicate rule'
`);

    expect(validateStrategyFrontmatter(first, 'first.strategy.md', context)).toEqual([]);
    const errors = validateStrategyFrontmatter(duplicate, 'second.strategy.md', context);
    expect(errors.join('\n')).toContain('duplicates "duplicated_rule" already declared in first.strategy.md');
    expect(errors.join('\n')).toContain('must declare either global: true or scenes, not both');
  });
});
