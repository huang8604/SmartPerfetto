// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Fork Manager
 *
 * 会话分叉管理器
 * 负责创建分叉、管理会话树、比较和合并分叉结果
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
  ForkOptions,
  ForkConfig,
  ForkResult,
  MergeOptions,
  MergeResult,
  ComparisonResult,
  SessionNode,
  SessionNodeSummary,
  ConflictingFinding,
  SessionSummaryComparison,
  DEFAULT_FORK_CONFIG,
  SerializedForkState,
} from './forkTypes';
import { SessionTree, createSessionTree } from './sessionTree';
import { MergeStrategyRegistry, getMergeStrategyRegistry } from './mergeStrategies';
import { CheckpointManager } from '../state/checkpointManager';
import { SubAgentContext, Finding, StageResult, Checkpoint } from '../types';

// =============================================================================
// Fork Manager
// =============================================================================

/**
 * 分叉管理器配置
 */
export interface ForkManagerConfig extends ForkConfig {
  /** 状态持久化目录 */
  stateDir?: string;
}

/**
 * 分叉管理器
 */
export class ForkManager {
  private config: ForkManagerConfig;
  private checkpointManager: CheckpointManager;
  private mergeRegistry: MergeStrategyRegistry;
  private sessionTrees: Map<string, SessionTree>;  // rootSessionId -> tree
  private sessionContexts: Map<string, SubAgentContext>;  // sessionId -> context
  private stateDir: string;

