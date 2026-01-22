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

/**
 * Domain Agent Registry
 *
 * Manages instantiation and access to all domain agents
 */
export class DomainAgentRegistry {
  private agents: Map<string, BaseAgent> = new Map();
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * Initialize all domain agents
   */
  initialize(): void {
    this.agents.set('frame_agent', new FrameAgent(this.modelRouter));
    this.agents.set('cpu_agent', new CPUAgent(this.modelRouter));
    this.agents.set('binder_agent', new BinderAgent(this.modelRouter));
    this.agents.set('memory_agent', new MemoryAgent(this.modelRouter));
    this.agents.set('startup_agent', new StartupAgent(this.modelRouter));
    this.agents.set('interaction_agent', new InteractionAgent(this.modelRouter));
    this.agents.set('anr_agent', new ANRAgent(this.modelRouter));
    this.agents.set('system_agent', new SystemAgent(this.modelRouter));

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
  const registry = new DomainAgentRegistry(modelRouter);
  registry.initialize();
  return registry;
}
