// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Launch Expert
 *
 * Domain expert for analyzing app startup performance:
 * - Cold launch (冷启动) - process creation to first frame
 * - Warm launch (温启动) - activity recreation
 * - Hot launch (热启动) - resume from background
 *
 * This expert specializes in understanding the app startup pipeline
 * and identifying bottlenecks in the initialization sequence.
 *
 * Key capabilities:
 * - TTID (Time To Initial Display) analysis
 * - Phase breakdown (process start, Application init, Activity create, first frame)
 * - Architecture-aware analysis for different app types
 * - Root cause classification with optimization suggestions
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
import { getDecisionTree, launchDecisionTree } from '../decision';
import { ArchitectureInfo, RenderingArchitectureType } from '../detectors';

/**
 * Configuration for the Launch Expert
 */
const LAUNCH_EXPERT_CONFIG: ExpertConfig = {
  id: 'launch_expert',
  name: '启动性能专家',
  domain: 'launch',
  description: '专注于应用启动性能分析，包括冷启动、温启动和热启动',
  handlesIntents: ['LAUNCH'],
  decisionTrees: ['launch'],
  availableSkills: [
    'startup_analysis',
    'cpu_analysis',
    'memory_analysis',
    'binder_analysis',
  ],
  maxDurationMs: 60000,
  canForkSession: true,
};

/**
 * Launch time thresholds (in milliseconds)
 */
const LAUNCH_THRESHOLDS = {
  cold: {
    excellent: 500,
    good: 1000,
    acceptable: 2000,
  },
  warm: {
    excellent: 200,
    good: 500,
    acceptable: 1000,
  },
  hot: {
    excellent: 100,
    good: 200,
    acceptable: 500,
  },
};

/**
 * Launch Expert Implementation
 *
 * Analyzes app startup performance using the launch decision tree
 * and architecture-aware strategies.
 */
export class LaunchExpert extends BaseExpert {
  constructor() {
    super(LAUNCH_EXPERT_CONFIG);
  }

  /**
   * Select analysis strategy based on intent and architecture
   *
   * Different architectures have different startup characteristics:
   * - STANDARD: Typical Android app startup flow
   * - UNITY/UNREAL: Game engines have heavy asset loading
   * - FLUTTER: Dart VM initialization adds overhead
   * - WEBVIEW: May have heavy WebView initialization
   */
  protected selectStrategy(
    intent: AnalysisIntent,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    const archType = architecture?.type || 'STANDARD';

    this.log(`Architecture: ${archType}, Intent: ${intent.category}`);

    return this.selectLaunchStrategy(archType, architecture);
  }

  /**
   * Select launch-specific strategy based on architecture
   */
  private selectLaunchStrategy(
    archType: RenderingArchitectureType,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    switch (archType) {
      case 'GLSURFACEVIEW':
      case 'SURFACEVIEW':
      case 'MIXED':
        // Game engines (Unity/Unreal) and heavy surface rendering have longer acceptable launch times
        return {
          name: 'game_launch',
          decisionTree: launchDecisionTree,
          architectureAdjustments: {
            thresholds: {
              cold: { excellent: 2000, good: 4000, acceptable: 6000 },
              warm: { excellent: 500, good: 1000, acceptable: 2000 },
              hot: { excellent: 200, good: 500, acceptable: 1000 },
            },
            checkGameInit: true,
            checkAssetLoading: true,
          },
        };

      case 'FLUTTER':
        return {
          name: 'flutter_launch',
          decisionTree: launchDecisionTree,
          architectureAdjustments: {
            thresholds: {
              cold: { excellent: 800, good: 1500, acceptable: 3000 },
              warm: { excellent: 300, good: 600, acceptable: 1200 },
              hot: { excellent: 150, good: 300, acceptable: 600 },
            },
            checkDartVMInit: true,
            checkFlutterEngineInit: true,
          },
        };

      case 'WEBVIEW':
        return {
          name: 'webview_launch',
          decisionTree: launchDecisionTree,
          architectureAdjustments: {
            thresholds: {
              cold: { excellent: 1000, good: 2000, acceptable: 4000 },
              warm: { excellent: 500, good: 1000, acceptable: 2000 },
              hot: { excellent: 200, good: 500, acceptable: 1000 },
            },
            checkWebViewInit: true,
            checkJsEngineInit: true,
          },
        };

      case 'COMPOSE':
        return {
          name: 'compose_launch',
          decisionTree: launchDecisionTree,
          architectureAdjustments: {
            // Compose apps may have slightly different startup characteristics
            checkComposeInit: true,
          },
        };

      case 'STANDARD':
      default:
        return {
          name: 'standard_launch',
          decisionTree: launchDecisionTree,
          architectureAdjustments: {
            thresholds: LAUNCH_THRESHOLDS,
          },
        };
    }
  }

