// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Decision Tree Executor
 *
 * 执行决策树，根据条件分支动态选择分析路径
 */

import { EventEmitter } from 'events';
import {
  DecisionTree,
  DecisionNode,
  DecisionContext,
  DecisionTreeExecutorConfig,
  DecisionTreeExecutionResult,
  NodeExecutionResult,
  ConclusionDefinition,
} from './types';

const DEFAULT_CONFIG: DecisionTreeExecutorConfig = {
  maxNodes: 50,
  nodeTimeoutMs: 30000,
  verbose: true,
};

/**
 * 决策树执行器
 */
export class DecisionTreeExecutor extends EventEmitter {
  private config: DecisionTreeExecutorConfig;
  private skillExecutor: SkillExecutorInterface;

  constructor(
    skillExecutor: SkillExecutorInterface,
    config: Partial<DecisionTreeExecutorConfig> = {}
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.skillExecutor = skillExecutor;
  }

  /**
   * 执行决策树
   */
  async execute(
    tree: DecisionTree,
    context: DecisionContext
  ): Promise<DecisionTreeExecutionResult> {
    const startTime = Date.now();
    const executionPath: string[] = [];
    const nodeResults: NodeExecutionResult[] = [];
    const collectedData = new Map<string, any>(context.previousResults);

    this.log(`Starting decision tree: ${tree.name} (${tree.id})`);

    let currentNodeId: string | undefined = tree.entryNode;
    let nodesExecuted = 0;
    let conclusion: ConclusionDefinition | undefined;
    let error: string | undefined;

    try {
      while (currentNodeId && nodesExecuted < this.config.maxNodes) {
        nodesExecuted++;

        // 查找当前节点
        const node = tree.nodes.find((n) => n.id === currentNodeId);
        if (!node) {
          throw new Error(`Node not found: ${currentNodeId}`);
        }

        executionPath.push(currentNodeId);
        this.log(`Executing node: ${node.name} (${node.id}) [${node.type}]`);
        this.emit('node:start', { nodeId: node.id, nodeName: node.name, nodeType: node.type });

        // 执行节点
        const nodeResult = await this.executeNode(node, context, collectedData);
        nodeResults.push(nodeResult);

        this.emit('node:complete', nodeResult);

        if (!nodeResult.success) {
          error = nodeResult.error;
          break;
        }

        // 处理结论
        if (node.type === 'CONCLUDE' && nodeResult.conclusion) {
          conclusion = nodeResult.conclusion;
          this.log(`Reached conclusion: ${conclusion.category} - ${conclusion.component}`);
          break;
        }

        // 获取下一个节点
        currentNodeId = nodeResult.nextNodeId;
      }

      if (nodesExecuted >= this.config.maxNodes) {
        error = `Max nodes (${this.config.maxNodes}) reached, possible infinite loop`;
        this.log(`WARNING: ${error}`);
      }
    } catch (e: any) {
      error = e.message;
      this.log(`ERROR: ${error}`);
    }

    const result: DecisionTreeExecutionResult = {
      treeId: tree.id,
      success: !error && !!conclusion,
      totalDurationMs: Date.now() - startTime,
      executionPath,
      nodeResults,
      conclusion,
      collectedData,
      error,
    };

    this.log(`Decision tree completed: ${result.success ? 'SUCCESS' : 'FAILED'} (${result.totalDurationMs}ms)`);
    this.log(`Execution path: ${executionPath.join(' -> ')}`);

    return result;
  }

  /**
   * 执行单个节点
   */
  private async executeNode(
    node: DecisionNode,
    context: DecisionContext,
    collectedData: Map<string, any>
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    try {
      switch (node.type) {
        case 'CHECK':
          return await this.executeCheckNode(node, context, collectedData, startTime);

        case 'ACTION':
          return await this.executeActionNode(node, context, collectedData, startTime);

        case 'BRANCH':
          return await this.executeBranchNode(node, context, collectedData, startTime);

        case 'CONCLUDE':
          return this.executeConcludeNode(node, context, collectedData, startTime);

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }
    } catch (e: any) {
      return {
        nodeId: node.id,
        nodeType: node.type,
        success: false,
        durationMs: Date.now() - startTime,
        error: e.message,
      };
    }
  }

