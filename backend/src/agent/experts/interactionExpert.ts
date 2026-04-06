// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Interaction Expert
 *
 * Domain expert for analyzing user interaction performance:
 * - Scrolling (滑动卡顿)
 * - Click response (点击响应)
 *
 * This expert specializes in understanding how the app responds
 * to user input and identifying bottlenecks in the rendering pipeline.
 *
 * Key capabilities:
 * - FPS analysis and jank detection
 * - Frame timing breakdown (doFrame, RenderThread, SurfaceFlinger)
 * - Architecture-aware analysis (handles SurfacePanel, Unity, etc.)
 * - Root cause classification (App vs System)
 */

import {
  BaseExpert,
  AnalysisStrategy,
  ExpertConfig,
  ExpertInput,
  AnalysisIntent,
} from './base';
import {
  DecisionTree,
  DecisionTreeExecutionResult,
  DecisionContext,
} from '../decision/types';
import { getDecisionTree, scrollingDecisionTree } from '../decision';
import { ArchitectureInfo, RenderingArchitectureType } from '../detectors';

/**
 * Configuration for the Interaction Expert
 */
const INTERACTION_EXPERT_CONFIG: ExpertConfig = {
  id: 'interaction_expert',
  name: '交互性能专家',
  domain: 'interaction',
  description: '专注于用户交互性能分析，包括滑动卡顿和点击响应',
  handlesIntents: ['SCROLLING', 'CLICK'],
  decisionTrees: ['scrolling'],
  availableSkills: [
    'scrolling_analysis',
    'jank_frame_detail',
    'sf_analysis',
    'cpu_analysis',
  ],
  maxDurationMs: 60000,
  canForkSession: true,
};

/**
 * Interaction Expert Implementation
 *
 * Analyzes user interaction performance using decision trees
 * and architecture-aware strategies.
 */
export class InteractionExpert extends BaseExpert {
  constructor() {
    super(INTERACTION_EXPERT_CONFIG);
  }

  /**
   * Select analysis strategy based on intent and architecture
   *
   * Different architectures require different analysis approaches:
   * - STANDARD: Use the normal scrolling decision tree
   * - SURF_PANEL: Focus on surface-level analysis first
   * - UNITY: Use game-specific timing analysis
   * - WEBVIEW: Consider JS performance
   */
  protected selectStrategy(
    intent: AnalysisIntent,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    const archType = architecture?.type || 'STANDARD';

    // Log architecture info for debugging
    this.log(`Architecture: ${archType}, Intent: ${intent.category}`);

    // Select strategy based on intent category
    if (intent.category === 'SCROLLING') {
      return this.selectScrollingStrategy(archType, architecture);
    } else if (intent.category === 'CLICK') {
      return this.selectClickStrategy(archType, architecture);
    }

    // Fallback to default scrolling strategy
    return {
      name: 'default_interaction',
      decisionTree: scrollingDecisionTree,
    };
  }

  /**
   * Select scrolling-specific strategy
   */
  private selectScrollingStrategy(
    archType: RenderingArchitectureType,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    switch (archType) {
      case 'SURFACEVIEW':
      case 'GLSURFACEVIEW':
        // For SurfaceView (video/camera), use modified approach
        return {
          name: 'surfaceview_scrolling',
          decisionTree: scrollingDecisionTree,
          architectureAdjustments: {
            // SurfaceView apps may have different frame timing expectations
            fpsThreshold: 30, // Video often runs at 30 FPS
            skipRenderThreadAnalysis: true, // No standard RenderThread
          },
        };

      case 'MIXED':
        // Mixed rendering (e.g., game engines like Unity/Unreal)
        return {
          name: 'mixed_scrolling',
          decisionTree: scrollingDecisionTree,
          architectureAdjustments: {
            fpsThreshold: 30, // Games often target 30 or 60
            skipRenderThreadAnalysis: true, // Game engines have own rendering
            checkGameThreads: true,
          },
        };

      case 'WEBVIEW':
        // WebView apps need consideration of JS performance
        return {
          name: 'webview_scrolling',
          decisionTree: scrollingDecisionTree,
          architectureAdjustments: {
            checkJsThread: true,
            webviewEngine: architecture?.webview?.engine,
          },
        };

      case 'COMPOSE':
        // Jetpack Compose has different rendering model
        return {
          name: 'compose_scrolling',
          decisionTree: scrollingDecisionTree,
          architectureAdjustments: {
            checkComposeFrames: true,
            hasRecomposition: architecture?.compose?.hasRecomposition,
            hasLazyLists: architecture?.compose?.hasLazyLists,
            isHybridView: architecture?.compose?.isHybridView,
          },
        };

      case 'FLUTTER':
        // Flutter uses its own rendering engine
        return {
          name: 'flutter_scrolling',
          decisionTree: scrollingDecisionTree,
          architectureAdjustments: {
            checkFlutterRaster: true,
            checkFlutterUI: true,
            flutterEngine: architecture?.flutter?.engine,
          },
        };

      case 'STANDARD':
      default:
        // Standard Android View system
        return {
          name: 'standard_scrolling',
          decisionTree: scrollingDecisionTree,
        };
    }
  }

