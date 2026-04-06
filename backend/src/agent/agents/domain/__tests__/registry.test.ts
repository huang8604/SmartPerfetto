// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, jest } from '@jest/globals';
import {
  DomainAgentRegistry,
  createDomainAgentRegistryWithOptions,
} from '..';

function mockAgent(id: string, domain: string = 'custom') {
  return {
    config: {
      id,
      name: id,
      description: `${id} description`,
      domain,
    },
  } as any;
}

describe('DomainAgentRegistry extensibility', () => {
  it('registers and initializes custom agent factories without editing core registry', () => {
    const registry = new DomainAgentRegistry({} as any);
    const customFactory = jest.fn(() => mockAgent('custom_agent'));

    registry.registerFactory('custom_agent', customFactory, { initialize: false });
    registry.initialize(['custom_agent']);

    expect(customFactory).toHaveBeenCalledTimes(1);
    expect(registry.get('custom_agent')).toBeDefined();
  });

  it('supports disabled defaults and extra factories via createDomainAgentRegistryWithOptions', () => {
    const defaults = [
      'frame_agent',
      'cpu_agent',
      'binder_agent',
      'memory_agent',
      'startup_agent',
      'interaction_agent',
      'anr_agent',
      'system_agent',
    ];

    const registry = createDomainAgentRegistryWithOptions({} as any, {
      disabledAgentIds: defaults,
      extraFactories: {
        custom_agent: () => mockAgent('custom_agent'),
      },
    });

    expect(registry.getAgentIds()).toEqual(['custom_agent']);
    expect(registry.get('frame_agent')).toBeUndefined();
  });
});