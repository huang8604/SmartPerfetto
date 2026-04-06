// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Evaluator Agent
 *
 * 评估专家，负责：
 * 1. 评估分析结果质量
 * 2. 检测发现之间的矛盾
 * 3. 评估结果完整性
 * 4. 生成改进建议
 */

import {
  SubAgentConfig,
  SubAgentContext,
  SubAgentResult,
  Finding,
  Evaluation,
  Contradiction,
  EvaluationFeedback,
  EvaluationCriteria,
  StageResult,
  PipelineStage,
  Intent,
} from '../types';
import { BaseSubAgent } from './base/baseSubAgent';
import { ModelRouter } from '../core/modelRouter';
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

type EvaluationJsonPayload = {
  qualityScore: number;
  completenessScore: number;
  contradictions: Contradiction[];
  feedback: EvaluationFeedback;
  passed: boolean;
  needsImprovement: boolean;
};

const EVALUATION_JSON_SCHEMA: LlmJsonSchema<EvaluationJsonPayload> = {
  name: 'evaluation_json@1.0.0',
  validate: (value: unknown): value is EvaluationJsonPayload => {
    if (!isPlainObject(value)) return false;
    if (typeof (value as any).qualityScore !== 'number') return false;
    if (typeof (value as any).completenessScore !== 'number') return false;
    if (!Array.isArray((value as any).contradictions)) return false;
    if (!isPlainObject((value as any).feedback)) return false;
    if (typeof (value as any).passed !== 'boolean') return false;
    if (typeof (value as any).needsImprovement !== 'boolean') return false;
    return true;
  },
};

const CONTRADICTIONS_JSON_SCHEMA: LlmJsonSchema<Contradiction[]> = {
  name: 'contradictions_json@1.0.0',
  validate: (value: unknown): value is Contradiction[] => {
    if (!Array.isArray(value)) return false;
    for (const item of value) {
      if (!isPlainObject(item)) return false;
      if (typeof (item as any).finding1 !== 'string') return false;
      if (typeof (item as any).finding2 !== 'string') return false;
      if (typeof (item as any).description !== 'string') return false;
      if (!['minor', 'major', 'critical'].includes(String((item as any).severity))) return false;
    }
    return true;
  },
};

const EVALUATION_FEEDBACK_JSON_SCHEMA: LlmJsonSchema<EvaluationFeedback> = {
  name: 'evaluation_feedback_json@1.0.0',
  validate: (value: unknown): value is EvaluationFeedback => {
    if (!isPlainObject(value)) return false;
    if (!isStringArray((value as any).strengths)) return false;
    if (!isStringArray((value as any).weaknesses)) return false;
    if (!isStringArray((value as any).missingAspects)) return false;
    if (!isStringArray((value as any).improvementSuggestions)) return false;
    if (!isStringArray((value as any).priorityActions)) return false;
    return true;
  },
};

// 默认配置
const DEFAULT_CONFIG: SubAgentConfig = {
  id: 'evaluator',
  name: '评估专家',
  type: 'evaluator',
  description: '负责评估分析结果的质量和完整性',
  preferredModel: 'evaluation',
  tools: [],
  maxIterations: 1,
  confidenceThreshold: 0.7,
};

// 默认评估标准
const DEFAULT_CRITERIA: EvaluationCriteria = {
  minQualityScore: 0.7,
  minCompletenessScore: 0.6,
  maxContradictions: 0,
  requiredAspects: [],
};

/**
 * 评估专家实现
 */
export class EvaluatorAgent extends BaseSubAgent {
  private criteria: EvaluationCriteria;

  constructor(
    modelRouter: ModelRouter,
    config?: Partial<SubAgentConfig>,
    criteria?: Partial<EvaluationCriteria>
  ) {
    super({ ...DEFAULT_CONFIG, ...config }, modelRouter);
    this.criteria = { ...DEFAULT_CRITERIA, ...criteria };
  }

  // ==========================================================================
  // 实现抽象方法
  // ==========================================================================

