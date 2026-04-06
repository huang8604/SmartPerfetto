// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Domain Agents
 *
 * Phase 2: All AI Agents that wrap Skills as tools
 *
 * Each agent specializes in a specific performance domain:
 * - FrameAgent: Frame timing, jank, scrolling
 * - CPUAgent: CPU scheduling, frequency, load
 * - BinderAgent: IPC and lock contention
 * - MemoryAgent: Memory, GC, LMK
 * - StartupAgent: App launch and startup
 * - InteractionAgent: Click response
 * - ANRAgent: ANR detection
 * - SystemAgent: Thermal, IO, suspend/wakeup
 */

// Base Agent
export { BaseAgent } from '../base/baseAgent';
export type {
  TaskUnderstanding,
  ExecutionPlan,
  ExecutionStep,
  ExecutionResult,
  ExecutionStepResult,
  Reflection,
} from '../base/baseAgent';

// Domain Agents
export { FrameAgent, createFrameAgent } from './frameAgent';
export { CPUAgent, createCPUAgent } from './cpuAgent';
export { BinderAgent, createBinderAgent } from './binderAgent';
export { MemoryAgent, createMemoryAgent } from './memoryAgent';

// Additional Agents
export {
  StartupAgent,
  InteractionAgent,
  ANRAgent,
  SystemAgent,
  createStartupAgent,
  createInteractionAgent,
  createANRAgent,
  createSystemAgent,
} from './additionalAgents';

// Agent Protocol Types
export * from '../../types/agentProtocol';

// =============================================================================
// Agent Registry
// =============================================================================

import { ModelRouter } from '../../core/modelRouter';
import { BaseAgent } from '../base/baseAgent';
import { FrameAgent } from './frameAgent';
import { CPUAgent } from './cpuAgent';
import { BinderAgent } from './binderAgent';
import { MemoryAgent } from './memoryAgent';
import { StartupAgent, InteractionAgent, ANRAgent, SystemAgent } from './additionalAgents';

/**
 * All available domain agents
 */
export type DomainAgentType =
  | 'frame_agent'
  | 'cpu_agent'
  | 'binder_agent'
  | 'memory_agent'
  | 'startup_agent'
  | 'interaction_agent'
  | 'anr_agent'
  | 'system_agent';

export type DomainAgentFactory = (modelRouter: ModelRouter) => BaseAgent;

interface RegisterFactoryOptions {
  replace?: boolean;
  initialize?: boolean;
}

export interface CreateDomainAgentRegistryOptions {
  extraFactories?: Record<string, DomainAgentFactory>;
  disabledAgentIds?: string[];
  initialize?: boolean;
}

const DEFAULT_AGENT_FACTORIES: Record<DomainAgentType, DomainAgentFactory> = {
  frame_agent: (modelRouter) => new FrameAgent(modelRouter),
  cpu_agent: (modelRouter) => new CPUAgent(modelRouter),
  binder_agent: (modelRouter) => new BinderAgent(modelRouter),
  memory_agent: (modelRouter) => new MemoryAgent(modelRouter),
  startup_agent: (modelRouter) => new StartupAgent(modelRouter),
  interaction_agent: (modelRouter) => new InteractionAgent(modelRouter),
  anr_agent: (modelRouter) => new ANRAgent(modelRouter),
  system_agent: (modelRouter) => new SystemAgent(modelRouter),
};

/**
 * Domain Agent Registry
 *
 * Manages instantiation and access to all domain agents
 */
