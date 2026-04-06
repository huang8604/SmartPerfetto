// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Merge Strategies
 *
 * 会话合并策略
 * 定义如何将分叉会话的结果合并回父会话
 */

import {
  MergeStrategy,
  ConflictResolution,
  MergeOptions,
  MergeResult,
  MergeFilter,
  ConflictResolutionDetail,
  ConflictingFinding,
} from './forkTypes';
import { Finding, StageResult, SubAgentContext } from '../types';

// =============================================================================
// Merge Strategy Interface
// =============================================================================

/**
 * 合并策略接口
 */
export interface IMergeStrategy {
  name: MergeStrategy;

  /**
   * 合并结果
   */
  mergeResults(
    parentResults: StageResult[],
    childResults: StageResult[],
    options: MergeOptions
  ): MergeResultData;

  /**
   * 合并发现
   */
  mergeFindings(
    parentFindings: Finding[],
    childFindings: Finding[],
    options: MergeOptions
  ): MergeFindingsData;
}

/**
 * 合并结果数据
 */
export interface MergeResultData {
  mergedResults: StageResult[];
  mergedCount: number;
}

/**
 * 合并发现数据
 */
export interface MergeFindingsData {
  mergedFindings: Finding[];
  conflicts: ConflictingFinding[];
  resolutions: ConflictResolutionDetail[];
}

// =============================================================================
// Replace Strategy
// =============================================================================

/**
 * 替换策略：完全用子会话的结果替换父会话
 */
export class ReplaceStrategy implements IMergeStrategy {
  name: MergeStrategy = 'replace';

  mergeResults(
    _parentResults: StageResult[],
    childResults: StageResult[],
    options: MergeOptions
  ): MergeResultData {
    const filtered = this.applyFilter(childResults, options.filter);
    return {
      mergedResults: filtered,
      mergedCount: filtered.length,
    };
  }

  mergeFindings(
    _parentFindings: Finding[],
    childFindings: Finding[],
    options: MergeOptions
  ): MergeFindingsData {
    const filtered = this.applyFindingsFilter(childFindings, options.filter);
    return {
      mergedFindings: filtered,
      conflicts: [],
      resolutions: [],
    };
  }

  private applyFilter(results: StageResult[], filter?: MergeFilter): StageResult[] {
    if (!filter?.excludeStages) {
      return results;
    }
    return results.filter(r => !filter.excludeStages!.includes(r.stageId));
  }

  private applyFindingsFilter(findings: Finding[], filter?: MergeFilter): Finding[] {
    if (!filter) {
      return findings;
    }

    let filtered = findings;

    if (filter.severities) {
      filtered = filtered.filter(f => filter.severities!.includes(f.severity));
    }

    if (filter.categories) {
      filtered = filtered.filter(f => f.category && filter.categories!.includes(f.category));
    }

    return filtered;
  }
}

// =============================================================================
// Append Strategy
// =============================================================================

/**
 * 追加策略：将子会话的结果追加到父会话
 */
export class AppendStrategy implements IMergeStrategy {
  name: MergeStrategy = 'append';

  mergeResults(
    parentResults: StageResult[],
    childResults: StageResult[],
    options: MergeOptions
  ): MergeResultData {
    const filtered = this.applyFilter(childResults, options.filter);

    // 标记子会话的结果来源（存储在 data 字段中）
    const taggedChildResults = filtered.map(r => ({
      ...r,
      data: {
        ...r.data,
        _mergeInfo: {
          sourceSession: options.childSessionId,
          mergedAt: Date.now(),
        },
      },
    }));

    return {
      mergedResults: [...parentResults, ...taggedChildResults],
      mergedCount: taggedChildResults.length,
    };
  }

  mergeFindings(
    parentFindings: Finding[],
    childFindings: Finding[],
    options: MergeOptions
  ): MergeFindingsData {
    const filtered = this.applyFindingsFilter(childFindings, options.filter);

    // 检测重复/冲突
    const { unique, conflicts } = this.detectConflicts(parentFindings, filtered);

    // 解决冲突
    const { resolved, resolutions } = this.resolveConflicts(
      parentFindings,
      conflicts,
      options.conflictResolution
    );

    return {
      mergedFindings: [...parentFindings, ...unique, ...resolved],
      conflicts,
      resolutions,
    };
  }

  private applyFilter(results: StageResult[], filter?: MergeFilter): StageResult[] {
    if (!filter?.excludeStages) {
      return results;
    }
    return results.filter(r => !filter.excludeStages!.includes(r.stageId));
  }

  private applyFindingsFilter(findings: Finding[], filter?: MergeFilter): Finding[] {
    if (!filter) {
      return findings;
    }

    let filtered = findings;

    if (filter.severities) {
      filtered = filtered.filter(f => filter.severities!.includes(f.severity));
    }

    if (filter.categories) {
      filtered = filtered.filter(f => f.category && filter.categories!.includes(f.category));
    }

    return filtered;
  }

