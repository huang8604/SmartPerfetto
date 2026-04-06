// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Module Expert Invoker
 *
 * Bridge between Cross-Domain Experts and Module Skills (YAML).
 * Handles:
 * - Translating ModuleQuery into skill execution
 * - Extracting structured findings and suggestions from results
 * - Managing dialogue context and parameter passing
 *
 * This is the key integration point that allows TypeScript cross-domain experts
 * to leverage the existing YAML skill system.
 */

import { EventEmitter } from 'events';
import {
  ModuleQuery,
  ModuleResponse,
  ModuleFinding,
  ModuleSuggestion,
  DialogueContext,
} from './types';
import {
  SkillDefinition,
  SkillExecutionContext,
  DiagnosticResult,
  DisplayResult,
} from '../../../services/skillEngine/types';
import {
  SkillExecutor,
  extractFindings,
  extractSuggestions,
  ExtractedFinding,
  ExtractedSuggestion,
} from '../../../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../../../services/skillEngine/skillLoader';
import logger from '../../../utils/logger';
import {
  LayeredSkillResult,
  isValidDisplayLayer,
  VALID_DISPLAY_LAYERS,
  DiagnosticFinding,
  DataEnvelope,
  layeredResultToEnvelopes,
  generateEventId,
} from '../../../types/dataContract';

/**
 * Configuration for ModuleExpertInvoker
 */
export interface ModuleExpertInvokerConfig {
  /** Enable result caching */
  enableCache?: boolean;
  /** Cache TTL in ms */
  cacheTtlMs?: number;
  /** Default timeout for skill execution */
  defaultTimeoutMs?: number;
  /** Whether to emit events */
  emitEvents?: boolean;
  /**
   * Use v2.0 DataEnvelope format for SSE events
   * When true, emits 'data' events with DataEnvelope instead of 'skill_data' with LayeredSkillResult
   * Default: false (backward compatible)
   */
  useDataEnvelopeFormat?: boolean;
}

/**
 * Cache entry for skill results
 */
interface CacheEntry {
  response: ModuleResponse;
  expiresAt: number;
}

/**
 * ModuleExpertInvoker - Bridges cross-domain experts to module skills
 */
export class ModuleExpertInvoker extends EventEmitter {
  private skillExecutor: SkillExecutor;
  private cache: Map<string, CacheEntry> = new Map();
  private config: Required<ModuleExpertInvokerConfig>;

  constructor(
    traceProcessorService: any,
    aiService?: any,
    config: ModuleExpertInvokerConfig = {}
  ) {
    super();

    this.config = {
      enableCache: config.enableCache ?? true,
      cacheTtlMs: config.cacheTtlMs ?? 30000, // 30 seconds default
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60000, // 60 seconds default
      emitEvents: config.emitEvents ?? true,
      useDataEnvelopeFormat: config.useDataEnvelopeFormat ?? false, // backward compatible default
    };

    // Create skill executor with event forwarding
    this.skillExecutor = new SkillExecutor(
      traceProcessorService,
      aiService,
      (event) => {
        if (this.config.emitEvents) {
          this.emit('skill_event', event);
        }
      }
    );

    // Register all skills from the registry
    const allSkills = skillRegistry.getAllSkills();
    this.skillExecutor.registerSkills(allSkills);

    logger.info('ModuleExpertInvoker', `Initialized with ${allSkills.length} skills`);
  }

