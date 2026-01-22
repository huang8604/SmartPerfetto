/**
 * SmartPerfetto Base Agent
 *
 * Phase 2.1: Abstract base class for all AI domain agents
 *
 * This class provides the foundation for AI-driven domain agents that:
 * 1. Use Skills as tools through AI reasoning
 * 2. Can request information from other agents
 * 3. Build and verify hypotheses
 * 4. Generate evidence-backed findings
 *
 * The Think-Act-Reflect loop:
 * 1. Understand: Parse task and build understanding
 * 2. Plan: Decide which tools to use
 * 3. Execute: Run tools and collect results
 * 4. Reflect: Evaluate results and decide next steps
 * 5. Respond: Generate response with findings
 */

import { EventEmitter } from 'events';
import {
  AgentConfig,
  AgentTask,
  AgentTaskContext,
  AgentResponse,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
  HypothesisUpdate,
  Evidence,
  InterAgentQuestion,
  ReasoningStep,
  SharedAgentContext,
  createHypothesisId,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';

// =============================================================================
// Types
// =============================================================================

/**
 * Understanding of a task
 */
export interface TaskUnderstanding {
  /** Main objective */
  objective: string;
  /** Key questions to answer */
  questions: string[];
  /** Relevant domain areas */
  relevantAreas: string[];
  /** Recommended tools to use */
  recommendedTools: string[];
  /** Constraints or requirements */
  constraints: string[];
  /** Confidence in understanding */
  confidence: number;
}

/**
 * Execution plan
 */
export interface ExecutionPlan {
  /** Sequence of tool calls */
  steps: ExecutionStep[];
  /** Expected outcomes */
  expectedOutcomes: string[];
  /** Estimated execution time */
  estimatedTimeMs: number;
  /** Plan confidence */
  confidence: number;
}

/**
 * Single execution step
 */
export interface ExecutionStep {
  stepNumber: number;
  toolName: string;
  params: Record<string, any>;
  purpose: string;
  dependsOn?: number[];
}

/**
 * Result of executing the plan
 */
export interface ExecutionResult {
  steps: ExecutionStepResult[];
  findings: Finding[];
  success: boolean;
  totalTimeMs: number;
}

/**
 * Result of a single execution step
 */
export interface ExecutionStepResult {
  stepNumber: number;
  toolName: string;
  result: AgentToolResult;
  observations: string[];
}

/**
 * Reflection on execution results
 */
export interface Reflection {
  /** What was learned */
  insights: string[];
  /** Whether objectives were met */
  objectivesMet: boolean;
  /** Confidence in findings */
  findingsConfidence: number;
  /** Gaps in analysis */
  gaps: string[];
  /** Suggested next steps */
  nextSteps: string[];
  /** Hypothesis updates */
  hypothesisUpdates: HypothesisUpdate[];
  /** Questions for other agents */
  questionsForOthers: InterAgentQuestion[];
}

// =============================================================================
// Base Agent Abstract Class
// =============================================================================

/**
 * Abstract base class for domain-specific AI agents
 *
 * Each domain agent (Frame, CPU, Memory, Binder, etc.) extends this class
 * and provides:
 * 1. Domain-specific tools (wrapped Skills)
 * 2. Domain-specific reasoning prompts
 * 3. Domain-specific hypothesis generation
 */
export abstract class BaseAgent extends EventEmitter {
  /** Agent configuration */
  readonly config: AgentConfig;
  /** Model router for LLM calls */
  protected modelRouter: ModelRouter;
  /** Available tools */
  protected tools: Map<string, AgentTool>;
  /** Current shared context */
  protected sharedContext: SharedAgentContext | null = null;
  /** Reasoning trace */
  protected reasoningTrace: ReasoningStep[] = [];
  /** Current iteration */
  protected currentIteration: number = 0;

  constructor(config: AgentConfig, modelRouter: ModelRouter) {
    super();
    this.config = config;
    this.modelRouter = modelRouter;
    this.tools = new Map();

    // Register tools
    for (const tool of config.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  // ==========================================================================
  // Abstract Methods - Must be implemented by domain agents
  // ==========================================================================

  /**
   * Build domain-specific system prompt for understanding
   */
  protected abstract buildUnderstandingPrompt(task: AgentTask): string;

  /**
   * Build domain-specific system prompt for planning
   */
  protected abstract buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string;

  /**
   * Build domain-specific system prompt for reflection
   */
  protected abstract buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string;

  /**
   * Generate domain-specific hypotheses based on findings
   */
  protected abstract generateHypotheses(findings: Finding[], task: AgentTask): Promise<Hypothesis[]>;

  /**
   * Get domain-specific tool recommendations
   */
  protected abstract getRecommendedTools(context: AgentTaskContext): string[];

  // ==========================================================================
  // Core Agent Loop
  // ==========================================================================

  /**
   * Execute a task through the Think-Act-Reflect loop
   */
  async executeTask(task: AgentTask, sharedContext: SharedAgentContext): Promise<AgentResponse> {
    const startTime = Date.now();
    this.sharedContext = sharedContext;
    this.reasoningTrace = [];
    this.currentIteration = 0;

    this.emit('task_started', { agentId: this.config.id, taskId: task.id });

    try {
      // 1. Understand the task
      this.addReasoningStep('observation', 'Analyzing task requirements');
      const understanding = await this.understand(task);
      this.emit('understanding_complete', { agentId: this.config.id, understanding });

      // 2. Plan execution
      this.addReasoningStep('analysis', 'Creating execution plan');
      const plan = await this.plan(understanding, task);
      this.emit('plan_created', { agentId: this.config.id, plan });

      // 3. Execute plan
      this.addReasoningStep('action', `Executing ${plan.steps.length} steps`);
      const result = await this.execute(plan, task);
      this.emit('execution_complete', { agentId: this.config.id, result });

      // 4. Reflect on results
      this.addReasoningStep('analysis', 'Reflecting on results');
      const reflection = await this.reflect(result, task);
      this.emit('reflection_complete', { agentId: this.config.id, reflection });

      // 5. Generate response
      const response = await this.respond(reflection, result, task, startTime);
      this.emit('task_completed', { agentId: this.config.id, response });

      return response;

    } catch (error: any) {
      this.emit('task_failed', { agentId: this.config.id, taskId: task.id, error: error.message });

      return {
        agentId: this.config.id,
        taskId: task.id,
        success: false,
        findings: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        reasoning: this.reasoningTrace,
      };
    }
  }

  // ==========================================================================
  // Think-Act-Reflect Steps
  // ==========================================================================

  /**
   * Step 1: Understand the task
   */
  protected async understand(task: AgentTask): Promise<TaskUnderstanding> {
    const prompt = this.buildUnderstandingPrompt(task);

    const response = await this.modelRouter.callWithFallback(prompt, 'intent_understanding');

    try {
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          objective: parsed.objective || task.description,
          questions: parsed.questions || [],
          relevantAreas: parsed.relevantAreas || [],
          recommendedTools: parsed.recommendedTools || this.getRecommendedTools(task.context),
          constraints: parsed.constraints || [],
          confidence: parsed.confidence || 0.7,
        };
      }
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse understanding response`);
    }

    // Fallback to basic understanding
    return {
      objective: task.description,
      questions: [],
      relevantAreas: [this.config.domain],
      recommendedTools: this.getRecommendedTools(task.context),
      constraints: [],
      confidence: 0.5,
    };
  }

  /**
   * Step 2: Plan execution
   */
  protected async plan(understanding: TaskUnderstanding, task: AgentTask): Promise<ExecutionPlan> {
    const prompt = this.buildPlanningPrompt(understanding, task);

    const response = await this.modelRouter.callWithFallback(prompt, 'planning');

    try {
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          steps: (parsed.steps || []).map((s: any, i: number) => ({
            stepNumber: i + 1,
            toolName: s.toolName || s.tool,
            params: s.params || {},
            purpose: s.purpose || `Execute ${s.toolName || s.tool}`,
            dependsOn: s.dependsOn,
          })),
          expectedOutcomes: parsed.expectedOutcomes || [],
          estimatedTimeMs: parsed.estimatedTimeMs || 30000,
          confidence: parsed.confidence || 0.7,
        };
      }
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse planning response`);
    }

    // Fallback to using recommended tools
    return {
      steps: understanding.recommendedTools.map((toolName, i) => ({
        stepNumber: i + 1,
        toolName,
        params: {},
        purpose: `Execute ${toolName}`,
      })),
      expectedOutcomes: [`Analyze ${this.config.domain}`],
      estimatedTimeMs: 30000,
      confidence: 0.5,
    };
  }

  /**
   * Step 3: Execute the plan
   */
  protected async execute(plan: ExecutionPlan, task: AgentTask): Promise<ExecutionResult> {
    const stepResults: ExecutionStepResult[] = [];
    const allFindings: Finding[] = [];
    let success = true;

    // Build tool context
    const toolContext: AgentToolContext = {
      sessionId: this.sharedContext?.sessionId || '',
      traceId: this.sharedContext?.traceId || '',
      traceProcessorService: task.context.additionalData?.traceProcessorService,
      packageName: task.context.additionalData?.packageName,
      timeRange: task.context.timeRange,
      aiService: task.context.additionalData?.aiService,
    };

    // Execute each step
    for (const step of plan.steps) {
      // Check dependencies
      if (step.dependsOn) {
        const pendingDeps = step.dependsOn.filter(dep =>
          !stepResults.find(r => r.stepNumber === dep && r.result.success)
        );
        if (pendingDeps.length > 0) {
          console.warn(`[${this.config.id}] Skipping step ${step.stepNumber} - dependencies not met`);
          continue;
        }
      }

      // Get tool
      const tool = this.tools.get(step.toolName);
      if (!tool) {
        console.warn(`[${this.config.id}] Tool not found: ${step.toolName}`);
        stepResults.push({
          stepNumber: step.stepNumber,
          toolName: step.toolName,
          result: { success: false, error: `Tool not found: ${step.toolName}`, executionTimeMs: 0 },
          observations: [`Tool ${step.toolName} not available`],
        });
        continue;
      }

      // Execute tool
      this.emit('tool_executing', { agentId: this.config.id, toolName: step.toolName, step: step.stepNumber });

      const result = await tool.execute(step.params, toolContext);

      this.emit('tool_completed', { agentId: this.config.id, toolName: step.toolName, success: result.success });

      // Collect findings
      if (result.findings) {
        allFindings.push(...result.findings);
      }

      // Generate observations
      const observations = this.generateObservations(result);

      stepResults.push({
        stepNumber: step.stepNumber,
        toolName: step.toolName,
        result,
        observations,
      });

      if (!result.success) {
        success = false;
      }
    }

    return {
      steps: stepResults,
      findings: allFindings,
      success,
      totalTimeMs: stepResults.reduce((sum, r) => sum + r.result.executionTimeMs, 0),
    };
  }

  /**
   * Step 4: Reflect on results
   */
  protected async reflect(result: ExecutionResult, task: AgentTask): Promise<Reflection> {
    const prompt = this.buildReflectionPrompt(result, task);

    const response = await this.modelRouter.callWithFallback(prompt, 'evaluation');

    try {
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          insights: parsed.insights || [],
          objectivesMet: parsed.objectivesMet ?? result.success,
          findingsConfidence: parsed.findingsConfidence || 0.5,
          gaps: parsed.gaps || [],
          nextSteps: parsed.nextSteps || [],
          hypothesisUpdates: parsed.hypothesisUpdates || [],
          questionsForOthers: parsed.questionsForOthers || [],
        };
      }
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse reflection response`);
    }

    // Fallback reflection
    return {
      insights: result.steps.flatMap(s => s.observations),
      objectivesMet: result.success,
      findingsConfidence: result.success ? 0.6 : 0.3,
      gaps: [],
      nextSteps: [],
      hypothesisUpdates: [],
      questionsForOthers: [],
    };
  }

  /**
   * Step 5: Generate final response
   */
  protected async respond(
    reflection: Reflection,
    result: ExecutionResult,
    task: AgentTask,
    startTime: number
  ): Promise<AgentResponse> {
    // Generate hypotheses based on findings
    const hypotheses = await this.generateHypotheses(result.findings, task);

    // Convert hypotheses to updates
    const hypothesisUpdates: HypothesisUpdate[] = hypotheses.map(h => ({
      hypothesisId: h.id,
      action: 'support',
      newConfidence: h.confidence,
      reason: `Generated from ${this.config.id} analysis`,
    }));

    // Add reflection hypothesis updates
    hypothesisUpdates.push(...reflection.hypothesisUpdates);

    return {
      agentId: this.config.id,
      taskId: task.id,
      success: result.success,
      findings: result.findings,
      hypothesisUpdates,
      questionsForAgents: reflection.questionsForOthers,
      suggestions: reflection.nextSteps,
      confidence: reflection.findingsConfidence,
      executionTimeMs: Date.now() - startTime,
      toolResults: result.steps.map(s => s.result),
      reasoning: this.reasoningTrace,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Add a step to the reasoning trace
   */
  protected addReasoningStep(type: ReasoningStep['type'], content: string, confidence: number = 0.8): void {
    this.reasoningTrace.push({
      step: this.reasoningTrace.length + 1,
      type,
      content,
      confidence,
      timestamp: Date.now(),
    });
  }

  /**
   * Generate observations from a tool result
   */
  protected generateObservations(result: AgentToolResult): string[] {
    const observations: string[] = [];

    if (!result.success) {
      observations.push(`Tool execution failed: ${result.error}`);
      return observations;
    }

    if (result.findings && result.findings.length > 0) {
      observations.push(`Found ${result.findings.length} issues`);
      const critical = result.findings.filter(f => f.severity === 'critical').length;
      if (critical > 0) {
        observations.push(`${critical} critical issues identified`);
      }
    }

    if (result.data) {
      if (typeof result.data === 'object') {
        const keys = Object.keys(result.data);
        if (keys.length > 0) {
          observations.push(`Returned data with ${keys.length} fields`);
        }
      }
    }

    return observations;
  }

  /**
   * Create a hypothesis
   */
  protected createHypothesis(
    description: string,
    confidence: number,
    supportingEvidence: Evidence[] = []
  ): Hypothesis {
    return {
      id: createHypothesisId(),
      description,
      confidence,
      status: 'proposed',
      supportingEvidence,
      contradictingEvidence: [],
      proposedBy: this.config.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Get tool by name
   */
  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAllTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool descriptions for LLM
   */
  getToolDescriptionsForLLM(): string {
    return this.getAllTools()
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');
  }

  /**
   * Set shared context
   */
  setSharedContext(context: SharedAgentContext): void {
    this.sharedContext = context;
  }
}

export default BaseAgent;
