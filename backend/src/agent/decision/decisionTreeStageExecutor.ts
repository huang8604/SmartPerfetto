// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Decision Tree Stage Executor
 *
 * Wraps decision tree execution as a PipelineExecutor stage, allowing
 * decision trees to be used within the existing pipeline architecture.
 *
 * This enables a hybrid approach:
 * - Simple analyses can use linear stages
 * - Complex analyses (scrolling, launch) can use decision trees
 */

import { EventEmitter } from 'events';
import { getDecisionTreePostProcessingThresholds } from '../config/decisionThresholdManifest';
import { StageExecutor } from '../core/pipelineExecutor';
import { PipelineStage, SubAgentContext, SubAgentResult, Finding } from '../types';
import {
  DecisionTree,
  DecisionContext,
  DecisionTreeExecutionResult,
  ConclusionDefinition,
} from './types';
import { DecisionTreeExecutor } from './decisionTreeExecutor';
import { SkillExecutorAdapter } from './skillExecutorAdapter';
import { getDecisionTree } from './index';

const DECISION_POST_THRESHOLDS = getDecisionTreePostProcessingThresholds();

/**
 * Stage executor that runs a decision tree
 */
export class DecisionTreeStageExecutor extends EventEmitter implements StageExecutor {
  private treeExecutor: DecisionTreeExecutor;
  private skillAdapter: SkillExecutorAdapter;
  private targetTree: DecisionTree | null = null;

  constructor(
    analysisType?: string,
    options?: {
      maxNodes?: number;
      nodeTimeoutMs?: number;
      verbose?: boolean;
    }
  ) {
    super();

    this.skillAdapter = new SkillExecutorAdapter({ enableCache: true });
    this.treeExecutor = new DecisionTreeExecutor(this.skillAdapter, {
      maxNodes: options?.maxNodes || 50,
      nodeTimeoutMs: options?.nodeTimeoutMs || 30000,
      verbose: options?.verbose ?? true,
    });

    // Pre-load the tree if analysis type is specified
    if (analysisType) {
      this.targetTree = getDecisionTree(analysisType) || null;
    }

    // Forward events from the tree executor
    this.treeExecutor.on('node:start', (data) => this.emit('node:start', data));
    this.treeExecutor.on('node:complete', (data) => this.emit('node:complete', data));
  }

  /**
   * Set the decision tree to use
   */
  setTree(tree: DecisionTree): void {
    this.targetTree = tree;
  }