  /**
   * Invoke a module skill with a structured query
   */
  async invoke(query: ModuleQuery): Promise<ModuleResponse> {
    const startTime = Date.now();

    // Check cache first
    if (this.config.enableCache) {
      const cached = this.getCachedResponse(query);
      if (cached) {
        logger.debug('ModuleExpertInvoker', `Cache hit for ${query.targetModule}`);
        return { ...cached, queryId: query.queryId };
      }
    }

    // Get the target skill
    const skill = skillRegistry.getSkill(query.targetModule);
    if (!skill) {
      return this.createErrorResponse(
        query.queryId,
        `Module skill not found: ${query.targetModule}`,
        startTime
      );
    }

    // Emit query event
    this.emitEvent('module_query_start', {
      queryId: query.queryId,
      targetModule: query.targetModule,
      questionId: query.questionId,
    });

    try {
      // Build execution parameters
      const params = this.buildExecutionParams(query, skill);

      // Get trace ID from context
      const traceId = query.context?.traceId || '';
      if (!traceId) {
        return this.createErrorResponse(
          query.queryId,
          'No traceId provided in query context',
          startTime
        );
      }

      // Build inherited context from dialogue context
      const inherited = this.buildInheritedContext(query.context);

      // Execute the skill
      const result = await this.skillExecutor.execute(
        query.targetModule,
        traceId,
        params,
        inherited
      );

      // Build execution context for findings/suggestions extraction
      const execContext: SkillExecutionContext = {
        traceId,
        params,
        inherited,
        results: result.rawResults || {},
        variables: {},
        packageName: query.context?.packageName,
      };

      // Extract structured findings
      // NOTE: If dialogue.findingsSchema is missing, fallback to diagnostics
      const findings = this.extractModuleFindings(
        skill,
        execContext,
        result.rawResults || {},
        result.diagnostics || []
      );

      // Extract suggestions for follow-up
      const suggestions = this.extractModuleSuggestions(
        skill,
        execContext,
        result.rawResults || {}
      );

      // Build response
      const response: ModuleResponse = {
        queryId: query.queryId,
        success: result.success,
        data: this.flattenResultData(result.rawResults || {}),
        findings,
        suggestions,
        confidence: this.calculateResponseConfidence(result, findings),
        executionTimeMs: Date.now() - startTime,
        error: result.error,
      };

      // Cache the response
      if (this.config.enableCache && response.success) {
        this.cacheResponse(query, response);
      }

      // Emit completion event
      this.emitEvent('module_query_complete', {
        queryId: query.queryId,
        targetModule: query.targetModule,
        success: response.success,
        findingsCount: findings.length,
        suggestionsCount: suggestions.length,
        executionTimeMs: response.executionTimeMs,
      });

      // Emit skill data event for SSE streaming
      // Uses the unified data contract for consistency across backend/frontend/reports
      if (result.displayResults && result.displayResults.length > 0 && this.config.emitEvents) {
        const layeredResult = this.buildLayeredSkillResult(
          skill.name,
          skill.meta?.display_name || skill.name,
          result.displayResults,
          result.diagnostics || [],
          result.executionTimeMs
        );

        if (this.config.useDataEnvelopeFormat) {
          // v2.0 format: emit 'data' event with DataEnvelope(s)
          const envelopes = layeredResultToEnvelopes(layeredResult);
          this.emit('skill_event', {
            type: 'data',
            id: generateEventId(skill.name),
            timestamp: Date.now(),
            data: envelopes,
          });
          logger.debug('ModuleExpertInvoker', `Emitted v2.0 data event for ${skill.name}: ${envelopes.length} envelopes`);
        } else {
          // Legacy format: emit 'skill_data' event with LayeredSkillResult
          this.emit('skill_event', {
            type: 'skill_data',
            timestamp: Date.now(),
            data: layeredResult,
          });
          logger.debug('ModuleExpertInvoker', `Emitted skill_data for ${skill.name}: overview=${Object.keys(layeredResult.layers.overview || {}).length}, list=${Object.keys(layeredResult.layers.list || {}).length}, deep=${Object.keys(layeredResult.layers.deep || {}).length}`);
        }
      }

      return response;

    } catch (error: any) {
      console.error(`[ModuleExpertInvoker] Error invoking ${query.targetModule}:`, error);

      this.emitEvent('module_query_error', {
        queryId: query.queryId,
        targetModule: query.targetModule,
        error: error.message,
      });

      return this.createErrorResponse(query.queryId, error.message, startTime);
    }
  }

  /**
   * Invoke multiple modules in parallel
   */
  async invokeParallel(queries: ModuleQuery[]): Promise<ModuleResponse[]> {
    const promises = queries.map(q => this.invoke(q));
    return Promise.all(promises);
  }

  /**
   * Get available capabilities for a module
   */
  getModuleCapabilities(moduleName: string): string[] {
    const skill = skillRegistry.getSkill(moduleName);
    if (!skill?.dialogue?.capabilities) {
      return [];
    }
    return skill.dialogue.capabilities.map(c => c.id);
  }

  /**
   * Check if a module can answer a specific question type
   */
  canAnswer(moduleName: string, questionId: string): boolean {
    const skill = skillRegistry.getSkill(moduleName);
    if (!skill?.dialogue?.capabilities) {
      return false;
    }
    return skill.dialogue.capabilities.some(c => c.id === questionId);
  }

  /**
   * Get required parameters for a question
   */
  getRequiredParams(moduleName: string, questionId: string): string[] {
    const skill = skillRegistry.getSkill(moduleName);
    if (!skill?.dialogue?.capabilities) {
      return [];
    }
    const cap = skill.dialogue.capabilities.find(c => c.id === questionId);
    return cap?.requiredParams || [];
  }

