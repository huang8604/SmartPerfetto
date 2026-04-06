// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * System Expert
 *
 * Domain expert for analyzing system-level performance:
 * - CPU usage and scheduling
 * - Memory pressure and allocations
 * - I/O operations and blocking
 * - ANR (Application Not Responding) analysis
 *
 * This expert specializes in understanding system resource usage
 * and identifying bottlenecks that may not be immediately visible
 * in frame timing analysis.
 *
 * Key capabilities:
 * - CPU frequency and scheduling analysis
 * - Memory allocation patterns and GC impact
 * - Disk and network I/O analysis
 * - ANR root cause identification
 */

import {
  BaseExpert,
  AnalysisStrategy,
  ExpertConfig,
  ExpertInput,
  ExpertOutput,
  AnalysisIntent,
} from './base';
import {
  DecisionTree,
  DecisionTreeExecutionResult,
  DecisionContext,
} from '../decision/types';
import { ArchitectureInfo } from '../detectors';

/**
 * Configuration for the System Expert
 */
const SYSTEM_EXPERT_CONFIG: ExpertConfig = {
  id: 'system_expert',
  name: '系统性能专家',
  domain: 'system',
  description: '专注于系统级性能分析，包括 CPU、内存、IO 和 ANR',
  handlesIntents: ['CPU', 'MEMORY', 'IO', 'ANR'],
  decisionTrees: [], // No pre-built decision trees yet
  availableSkills: [
    'cpu_analysis',
    'memory_analysis',
    'binder_analysis',
    'blocking_analysis',
  ],
  maxDurationMs: 90000, // System analysis may take longer
  canForkSession: true,
};

/**
 * System Expert Implementation
 *
 * Analyzes system-level performance using skill sequences
 * and custom analysis logic.
 */
export class SystemExpert extends BaseExpert {
  constructor() {
    super(SYSTEM_EXPERT_CONFIG);
  }