  protected buildSystemPrompt(_context: SubAgentContext): string {
    return `你是 SmartPerfetto 的评估专家，专门负责评估分析结果的质量和完整性。

你的职责：
1. 评估分析发现的质量（准确性、相关性、可操作性）
2. 检测不同发现之间的矛盾
3. 评估结果相对于用户意图的完整性
4. 生成改进建议

评估标准：
- 最低质量分数: ${this.criteria.minQualityScore}
- 最低完整性分数: ${this.criteria.minCompletenessScore}
- 允许的最大矛盾数: ${this.criteria.maxContradictions}

输出格式要求：JSON`;
  }

  protected buildTaskPrompt(context: SubAgentContext): string {
    const findings = this.collectFindings(context);
    const intent = context.intent;

    return `请评估以下分析结果：

用户意图: ${intent?.primaryGoal || '分析性能问题'}
期望分析方面: ${intent?.aspects?.join(', ') || '综合分析'}

分析发现:
${findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}: ${f.description}`).join('\n')}

请评估并以 JSON 格式返回：
{
  "qualityScore": 0.0-1.0,
  "completenessScore": 0.0-1.0,
  "contradictions": [],
  "feedback": {
    "strengths": [],
    "weaknesses": [],
    "missingAspects": [],
    "improvementSuggestions": [],
    "priorityActions": []
  },
  "passed": true/false,
  "needsImprovement": true/false
}`;
  }

  protected parseResponse(response: string, _context: SubAgentContext): SubAgentResult {
    try {
      const parsed = parseLlmJson<EvaluationJsonPayload>(response, EVALUATION_JSON_SCHEMA);
      return {
        agentId: this.config.id,
        success: true,
        findings: [],
        suggestions: parsed.feedback?.improvementSuggestions || [],
        data: { evaluation: parsed },
        confidence: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 0.5,
        executionTimeMs: 0,
      };
    } catch (error) {
      // 解析失败
    }

    return {
      agentId: this.config.id,
      success: false,
      findings: [],
      suggestions: [],
      confidence: 0,
      executionTimeMs: 0,
      error: 'Failed to parse evaluation response',
    };
  }

  // ==========================================================================
  // 评估方法
  // ==========================================================================

  /**
   * 执行完整评估
   */
  async evaluate(
    results: StageResult[],
    intent: Intent
  ): Promise<Evaluation> {
    const findings = this.extractAllFindings(results);

    // 1. 评估质量
    const qualityScore = await this.assessQuality(findings, intent);

    // 2. 检测矛盾
    const contradictions = await this.detectContradictions(findings);

    // 3. 评估完整性
    const completenessScore = await this.checkCompleteness(findings, intent);

    // 4. 生成反馈
    const feedback = await this.generateFeedback(findings, {
      qualityScore,
      contradictions,
      completenessScore,
    }, intent);

    // 5. 判断是否通过
    const passed = this.checkPassed(qualityScore, completenessScore, contradictions);
    const needsImprovement = !passed || completenessScore < this.criteria.minCompletenessScore;

    return {
      passed,
      qualityScore,
      completenessScore,
      contradictions,
      feedback,
      needsImprovement,
      suggestedActions: feedback.priorityActions,
    };
  }

  /**
   * 评估质量分数
   */
  async assessQuality(findings: Finding[], intent: Intent): Promise<number> {
    if (findings.length === 0) {
      return 0;
    }

    const prompt = `评估以下分析发现的质量（准确性、相关性、可操作性）：

用户意图: ${intent.primaryGoal}