  /**
   * 执行 CHECK 节点
   */
  private async executeCheckNode(
    node: DecisionNode,
    context: DecisionContext,
    collectedData: Map<string, any>,
    startTime: number
  ): Promise<NodeExecutionResult> {
    const check = node.check!;

    // 获取数据
    let data: any;
    if (check.useResultFrom) {
      data = collectedData.get(check.useResultFrom);
      this.log(`  Using cached result from: ${check.useResultFrom}`);
    } else if (check.skill) {
      this.log(`  Executing skill: ${check.skill}`);
      data = await this.skillExecutor.execute(check.skill, check.skillParams || {}, context);
      if (check.skill) {
        collectedData.set(check.skill, data);
      }
    }

    // 评估条件
    const conditionResult = check.evaluate(data, context);
    this.log(`  Condition "${check.description}": ${conditionResult}`);

    // 确定下一个节点
    const nextNodeId = conditionResult ? node.next?.true : node.next?.false;

    return {
      nodeId: node.id,
      nodeType: 'CHECK',
      success: true,
      durationMs: Date.now() - startTime,
      conditionResult,
      nextNodeId,
    };
  }

  /**
   * 执行 ACTION 节点
   */
  private async executeActionNode(
    node: DecisionNode,
    context: DecisionContext,
    collectedData: Map<string, any>,
    startTime: number
  ): Promise<NodeExecutionResult> {
    const action = node.action!;

    this.log(`  Executing action: ${action.description}`);
    this.log(`  Skill: ${action.skill}`);

    const result = await this.skillExecutor.execute(action.skill, action.params || {}, context);

    // 存储结果
    const resultKey = action.resultKey || action.skill;
    collectedData.set(resultKey, result);

    return {
      nodeId: node.id,
      nodeType: 'ACTION',
      success: true,
      durationMs: Date.now() - startTime,
      actionResult: result,
      nextNodeId: node.next?.default,
    };
  }

  /**
   * 执行 BRANCH 节点 (多条件分支)
   */
  private async executeBranchNode(
    node: DecisionNode,
    context: DecisionContext,
    collectedData: Map<string, any>,
    startTime: number
  ): Promise<NodeExecutionResult> {
    const branches = node.branches!;

    for (const branch of branches) {
      // 获取数据
      let data: any;
      if (branch.condition.useResultFrom) {
        data = collectedData.get(branch.condition.useResultFrom);
      } else if (branch.condition.skill) {
        data = await this.skillExecutor.execute(
          branch.condition.skill,
          branch.condition.skillParams || {},
          context
        );
        collectedData.set(branch.condition.skill, data);
      }

      // 评估条件
      const conditionResult = branch.condition.evaluate(data, context);
      this.log(`  Branch "${branch.condition.description}": ${conditionResult}`);

      if (conditionResult) {
        return {
          nodeId: node.id,
          nodeType: 'BRANCH',
          success: true,
          durationMs: Date.now() - startTime,
          conditionResult: true,
          nextNodeId: branch.next,
        };
      }
    }

    // 没有匹配的分支，使用默认
    return {
      nodeId: node.id,
      nodeType: 'BRANCH',
      success: true,
      durationMs: Date.now() - startTime,
      conditionResult: false,
      nextNodeId: node.next?.default,
    };
  }

  /**
   * 执行 CONCLUDE 节点
   */
  private executeConcludeNode(
    node: DecisionNode,
    context: DecisionContext,
    collectedData: Map<string, any>,
    startTime: number
  ): NodeExecutionResult {
    const conclusion = node.conclusion!;

    // 替换模板中的变量
    let summary = conclusion.summaryTemplate;
    for (const [key, value] of collectedData) {
      summary = summary.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }

    const finalConclusion: ConclusionDefinition = {
      ...conclusion,
      summaryTemplate: summary,
    };

    return {
      nodeId: node.id,
      nodeType: 'CONCLUDE',
      success: true,
      durationMs: Date.now() - startTime,
      conclusion: finalConclusion,
    };
  }

  /**
   * 日志输出
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[DecisionTreeExecutor] ${message}`);
    }
  }
}

/**
 * Skill 执行器接口
 * 用于解耦决策树和实际的 Skill 执行
 */
export interface SkillExecutorInterface {
  execute(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): Promise<any>;
}

/**
 * 创建决策树执行器
 */
export function createDecisionTreeExecutor(
  skillExecutor: SkillExecutorInterface,
  config?: Partial<DecisionTreeExecutorConfig>
): DecisionTreeExecutor {
  return new DecisionTreeExecutor(skillExecutor, config);
}