  private detectConflicts(
    parentFindings: Finding[],
    childFindings: Finding[]
  ): { unique: Finding[]; conflicts: ConflictingFinding[] } {
    const parentKeys = new Map<string, Finding>();
    for (const f of parentFindings) {
      parentKeys.set(this.getFindingKey(f), f);
    }

    const unique: Finding[] = [];
    const conflicts: ConflictingFinding[] = [];

    for (const childFinding of childFindings) {
      const key = this.getFindingKey(childFinding);
      const parentFinding = parentKeys.get(key);

      if (parentFinding) {
        // 存在冲突
        if (this.isConflicting(parentFinding, childFinding)) {
          conflicts.push({
            issueKey: key,
            findings: [
              { sessionId: 'parent', finding: parentFinding },
              { sessionId: 'child', finding: childFinding },
            ],
            conflictType: this.getConflictType(parentFinding, childFinding),
          });
        }
        // 如果不冲突，忽略（已存在）
      } else {
        unique.push(childFinding);
      }
    }

    return { unique, conflicts };
  }

  private getFindingKey(finding: Finding): string {
    // 使用标题和类别作为唯一键
    return `${finding.category || 'unknown'}:${finding.title}`;
  }

  private isConflicting(f1: Finding, f2: Finding): boolean {
    // 严重程度不同或描述不同视为冲突
    return f1.severity !== f2.severity || f1.description !== f2.description;
  }

  private getConflictType(f1: Finding, f2: Finding): 'severity' | 'root_cause' | 'recommendation' {
    if (f1.severity !== f2.severity) {
      return 'severity';
    }
    return 'root_cause';
  }

  private resolveConflicts(
    parentFindings: Finding[],
    conflicts: ConflictingFinding[],
    resolution: ConflictResolution
  ): { resolved: Finding[]; resolutions: ConflictResolutionDetail[] } {
    const resolved: Finding[] = [];
    const resolutions: ConflictResolutionDetail[] = [];

    for (const conflict of conflicts) {
      const parentFinding = conflict.findings.find(f => f.sessionId === 'parent')?.finding;
      const childFinding = conflict.findings.find(f => f.sessionId === 'child')?.finding;

      if (!parentFinding || !childFinding) continue;

      let selectedFinding: Finding;
      let selectedFrom: 'parent' | 'child' | 'both';
      let reason: string;

      switch (resolution) {
        case 'prefer_parent':
          selectedFinding = parentFinding;
          selectedFrom = 'parent';
          reason = 'Preferred parent session finding';
          break;

        case 'prefer_child':
          selectedFinding = childFinding;
          selectedFrom = 'child';
          reason = 'Preferred child session finding';
          // 替换父会话中的发现
          resolved.push(childFinding);
          break;

        case 'prefer_higher_severity':
          const severityOrder: Record<string, number> = {
            critical: 6, high: 5, warning: 4, medium: 3, low: 2, info: 1
          };
          if ((severityOrder[childFinding.severity] || 0) > (severityOrder[parentFinding.severity] || 0)) {
            selectedFinding = childFinding;
            selectedFrom = 'child';
            reason = `Child has higher severity: ${childFinding.severity} > ${parentFinding.severity}`;
            resolved.push(childFinding);
          } else {
            selectedFinding = parentFinding;
            selectedFrom = 'parent';
            reason = `Parent has higher or equal severity: ${parentFinding.severity}`;
          }
          break;

        case 'keep_both':
        default:
          // 保留两个，但标记冲突（通过 title 前缀标记）
          resolved.push({
            ...childFinding,
            title: `[Alt: ${conflict.issueKey}] ${childFinding.title}`,
          });
          selectedFrom = 'both';
          reason = 'Kept both findings';
          break;
      }

      resolutions.push({
        findingKey: conflict.issueKey,
        selectedFrom,
        reason,
      });
    }

    return { resolved, resolutions };
  }
}

// =============================================================================
// Merge Findings Strategy
// =============================================================================

/**
 * 仅合并发现策略：只合并 findings，不改变 results
 */
export class MergeFindingsStrategy implements IMergeStrategy {
  name: MergeStrategy = 'merge_findings';

  private appendStrategy = new AppendStrategy();

  mergeResults(
    parentResults: StageResult[],
    _childResults: StageResult[],
    _options: MergeOptions
  ): MergeResultData {
    // 不改变 results
    return {
      mergedResults: parentResults,
      mergedCount: 0,
    };
  }

  mergeFindings(
    parentFindings: Finding[],
    childFindings: Finding[],
    options: MergeOptions
  ): MergeFindingsData {
    return this.appendStrategy.mergeFindings(parentFindings, childFindings, options);
  }
}