  /**
   * Clear the response cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Build execution parameters from query
   */
  private buildExecutionParams(
    query: ModuleQuery,
    skill: SkillDefinition
  ): Record<string, any> {
    const params: Record<string, any> = { ...query.params };

    // Add time range if specified
    if (query.timeRange) {
      params.start_ts = query.timeRange.start;
      params.end_ts = query.timeRange.end;
    }

    // Add package name from context if not in params
    if (!params.package && query.context?.packageName) {
      params.package = query.context.packageName;
    }

    // Validate required inputs
    if (skill.inputs) {
      for (const input of skill.inputs) {
        if (input.required && params[input.name] === undefined) {
          if (input.default !== undefined) {
            params[input.name] = input.default;
          }
        }
      }
    }

    return params;
  }

  /**
   * Build inherited context from dialogue context
   */
  private buildInheritedContext(
    dialogueContext?: DialogueContext
  ): Record<string, any> {
    if (!dialogueContext) {
      return {};
    }

    return {
      ...dialogueContext.variables,
      sessionId: dialogueContext.sessionId,
      packageName: dialogueContext.packageName,
      turnNumber: dialogueContext.turnNumber,
    };
  }

  /**
   * Extract structured findings from skill results
   *
   * Extraction strategy:
   * 1. First try dialogue.findingsSchema (for module experts with explicit schema)
   * 2. Fallback to diagnostics (for composite skills with diagnostic rules)
   */
  private extractModuleFindings(
    skill: SkillDefinition,
    context: SkillExecutionContext,
    stepResults: Record<string, any>,
    diagnostics: DiagnosticResult[] = []
  ): ModuleFinding[] {
    // Strategy 1: Use the schema-based extraction if available
    if (skill.dialogue?.findingsSchema && skill.dialogue.findingsSchema.length > 0) {
      const extracted = extractFindings(
        skill.name,
        skill.dialogue.findingsSchema,
        context,
        stepResults
      );

      if (extracted.length > 0) {
        return extracted.map(f => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          description: f.description,
          evidence: f.evidence,
          sourceModule: f.sourceModule,
          confidence: f.confidence,
        }));
      }
    }

    // Strategy 2: Fallback to diagnostics for composite skills
    // Composite skills use DiagnosticStep with rules instead of dialogue.findingsSchema
    if (diagnostics.length > 0) {
      logger.debug('ModuleExpertInvoker', `Using diagnostics fallback for ${skill.name}: ${diagnostics.length} findings`);
      return diagnostics.map(d => ({
        id: `${skill.name}_${d.id}`,
        severity: d.severity,
        title: d.diagnosis,
        description: d.suggestions?.join('; '),
        evidence: d.evidence || {},
        sourceModule: skill.name,
        confidence: d.confidence,
      }));
    }

    // Strategy 3: Auto-detect critical data patterns in step results
    // This handles cases where neither schema nor diagnostics exist but data is present
    const autoFindings = this.autoDetectFindings(skill.name, stepResults);
    if (autoFindings.length > 0) {
      logger.info('ModuleExpertInvoker', `Auto-detected ${autoFindings.length} findings for ${skill.name}`);
    }

    return autoFindings;
  }

  /**
   * Unwrap StepResult / nested SkillExecutionResult payloads into row data.
   * This keeps module extraction resilient when a step is switched to `type: skill`.
   */
  private unwrapStepData(value: any): any {
    if (!value || typeof value !== 'object') return value;

    const maybe = value as Record<string, any>;
    const isStepResult =
      typeof maybe.stepId === 'string' &&
      typeof maybe.success === 'boolean' &&
      Object.prototype.hasOwnProperty.call(maybe, 'data');
    if (isStepResult) {
      return this.unwrapStepData(maybe.data);
    }

    const rawResults = maybe.rawResults;
    if (rawResults && typeof rawResults === 'object') {
      if (Object.prototype.hasOwnProperty.call(maybe, 'data')) {
        return this.unwrapStepData(maybe.data);
      }

      if ((rawResults as any).root?.data !== undefined) {
        return this.unwrapStepData((rawResults as any).root.data);
      }

      for (const step of Object.values(rawResults as Record<string, any>)) {
        if (step && typeof step === 'object' && Object.prototype.hasOwnProperty.call(step, 'data')) {
          return this.unwrapStepData((step as any).data);
        }
      }
    }

    return value;
  }

  /**
   * Auto-detect findings from step results
   * Looks for common patterns that indicate performance issues
   */
  private autoDetectFindings(
    skillName: string,
    stepResults: Record<string, any>
  ): ModuleFinding[] {
    const findings: ModuleFinding[] = [];

    for (const [stepId, stepResult] of Object.entries(stepResults)) {
      const data = this.unwrapStepData(stepResult);
      if (!Array.isArray(data)) continue;

      // Pattern 1: Jank frame detection (for scrolling_analysis)
      if (stepId.includes('jank') || stepId.includes('frame')) {
        const jankFrames = data.filter((row: any) =>
          row.jank_type && row.jank_type !== 'None'
        );

        if (jankFrames.length > 0) {
          findings.push({
            id: `${skillName}_${stepId}_jank`,
            severity: jankFrames.length > 10 ? 'critical' : 'warning',
            title: `检测到 ${jankFrames.length} 个卡顿帧`,
            description: `在 ${stepId} 步骤中发现卡顿帧数据`,
            evidence: {
              total_jank_frames: jankFrames.length,
              sample: jankFrames.slice(0, 3),
            },
            sourceModule: skillName,
            confidence: 0.9,
          });
        }
      }

      // Pattern 2: Performance summary with jank rate
      if (stepId.includes('summary') || stepId.includes('performance')) {
        const summaryRow = data[0];
        if (summaryRow) {
          const jankRate = summaryRow.app_jank_rate || summaryRow.jank_rate || 0;
          const jankCount = summaryRow.app_jank_count || summaryRow.jank_count || summaryRow.janky_frames || 0;

          if (jankRate > 5 || jankCount > 5) {
            findings.push({
              id: `${skillName}_${stepId}_high_jank_rate`,
              severity: jankRate > 15 || jankCount > 20 ? 'critical' : 'warning',
              title: `掉帧率 ${jankRate.toFixed(1)}% (${jankCount} 帧)`,
              description: `性能指标显示存在明显卡顿问题`,
              evidence: {
                jank_rate: jankRate,
                jank_count: jankCount,
                raw_data: summaryRow,
              },
              sourceModule: skillName,
              confidence: 0.85,
            });
          }
        }
      }
    }

    return findings;
  }

  /**
   * Extract suggestions from skill results
   */
  private extractModuleSuggestions(
    skill: SkillDefinition,
    context: SkillExecutionContext,
    stepResults: Record<string, any>
  ): ModuleSuggestion[] {
    // Use the schema-based extraction
    const extracted = extractSuggestions(
      skill.name,
      skill.dialogue?.suggestionsSchema,
      context,
      stepResults
    );

    // Convert ExtractedSuggestion to ModuleSuggestion
    return extracted.map(s => ({
      id: s.id,
      targetModule: s.targetModule,
      questionTemplate: s.questionTemplate,
      params: s.params,
      priority: s.priority,
      reason: s.reason,
    }));
  }

  /**
   * Flatten result data for easier access
   */
  private flattenResultData(
    rawResults: Record<string, any>
  ): Record<string, any> {
    const flattened: Record<string, any> = {};

    for (const [stepId, stepResult] of Object.entries(rawResults)) {
      if (stepResult !== undefined) {
        flattened[stepId] = this.unwrapStepData(stepResult);
      }
    }

    return flattened;
  }

  /**
   * Calculate confidence score for response
   */
  private calculateResponseConfidence(
    result: any,
    findings: ModuleFinding[]
  ): number {
    if (!result.success) {
      return 0;
    }

    // Base confidence from having data
    let confidence = 0.5;

    // Boost from findings
    if (findings.length > 0) {
      const avgFindingConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
      confidence = Math.max(confidence, avgFindingConfidence);
    }

    // Boost from diagnostics
    if (result.diagnostics && result.diagnostics.length > 0) {
      const avgDiagConfidence = result.diagnostics.reduce(
        (sum: number, d: any) => sum + (d.confidence || 0.5),
        0
      ) / result.diagnostics.length;
      confidence = Math.max(confidence, avgDiagConfidence);
    }

    return Math.min(1, confidence);
  }

  /**
   * Create error response
   */
  private createErrorResponse(
    queryId: string,
    error: string,
    startTime: number
  ): ModuleResponse {
    return {
      queryId,
      success: false,
      findings: [],
      suggestions: [],
      confidence: 0,
      executionTimeMs: Date.now() - startTime,
      error,
    };
  }

  /**
   * Generate cache key for a query
   */
  private getCacheKey(query: ModuleQuery): string {
    return JSON.stringify({
      module: query.targetModule,
      question: query.questionId,
      params: query.params,
      traceId: query.context?.traceId,
    });
  }

  /**
   * Get cached response if available and not expired
   */
  private getCachedResponse(query: ModuleQuery): ModuleResponse | null {
    const key = this.getCacheKey(query);
    const entry = this.cache.get(key);

    if (entry && entry.expiresAt > Date.now()) {
      return entry.response;
    }

    // Clean up expired entry
    if (entry) {
      this.cache.delete(key);
    }

    return null;
  }

  /**
   * Cache a response
   */
  private cacheResponse(query: ModuleQuery, response: ModuleResponse): void {
    const key = this.getCacheKey(query);
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });
  }

  /**
   * Emit event if events are enabled
   */
  private emitEvent(type: string, data: Record<string, any>): void {
    if (this.config.emitEvents) {
      this.emit(type, { type, timestamp: Date.now(), ...data });
    }
  }

  /**
   * Organize displayResults into a LayeredSkillResult structure
   *
   * Uses the shared data contract types for consistency across
   * backend, frontend, and HTML report generation.
   *
   * @param skillId - The skill identifier
   * @param skillName - Human-readable skill name
   * @param displayResults - Array of DisplayResult from skill execution
   * @param diagnostics - Array of DiagnosticResult findings
   * @param executionTimeMs - Execution time in milliseconds
   * @returns LayeredSkillResult conforming to the data contract
   */
  private buildLayeredSkillResult(
    skillId: string,
    skillName: string,
    displayResults: DisplayResult[],
    diagnostics: DiagnosticResult[] = [],
    executionTimeMs: number = 0
  ): LayeredSkillResult {
    // Initialize layers with proper structure (keyed by stepId, not arrays)
    const layers: LayeredSkillResult['layers'] = {
      overview: {},
      list: {},
      session: {},
      deep: {},
    };

    // Organize results by layer
    for (const result of displayResults) {
      // Validate and normalize layer value using data contract
      const rawLayer = result.layer || 'list';
      const layer = isValidDisplayLayer(rawLayer) ? rawLayer : 'list';

      // Store result in appropriate layer, keyed by stepId
      layers[layer]![result.stepId] = {
        stepId: result.stepId,
        title: result.title,
        level: result.level,
        layer: layer,
        format: result.format,
        data: result.data,
        highlight: result.highlight,
        sql: result.sql,
      };
    }

    // Convert diagnostics to data contract format
    const contractDiagnostics: DiagnosticFinding[] = diagnostics.map(d => ({
      id: d.id,
      severity: d.severity,
      title: d.diagnosis,
      description: d.suggestions?.join('; '),
      evidence: d.evidence,
      suggestions: d.suggestions,
      confidence: typeof d.confidence === 'number' ? d.confidence : 0.5,
      sourceModule: skillId,
    }));

    return {
      skillId,
      skillName,
      layers,
      diagnostics: contractDiagnostics,
      metadata: {
        executedAt: new Date().toISOString(),
        executionTimeMs,
      },
    };
  }

  /**
   * @deprecated Use buildLayeredSkillResult instead
   * Kept for backward compatibility during transition
   */
  private organizeResultsIntoLayers(
    displayResults: DisplayResult[]
  ): Record<string, any> {
    const layers: Record<string, any[]> = {
      overview: [],
      list: [],
      deep: [],
    };

    for (const result of displayResults) {
      const rawLayer = result.layer || 'list';
      const layer = isValidDisplayLayer(rawLayer) ? rawLayer : 'list';

      const resultData = {
        stepId: result.stepId,
        title: result.title,
        format: result.format,
        data: result.data,
        highlight: result.highlight,
        sql: result.sql,
      };

      if (layer === 'overview') {
        layers.overview.push(resultData);
      } else if (layer === 'session' || layer === 'deep') {
        layers.deep.push(resultData);
      } else {
        layers.list.push(resultData);
      }
    }

    return layers;
  }
}

/**
 * Factory function to create a ModuleExpertInvoker
 * NOTE: This is now async to ensure skill registry is initialized before creating the invoker
 */
export async function createModuleExpertInvoker(
  traceProcessorService: any,
  aiService?: any,
  config?: ModuleExpertInvokerConfig
): Promise<ModuleExpertInvoker> {
  // CRITICAL: Ensure skill registry is initialized before creating the invoker
  await ensureSkillRegistryInitialized();
  return new ModuleExpertInvoker(traceProcessorService, aiService, config);
}