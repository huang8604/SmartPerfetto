// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session Fork Types
 *
 * 会话分叉类型定义
 * 支持从检查点分叉、并行探索、比较和合并
 */

import { Checkpoint, Finding, StageResult } from '../types';

// =============================================================================
// Fork Configuration
// =============================================================================

/**
 * 分叉选项
 */
export interface ForkOptions {
  /** 源检查点 ID */
  checkpointId: string;

  /** 分支名称（可选） */
  branchName?: string;

  /** 分支描述 */
  description?: string;

  /** 是否并行运行 */
  runParallel?: boolean;

  /** 分叉时的假设/目标 */
  hypothesis?: string;

  /** 继承父会话的配置 */
  inheritConfig?: boolean;
}

/**
 * 分叉配置
 */
export interface ForkConfig {
  /** 是否启用分叉功能 */
  enabled: boolean;

  /** 最大分叉深度 */
  maxForkDepth: number;

  /** 单个会话最大分叉数 */
  maxForksPerSession: number;

  /** 分叉会话自动过期时间（毫秒） */
  forkExpirationMs: number;

  /** 是否允许从分叉再分叉 */
  allowNestedForks: boolean;

  /** 是否自动清理已合并的分叉 */
  autoCleanupMerged: boolean;
}

/**
 * 默认分叉配置
 */
export const DEFAULT_FORK_CONFIG: ForkConfig = {
  enabled: false,  // 默认禁用，向后兼容
  maxForkDepth: 3,
  maxForksPerSession: 5,
  forkExpirationMs: 24 * 60 * 60 * 1000, // 24 hours
  allowNestedForks: true,
  autoCleanupMerged: true,
};

// =============================================================================
// Fork Result
// =============================================================================

/**
 * 分叉结果
 */
export interface ForkResult {
  /** 是否成功 */
  success: boolean;

  /** 新分叉的会话 ID */
  forkedSessionId: string;

  /** 源会话 ID */
  parentSessionId: string;

  /** 源检查点 ID */
  sourceCheckpointId: string;

  /** 分支名称 */
  branchName: string;

  /** 分叉时间 */
  forkTime: number;

  /** 错误信息（如果失败） */
  error?: string;
}

// =============================================================================
// Session Tree
// =============================================================================

/**
 * 会话节点（树形结构）
 */
export interface SessionNode {
  /** 会话 ID */
  sessionId: string;

  /** 父会话 ID（根节点为 null） */
  parentSessionId: string | null;

  /** 子会话 ID 列表 */
  childSessionIds: string[];

  /** 分支名称 */
  branchName: string;

  /** 分叉时的检查点 ID */
  forkCheckpointId: string | null;

  /** 分叉深度（根节点为 0） */
  depth: number;

  /** 创建时间 */
  createdAt: number;

  /** 状态 */
  status: SessionNodeStatus;

  /** 假设/探索目标 */
  hypothesis?: string;

  /** 分析摘要（完成后填充） */
  summary?: SessionNodeSummary;
}

/**
 * 会话节点状态
 */
export type SessionNodeStatus =
  | 'active'      // 活跃（正在运行或可以继续）
  | 'completed'   // 已完成
  | 'merged'      // 已合并到父会话
  | 'abandoned'   // 已放弃
  | 'expired';    // 已过期

/**
 * 会话节点摘要
 */
export interface SessionNodeSummary {
  /** 总迭代次数 */
  totalIterations: number;

  /** 总发现数量 */
  totalFindings: number;

  /** 按严重程度统计 */
  findingsBySeverity: {
    critical: number;
    warning: number;
    info: number;
    high?: number;
    medium?: number;
    low?: number;
  };

  /** 关键结论 */
  keyConclusions: string[];

  /** 完成时间 */
  completedAt?: number;
}

// =============================================================================
// Comparison
// =============================================================================

/**
 * 比较结果
 */
export interface ComparisonResult {
  /** 比较的会话 ID 列表 */
  sessionIds: string[];

  /** 共同发现 */
  commonFindings: Finding[];

  /** 各会话独有的发现 */
  uniqueFindings: Map<string, Finding[]>;

  /** 冲突的发现（同一问题不同结论） */
  conflictingFindings: ConflictingFinding[];

  /** 各会话的摘要比较 */
  summaryComparison: SessionSummaryComparison[];

  /** 推荐的最佳会话 */
  recommendedSession?: string;