// =============================================================================
// Cherry Pick Strategy
// =============================================================================

/**
 * 选择性合并策略：只合并符合特定条件的内容
 */
export class CherryPickStrategy implements IMergeStrategy {
  name: MergeStrategy = 'cherry_pick';

  mergeResults(
    parentResults: StageResult[],
    childResults: StageResult[],
    options: MergeOptions
  ): MergeResultData {
    if (!options.filter) {
      // 没有过滤器，不合并任何内容
      return {
        mergedResults: parentResults,
        mergedCount: 0,
      };
    }

    // 只合并符合过滤条件的结果
    const filtered = childResults.filter(r => {
      if (options.filter!.excludeStages?.includes(r.stageId)) {
        return false;
      }
      return true;
    });

    // 标记来源（存储在 data 字段中）
    const tagged = filtered.map(r => ({
      ...r,
      data: {
        ...r.data,
        _mergeInfo: {
          cherryPicked: true,
          sourceSession: options.childSessionId,
        },
      },
    }));

    return {
      mergedResults: [...parentResults, ...tagged],
      mergedCount: tagged.length,
    };
  }

  mergeFindings(
    parentFindings: Finding[],
    childFindings: Finding[],
    options: MergeOptions
  ): MergeFindingsData {
    if (!options.filter) {
      return {
        mergedFindings: parentFindings,
        conflicts: [],
        resolutions: [],
      };
    }

    // 只合并符合条件的发现
    let filtered = childFindings;

    if (options.filter.severities) {
      filtered = filtered.filter(f => options.filter!.severities!.includes(f.severity));
    }

    if (options.filter.categories) {
      filtered = filtered.filter(
        f => f.category && options.filter!.categories!.includes(f.category)
      );
    }

    // 标记来源（通过 title 前缀标记）
    const tagged = filtered.map(f => ({
      ...f,
      title: `[Pick: ${options.childSessionId.slice(0, 8)}] ${f.title}`,
    }));

    return {
      mergedFindings: [...parentFindings, ...tagged],
      conflicts: [],
      resolutions: [],
    };
  }
}

// =============================================================================
// Strategy Registry
// =============================================================================

/**
 * 合并策略注册表
 */
export class MergeStrategyRegistry {
  private strategies: Map<MergeStrategy, IMergeStrategy>;

  constructor() {
    this.strategies = new Map();

    // 注册内置策略
    this.register(new ReplaceStrategy());
    this.register(new AppendStrategy());
    this.register(new MergeFindingsStrategy());
    this.register(new CherryPickStrategy());
  }

  /**
   * 注册策略
   */
  register(strategy: IMergeStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * 获取策略
   */
  get(name: MergeStrategy): IMergeStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Unknown merge strategy: ${name}`);
    }
    return strategy;
  }

  /**
   * 执行合并
   */
  merge(
    parentContext: SubAgentContext,
    childContext: SubAgentContext,
    options: MergeOptions
  ): {
    mergedContext: SubAgentContext;
    result: Omit<MergeResult, 'success' | 'parentSessionId' | 'childSessionId' | 'mergedAt'>;
  } {
    const strategy = this.get(options.strategy);

    // 合并结果
    const resultData = strategy.mergeResults(
      parentContext.previousResults || [],
      childContext.previousResults || [],
      options
    );

    // 收集所有发现
    const parentFindings = this.collectFindings(parentContext.previousResults || []);
    const childFindings = this.collectFindings(childContext.previousResults || []);

    // 合并发现
    const findingsData = strategy.mergeFindings(parentFindings, childFindings, options);

    // 构建合并后的上下文
    const mergedContext: SubAgentContext = {
      ...parentContext,
      previousResults: resultData.mergedResults,
    };

    return {
      mergedContext,
      result: {
        mergedFindingsCount: findingsData.mergedFindings.length - parentFindings.length,
        mergedResultsCount: resultData.mergedCount,
        conflictsCount: findingsData.conflicts.length,
        conflictResolutions: findingsData.resolutions,
      },
    };
  }

  /**
   * 收集所有发现
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
}

// =============================================================================
// Singleton
// =============================================================================

let _mergeRegistry: MergeStrategyRegistry | null = null;

/**
 * 获取合并策略注册表
 */
export function getMergeStrategyRegistry(): MergeStrategyRegistry {
  if (!_mergeRegistry) {
    _mergeRegistry = new MergeStrategyRegistry();
  }
  return _mergeRegistry;
}

/**
 * 创建合并策略注册表
 */
export function createMergeStrategyRegistry(): MergeStrategyRegistry {
  return new MergeStrategyRegistry();
}

export default MergeStrategyRegistry;