export class DomainAgentRegistry {
  private agents: Map<string, BaseAgent> = new Map();
  private agentFactories: Map<string, DomainAgentFactory> = new Map();
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
    this.registerDefaultFactories();
  }

  private registerDefaultFactories(): void {
    for (const [agentId, factory] of Object.entries(DEFAULT_AGENT_FACTORIES)) {
      this.registerFactory(agentId, factory, { replace: true, initialize: false });
    }
  }

  registerFactory(
    agentId: string,
    factory: DomainAgentFactory,
    options: RegisterFactoryOptions = {}
  ): void {
    const replace = options.replace === true;
    const initialize = options.initialize !== false;

    if (!replace && this.agentFactories.has(agentId)) {
      throw new Error(`Domain agent factory already registered: ${agentId}`);
    }
    this.agentFactories.set(agentId, factory);

    if (initialize) {
      const agent = factory(this.modelRouter);
      this.registerAgent(agent, { replace });
    }
  }

  registerAgent(agent: BaseAgent, options: { replace?: boolean } = {}): void {
    const replace = options.replace === true;
    if (!replace && this.agents.has(agent.config.id)) {
      throw new Error(`Domain agent already registered: ${agent.config.id}`);
    }
    this.agents.set(agent.config.id, agent);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  unregisterFactory(agentId: string): void {
    this.agentFactories.delete(agentId);
    this.agents.delete(agentId);
  }

  getRegisteredFactoryIds(): string[] {
    return Array.from(this.agentFactories.keys());
  }

  /**
   * Initialize all domain agents
   */
  initialize(agentIds?: string[]): void {
    const idsToInitialize = Array.isArray(agentIds) && agentIds.length > 0
      ? agentIds
      : this.getRegisteredFactoryIds();

    for (const agentId of idsToInitialize) {
      const factory = this.agentFactories.get(agentId);
      if (!factory) continue;
      if (this.agents.has(agentId)) continue;
      this.agents.set(agentId, factory(this.modelRouter));
    }

    console.log(`[DomainAgentRegistry] Initialized ${this.agents.size} domain agents`);
  }

  /**
   * Get agent by ID
   */
  get(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agents
   */
  getAll(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get agent for a specific domain
   */
  getForDomain(domain: string): BaseAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.config.domain === domain) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Get agents that can handle a specific topic
   */
  getAgentsForTopic(topic: string): BaseAgent[] {
    const topicLower = topic.toLowerCase();
    const relevantAgents: BaseAgent[] = [];

    const topicMapping: Record<string, string[]> = {
      'frame': ['frame_agent'],
      'jank': ['frame_agent'],
      'scroll': ['frame_agent'],
      '滑动': ['frame_agent'],
      '掉帧': ['frame_agent'],
      '卡顿': ['frame_agent', 'cpu_agent'],
      'cpu': ['cpu_agent'],
      '调度': ['cpu_agent'],
      'binder': ['binder_agent'],
      'ipc': ['binder_agent'],
      '锁': ['binder_agent'],
      'memory': ['memory_agent'],
      '内存': ['memory_agent'],
      'gc': ['memory_agent'],
      'lmk': ['memory_agent'],
      'startup': ['startup_agent'],
      '启动': ['startup_agent'],
      'launch': ['startup_agent'],
      'click': ['interaction_agent'],
      '点击': ['interaction_agent'],
      '响应': ['interaction_agent'],
      'anr': ['anr_agent'],
      '无响应': ['anr_agent'],
      'thermal': ['system_agent'],
      '热': ['system_agent'],
      'io': ['system_agent'],
    };

    for (const [keyword, agentIds] of Object.entries(topicMapping)) {
      if (topicLower.includes(keyword)) {
        for (const agentId of agentIds) {
          const agent = this.agents.get(agentId);
          if (agent && !relevantAgents.includes(agent)) {
            relevantAgents.push(agent);
          }
        }
      }
    }

    return relevantAgents;
  }

  /**
   * Get descriptions of all agents for LLM
   */
  getAgentDescriptionsForLLM(): string {
    return Array.from(this.agents.values())
      .map(a => `- ${a.config.id}: ${a.config.name} - ${a.config.description}`)
      .join('\n');
  }
}

/**
 * Create a domain agent registry
 */
export function createDomainAgentRegistry(modelRouter: ModelRouter): DomainAgentRegistry {
  return createDomainAgentRegistryWithOptions(modelRouter);
}

export function createDomainAgentRegistryWithOptions(
  modelRouter: ModelRouter,
  options: CreateDomainAgentRegistryOptions = {}
): DomainAgentRegistry {
  const registry = new DomainAgentRegistry(modelRouter);
  const {
    extraFactories = {},
    disabledAgentIds = [],
    initialize = true,
  } = options;

  for (const [agentId, factory] of Object.entries(extraFactories)) {
    registry.registerFactory(agentId, factory, { replace: false, initialize: false });
  }

  if (initialize) {
    const disabled = new Set(disabledAgentIds);
    const enabledAgentIds = registry
      .getRegisteredFactoryIds()
      .filter(agentId => !disabled.has(agentId));
    registry.initialize(enabledAgentIds);
  }

  return registry;
}