  /**
   * Perform custom analysis when decision tree doesn't cover the case
   */
  protected async performCustomAnalysis(
    input: ExpertInput,
    architecture?: ArchitectureInfo
  ): Promise<DecisionTreeExecutionResult> {
    this.log('Performing custom launch analysis...');

    const startTime = Date.now();
    const collectedData = new Map<string, any>();
    const executionPath: string[] = [];

    // Build context
    const context: DecisionContext = {
      sessionId: input.sessionId,
      traceId: input.traceId,
      query: input.query,
      architecture,
      traceProcessorService: input.traceProcessorService,
      previousResults: new Map(),
      timeRange: input.timeRange,
      packageName: input.packageName,
      analysisParams: input.analysisParams,
    };

    try {
      // Step 1: Get startup analysis data
      executionPath.push('get_startup_data');
      this.log('Executing startup_analysis skill...');
      const startupData = await this.executeSkill('startup_analysis', {}, context);
      collectedData.set('startup_data', startupData);

      // Step 2: Get CPU data if startup seems CPU bound
      if (this.mightBeCpuBound(startupData)) {
        executionPath.push('get_cpu_data');
        this.log('Startup appears CPU bound, getting CPU data...');
        const cpuData = await this.executeSkill('cpu_analysis', {}, context);
        collectedData.set('cpu_data', cpuData);
      }

      // Step 3: Analyze and conclude
      executionPath.push('analyze_startup');
      const conclusion = this.analyzeStartupData(startupData, collectedData, architecture);

      return {
        treeId: 'launch_custom_analysis',
        success: true,
        conclusion,
        collectedData,
        executionPath,
        nodeResults: [],
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.log(`Custom launch analysis failed: ${error.message}`);
      return {
        treeId: 'launch_custom_analysis',
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
   * Check if startup might be CPU bound
   */
  private mightBeCpuBound(startupData: any): boolean {
    if (!startupData) return false;
    // Check if Application init or Activity create takes a long time
    const appInit = startupData.application_init_time || 0;
    const actCreate = startupData.activity_create_time || 0;
    return appInit > 500 || actCreate > 300;
  }

  /**
   * Analyze startup data and produce conclusion
   */
  private analyzeStartupData(
    startupData: any,
    collectedData: Map<string, any>,
    architecture?: ArchitectureInfo
  ): any {
    if (!startupData) {
      return {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: '启动数据不足，无法进行分析',
        confidence: 0.3,
        suggestedNextSteps: [
          '确保 trace 包含完整的启动过程',
          '从应用完全退出状态开始录制',
        ],
      };
    }

    // Get thresholds based on architecture
    const archType = architecture?.type || 'STANDARD';
    const thresholds = this.getThresholds(archType);

    // Extract TTID
    const ttid = startupData.ttid ||
                 startupData.time_to_initial_display ||
                 startupData.total_time ||
                 0;

    // Determine launch type and evaluate
    const launchType = this.determineLaunchType(startupData);
    const threshold = thresholds[launchType];

    if (ttid < threshold.excellent) {
      return {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: `启动性能优秀 (${launchType} launch: ${ttid}ms)`,
        confidence: 0.9,
        suggestedNextSteps: [],
      };
    }

    if (ttid < threshold.good) {
      return {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: `启动性能良好 (${launchType} launch: ${ttid}ms)`,
        confidence: 0.85,
        suggestedNextSteps: [
          '可考虑进一步优化以达到优秀水平',
        ],
      };
    }

    // Performance needs improvement - identify bottleneck
    return this.identifyStartupBottleneck(startupData, ttid, launchType);
  }

  /**
   * Get thresholds based on architecture type
   */
  private getThresholds(archType: RenderingArchitectureType): typeof LAUNCH_THRESHOLDS {
    // Different architectures have different acceptable thresholds
    switch (archType) {
      case 'GLSURFACEVIEW':
      case 'SURFACEVIEW':
      case 'MIXED':
        // Game engines and heavy surface rendering
        return {
          cold: { excellent: 2000, good: 4000, acceptable: 6000 },
          warm: { excellent: 500, good: 1000, acceptable: 2000 },
          hot: { excellent: 200, good: 500, acceptable: 1000 },
        };
      case 'FLUTTER':
        return {
          cold: { excellent: 800, good: 1500, acceptable: 3000 },
          warm: { excellent: 300, good: 600, acceptable: 1200 },
          hot: { excellent: 150, good: 300, acceptable: 600 },
        };
      default:
        return LAUNCH_THRESHOLDS;
    }
  }

  /**
   * Determine launch type from data
   */
  private determineLaunchType(data: any): 'cold' | 'warm' | 'hot' {
    // 1. Trust reclassified startup_type from skill YAML (highest priority)
    const reclassified = data.startup_type || data.launch_type;
    if (reclassified === 'cold' || reclassified === 'warm' || reclassified === 'hot') return reclassified;
    // 2. bindApplication → cold (aligned with startup_events_in_range.skill.yaml)
    if (data.has_bind_app || data.has_bind_application) return 'cold';
    // 3. performCreate without bindApplication → warm
    if (data.has_perform_create || data.has_activity_restart) return 'warm';
    // 4. Legacy fallback: has_process_start (backward compat for older data)
    if (data.has_process_start || data.process_start_time > 0) return 'cold';
    return 'hot';
  }

  /**
   * Identify the startup bottleneck
   */
  private identifyStartupBottleneck(
    data: any,
    ttid: number,
    launchType: string
  ): any {
    // Extract phase times
    const phases = {
      process_start: data.process_start_time || 0,
      application_init: data.application_init_time || 0,
      activity_create: data.activity_create_time || 0,
      first_frame: data.first_frame_time || 0,
    };

    // Find the slowest phase
    const slowestPhase = Object.entries(phases)
      .sort(([, a], [, b]) => b - a)[0];

    const [phaseName, phaseTime] = slowestPhase;

    // Generate conclusion based on slowest phase
    switch (phaseName) {
      case 'process_start':
        return {
          category: 'MIXED',
          component: 'MAIN_THREAD',
          summaryTemplate: `${launchType} 启动慢 (${ttid}ms)，主要瓶颈在进程创建阶段 (${phaseTime}ms)`,
          confidence: 0.8,
          suggestedNextSteps: [
            '检查系统负载是否过高',
            '检查内存压力',
            '检查 Application 的静态初始化',
          ],
        };

      case 'application_init':
        return {
          category: 'APP',
          component: 'MAIN_THREAD',
          summaryTemplate: `${launchType} 启动慢 (${ttid}ms)，主要瓶颈在 Application 初始化 (${phaseTime}ms)`,
          confidence: 0.85,
          suggestedNextSteps: [
            '检查 Application.onCreate 的耗时操作',
            '将非必要初始化延迟执行',
            '使用懒加载模式',
          ],
        };

      case 'activity_create':
        return {
          category: 'APP',
          component: 'MAIN_THREAD',
          summaryTemplate: `${launchType} 启动慢 (${ttid}ms)，主要瓶颈在 Activity 创建 (${phaseTime}ms)`,
          confidence: 0.85,
          suggestedNextSteps: [
            '简化启动 Activity 的布局',
            '检查 onCreate 中的耗时操作',
            '将数据加载移至后台',
          ],
        };

      case 'first_frame':
        return {
          category: 'APP',
          component: 'RENDER_THREAD',
          summaryTemplate: `${launchType} 启动慢 (${ttid}ms)，主要瓶颈在首帧渲染 (${phaseTime}ms)`,
          confidence: 0.8,
          suggestedNextSteps: [
            '简化首屏内容',
            '检查是否有大图片加载',
            '考虑使用占位图延迟加载实际内容',
          ],
        };

      default:
        return {
          category: 'MIXED',
          component: 'UNKNOWN',
          summaryTemplate: `${launchType} 启动慢 (${ttid}ms)，多个阶段均有耗时`,
          confidence: 0.6,
          suggestedNextSteps: [
            '逐阶段优化',
            '优先优化耗时最长的阶段',
          ],
        };
    }
  }
}

/**
 * Create a new LaunchExpert instance
 */
export function createLaunchExpert(): LaunchExpert {
  return new LaunchExpert();
}

export default LaunchExpert;