  /**
   * Select click response strategy
   *
   * Click analysis focuses on:
   * - Time from input to first frame
   * - Any blocking operations during response
   * - System vs app delays
   */
  private selectClickStrategy(
    archType: RenderingArchitectureType,
    _architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    // Click analysis currently uses a custom approach
    // (no dedicated decision tree yet)
    return {
      name: 'click_response',
      decisionTree: undefined, // Will use performCustomAnalysis
      skillSequence: [
        'input_analysis',     // Analyze input events
        'jank_frame_detail',  // Check frame response
        'cpu_analysis',       // Check if CPU bound
      ],
      architectureAdjustments: {
        archType,
      },
    };
  }

  /**
   * Perform custom analysis when no decision tree is available
   * (e.g., for CLICK analysis)
   */
  protected async performCustomAnalysis(
    input: ExpertInput,
    architecture?: ArchitectureInfo
  ): Promise<DecisionTreeExecutionResult> {
    this.log('Performing custom click analysis...');

    const startTime = Date.now();
    const collectedData = new Map<string, any>();
    const executionPath: string[] = [];

    // Build context
    const context: DecisionContext = {
      sessionId: input.sessionId,
      traceId: input.traceId,
      architecture,
      traceProcessorService: input.traceProcessorService,
      previousResults: new Map(),
      timeRange: input.timeRange,
      packageName: input.packageName,
    };

    try {
      // Step 1: Get frame detail data
      executionPath.push('get_frame_data');
      this.log('Executing jank_frame_detail skill...');
      const frameData = await this.executeSkill('jank_frame_detail', {}, context);
      collectedData.set('frame_data', frameData);

      // Step 2: Analyze the data
      executionPath.push('analyze_click_response');

      // Simple analysis: check if there are slow frames after input
      const conclusion = this.analyzeClickResponse(frameData, collectedData);

      return {
        treeId: 'click_custom_analysis',
        success: true,
        conclusion,
        collectedData,
        executionPath,
        nodeResults: [],
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.log(`Custom analysis failed: ${error.message}`);
      return {
        treeId: 'click_custom_analysis',
        success: false,
        collectedData,
        executionPath,
        nodeResults: [],
        totalDurationMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Analyze click response from frame data
   */
  private analyzeClickResponse(
    frameData: any,
    _collectedData: Map<string, any>
  ): any {
    // Extract relevant metrics
    const avgDoFrame = frameData?.layers?.overview?.frame_timing_summary?.data?.[0]?.avg_do_frame_ms || 0;
    const avgRender = frameData?.layers?.overview?.frame_timing_summary?.data?.[0]?.avg_render_thread_ms || 0;

    // Determine if there's a click response issue
    if (avgDoFrame > 32) {
      return {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: `点击响应慢，主线程平均耗时 ${avgDoFrame.toFixed(1)}ms，超过两帧时间`,
        confidence: 0.8,
        suggestedNextSteps: [
          '检查点击处理逻辑是否有耗时操作',
          '检查是否有同步 Binder 调用',
          '检查是否触发了复杂的布局计算',
        ],
      };
    } else if (avgRender > 16) {
      return {
        category: 'APP',
        component: 'RENDER_THREAD',
        summaryTemplate: `点击响应慢，RenderThread 平均耗时 ${avgRender.toFixed(1)}ms`,
        confidence: 0.75,
        suggestedNextSteps: [
          '检查是否有复杂的动画',
          '检查绘制复杂度',
        ],
      };
    }

    return {
      category: 'UNKNOWN',
      component: 'UNKNOWN',
      summaryTemplate: '点击响应数据不足以判断具体问题',
      confidence: 0.5,
      suggestedNextSteps: [
        '需要更多的输入事件数据',
        '建议录制包含点击操作的 trace',
      ],
    };
  }
}

/**
 * Create a new InteractionExpert instance
 */
export function createInteractionExpert(): InteractionExpert {
  return new InteractionExpert();
}

export default InteractionExpert;