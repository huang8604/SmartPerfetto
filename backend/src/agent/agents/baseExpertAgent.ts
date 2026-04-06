// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ExpertAgent,
  ExpertAgentConfig,
  ExpertResult,
  AnalysisContext,
  AgentState,
  AgentThought,
  AgentTrace,
  ToolCall,
  ToolResult,
  Finding,
  Diagnostic,
  Intent,
  ToolContext,
} from '../types';
import { getToolRegistry } from '../toolRegistry';

export interface LLMClient {
  complete(prompt: string): Promise<string>;
  completeJSON<T>(prompt: string): Promise<T>;
}

export abstract class BaseExpertAgent implements ExpertAgent {
  config: ExpertAgentConfig;
  protected llm: LLMClient;
  protected traceProcessor: any;
  protected traceProcessorService: any;
  protected currentTraceId: string | null = null;

  constructor(config: ExpertAgentConfig, llm: LLMClient) {
    this.config = config;
    this.llm = llm;
  }

  abstract canHandle(intent: Intent): boolean;
  protected abstract getSystemPrompt(): string;
  protected abstract getAnalysisGoals(context: AnalysisContext): string[];

  /**
   * Override this method to provide initial SQL queries to execute
   * before the main think-act loop. Results will be added to state.toolResults.
   */
  protected getInitialQueries?(): string[];

  async analyze(context: AnalysisContext): Promise<ExpertResult> {
    const startTime = Date.now();
    const trace: AgentTrace = {
      agentName: this.config.name,
      startTime,
      endTime: 0,
      thoughts: [],
      toolCalls: [],
    };

    const state: AgentState = {
      query: context.previousFindings?.join('; ') || '',
      context,
      thoughts: [],
      toolResults: [],
      findings: [],
      currentStep: 0,
      isComplete: false,
    };

    const findings: Finding[] = [];
    const findingTitles = new Set<string>(); // For de-duplication
    const diagnostics: Diagnostic[] = [];
    const suggestions: string[] = [];

    try {
      // Execute initial queries if defined by subclass
      const initialQueries = this.getInitialQueries?.();
      if (initialQueries && initialQueries.length > 0) {
        console.log(`[${this.config.name}] Executing ${initialQueries.length} initial queries`);
        for (const sql of initialQueries) {
          const toolCallStart = Date.now();
          const result = await this.executeTool('execute_sql', { sql }, context);
          const toolCall: ToolCall = {
            toolName: 'execute_sql',
            params: { sql },
            result,
            startTime: toolCallStart,
            endTime: Date.now(),
          };
          trace.toolCalls.push(toolCall);
          state.toolResults.push(result);

          if (result.success) {
            const newFindings = await this.extractFindings(result, 'execute_sql', state);
            // De-duplicate findings by title
            for (const f of newFindings) {
              if (!findingTitles.has(f.title)) {
                findingTitles.add(f.title);
                findings.push(f);
                state.findings.push(f.title);
              }
            }
          }
        }
        console.log(`[${this.config.name}] Initial queries completed, ${findings.length} unique findings extracted`);
      }

      while (!state.isComplete && state.currentStep < this.config.maxIterations) {
        const thought = await this.think(state);
        state.thoughts.push(thought);
        trace.thoughts.push(thought);

        if (thought.decision === 'conclude' || thought.confidence >= this.config.confidenceThreshold) {
          state.isComplete = true;
          break;
        }

        const toolCalls = await this.selectTools(thought, state);
        
        for (const { toolName, params } of toolCalls) {
          const toolCallStart = Date.now();
          const result = await this.executeTool(toolName, params, context);
          const toolCall: ToolCall = {
            toolName,
            params,
            result,
            startTime: toolCallStart,
            endTime: Date.now(),
          };
          trace.toolCalls.push(toolCall);
          state.toolResults.push(result);

          if (result.success) {
            const newFindings = await this.extractFindings(result, toolName, state);
            // De-duplicate findings by title
            for (const f of newFindings) {
              if (!findingTitles.has(f.title)) {
                findingTitles.add(f.title);
                findings.push(f);
                state.findings.push(f.title);
              }
            }
          }
        }

        state.currentStep++;
      }

      const conclusion = await this.generateConclusion(state, findings);
      suggestions.push(...conclusion.suggestions);
      diagnostics.push(...conclusion.diagnostics);

      trace.endTime = Date.now();

      return {
        agentName: this.config.name,
        findings,
        diagnostics,
        suggestions,
        confidence: this.calculateConfidence(state),
        executionTimeMs: Date.now() - startTime,
        trace,
      };
    } catch (error: any) {
      trace.endTime = Date.now();
      return {
        agentName: this.config.name,
        findings,
        diagnostics: [{
          id: 'error',
          condition: 'execution_error',
          matched: true,
          message: `Analysis failed: ${error.message}`,
          suggestions: [],
        }],
        suggestions,
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        trace,
      };
    }
  }