  /** 推荐理由 */
  recommendationReason?: string;

  /** 比较时间 */
  comparedAt: number;
}

/**
 * 冲突发现
 */
export interface ConflictingFinding {
  /** 问题标识 */
  issueKey: string;

  /** 各会话的发现 */
  findings: {
    sessionId: string;
    finding: Finding;
  }[];

  /** 冲突类型 */
  conflictType: 'severity' | 'root_cause' | 'recommendation';
}

/**
 * 会话摘要比较
 */
export interface SessionSummaryComparison {
  /** 会话 ID */
  sessionId: string;

  /** 分支名称 */
  branchName: string;

  /** 总发现数 */
  totalFindings: number;

  /** Critical 发现数 */
  criticalFindings: number;

  /** 覆盖的分析领域 */
  coveredDomains: string[];

  /** 分析质量评分（0-100） */
  qualityScore?: number;
}

// =============================================================================
// Merge
// =============================================================================

/**
 * 合并选项
 */
export interface MergeOptions {
  /** 要合并的子会话 ID */
  childSessionId: string;

  /** 合并策略 */
  strategy: MergeStrategy;

  /** 冲突解决策略 */
  conflictResolution: ConflictResolution;

  /** 是否在合并后删除子会话 */
  deleteAfterMerge: boolean;

  /** 自定义合并过滤器 */
  filter?: MergeFilter;
}

/**
 * 合并策略
 */
export type MergeStrategy =
  | 'replace'         // 完全替换父会话结果
  | 'append'          // 追加到父会话结果
  | 'merge_findings'  // 只合并发现
  | 'cherry_pick';    // 选择性合并

/**
 * 冲突解决策略
 */
export type ConflictResolution =
  | 'prefer_parent'   // 优先父会话
  | 'prefer_child'    // 优先子会话
  | 'prefer_higher_severity'  // 优先更高严重程度
  | 'keep_both';      // 都保留

/**
 * 合并过滤器
 */
export interface MergeFilter {
  /** 只合并特定严重程度的发现 */
  severities?: ('critical' | 'warning' | 'info' | 'low' | 'medium' | 'high')[];

  /** 只合并特定类别的发现 */
  categories?: string[];

  /** 排除特定阶段的结果 */
  excludeStages?: string[];
}

/**
 * 合并结果
 */
export interface MergeResult {
  /** 是否成功 */
  success: boolean;

  /** 父会话 ID */
  parentSessionId: string;

  /** 子会话 ID */
  childSessionId: string;

  /** 合并的发现数量 */
  mergedFindingsCount: number;

  /** 合并的结果数量 */
  mergedResultsCount: number;

  /** 冲突数量 */
  conflictsCount: number;

  /** 冲突解决详情 */
  conflictResolutions: ConflictResolutionDetail[];

  /** 合并时间 */
  mergedAt: number;

  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * 冲突解决详情
 */
export interface ConflictResolutionDetail {
  /** 冲突的发现 key */
  findingKey: string;

  /** 选择的来源 */
  selectedFrom: 'parent' | 'child' | 'both';

  /** 解决原因 */
  reason: string;
}

// =============================================================================
// Fork Events (for hooks)
// =============================================================================

/**
 * 分叉事件类型
 */
export type ForkEventType =
  | 'fork:created'
  | 'fork:resumed'
  | 'fork:completed'
  | 'fork:merged'
  | 'fork:abandoned'
  | 'fork:compared';

/**
 * 分叉事件数据
 */
export interface ForkEventData {
  type: ForkEventType;
  sessionId: string;
  parentSessionId?: string;
  childSessionId?: string;
  checkpointId?: string;
  branchName?: string;
  result?: ForkResult | MergeResult | ComparisonResult;
}

// =============================================================================
// Fork State (for persistence)
// =============================================================================

/**
 * 分叉状态（用于持久化）
 */
export interface ForkState {
  /** 会话树 */
  sessionTree: Map<string, SessionNode>;

  /** 根会话 ID */
  rootSessionId: string;

  /** 活跃分叉数量 */
  activeForkCount: number;

  /** 最后更新时间 */
  lastUpdated: number;
}

/**
 * 序列化的分叉状态
 */
export interface SerializedForkState {
  sessionTree: [string, SessionNode][];
  rootSessionId: string;
  activeForkCount: number;
  lastUpdated: number;
}