发现:
${findings.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n')}

请返回一个 0-1 之间的质量分数，只返回数字：`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation', {
        temperature: 0,
        maxTokens: 32,
        promptId: 'agent.evaluatorAgent.qualityScore',
        promptVersion: '1.0.0',
        contractVersion: 'quality_score_number@1.0.0',
      });
      const score = parseFloat(response.response.trim());
      if (!isNaN(score) && score >= 0 && score <= 1) {
        return score;
      }
    } catch (error) {
      // 评估失败
    }

    // 基于发现数量和严重程度的启发式评分
    let score = Math.min(findings.length / 5, 1) * 0.5; // 发现数量贡献 50%
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    score += (criticalCount > 0 ? 0.3 : 0); // 关键发现加分
    score += (findings.some(f => f.evidence && f.evidence.length > 0) ? 0.2 : 0); // 有证据加分

    return Math.min(score, 1);
  }

  /**
   * 检测矛盾
   */
  async detectContradictions(findings: Finding[]): Promise<Contradiction[]> {
    if (findings.length < 2) {
      return [];
    }

    const prompt = `检查以下分析发现之间是否存在矛盾：

发现:
${findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}: ${f.description}`).join('\n')}

如果存在矛盾，请以 JSON 数组格式返回：
[
  {
    "finding1": "发现1的标题",
    "finding2": "发现2的标题",
    "description": "矛盾描述",
    "severity": "minor | major | critical"
  }
]

如果没有矛盾，返回空数组: []`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation', {
        jsonMode: true,
        promptId: 'agent.evaluatorAgent.contradictions',
        promptVersion: '1.0.0',
        contractVersion: CONTRADICTIONS_JSON_SCHEMA.name,
      });
      return parseLlmJson<Contradiction[]>(response.response, CONTRADICTIONS_JSON_SCHEMA);
    } catch (error) {
      // 检测失败
    }

    return [];
  }

  /**
   * 评估完整性
   */
  async checkCompleteness(findings: Finding[], intent: Intent): Promise<number> {
    const prompt = `评估分析结果相对于用户意图的完整性：

用户意图:
- 主要目标: ${intent.primaryGoal}
- 期望分析方面: ${intent.aspects.join(', ')}
- 复杂度: ${intent.complexity}

当前发现:
${findings.map(f => `- ${f.title}`).join('\n')}

请返回一个 0-1 之间的完整性分数，只返回数字：`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation', {
        temperature: 0,
        maxTokens: 32,
        promptId: 'agent.evaluatorAgent.completenessScore',
        promptVersion: '1.0.0',
        contractVersion: 'completeness_score_number@1.0.0',
      });
      const score = parseFloat(response.response.trim());
      if (!isNaN(score) && score >= 0 && score <= 1) {
        return score;
      }
    } catch (error) {
      // 评估失败
    }

    // 基于覆盖的方面计算
    const coveredAspects = new Set<string>();
    for (const finding of findings) {
      if (finding.category) {
        coveredAspects.add(finding.category);
      }
    }

    const coverage = intent.aspects.length > 0
      ? coveredAspects.size / intent.aspects.length
      : (findings.length > 0 ? 0.5 : 0);

    return Math.min(coverage, 1);
  }

  /**
   * 生成反馈
   */
  async generateFeedback(
    findings: Finding[],
    scores: { qualityScore: number; contradictions: Contradiction[]; completenessScore: number },
    intent: Intent
  ): Promise<EvaluationFeedback> {
    const prompt = `基于以下评估结果生成反馈：

用户意图: ${intent.primaryGoal}

评估分数:
- 质量分数: ${scores.qualityScore.toFixed(2)}
- 完整性分数: ${scores.completenessScore.toFixed(2)}
- 矛盾数量: ${scores.contradictions.length}

发现:
${findings.map(f => `- [${f.severity}] ${f.title}`).join('\n')}

请以 JSON 格式返回反馈：
{
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["不足1", "不足2"],
  "missingAspects": ["缺失方面1"],
  "improvementSuggestions": ["改进建议1", "改进建议2"],
  "priorityActions": ["优先行动1"]
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation', {
        jsonMode: true,
        promptId: 'agent.evaluatorAgent.feedback',
        promptVersion: '1.0.0',
        contractVersion: EVALUATION_FEEDBACK_JSON_SCHEMA.name,
      });
      return parseLlmJson<EvaluationFeedback>(response.response, EVALUATION_FEEDBACK_JSON_SCHEMA);
    } catch (error) {
      // 生成失败
    }

    // 生成默认反馈
    return this.generateDefaultFeedback(findings, scores, intent);
  }

  /**
   * 生成默认反馈
   */
  private generateDefaultFeedback(
    findings: Finding[],
    scores: { qualityScore: number; contradictions: Contradiction[]; completenessScore: number },
    intent: Intent
  ): EvaluationFeedback {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const missingAspects: string[] = [];
    const improvementSuggestions: string[] = [];
    const priorityActions: string[] = [];

    // 分析优点
    if (findings.length >= 3) {
      strengths.push(`发现了 ${findings.length} 个问题点`);
    }
    if (findings.some(f => f.severity === 'critical')) {
      strengths.push('识别出了关键问题');
    }
    if (scores.qualityScore >= 0.7) {
      strengths.push('分析质量较高');
    }

    // 分析不足
    if (scores.qualityScore < this.criteria.minQualityScore) {
      weaknesses.push('分析质量未达标');
    }
    if (scores.completenessScore < this.criteria.minCompletenessScore) {
      weaknesses.push('分析覆盖不完整');
    }
    if (scores.contradictions.length > 0) {
      weaknesses.push(`存在 ${scores.contradictions.length} 处矛盾`);
    }

    // 缺失方面
    const coveredCategories = new Set(findings.map(f => f.category));
    for (const aspect of intent.aspects) {
      if (!coveredCategories.has(aspect)) {
        missingAspects.push(aspect);
      }
    }

    // 改进建议
    if (missingAspects.length > 0) {
      improvementSuggestions.push(`补充对 ${missingAspects.join(', ')} 的分析`);
    }
    if (scores.contradictions.length > 0) {
      improvementSuggestions.push('解决分析中的矛盾');
    }
    if (findings.length < 3) {
      improvementSuggestions.push('深入分析以发现更多问题');
    }

    // 优先行动
    if (scores.contradictions.length > 0) {
      priorityActions.push('首先解决矛盾问题');
    } else if (missingAspects.length > 0) {
      priorityActions.push(`优先分析: ${missingAspects[0]}`);
    } else if (scores.qualityScore < 0.7) {
      priorityActions.push('提高分析深度');
    }

    return {
      strengths,
      weaknesses,
      missingAspects,
      improvementSuggestions,
      priorityActions,
    };
  }

  /**
   * 检查是否通过
   */
  private checkPassed(
    qualityScore: number,
    completenessScore: number,
    contradictions: Contradiction[]
  ): boolean {
    const majorOrCritical = contradictions.filter(
      c => c.severity === 'major' || c.severity === 'critical'
    ).length;

    return (
      qualityScore >= this.criteria.minQualityScore &&
      completenessScore >= this.criteria.minCompletenessScore &&
      majorOrCritical <= this.criteria.maxContradictions
    );
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /**
   * 从上下文中收集发现
   */
  private collectFindings(context: SubAgentContext): Finding[] {
    const findings: Finding[] = [];

    if (context.previousResults) {
      for (const result of context.previousResults) {
        if (result.findings) {
          findings.push(...result.findings);
        }
      }
    }

    return findings;
  }

  /**
   * 从阶段结果中提取所有发现
   */
  private extractAllFindings(results: StageResult[]): Finding[] {
    const findings: Finding[] = [];

    for (const result of results) {
      if (result.findings) {
        findings.push(...result.findings);
      }
    }

    return findings;
  }

  /**
   * 更新评估标准
   */
  setCriteria(criteria: Partial<EvaluationCriteria>): void {
    this.criteria = { ...this.criteria, ...criteria };
  }

  /**
   * 获取评估标准
   */
  getCriteria(): EvaluationCriteria {
    return { ...this.criteria };
  }

  // ==========================================================================
  // 重写执行方法
  // ==========================================================================

  /**
   * 执行评估（简化版）
   */
  async execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult> {
    const startTime = Date.now();

    try {
      this.emit('start', { agentId: this.config.id, stage: stage.id });

      // 收集之前的结果
      const previousResults = context.previousResults || [];
      const intent = context.intent || {
        primaryGoal: '分析性能问题',
        aspects: [],
        expectedOutputType: 'diagnosis' as const,
        complexity: 'moderate' as const,
      };

      // 执行评估
      const evaluation = await this.evaluate(previousResults, intent);

      const result: SubAgentResult = {
        agentId: this.config.id,
        success: true,
        findings: [],
        suggestions: evaluation.suggestedActions,
        data: { evaluation },
        confidence: evaluation.qualityScore,
        executionTimeMs: Date.now() - startTime,
      };

      this.emit('complete', { agentId: this.config.id, result });
      return result;
    } catch (error: any) {
      this.emit('error', { agentId: this.config.id, error: error.message });

      return {
        agentId: this.config.id,
        success: false,
        findings: [],
        suggestions: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }
}

export default EvaluatorAgent;