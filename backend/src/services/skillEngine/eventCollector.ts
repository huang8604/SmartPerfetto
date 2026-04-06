// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill 执行事件收集器 v1.0
 *
 * 收集 skill 执行过程中的事件，用于：
 * 1. 前端进度展示
 * 2. 调试和监控
 * 3. 性能分析
 */

import { SkillEvent, SkillEventType } from './types';

// =============================================================================
// 类型定义
// =============================================================================

export interface EventSummary {
  /** 事件总数 */
  totalEvents: number;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 总耗时(ms) */
  totalDurationMs: number;
  /** 各类型事件计数 */
  eventCounts: Record<SkillEventType, number>;
  /** 已完成步骤数 */
  completedSteps: number;
  /** 失败步骤数 */
  failedSteps: number;
  /** 是否有 AI 调用 */
  hasAICall: boolean;
  /** AI 调用次数 */
  aiCallCount: number;
}

export interface ProgressInfo {
  /** 当前阶段 */
  phase: 'initializing' | 'executing' | 'ai_processing' | 'completed' | 'failed';
  /** 当前步骤 ID */
  currentStepId?: string;
  /** 当前步骤名称 */
  currentStepName?: string;
  /** 进度百分比 (0-100) */
  progressPercent: number;
  /** 状态消息 */
  message: string;
}

// =============================================================================
// 事件收集器
// =============================================================================

export class SkillEventCollector {
  private events: SkillEvent[] = [];
  private skillId: string = '';
  private totalSteps: number = 0;

  /**
   * 开始收集新的 skill 执行事件
   */
  start(skillId: string, totalSteps: number = 0): void {
    this.events = [];
    this.skillId = skillId;
    this.totalSteps = totalSteps;
  }

  /**
   * 添加事件
   */
  addEvent(event: SkillEvent): void {
    this.events.push(event);
  }

  /**
   * 创建事件处理器（用于注入到 executor）
   */
  createHandler(): (event: SkillEvent) => void {
    return (event: SkillEvent) => {
      this.addEvent(event);
    };
  }

  /**
   * 获取所有事件
   */
  getEvents(): SkillEvent[] {
    return [...this.events];
  }

  /**
   * 获取事件摘要
   */
  getSummary(): EventSummary {
    const eventCounts: Record<SkillEventType, number> = {
      skill_started: 0,
      step_started: 0,
      step_completed: 0,
      display_result: 0,
      diagnostic_found: 0,
      ai_thinking: 0,
      ai_response: 0,
      skill_completed: 0,
      skill_error: 0,
    };

    let completedSteps = 0;
    let failedSteps = 0;
    let aiCallCount = 0;

    for (const event of this.events) {
      eventCounts[event.type]++;

      if (event.type === 'step_completed') {
        if (event.data?.success) {
          completedSteps++;
        } else {
          failedSteps++;
        }
      }

      if (event.type === 'ai_thinking') {
        aiCallCount++;
      }
    }

    const startTime = this.events.length > 0 ? this.events[0].timestamp : Date.now();
    const endTime = this.events.length > 0 ? this.events[this.events.length - 1].timestamp : Date.now();

    return {
      totalEvents: this.events.length,
      startTime,
      endTime,
      totalDurationMs: endTime - startTime,
      eventCounts,
      completedSteps,
      failedSteps,
      hasAICall: aiCallCount > 0,
      aiCallCount,
    };
  }

  /**
   * 获取当前进度信息
   */
  getProgress(): ProgressInfo {
    if (this.events.length === 0) {
      return {
        phase: 'initializing',
        progressPercent: 0,
        message: '初始化中...',
      };
    }

    const lastEvent = this.events[this.events.length - 1];

    // 检查是否完成
    if (lastEvent.type === 'skill_completed') {
      return {
        phase: 'completed',
        progressPercent: 100,
        message: '分析完成',
      };
    }

    if (lastEvent.type === 'skill_error') {
      return {
        phase: 'failed',
        progressPercent: 100,
        message: `分析失败: ${lastEvent.data?.error || '未知错误'}`,
      };
    }

    // 检查是否正在 AI 处理
    if (lastEvent.type === 'ai_thinking') {
      return {
        phase: 'ai_processing',
        currentStepId: lastEvent.stepId,
        progressPercent: this.calculateProgress(),
        message: 'AI 正在分析...',
      };
    }

    // 正在执行步骤
    const currentStep = this.findCurrentStep();
    return {
      phase: 'executing',
      currentStepId: currentStep?.stepId,
      currentStepName: currentStep?.data?.stepName,
      progressPercent: this.calculateProgress(),
      message: currentStep ? `正在执行: ${currentStep.stepId}` : '执行中...',
    };
  }

  /**
   * 计算进度百分比
   */
  private calculateProgress(): number {
    if (this.totalSteps === 0) {
      // 如果不知道总步骤数，基于事件类型估算
      const completed = this.events.filter(e => e.type === 'step_completed').length;
      const started = this.events.filter(e => e.type === 'step_started').length;
      if (started === 0) return 0;
      return Math.min(95, Math.round((completed / started) * 100));
    }

    const completed = this.events.filter(e => e.type === 'step_completed').length;
    return Math.min(99, Math.round((completed / this.totalSteps) * 100));
  }

  /**
   * 找到当前正在执行的步骤
   */
  private findCurrentStep(): SkillEvent | undefined {
    // 找到最后一个 step_started 事件，且没有对应的 step_completed
    const startedSteps = new Set<string>();
    const completedSteps = new Set<string>();

    for (const event of this.events) {
      if (event.type === 'step_started' && event.stepId) {
        startedSteps.add(event.stepId);
      }
      if (event.type === 'step_completed' && event.stepId) {
        completedSteps.add(event.stepId);
      }
    }

    // 找到还没完成的步骤
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === 'step_started' && event.stepId && !completedSteps.has(event.stepId)) {
        return event;
      }
    }

    return undefined;
  }

  /**
   * 获取步骤时间线
   */
  getTimeline(): Array<{
    stepId: string;
    stepType: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    success?: boolean;
    hasAI: boolean;
  }> {
    const timeline: Array<{
      stepId: string;
      stepType: string;
      startTime: number;
      endTime?: number;
      durationMs?: number;
      success?: boolean;
      hasAI: boolean;
    }> = [];

    const stepMap = new Map<string, {
      stepId: string;
      stepType: string;
      startTime: number;
      endTime?: number;
      durationMs?: number;
      success?: boolean;
      hasAI: boolean;
    }>();

    for (const event of this.events) {
      if (!event.stepId) continue;

      if (event.type === 'step_started') {
        stepMap.set(event.stepId, {
          stepId: event.stepId,
          stepType: event.data?.stepType || 'unknown',
          startTime: event.timestamp,
          hasAI: false,
        });
      }

      if (event.type === 'step_completed') {
        const step = stepMap.get(event.stepId);
        if (step) {
          step.endTime = event.timestamp;
          step.durationMs = event.timestamp - step.startTime;
          step.success = event.data?.success;
        }
      }

      if (event.type === 'ai_thinking' || event.type === 'ai_response') {
        const step = stepMap.get(event.stepId);
        if (step) {
          step.hasAI = true;
        }
      }
    }

    return Array.from(stepMap.values());
  }

  /**
   * 清空收集器
   */
  clear(): void {
    this.events = [];
    this.skillId = '';
    this.totalSteps = 0;
  }
}

// =============================================================================
// 单例导出
// =============================================================================

export function createEventCollector(): SkillEventCollector {
  return new SkillEventCollector();
}