  /**
   * Select analysis strategy based on intent and architecture
   */
  protected selectStrategy(
    intent: AnalysisIntent,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy {
    this.log(`System analysis for: ${intent.category}`);

    switch (intent.category) {
      case 'CPU':
        return this.selectCpuStrategy(architecture);
      case 'MEMORY':
        return this.selectMemoryStrategy(architecture);
      case 'IO':
        return this.selectIoStrategy(architecture);
      case 'ANR':
        return this.selectAnrStrategy(architecture);
      default:
        return {
          name: 'general_system',
          skillSequence: ['cpu_analysis', 'memory_analysis'],
        };
    }
  }

  /**
   * CPU analysis strategy
   */
  private selectCpuStrategy(_architecture?: ArchitectureInfo): AnalysisStrategy {
    return {
      name: 'cpu_analysis',
      skillSequence: [
        'cpu_analysis',      // Get CPU usage and frequency
        'jank_frame_detail', // Check if CPU affects frames
      ],
      architectureAdjustments: {
        checkScheduling: true,
        checkFrequency: true,
        checkThermalThrottling: true,
      },
    };
  }

  /**
   * Memory analysis strategy
   */
  private selectMemoryStrategy(_architecture?: ArchitectureInfo): AnalysisStrategy {
    return {
      name: 'memory_analysis',
      skillSequence: [
        'memory_analysis',   // Get memory usage and GC
      ],
      architectureAdjustments: {
        checkGcPauses: true,
        checkMemoryPressure: true,
        checkLmk: true,
      },
    };
  }

  /**
   * I/O analysis strategy
   */
  private selectIoStrategy(_architecture?: ArchitectureInfo): AnalysisStrategy {
    return {
      name: 'io_analysis',
      skillSequence: [
        'blocking_analysis', // Find blocking operations
        'binder_analysis',   // Check Binder calls (often IO)
      ],
      architectureAdjustments: {
        checkDiskIo: true,
        checkNetworkIo: true,
        checkBinderCalls: true,
      },
    };
  }

  /**
   * ANR analysis strategy
   */
  private selectAnrStrategy(_architecture?: ArchitectureInfo): AnalysisStrategy {
    return {
      name: 'anr_analysis',
      skillSequence: [
        'blocking_analysis', // Find what blocked main thread
        'binder_analysis',   // Check for Binder deadlocks
        'cpu_analysis',      // Check CPU starvation
      ],
      architectureAdjustments: {
        checkMainThreadBlocking: true,
        checkBinderDeadlock: true,
        checkLockContention: true,
      },
    };
  }

  /**
   * Perform custom analysis based on the strategy
   */
  protected async performCustomAnalysis(
    input: ExpertInput,
    architecture?: ArchitectureInfo
  ): Promise<DecisionTreeExecutionResult> {
    const strategy = this.selectStrategy(input.intent, architecture);
    this.log(`Executing ${strategy.name} with skills: ${strategy.skillSequence?.join(', ')}`);

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
      // Execute skill sequence
      if (strategy.skillSequence) {
        for (const skillId of strategy.skillSequence) {
          executionPath.push(`execute_${skillId}`);
          this.log(`Executing skill: ${skillId}`);
          try {
            const result = await this.executeSkill(skillId, {}, context);
            collectedData.set(skillId, result);
            context.previousResults.set(skillId, result);
          } catch (skillError: any) {
            this.log(`Skill ${skillId} failed: ${skillError.message}`);
            collectedData.set(skillId, { error: skillError.message });
          }
        }
      }

      // Analyze collected data based on intent
      executionPath.push('analyze_results');
      const conclusion = this.analyzeSystemData(input.intent, collectedData, strategy);

      return {
        treeId: `system_${input.intent.category.toLowerCase()}_analysis`,
        success: true,
        conclusion,
        collectedData,
        executionPath,
        nodeResults: [],
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.log(`System analysis failed: ${error.message}`);
      return {
        treeId: `system_${input.intent.category.toLowerCase()}_analysis`,
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
   * Analyze system data based on intent
   */
  private analyzeSystemData(
    intent: AnalysisIntent,
    collectedData: Map<string, any>,
    strategy: AnalysisStrategy
  ): any {
    switch (intent.category) {
      case 'CPU':
        return this.analyzeCpuData(collectedData);
      case 'MEMORY':
        return this.analyzeMemoryData(collectedData);
      case 'IO':
        return this.analyzeIoData(collectedData);
      case 'ANR':
        return this.analyzeAnrData(collectedData);
      default:
        return {
          category: 'UNKNOWN',
          component: 'UNKNOWN',
          summaryTemplate: '系统分析完成，未发现明显问题',
          confidence: 0.5,
          suggestedNextSteps: [
            '请提供更具体的分析目标',
          ],
        };
    }
  }

  /**
   * Analyze CPU data
   */
  private analyzeCpuData(collectedData: Map<string, any>): any {
    const cpuData = collectedData.get('cpu_analysis');

    if (!cpuData || cpuData.error) {
      return {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: 'CPU 数据不足，无法进行详细分析',
        confidence: 0.3,
        suggestedNextSteps: [
          '确保 trace 包含 CPU 调度数据',
          '检查 trace 时长是否足够',
        ],
      };
    }

    // Check for CPU throttling
    const maxFreq = cpuData.max_frequency || 0;
    const avgFreq = cpuData.avg_frequency || 0;
    const freqRatio = maxFreq > 0 ? avgFreq / maxFreq : 1;

    if (freqRatio < 0.7) {
      return {
        category: 'SYSTEM',
        component: 'CPU_SCHEDULING',
        summaryTemplate: `CPU 频率受限，平均频率只有最大频率的 ${(freqRatio * 100).toFixed(0)}%，可能存在温控限制`,
        confidence: 0.8,
        suggestedNextSteps: [
          '检查设备温度',
          '检查是否有后台任务消耗资源',
          '考虑优化以减少 CPU 负载',
        ],
      };
    }

    // Check for scheduling delays
    const avgRunnable = cpuData.avg_runnable_time || 0;
    if (avgRunnable > 5) {
      return {
        category: 'SYSTEM',
        component: 'CPU_SCHEDULING',
        summaryTemplate: `CPU 调度延迟高，平均 Runnable 等待 ${avgRunnable.toFixed(1)}ms，线程得不到及时执行`,
        confidence: 0.75,
        suggestedNextSteps: [
          '检查 CPU 核心使用率',
          '检查是否有高优先级任务抢占',
          '检查线程优先级设置',
        ],
      };
    }

    // Check for high CPU usage
    const avgUsage = cpuData.avg_cpu_usage || 0;
    if (avgUsage > 80) {
      return {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: `CPU 使用率高 (${avgUsage.toFixed(0)}%)，应用可能有计算密集型操作`,
        confidence: 0.7,
        suggestedNextSteps: [
          '分析主线程的耗时函数',
          '考虑将计算移到后台线程',
          '优化算法复杂度',
        ],
      };
    }

    return {
      category: 'UNKNOWN',
      component: 'UNKNOWN',
      summaryTemplate: 'CPU 性能正常，未发现明显问题',
      confidence: 0.8,
      suggestedNextSteps: [],
    };
  }

  /**
   * Analyze memory data
   */
  private analyzeMemoryData(collectedData: Map<string, any>): any {
    const memData = collectedData.get('memory_analysis');

    if (!memData || memData.error) {
      return {
        category: 'UNKNOWN',
        component: 'UNKNOWN',
        summaryTemplate: '内存数据不足，无法进行详细分析',
        confidence: 0.3,
        suggestedNextSteps: [
          '确保 trace 包含内存相关事件',
        ],
      };
    }

    // Check for GC pressure
    const gcCount = memData.gc_count || 0;
    const gcDuration = memData.total_gc_duration || 0;
    const traceDuration = memData.trace_duration || 1000;

    const gcFrequency = gcCount / (traceDuration / 1000); // GC per second
    const gcRatio = gcDuration / traceDuration;

    if (gcFrequency > 2) {
      return {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: `GC 频繁 (${gcFrequency.toFixed(1)}次/秒)，可能有大量临时对象分配`,
        confidence: 0.8,
        suggestedNextSteps: [
          '减少临时对象创建',
          '使用对象池复用对象',
          '避免在循环中创建对象',
        ],
      };
    }

    if (gcRatio > 0.1) {
      return {
        category: 'APP',
        component: 'MAIN_THREAD',
        summaryTemplate: `GC 占用时间过多 (${(gcRatio * 100).toFixed(1)}%)，影响应用响应`,
        confidence: 0.75,
        suggestedNextSteps: [
          '优化内存使用',
          '检查是否有内存泄漏',
          '减少大对象分配',
        ],
      };
    }

    // Check memory pressure
    const memPressure = memData.memory_pressure || 'normal';
    if (memPressure === 'high' || memPressure === 'critical') {
      return {
        category: 'SYSTEM',
        component: 'UNKNOWN',
        summaryTemplate: `系统内存压力${memPressure === 'critical' ? '严重' : '较高'}，可能影响应用性能`,
        confidence: 0.7,
        suggestedNextSteps: [
          '减少应用内存占用',
          '关闭不必要的后台应用',
          '检查是否有内存泄漏',
        ],
      };
    }

    return {
      category: 'UNKNOWN',
      component: 'UNKNOWN',
      summaryTemplate: '内存性能正常，未发现明显问题',
      confidence: 0.8,
      suggestedNextSteps: [],
    };
  }

  /**
   * Analyze I/O data
   */
  private analyzeIoData(collectedData: Map<string, any>): any {
    const blockingData = collectedData.get('blocking_analysis');
    const binderData = collectedData.get('binder_analysis');

    // Check for blocking operations
    if (blockingData && !blockingData.error) {
      const mainThreadBlocking = blockingData.main_thread_blocking || [];
      const longBlocks = mainThreadBlocking.filter((b: any) => b.duration > 16);

      if (longBlocks.length > 0) {
        const longestBlock = longBlocks.sort((a: any, b: any) => b.duration - a.duration)[0];
        return {
          category: 'APP',
          component: 'MAIN_THREAD',
          summaryTemplate: `主线程存在 ${longBlocks.length} 次长时间阻塞，最长 ${longestBlock.duration.toFixed(0)}ms (${longestBlock.type})`,
          confidence: 0.85,
          suggestedNextSteps: [
            '将 IO 操作移到后台线程',
            '使用异步 API',
            `检查 ${longestBlock.type} 调用`,
          ],
        };
      }
    }

    // Check for slow Binder calls
    if (binderData && !binderData.error) {
      const slowBinderCalls = binderData.slow_calls || [];
      if (slowBinderCalls.length > 0) {
        const slowest = slowBinderCalls[0];
        return {
          category: 'MIXED',
          component: 'BINDER',
          summaryTemplate: `发现 ${slowBinderCalls.length} 次慢 Binder 调用，最慢 ${slowest.duration.toFixed(0)}ms`,
          confidence: 0.8,
          suggestedNextSteps: [
            '检查 Binder 调用是否必要',
            '考虑缓存 Binder 调用结果',
            '将 Binder 调用移到后台',
          ],
        };
      }
    }

    return {
      category: 'UNKNOWN',
      component: 'UNKNOWN',
      summaryTemplate: 'IO 性能正常，未发现明显的阻塞操作',
      confidence: 0.7,
      suggestedNextSteps: [],
    };
  }

  /**
   * Analyze ANR data
   */
  private analyzeAnrData(collectedData: Map<string, any>): any {
    const blockingData = collectedData.get('blocking_analysis');
    const binderData = collectedData.get('binder_analysis');
    const cpuData = collectedData.get('cpu_analysis');

    // ANR is typically caused by main thread blocking for > 5 seconds
    // Check for long blocking periods

    if (blockingData && !blockingData.error) {
      const anrCandidate = blockingData.main_thread_blocking?.find(
        (b: any) => b.duration > 4000
      );

      if (anrCandidate) {
        return {
          category: 'APP',
          component: 'MAIN_THREAD',
          summaryTemplate: `可能的 ANR 原因：主线程阻塞 ${(anrCandidate.duration / 1000).toFixed(1)} 秒 (${anrCandidate.type})`,
          confidence: 0.9,
          suggestedNextSteps: [
            '将长时间操作移到后台线程',
            `检查 ${anrCandidate.type} 是否可以优化`,
            '添加超时处理机制',
          ],
        };
      }
    }

    // Check for Binder deadlock
    if (binderData && !binderData.error) {
      const deadlock = binderData.potential_deadlock;
      if (deadlock) {
        return {
          category: 'MIXED',
          component: 'BINDER',
          summaryTemplate: 'ANR 可能由 Binder 死锁导致，存在循环等待',
          confidence: 0.85,
          suggestedNextSteps: [
            '检查 Binder 调用的依赖关系',
            '避免在主线程进行同步 Binder 调用',
            '使用异步 Binder 模式',
          ],
        };
      }
    }

    // Check for CPU starvation
    if (cpuData && !cpuData.error) {
      const avgRunnable = cpuData.avg_runnable_time || 0;
      if (avgRunnable > 1000) {
        return {
          category: 'SYSTEM',
          component: 'CPU_SCHEDULING',
          summaryTemplate: `ANR 可能由 CPU 饥饿导致，主线程平均等待 ${(avgRunnable / 1000).toFixed(1)} 秒`,
          confidence: 0.75,
          suggestedNextSteps: [
            '检查系统负载',
            '提高应用线程优先级',
            '减少后台任务',
          ],
        };
      }
    }

    return {
      category: 'UNKNOWN',
      component: 'UNKNOWN',
      summaryTemplate: '未能确定 ANR 的具体原因，需要更多数据',
      confidence: 0.4,
      suggestedNextSteps: [
        '确保 trace 覆盖 ANR 发生时段',
        '检查 ANR 日志',
        '分析 trace 中的主线程状态',
      ],
    };
  }
}

/**
 * Create a new SystemExpert instance
 */
export function createSystemExpert(): SystemExpert {
  return new SystemExpert();
}

export default SystemExpert;