  /**
   * Execute the decision tree as a pipeline stage
   */
  async execute(
    stage: PipelineStage,
    context: SubAgentContext
  ): Promise<SubAgentResult> {
    const startTime = Date.now();

    // Determine which tree to use
    let tree = this.targetTree;

    // If no pre-configured tree, try to get one based on the stage or context
    if (!tree) {
      const analysisType = this.detectAnalysisType(stage, context);
      tree = analysisType ? getDecisionTree(analysisType) || null : null;
    }

    if (!tree) {
      return {
        success: false,
        findings: [],
        message: `No decision tree found for stage: ${stage.id}`,
        metrics: {
          totalDurationMs: Date.now() - startTime,
        },
      };
    }

    console.log(`[DecisionTreeStageExecutor] Executing tree: ${tree.name} (${tree.id})`);

    // Build decision context from SubAgentContext
    const stageAnalysisParams =
      stage.metadata && typeof stage.metadata === 'object'
        ? (stage.metadata as any).analysisParams
        : undefined;

    const decisionContext: DecisionContext = {
      sessionId: context.sessionId,
      traceId: context.traceId || '',
      query: context.query || context.userQuery,
      architecture: context.architecture,
      traceProcessorService: context.traceProcessorService,
      previousResults: new Map(),
      timeRange: context.timeRange,
      packageName: context.package,
      analysisParams:
        (context.analysisParams && typeof context.analysisParams === 'object'
          ? context.analysisParams
          : undefined) ||
        (stageAnalysisParams && typeof stageAnalysisParams === 'object'
          ? stageAnalysisParams
          : undefined),
    };

    // Add any previous stage results to the context
    if (context.previousResults) {
      for (const result of context.previousResults) {
        if (result.data) {
          decisionContext.previousResults.set(result.stageId, result.data);
        }
      }
    }

    try {
      // Execute the decision tree
      const treeResult = await this.treeExecutor.execute(tree, decisionContext);

      // Convert tree result to SubAgentResult
      return this.convertToSubAgentResult(treeResult, startTime);
    } catch (error: any) {
      console.error(`[DecisionTreeStageExecutor] Error:`, error);
      return {
        success: false,
        findings: [],
        message: `Decision tree execution failed: ${error.message}`,
        metrics: {
          totalDurationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Detect analysis type from stage or context
   */
  private detectAnalysisType(
    stage: PipelineStage,
    context: SubAgentContext
  ): string | null {
    // Check stage metadata
    if (stage.metadata?.analysisType) {
      return stage.metadata.analysisType;
    }

    // Check stage ID for hints
    if (stage.id.includes('scrolling') || stage.id.includes('scroll')) {
      return 'scrolling';
    }
    if (stage.id.includes('launch') || stage.id.includes('startup')) {
      return 'launch';
    }

    // Check user query for hints
    const query = (context.query || context.userQuery || '').toLowerCase();
    if (query.includes('滑动') || query.includes('scroll') || query.includes('fps')) {
      return 'scrolling';
    }
    if (query.includes('启动') || query.includes('launch') || query.includes('start')) {
      return 'launch';
    }

    return null;
  }

  /**
   * Convert decision tree result to SubAgentResult
   */
  private convertToSubAgentResult(
    treeResult: DecisionTreeExecutionResult,
    startTime: number
  ): SubAgentResult {
    const findings: Finding[] = [];

    // Convert conclusion to finding
    if (treeResult.conclusion) {
      const conclusionFinding = this.conclusionToFinding(treeResult.conclusion);
      findings.push(conclusionFinding);
    }

    // Add findings from collected data
    const dataFindings = this.extractFindings(treeResult.collectedData);
    findings.push(...dataFindings);

    // Build message
    let message = '';
    if (treeResult.success && treeResult.conclusion) {
      message = treeResult.conclusion.summaryTemplate;
    } else if (treeResult.error) {
      message = `分析未能完成: ${treeResult.error}`;
    } else {
      message = '分析完成但未能得出明确结论';
    }

    return {
      success: treeResult.success,
      findings,
      message,
      data: {
        treeId: treeResult.treeId,
        executionPath: treeResult.executionPath,
        conclusion: treeResult.conclusion,
        collectedData: Object.fromEntries(treeResult.collectedData),
        nodeResults: treeResult.nodeResults.map((r) => ({
          nodeId: r.nodeId,
          nodeType: r.nodeType,
          success: r.success,
          durationMs: r.durationMs,
          conditionResult: r.conditionResult,
        })),
      },
      metrics: {
        totalDurationMs: Date.now() - startTime,
        treeExecutionMs: treeResult.totalDurationMs,
        nodesExecuted: treeResult.nodeResults.length,
      },
    };
  }

  /**
   * Convert a conclusion to a finding
   */
  private conclusionToFinding(conclusion: ConclusionDefinition): Finding {
    // Map conclusion category to severity
    let severity: 'high' | 'medium' | 'low' = 'medium';
    if (conclusion.category === 'APP') {
      severity = 'high';
    } else if (conclusion.category === 'SYSTEM') {
      severity = 'medium';
    } else if (conclusion.category === 'UNKNOWN') {
      severity = 'low';
    }

    return {
      id: `conclusion_${Date.now()}`,
      type: 'root_cause',
      severity,
      title: `根因: ${conclusion.component}`,
      description: conclusion.summaryTemplate,
      source: 'decision_tree',
      confidence: conclusion.confidence,
      details: {
        category: conclusion.category,
        component: conclusion.component,
        suggestedNextSteps: conclusion.suggestedNextSteps,
      },
      // Include suggestions as recommendations
      recommendations: conclusion.suggestedNextSteps?.map((step, i) => ({
        id: `rec_${i}`,
        text: step,
        priority: i + 1,
      })),
    };
  }

  /**
   * Extract additional findings from collected data
   */
  private extractFindings(collectedData: Map<string, any>): Finding[] {
    const findings: Finding[] = [];

    // Look for specific data patterns that indicate issues
    for (const [key, value] of collectedData) {
      if (!value || typeof value !== 'object') continue;

      // Scrolling-related findings
      if (key === 'scrolling_analysis' || key.includes('fps')) {
        const fps = value.transformed?.avg_fps || value.avg_fps;
        if (fps && fps < DECISION_POST_THRESHOLDS.findings.lowFps.threshold) {
          findings.push({
            id: `finding_low_fps_${Date.now()}`,
            type: 'performance',
            severity: fps < DECISION_POST_THRESHOLDS.findings.lowFps.highSeverityThreshold ? 'high' : 'medium',
            title: 'FPS 低于目标值',
            description: `平均 FPS 为 ${fps.toFixed(1)}，低于 60 FPS 的目标`,
            source: 'decision_tree',
            confidence: 0.9,
          });
        }
      }

      // Startup-related findings
      if (key === 'launch_data' || key === 'startup_analysis') {
        const ttid = value.transformed?.ttid || value.ttid || value.time_to_initial_display;
        if (ttid && ttid > DECISION_POST_THRESHOLDS.findings.slowStartup.thresholdMs) {
          findings.push({
            id: `finding_slow_startup_${Date.now()}`,
            type: 'performance',
            severity: ttid > DECISION_POST_THRESHOLDS.findings.slowStartup.highSeverityThresholdMs ? 'high' : 'medium',
            title: '启动时间过长',
            description: `TTID 为 ${ttid.toFixed(0)}ms，超过 ${DECISION_POST_THRESHOLDS.findings.slowStartup.thresholdMs}ms 的目标`,
            source: 'decision_tree',
            confidence: 0.85,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Clear skill result cache
   */
  clearCache(): void {
    this.skillAdapter.clearCache();
  }
}

/**
 * Create a decision tree stage executor for a specific analysis type
 */
export function createDecisionTreeStageExecutor(
  analysisType?: string,
  options?: {
    maxNodes?: number;
    nodeTimeoutMs?: number;
    verbose?: boolean;
  }
): DecisionTreeStageExecutor {
  return new DecisionTreeStageExecutor(analysisType, options);
}

export default DecisionTreeStageExecutor;