  protected async think(state: AgentState): Promise<AgentThought> {
    // Auto-conclude if we have enough findings from initial queries
    const hasGoodFindings = state.findings.length >= 3;
    const isLastStep = state.currentStep >= this.config.maxIterations - 1;

    if (hasGoodFindings || isLastStep) {
      console.log(`[${this.config.name}] Auto-concluding: findings=${state.findings.length}, step=${state.currentStep}`);
      return {
        step: state.currentStep + 1,
        observation: `Collected ${state.findings.length} findings from analysis`,
        reasoning: hasGoodFindings
          ? 'We have sufficient findings to answer the user query'
          : 'Reached maximum analysis steps, concluding with current findings',
        decision: 'conclude',
        confidence: Math.min(0.5 + state.findings.length * 0.1, 0.9),
      };
    }

    const prompt = `${this.getSystemPrompt()}

Current Analysis State:
- Step: ${state.currentStep + 1} of ${this.config.maxIterations}
- Findings so far: ${state.findings.length > 0 ? state.findings.join(', ') : 'None yet'}
- Tool results collected: ${state.toolResults.length}

IMPORTANT: If we already have 2+ findings that answer the user's question, you should CONCLUDE.
Only request more data if the current findings are insufficient to answer the query.

Analysis goals:
${this.getAnalysisGoals(state.context).map((g, i) => `${i + 1}. ${g}`).join('\n')}

Decide what to do next:
1. What have we observed?
2. Do we have enough information to conclude? (If yes, set decision to "conclude")
3. If not, what specific information is still missing?

Respond in JSON format:
{
  "observation": "what we've learned",
  "reasoning": "why we can conclude or need more info",
  "decision": "conclude" or "tool_call",
  "confidence": 0.0-1.0
}`;

    const response = await this.llm.completeJSON<{
      observation: string;
      reasoning: string;
      decision: string;
      confidence: number;
    }>(prompt);

    return {
      step: state.currentStep + 1,
      observation: response.observation,
      reasoning: response.reasoning,
      decision: response.decision,
      confidence: response.confidence,
    };
  }

  protected async selectTools(thought: AgentThought, state: AgentState): Promise<{ toolName: string; params: Record<string, any> }[]> {
    if (thought.decision === 'conclude') {
      return [];
    }

    const registry = getToolRegistry();
    const availableTools = this.config.tools
      .map(name => registry.get(name))
      .filter(Boolean)
      .map(t => t!.definition);

    const prompt = `Based on the analysis reasoning: "${thought.reasoning}"

Available tools:
${availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Context:
- Trace ID: ${state.context.traceId}
- Package: ${state.context.package || 'not specified'}
- Time range: ${state.context.timeRange ? `${state.context.timeRange.start} to ${state.context.timeRange.end}` : 'full trace'}

Select which tool(s) to call and with what parameters.
Respond in JSON format:
{
  "toolCalls": [
    { "toolName": "tool_name", "params": { ... } }
  ]
}`;

    const response = await this.llm.completeJSON<{
      toolCalls: { toolName: string; params: Record<string, any> }[];
    }>(prompt);

    return response.toolCalls || [];
  }