  constructor(
    checkpointManager: CheckpointManager,
    config: Partial<ForkManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_FORK_CONFIG, ...config };
    this.checkpointManager = checkpointManager;
    this.mergeRegistry = getMergeStrategyRegistry();
    this.sessionTrees = new Map();
    this.sessionContexts = new Map();
    this.stateDir = config.stateDir || path.join(process.cwd(), 'agent-state', 'forks');
    this.ensureDirectory();
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ForkManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): ForkManagerConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // Session Tree Management
  // ===========================================================================

  /**
   * 初始化会话树（为根会话创建）
   */
  initializeSession(sessionId: string, branchName: string = 'main'): SessionTree {
    if (this.sessionTrees.has(sessionId)) {
      return this.sessionTrees.get(sessionId)!;
    }

    const tree = createSessionTree();
    tree.createRoot(sessionId, branchName);
    this.sessionTrees.set(sessionId, tree);

    return tree;
  }

  /**
   * 获取会话树
   */
  getSessionTree(rootSessionId: string): SessionTree | undefined {
    return this.sessionTrees.get(rootSessionId);
  }

  /**
   * 注册会话上下文
   */
  registerContext(sessionId: string, context: SubAgentContext): void {
    this.sessionContexts.set(sessionId, context);
  }

  /**
   * 获取会话上下文
   */
  getContext(sessionId: string): SubAgentContext | undefined {
    return this.sessionContexts.get(sessionId);
  }

  // ===========================================================================
  // Fork Operations
  // ===========================================================================

  /**
   * 从检查点创建分叉
   */
  async fork(
    parentSessionId: string,
    options: ForkOptions
  ): Promise<ForkResult> {
    // 检查是否启用
    if (!this.config.enabled) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: 'Fork feature is disabled',
      };
    }

    // 查找根会话
    const rootSessionId = this.findRootSessionId(parentSessionId);
    if (!rootSessionId) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: `Session tree not found for: ${parentSessionId}`,
      };
    }

    const tree = this.sessionTrees.get(rootSessionId)!;
    const parentNode = tree.getNode(parentSessionId);

    // 检查分叉深度限制
    if (parentNode && parentNode.depth >= this.config.maxForkDepth) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: `Max fork depth exceeded: ${this.config.maxForkDepth}`,
      };
    }

    // 检查分叉数量限制
    if (tree.getActiveForkCount() >= this.config.maxForksPerSession) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: `Max forks per session exceeded: ${this.config.maxForksPerSession}`,
      };
    }

    // 检查是否允许嵌套分叉
    if (!this.config.allowNestedForks && parentNode?.parentSessionId) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: 'Nested forks are not allowed',
      };
    }

    // 加载检查点
    const checkpoint = await this.checkpointManager.loadCheckpoint(
      parentSessionId,
      options.checkpointId
    );

    if (!checkpoint) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId,
        sourceCheckpointId: options.checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: `Checkpoint not found: ${options.checkpointId}`,
      };
    }

    // 创建新会话 ID
    const forkedSessionId = `fork_${uuidv4().slice(0, 8)}`;
    const branchName = options.branchName || `fork-${Date.now()}`;

    // 在树中添加分叉节点
    tree.addFork(
      parentSessionId,
      forkedSessionId,
      options.checkpointId,
      branchName,
      options.hypothesis
    );

    // 复制检查点到新会话
    await this.copyCheckpointToFork(parentSessionId, forkedSessionId, checkpoint);

    // 复制并更新上下文
    const parentContext = this.sessionContexts.get(parentSessionId);
    if (parentContext && options.inheritConfig !== false) {
      const forkedContext: SubAgentContext = {
        ...parentContext,
        sessionId: forkedSessionId,
        previousResults: checkpoint.stageResults,
      };
      this.sessionContexts.set(forkedSessionId, forkedContext);
    }

    // 保存状态
    await this.saveState(rootSessionId);

    return {
      success: true,
      forkedSessionId,
      parentSessionId,
      sourceCheckpointId: options.checkpointId,
      branchName,
      forkTime: Date.now(),
    };
  }

  /**
   * 复制检查点到分叉会话
   */
  private async copyCheckpointToFork(
    parentSessionId: string,
    forkedSessionId: string,
    checkpoint: Checkpoint
  ): Promise<void> {
    // 创建新检查点
    await this.checkpointManager.createCheckpoint(
      forkedSessionId,
      checkpoint.stageId,
      checkpoint.phase,
      checkpoint.stageResults,
      checkpoint.findings,
      {
        ...checkpoint.agentState,
        metadata: {
          ...checkpoint.agentState.metadata,
          forkedFrom: parentSessionId,
          sourceCheckpoint: checkpoint.id,
        },
      }
    );
  }

  // ===========================================================================
  // Fork Listing
  // ===========================================================================

  /**
   * 列出会话的所有分叉
   */
  listForks(sessionId: string): SessionNode[] {
    const rootSessionId = this.findRootSessionId(sessionId);
    if (!rootSessionId) {
      return [];
    }

    const tree = this.sessionTrees.get(rootSessionId)!;
    const node = tree.getNode(sessionId);

    if (!node) {
      return [];
    }

    return tree.getChildren(sessionId);
  }

  /**
   * 列出所有分叉（包括嵌套）
   */
  listAllForks(sessionId: string): SessionNode[] {
    const rootSessionId = this.findRootSessionId(sessionId);
    if (!rootSessionId) {
      return [];
    }

    const tree = this.sessionTrees.get(rootSessionId)!;
    return tree.getDescendants(sessionId);
  }

  /**
   * 获取会话节点信息
   */
  getSessionNode(sessionId: string): SessionNode | undefined {
    for (const [_, tree] of this.sessionTrees) {
      const node = tree.getNode(sessionId);
      if (node) {
        return node;
      }
    }
    return undefined;
  }

  // ===========================================================================
  // Comparison
  // ===========================================================================

  /**
   * 比较两个或多个会话的分析结果
   */
  async compare(sessionIds: string[]): Promise<ComparisonResult> {
    if (sessionIds.length < 2) {
      throw new Error('At least 2 sessions are required for comparison');
    }

    // 收集各会话的发现
    const sessionFindings = new Map<string, Finding[]>();
    for (const sessionId of sessionIds) {
      const context = this.sessionContexts.get(sessionId);
      if (context?.previousResults) {
        const findings = this.collectFindings(context.previousResults);
        sessionFindings.set(sessionId, findings);
      } else {
        sessionFindings.set(sessionId, []);
      }
    }

    // 找出共同发现
    const commonFindings = this.findCommonFindings(sessionFindings);

    // 找出各会话独有的发现
    const uniqueFindings = this.findUniqueFindings(sessionFindings, commonFindings);

    // 找出冲突发现
    const conflictingFindings = this.findConflictingFindings(sessionFindings);

    // 生成摘要比较
    const summaryComparison = this.generateSummaryComparison(sessionIds, sessionFindings);

    // 推荐最佳会话
    const { recommendedSession, recommendationReason } = this.recommendBestSession(
      summaryComparison
    );

    return {
      sessionIds,
      commonFindings,
      uniqueFindings,
      conflictingFindings,
      summaryComparison,
      recommendedSession,
      recommendationReason,
      comparedAt: Date.now(),
    };
  }

  /**
   * 收集结果中的所有发现
   */
  private collectFindings(results: StageResult[]): Finding[] {
    const findings: Finding[] = [];
    for (const result of results) {
      if (result.findings) {
        findings.push(...result.findings);
      }
    }
    return findings;
  }

  /**
   * 找出共同发现
   */
  private findCommonFindings(sessionFindings: Map<string, Finding[]>): Finding[] {
    const sessionIds = Array.from(sessionFindings.keys());
    if (sessionIds.length === 0) return [];

    const firstFindings = sessionFindings.get(sessionIds[0]) || [];
    const common: Finding[] = [];

    for (const finding of firstFindings) {
      const key = this.getFindingKey(finding);
      let isCommon = true;

      for (let i = 1; i < sessionIds.length; i++) {
        const otherFindings = sessionFindings.get(sessionIds[i]) || [];
        if (!otherFindings.some(f => this.getFindingKey(f) === key)) {
          isCommon = false;
          break;
        }
      }

      if (isCommon) {
        common.push(finding);
      }
    }

    return common;
  }

  /**
   * 找出各会话独有的发现
   */
  private findUniqueFindings(
    sessionFindings: Map<string, Finding[]>,
    commonFindings: Finding[]
  ): Map<string, Finding[]> {
    const commonKeys = new Set(commonFindings.map(f => this.getFindingKey(f)));
    const unique = new Map<string, Finding[]>();

    for (const [sessionId, findings] of sessionFindings) {
      const sessionUnique = findings.filter(
        f => !commonKeys.has(this.getFindingKey(f))
      );
      unique.set(sessionId, sessionUnique);
    }

    return unique;
  }

  /**
   * 找出冲突发现（同一问题不同结论）
   */
  private findConflictingFindings(
    sessionFindings: Map<string, Finding[]>
  ): ConflictingFinding[] {
    const conflicts: ConflictingFinding[] = [];
    const processed = new Set<string>();

    const sessionIds = Array.from(sessionFindings.keys());

    for (const sessionId of sessionIds) {
      const findings = sessionFindings.get(sessionId) || [];

      for (const finding of findings) {
        const key = this.getFindingKey(finding);
        if (processed.has(key)) continue;

        // 在其他会话中查找同一问题
        const relatedFindings: { sessionId: string; finding: Finding }[] = [
          { sessionId, finding },
        ];

        for (const otherId of sessionIds) {
          if (otherId === sessionId) continue;
          const otherFindings = sessionFindings.get(otherId) || [];
          const match = otherFindings.find(f => this.getFindingKey(f) === key);
          if (match) {
            relatedFindings.push({ sessionId: otherId, finding: match });
          }
        }

        // 检查是否有冲突（同一问题但结论不同）
        if (relatedFindings.length > 1) {
          const hasConflict = relatedFindings.some(
            (f1, i) =>
              relatedFindings.slice(i + 1).some(
                f2 =>
                  f1.finding.severity !== f2.finding.severity ||
                  f1.finding.description !== f2.finding.description
              )
          );

          if (hasConflict) {
            conflicts.push({
              issueKey: key,
              findings: relatedFindings,
              conflictType: this.determineConflictType(relatedFindings),
            });
          }
        }

        processed.add(key);
      }
    }

    return conflicts;
  }

  /**
   * 获取发现的唯一键
   */
  private getFindingKey(finding: Finding): string {
    return `${finding.category || 'unknown'}:${finding.title}`;
  }

  /**
   * 确定冲突类型
   */
  private determineConflictType(
    findings: { sessionId: string; finding: Finding }[]
  ): 'severity' | 'root_cause' | 'recommendation' {
    const severities = new Set(findings.map(f => f.finding.severity));
    if (severities.size > 1) {
      return 'severity';
    }
    return 'root_cause';
  }

  /**
   * 生成摘要比较
   */
  private generateSummaryComparison(
    sessionIds: string[],
    sessionFindings: Map<string, Finding[]>
  ): SessionSummaryComparison[] {
    const comparisons: SessionSummaryComparison[] = [];

    for (const sessionId of sessionIds) {
      const findings = sessionFindings.get(sessionId) || [];
      const node = this.getSessionNode(sessionId);

      const criticalCount = findings.filter(f => f.severity === 'critical').length;
      const categories = [...new Set(findings.map(f => f.category).filter(Boolean))] as string[];

      comparisons.push({
        sessionId,
        branchName: node?.branchName || 'unknown',
        totalFindings: findings.length,
        criticalFindings: criticalCount,
        coveredDomains: categories,
        qualityScore: this.calculateQualityScore(findings),
      });
    }

    return comparisons;
  }

  /**
   * 计算质量评分
   */
  private calculateQualityScore(findings: Finding[]): number {
    if (findings.length === 0) return 0;

    // 简单评分：critical = 30, warning = 20, info = 10，最高 100
    let score = 0;
    for (const finding of findings) {
      switch (finding.severity) {
        case 'critical':
          score += 30;
          break;
        case 'warning':
          score += 20;
          break;
        case 'info':
          score += 10;
          break;
      }
    }

    return Math.min(100, score);
  }

  /**
   * 推荐最佳会话
   */
  private recommendBestSession(comparisons: SessionSummaryComparison[]): {
    recommendedSession?: string;
    recommendationReason?: string;
  } {
    if (comparisons.length === 0) {
      return {};
    }

    // 按 critical 发现数和总发现数排序
    const sorted = [...comparisons].sort((a, b) => {
      if (a.criticalFindings !== b.criticalFindings) {
        return b.criticalFindings - a.criticalFindings;
      }
      return b.totalFindings - a.totalFindings;
    });

    const best = sorted[0];

    return {
      recommendedSession: best.sessionId,
      recommendationReason:
        `Highest critical findings (${best.criticalFindings}) ` +
        `and total findings (${best.totalFindings}) ` +
        `covering ${best.coveredDomains.length} domains`,
    };
  }

  // ===========================================================================
  // Merge Operations
  // ===========================================================================

  /**
   * 合并分叉到父会话
   */
  async merge(options: MergeOptions): Promise<MergeResult> {
    const childSessionId = options.childSessionId;
    const childNode = this.getSessionNode(childSessionId);

    if (!childNode) {
      return {
        success: false,
        parentSessionId: '',
        childSessionId,
        mergedFindingsCount: 0,
        mergedResultsCount: 0,
        conflictsCount: 0,
        conflictResolutions: [],
        mergedAt: Date.now(),
        error: `Child session not found: ${childSessionId}`,
      };
    }

    if (!childNode.parentSessionId) {
      return {
        success: false,
        parentSessionId: '',
        childSessionId,
        mergedFindingsCount: 0,
        mergedResultsCount: 0,
        conflictsCount: 0,
        conflictResolutions: [],
        mergedAt: Date.now(),
        error: 'Cannot merge root session',
      };
    }

    const parentSessionId = childNode.parentSessionId;
    const parentContext = this.sessionContexts.get(parentSessionId);
    const childContext = this.sessionContexts.get(childSessionId);

    if (!parentContext || !childContext) {
      return {
        success: false,
        parentSessionId,
        childSessionId,
        mergedFindingsCount: 0,
        mergedResultsCount: 0,
        conflictsCount: 0,
        conflictResolutions: [],
        mergedAt: Date.now(),
        error: 'Context not found for parent or child session',
      };
    }

    // 执行合并
    const { mergedContext, result } = this.mergeRegistry.merge(
      parentContext,
      childContext,
      options
    );

    // 更新父会话上下文
    this.sessionContexts.set(parentSessionId, mergedContext);

    // 更新树状态
    const rootSessionId = this.findRootSessionId(childSessionId);
    if (rootSessionId) {
      const tree = this.sessionTrees.get(rootSessionId)!;
      tree.updateStatus(childSessionId, 'merged');

      // 如果配置了自动清理
      if (options.deleteAfterMerge && this.config.autoCleanupMerged) {
        tree.removeNode(childSessionId, false);
        this.sessionContexts.delete(childSessionId);
      }

      await this.saveState(rootSessionId);
    }

    return {
      success: true,
      parentSessionId,
      childSessionId,
      ...result,
      mergedAt: Date.now(),
    };
  }

  // ===========================================================================
  // Session Status Management
  // ===========================================================================

  /**
   * 标记会话完成
   */
  markCompleted(sessionId: string, summary: SessionNodeSummary): void {
    const rootSessionId = this.findRootSessionId(sessionId);
    if (rootSessionId) {
      const tree = this.sessionTrees.get(rootSessionId)!;
      tree.updateStatus(sessionId, 'completed');
      tree.updateSummary(sessionId, summary);
    }
  }

  /**
   * 放弃分叉
   */
  abandonFork(sessionId: string): boolean {
    const rootSessionId = this.findRootSessionId(sessionId);
    if (!rootSessionId) {
      return false;
    }

    const tree = this.sessionTrees.get(rootSessionId)!;
    const node = tree.getNode(sessionId);

    if (!node || !node.parentSessionId) {
      return false;  // 不能放弃根节点
    }

    tree.updateStatus(sessionId, 'abandoned');
    this.saveState(rootSessionId);

    return true;
  }

  // ===========================================================================
  // State Persistence
  // ===========================================================================

  /**
   * 保存状态到磁盘
   */
  async saveState(rootSessionId: string): Promise<void> {
    const tree = this.sessionTrees.get(rootSessionId);
    if (!tree) return;

    const serialized = tree.serialize();
    const filePath = path.join(this.stateDir, `${rootSessionId}.json`);

    await fs.promises.writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8');
  }

  /**
   * 加载状态
   */
  async loadState(rootSessionId: string): Promise<SessionTree | null> {
    const filePath = path.join(this.stateDir, `${rootSessionId}.json`);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as SerializedForkState;
      const tree = SessionTree.deserialize(data);
      this.sessionTrees.set(rootSessionId, tree);
      return tree;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 清除会话状态
   */
  async clearState(rootSessionId: string): Promise<void> {
    this.sessionTrees.delete(rootSessionId);

    const filePath = path.join(this.stateDir, `${rootSessionId}.json`);
    try {
      await fs.promises.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * 查找根会话 ID
   */
  private findRootSessionId(sessionId: string): string | undefined {
    // 首先检查是否是根会话
    if (this.sessionTrees.has(sessionId)) {
      return sessionId;
    }

    // 在所有树中查找
    for (const [rootId, tree] of this.sessionTrees) {
      if (tree.getNode(sessionId)) {
        return rootId;
      }
    }

    return undefined;
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  /**
   * 获取会话树可视化
   */
  getTreeVisualization(rootSessionId: string): string {
    const tree = this.sessionTrees.get(rootSessionId);
    if (!tree) {
      return '(no session tree)';
    }
    return tree.toTreeString();
  }
}

// =============================================================================
// Singleton and Factory
// =============================================================================

let _globalForkManager: ForkManager | null = null;

/**
 * 获取全局 Fork Manager
 */
export function getForkManager(): ForkManager | null {
  return _globalForkManager;
}

/**
 * 设置全局 Fork Manager
 */
export function setForkManager(manager: ForkManager): void {
  _globalForkManager = manager;
}

/**
 * 创建 Fork Manager
 */
export function createForkManager(
  checkpointManager: CheckpointManager,
  config: Partial<ForkManagerConfig> = {}
): ForkManager {
  return new ForkManager(checkpointManager, config);
}

export default ForkManager;