// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session Tree
 *
 * 会话树结构管理
 * 追踪会话之间的父子关系和分叉历史
 */

import {
  SessionNode,
  SessionNodeStatus,
  SessionNodeSummary,
  ForkState,
  SerializedForkState,
} from './forkTypes';

// =============================================================================
// Session Tree
// =============================================================================

/**
 * 会话树
 */
export class SessionTree {
  private nodes: Map<string, SessionNode>;
  private rootSessionId: string | null;

  constructor() {
    this.nodes = new Map();
    this.rootSessionId = null;
  }

  // ===========================================================================
  // Node Management
  // ===========================================================================

  /**
   * 创建根节点
   */
  createRoot(sessionId: string, branchName: string = 'main'): SessionNode {
    const node: SessionNode = {
      sessionId,
      parentSessionId: null,
      childSessionIds: [],
      branchName,
      forkCheckpointId: null,
      depth: 0,
      createdAt: Date.now(),
      status: 'active',
    };

    this.nodes.set(sessionId, node);
    this.rootSessionId = sessionId;

    return node;
  }

  /**
   * 添加分叉节点
   */
  addFork(
    parentSessionId: string,
    childSessionId: string,
    checkpointId: string,
    branchName: string,
    hypothesis?: string
  ): SessionNode {
    const parent = this.nodes.get(parentSessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${parentSessionId}`);
    }

    const childNode: SessionNode = {
      sessionId: childSessionId,
      parentSessionId,
      childSessionIds: [],
      branchName,
      forkCheckpointId: checkpointId,
      depth: parent.depth + 1,
      createdAt: Date.now(),
      status: 'active',
      hypothesis,
    };

    // 更新父节点
    parent.childSessionIds.push(childSessionId);
    this.nodes.set(parentSessionId, parent);

    // 添加子节点
    this.nodes.set(childSessionId, childNode);

    return childNode;
  }

  /**
   * 获取节点
   */
  getNode(sessionId: string): SessionNode | undefined {
    return this.nodes.get(sessionId);
  }

  /**
   * 更新节点状态
   */
  updateStatus(sessionId: string, status: SessionNodeStatus): void {
    const node = this.nodes.get(sessionId);
    if (node) {
      node.status = status;
      this.nodes.set(sessionId, node);
    }
  }

  /**
   * 更新节点摘要
   */
  updateSummary(sessionId: string, summary: SessionNodeSummary): void {
    const node = this.nodes.get(sessionId);
    if (node) {
      node.summary = summary;
      this.nodes.set(sessionId, node);
    }
  }

  /**
   * 删除节点（及其所有子节点）
   */
  removeNode(sessionId: string, recursive: boolean = true): string[] {
    const node = this.nodes.get(sessionId);
    if (!node) {
      return [];
    }

    const removed: string[] = [];

    // 递归删除子节点
    if (recursive) {
      for (const childId of node.childSessionIds) {
        removed.push(...this.removeNode(childId, true));
      }
    }

    // 从父节点移除引用
    if (node.parentSessionId) {
      const parent = this.nodes.get(node.parentSessionId);
      if (parent) {
        parent.childSessionIds = parent.childSessionIds.filter(
          id => id !== sessionId
        );
        this.nodes.set(node.parentSessionId, parent);
      }
    }

    // 删除当前节点
    this.nodes.delete(sessionId);
    removed.push(sessionId);

    return removed;
  }

  // ===========================================================================
  // Tree Queries
  // ===========================================================================

  /**
   * 获取根节点
   */
  getRoot(): SessionNode | undefined {
    return this.rootSessionId ? this.nodes.get(this.rootSessionId) : undefined;
  }

  /**
   * 获取父节点
   */
  getParent(sessionId: string): SessionNode | undefined {
    const node = this.nodes.get(sessionId);
    if (node?.parentSessionId) {
      return this.nodes.get(node.parentSessionId);
    }
    return undefined;
  }

  /**
   * 获取子节点
   */
  getChildren(sessionId: string): SessionNode[] {
    const node = this.nodes.get(sessionId);
    if (!node) {
      return [];
    }

    return node.childSessionIds
      .map(id => this.nodes.get(id))
      .filter((n): n is SessionNode => n !== undefined);
  }

  /**
   * 获取所有祖先节点（从父到根）
   */
  getAncestors(sessionId: string): SessionNode[] {
    const ancestors: SessionNode[] = [];
    let current = this.nodes.get(sessionId);

    while (current?.parentSessionId) {
      const parent = this.nodes.get(current.parentSessionId);
      if (parent) {
        ancestors.push(parent);
        current = parent;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * 获取所有后代节点（深度优先）
   */
  getDescendants(sessionId: string): SessionNode[] {
    const node = this.nodes.get(sessionId);
    if (!node) {
      return [];
    }

    const descendants: SessionNode[] = [];
    const stack = [...node.childSessionIds];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      const current = this.nodes.get(currentId);
      if (current) {
        descendants.push(current);
        stack.push(...current.childSessionIds);
      }
    }

    return descendants;
  }

  /**
   * 获取兄弟节点
   */
  getSiblings(sessionId: string): SessionNode[] {
    const node = this.nodes.get(sessionId);
    if (!node?.parentSessionId) {
      return [];
    }

    const parent = this.nodes.get(node.parentSessionId);
    if (!parent) {
      return [];
    }

    return parent.childSessionIds
      .filter(id => id !== sessionId)
      .map(id => this.nodes.get(id))
      .filter((n): n is SessionNode => n !== undefined);
  }

  /**
   * 获取所有叶子节点
   */
  getLeaves(): SessionNode[] {
    return Array.from(this.nodes.values()).filter(
      node => node.childSessionIds.length === 0
    );
  }

  /**
   * 获取指定状态的节点
   */
  getNodesByStatus(status: SessionNodeStatus): SessionNode[] {
    return Array.from(this.nodes.values()).filter(
      node => node.status === status
    );
  }

  /**
   * 获取指定深度的节点
   */
  getNodesByDepth(depth: number): SessionNode[] {
    return Array.from(this.nodes.values()).filter(node => node.depth === depth);
  }

  // ===========================================================================
  // Tree Analysis
  // ===========================================================================

  /**
   * 获取树的最大深度
   */
  getMaxDepth(): number {
    let maxDepth = 0;
    for (const node of this.nodes.values()) {
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
    }
    return maxDepth;
  }

  /**
   * 获取活跃分叉数量
   */
  getActiveForkCount(): number {
    return Array.from(this.nodes.values()).filter(
      node => node.status === 'active' && node.parentSessionId !== null
    ).length;
  }

  /**
   * 获取节点总数
   */
  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * 检查是否为根节点
   */
  isRoot(sessionId: string): boolean {
    return sessionId === this.rootSessionId;
  }

  /**
   * 检查是否为叶子节点
   */
  isLeaf(sessionId: string): boolean {
    const node = this.nodes.get(sessionId);
    return node ? node.childSessionIds.length === 0 : false;
  }

  /**
   * 检查两个节点是否有共同祖先
   */
  haveCommonAncestor(sessionId1: string, sessionId2: string): boolean {
    const ancestors1 = new Set(this.getAncestors(sessionId1).map(n => n.sessionId));
    ancestors1.add(sessionId1);

    const ancestors2 = this.getAncestors(sessionId2).map(n => n.sessionId);
    ancestors2.push(sessionId2);

    return ancestors2.some(id => ancestors1.has(id));
  }

  /**
   * 找到两个节点的最近共同祖先
   */
  findLowestCommonAncestor(sessionId1: string, sessionId2: string): SessionNode | undefined {
    const ancestors1 = new Set(this.getAncestors(sessionId1).map(n => n.sessionId));
    ancestors1.add(sessionId1);

    // 从 session2 向上找，第一个在 ancestors1 中的就是 LCA
    let current = this.nodes.get(sessionId2);
    while (current) {
      if (ancestors1.has(current.sessionId)) {
        return current;
      }
      if (current.parentSessionId) {
        current = this.nodes.get(current.parentSessionId);
      } else {
        break;
      }
    }

    return undefined;
  }

  // ===========================================================================
  // Path Operations
  // ===========================================================================

  /**
   * 获取从根到节点的路径
   */
  getPathFromRoot(sessionId: string): SessionNode[] {
    const path = this.getAncestors(sessionId).reverse();
    const node = this.nodes.get(sessionId);
    if (node) {
      path.push(node);
    }
    return path;
  }

  /**
   * 获取两个节点之间的路径
   */
  getPathBetween(sessionId1: string, sessionId2: string): SessionNode[] {
    const lca = this.findLowestCommonAncestor(sessionId1, sessionId2);
    if (!lca) {
      return [];
    }

    // 从 session1 到 LCA 的路径
    const path1: SessionNode[] = [];
    let current = this.nodes.get(sessionId1);
    while (current && current.sessionId !== lca.sessionId) {
      path1.push(current);
      if (current.parentSessionId) {
        current = this.nodes.get(current.parentSessionId);
      } else {
        break;
      }
    }

    // 从 LCA 到 session2 的路径
    const path2: SessionNode[] = [];
    current = this.nodes.get(sessionId2);
    while (current && current.sessionId !== lca.sessionId) {
      path2.unshift(current);
      if (current.parentSessionId) {
        current = this.nodes.get(current.parentSessionId);
      } else {
        break;
      }
    }

    // 合并路径
    return [...path1, lca, ...path2];
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * 获取分叉状态
   */
  getForkState(): ForkState {
    return {
      sessionTree: this.nodes,
      rootSessionId: this.rootSessionId || '',
      activeForkCount: this.getActiveForkCount(),
      lastUpdated: Date.now(),
    };
  }

  /**
   * 序列化为 JSON
   */
  serialize(): SerializedForkState {
    return {
      sessionTree: Array.from(this.nodes.entries()),
      rootSessionId: this.rootSessionId || '',
      activeForkCount: this.getActiveForkCount(),
      lastUpdated: Date.now(),
    };
  }

  /**
   * 从序列化数据恢复
   */
  static deserialize(data: SerializedForkState): SessionTree {
    const tree = new SessionTree();
    tree.nodes = new Map(data.sessionTree);
    tree.rootSessionId = data.rootSessionId || null;
    return tree;
  }

  // ===========================================================================
  // Visualization
  // ===========================================================================

  /**
   * 生成树形可视化字符串
   */
  toTreeString(): string {
    if (!this.rootSessionId) {
      return '(empty tree)';
    }

    const lines: string[] = [];
    this.buildTreeString(this.rootSessionId, '', true, lines);
    return lines.join('\n');
  }

  /**
   * 构建树形字符串（递归）
   */
  private buildTreeString(
    sessionId: string,
    prefix: string,
    isLast: boolean,
    lines: string[]
  ): void {
    const node = this.nodes.get(sessionId);
    if (!node) {
      return;
    }

    const connector = isLast ? '└── ' : '├── ';
    const statusIcon = this.getStatusIcon(node.status);
    const summary = node.summary
      ? ` [${node.summary.totalFindings} findings]`
      : '';

    lines.push(
      `${prefix}${connector}${statusIcon} ${node.branchName} (${sessionId.slice(0, 8)}...)${summary}`
    );

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const children = node.childSessionIds;

    for (let i = 0; i < children.length; i++) {
      this.buildTreeString(
        children[i],
        childPrefix,
        i === children.length - 1,
        lines
      );
    }
  }

  /**
   * 获取状态图标
   */
  private getStatusIcon(status: SessionNodeStatus): string {
    switch (status) {
      case 'active':
        return '●';
      case 'completed':
        return '✓';
      case 'merged':
        return '⊕';
      case 'abandoned':
        return '✗';
      case 'expired':
        return '○';
      default:
        return '?';
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * 创建会话树
 */
export function createSessionTree(): SessionTree {
  return new SessionTree();
}

export default SessionTree;