  protected async executeTool(toolName: string, params: Record<string, any>, context: AnalysisContext): Promise<ToolResult> {
    const registry = getToolRegistry();
    const tool = registry.get(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}`,
        executionTimeMs: 0,
      };
    }

    const toolContext: ToolContext = {
      traceId: context.traceId,
      traceProcessor: this.traceProcessor,
      traceProcessorService: this.traceProcessorService,
      package: context.package,
    };

    return tool.execute(params, toolContext);
  }

  protected async extractFindings(result: ToolResult, toolName: string, state: AgentState): Promise<Finding[]> {
    if (!result.success || !result.data) {
      return [];
    }

    const prompt = `Analyze this tool result and extract key findings:

Tool: ${toolName}
Result: ${JSON.stringify(result.data, null, 2)}

Context: ${state.context.package ? `Analyzing package ${state.context.package}` : 'General analysis'}

Extract findings in JSON format. IMPORTANT: If the result contains timestamp values (ts, start_ts, end_ts columns in nanoseconds), include them in timestampsNs array. Format timestamps in description using [[ts:NANOSECONDS]] syntax for clickable links.

{
  "findings": [
    {
      "category": "performance|error|warning|info",
      "severity": "info|warning|critical",
      "title": "brief title",
      "description": "detailed description with [[ts:123456789]] for timestamps",
      "evidence": ["relevant data points"],
      "timestampsNs": [123456789, 234567890]
    }
  ]
}`;

    try {
      const response = await this.llm.completeJSON<{
        findings: Array<{
          category: string;
          severity: 'info' | 'warning' | 'critical';
          title: string;
          description: string;
          evidence: any[];
          timestampsNs?: number[];
        }>;
      }>(prompt);

      return (response.findings || []).map((f, i) => ({
        id: `${toolName}_finding_${i}`,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
        evidence: f.evidence,
        timestampsNs: f.timestampsNs,
      }));
    } catch {
      return [];
    }
  }

  protected async generateConclusion(state: AgentState, findings: Finding[]): Promise<{
    suggestions: string[];
    diagnostics: Diagnostic[];
  }> {
    const prompt = `Based on the analysis findings, generate actionable suggestions and diagnostics.

Findings:
${findings.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n') || 'No significant findings'}

Analysis context:
- Domain: ${this.config.domain}
- Package: ${state.context.package || 'not specified'}

Generate conclusion in JSON format:
{
  "suggestions": ["actionable suggestion 1", "actionable suggestion 2"],
  "diagnostics": [
    {
      "id": "diag_1",
      "condition": "what was checked",
      "matched": true,
      "message": "what was found",
      "suggestions": ["how to fix"]
    }
  ]
}`;

    try {
      const response = await this.llm.completeJSON<{
        suggestions: string[];
        diagnostics: Array<{
          id: string;
          condition: string;
          matched: boolean;
          message: string;
          suggestions: string[];
        }>;
      }>(prompt);

      return {
        suggestions: response.suggestions || [],
        diagnostics: response.diagnostics || [],
      };
    } catch {
      return { suggestions: [], diagnostics: [] };
    }
  }

  protected calculateConfidence(state: AgentState): number {
    if (state.thoughts.length === 0) return 0;
    const lastThought = state.thoughts[state.thoughts.length - 1];
    return lastThought.confidence;
  }

  setTraceProcessor(tp: any): void {
    this.traceProcessor = tp;
  }

  setTraceProcessorService(service: any, traceId: string): void {
    this.traceProcessorService = service;
    this.currentTraceId = traceId;
  }
}