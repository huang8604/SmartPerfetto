/**
 * SmartPerfetto Iteration Strategy Planner
 *
 * Phase 1.4: Intelligent iteration decision-making
 *
 * This agent decides what to do after each analysis iteration based on:
 * - Current evaluation results
 * - Previous analysis findings
 * - User intent and expectations
 * - Resource constraints
 *
 * Strategies:
 * - 'continue': Keep executing remaining skills
 * - 'deep_dive': Focus analysis on a specific area that needs more investigation
 * - 'pivot': Change analysis direction based on discoveries
 * - 'conclude': Sufficient information gathered, generate final answer
 */

import {
  Evaluation,
  StageResult,
  Intent,
  Finding,
} from '../types';
import { ModelRouter } from '../core/modelRouter';

/**
 * Available iteration strategies
 */
export type IterationStrategy =
  | 'continue'    // Keep executing remaining skills
  | 'deep_dive'   // Focus on specific area
  | 'pivot'       // Change analysis direction
  | 'conclude';   // Sufficient info, generate answer

/**
 * Context passed to the strategy planner
 */
export interface IterationContext {
  /** Current evaluation results */
  evaluation: Evaluation;
  /** Previous stage results */
  previousResults: StageResult[];
  /** Original user intent */
  intent: Intent;
  /** Current iteration count */
  iterationCount: number;
  /** Maximum allowed iterations */
  maxIterations: number;
  /** All findings collected so far */
  allFindings: Finding[];
}

/**
 * Strategy decision output
 */
export interface StrategyDecision {
  /** Chosen strategy */
  strategy: IterationStrategy;
  /** Confidence in this decision (0-1) */
  confidence: number;
  /** Reasoning for this decision */
  reasoning: string;
  /** For 'deep_dive': which area to focus on */
  focusArea?: string;
  /** For 'pivot': new direction to take */
  newDirection?: string;
  /** Additional skills to invoke */
  additionalSkills?: string[];
  /** Priority actions to take */
  priorityActions?: string[];
}

/**
 * Configuration for the strategy planner
 */
export interface StrategyPlannerConfig {
  /** Minimum quality score to consider concluding */
  minQualityForConclusion: number;
  /** Minimum completeness score to consider concluding */
  minCompletenessForConclusion: number;
  /** Threshold for deep dive (findings with high severity) */
  deepDiveThreshold: number;
  /** Whether to allow AI-driven decisions */
  useAIDecisions: boolean;
  /** 【P1 Fix】连续无改进的最大次数（超过后强制结束） */
  maxConsecutiveNoProgress: number;
  /** 【P1 Fix】最小分数改进阈值（低于此阈值视为无改进） */
  minScoreImprovementThreshold: number;
}

const DEFAULT_CONFIG: StrategyPlannerConfig = {
  minQualityForConclusion: 0.7,
  minCompletenessForConclusion: 0.6,
  deepDiveThreshold: 0.3,
  useAIDecisions: true,
  maxConsecutiveNoProgress: 2, // 连续 2 次无改进则结束
  minScoreImprovementThreshold: 0.05, // 5% 的改进阈值
};

/**
 * Iteration Strategy Planner
 *
 * Makes intelligent decisions about how to proceed after each analysis iteration.
 * This replaces the simple "passed/not passed" binary logic with nuanced strategy selection.
 */
export class IterationStrategyPlanner {
  private config: StrategyPlannerConfig;
  private modelRouter: ModelRouter;

  // 【P1 Fix】分数历史跟踪（用于无进展检测）
  private scoreHistory: Array<{ qualityScore: number; completenessScore: number; timestamp: number }> = [];
  private consecutiveNoProgressCount: number = 0;

  constructor(modelRouter: ModelRouter, config?: Partial<StrategyPlannerConfig>) {
    this.modelRouter = modelRouter;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 【P1 Fix】重置进度跟踪（新会话开始时调用）
   */
  resetProgressTracking(): void {
    this.scoreHistory = [];
    this.consecutiveNoProgressCount = 0;
    console.log('[IterationStrategyPlanner] Progress tracking reset');
  }

  /**
   * Plan the next iteration strategy based on current context
   */
  async planNextIteration(context: IterationContext): Promise<StrategyDecision> {
    const startTime = Date.now();
    console.log(`[IterationStrategyPlanner] Planning iteration ${context.iterationCount + 1}/${context.maxIterations}`);

    // 【P1 Fix】记录当前分数并检测无进展
    const noProgressDecision = this.checkNoProgress(context.evaluation);
    if (noProgressDecision) {
      return noProgressDecision;
    }

    // 1. Check if we should conclude (hard conditions)
    if (this.shouldConclude(context)) {
      return {
        strategy: 'conclude',
        confidence: 0.9,
        reasoning: 'Analysis quality and completeness meet thresholds',
      };
    }

    // 2. Check if we're at max iterations
    // Note: iterationCount is 1-indexed (starts at 1 after first round)
    // So we conclude when iterationCount >= maxIterations
    if (context.iterationCount >= context.maxIterations) {
      return {
        strategy: 'conclude',
        confidence: 0.8,
        reasoning: 'Maximum iterations reached, concluding with current findings',
      };
    }

    // 3. Use AI to make nuanced decisions if enabled
    if (this.config.useAIDecisions) {
      try {
        const aiDecision = await this.getAIDecision(context);
        console.log(`[IterationStrategyPlanner] AI decided: ${aiDecision.strategy} (confidence: ${aiDecision.confidence.toFixed(2)})`);
        return aiDecision;
      } catch (error) {
        console.warn(`[IterationStrategyPlanner] AI decision failed, using heuristics:`, error);
      }
    }

    // 4. Fallback to heuristic-based decision
    return this.getHeuristicDecision(context);
  }

  /**
   * 【P1 Fix】检测无进展情况
   * 如果连续多次迭代评估分数无明显提升，则强制结束
   */
  private checkNoProgress(evaluation: Evaluation): StrategyDecision | null {
    const currentScore = {
      qualityScore: evaluation.qualityScore,
      completenessScore: evaluation.completenessScore,
      timestamp: Date.now(),
    };

    // 添加到历史记录
    this.scoreHistory.push(currentScore);

    // 至少需要 2 次记录才能比较
    if (this.scoreHistory.length < 2) {
      return null;
    }

    // 获取上一次的分数
    const previousScore = this.scoreHistory[this.scoreHistory.length - 2];

    // 计算综合分数改进
    const previousCombined = (previousScore.qualityScore + previousScore.completenessScore) / 2;
    const currentCombined = (currentScore.qualityScore + currentScore.completenessScore) / 2;
    const improvement = currentCombined - previousCombined;

    console.log(`[IterationStrategyPlanner] Score comparison:`, {
      previous: previousCombined.toFixed(3),
      current: currentCombined.toFixed(3),
      improvement: improvement.toFixed(3),
      threshold: this.config.minScoreImprovementThreshold,
      consecutiveNoProgress: this.consecutiveNoProgressCount,
    });

    // 检查是否有显著改进
    if (improvement < this.config.minScoreImprovementThreshold) {
      this.consecutiveNoProgressCount++;
      console.log(`[IterationStrategyPlanner] No progress detected (${this.consecutiveNoProgressCount}/${this.config.maxConsecutiveNoProgress})`);

      if (this.consecutiveNoProgressCount >= this.config.maxConsecutiveNoProgress) {
        console.log(`[IterationStrategyPlanner] Max consecutive no-progress reached, forcing conclusion`);
        return {
          strategy: 'conclude',
          confidence: 0.85,
          reasoning: `连续 ${this.consecutiveNoProgressCount} 次迭代未见明显改进（分数变化 ${(improvement * 100).toFixed(1)}%），结束分析`,
        };
      }
    } else {
      // 有改进，重置计数器
      this.consecutiveNoProgressCount = 0;
    }

    return null;
  }

  /**
   * Check if analysis should conclude based on hard thresholds
   */
  private shouldConclude(context: IterationContext): boolean {
    const { evaluation } = context;

    // Conclude if evaluation passed and meets quality thresholds
    if (evaluation.passed &&
        evaluation.qualityScore >= this.config.minQualityForConclusion &&
        evaluation.completenessScore >= this.config.minCompletenessForConclusion) {
      return true;
    }

    // Also conclude if we have critical findings with high confidence
    const allFindings = context.allFindings || [];
    const criticalFindings = allFindings.filter(f => f.severity === 'critical');
    if (criticalFindings.length > 0 && evaluation.qualityScore >= 0.6) {
      return true;
    }

    return false;
  }

  /**
   * Get AI-driven strategy decision
   */
  private async getAIDecision(context: IterationContext): Promise<StrategyDecision> {
    const prompt = this.buildDecisionPrompt(context);

    const response = await this.modelRouter.callWithFallback(prompt, 'planning');

    try {
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return this.validateDecision(parsed, context);
      }
    } catch (error) {
      // Parsing failed
    }

    // Fallback
    return this.getHeuristicDecision(context);
  }

  /**
   * Build prompt for AI decision making
   */
  private buildDecisionPrompt(context: IterationContext): string {
    const { evaluation, intent, iterationCount, maxIterations, allFindings } = context;
    const fb = evaluation.feedback;

    return `你是性能分析迭代策略规划器。基于当前分析状态，决定下一步策略。

## 当前状态
- 用户意图: ${intent.primaryGoal}
- 期望分析方面: ${intent.aspects.join(', ')}
- 当前迭代: ${iterationCount}/${maxIterations}
- 质量分数: ${evaluation.qualityScore.toFixed(2)}
- 完整性分数: ${evaluation.completenessScore.toFixed(2)}

## 发现汇总
- 总发现数: ${allFindings.length}
- 严重问题: ${allFindings.filter(f => f.severity === 'critical').length}
- 警告: ${allFindings.filter(f => f.severity === 'warning').length}
- 信息: ${allFindings.filter(f => f.severity === 'info').length}

## 评估反馈
- 优点: ${fb.strengths.join('; ') || '无'}
- 不足: ${fb.weaknesses.join('; ') || '无'}
- 缺失方面: ${fb.missingAspects.join(', ') || '无'}
- 改进建议: ${fb.improvementSuggestions.join('; ') || '无'}

## 可用策略
1. **continue** - 继续执行剩余分析任务
2. **deep_dive** - 深入分析某个特定领域（需指定 focusArea）
3. **pivot** - 改变分析方向（需指定 newDirection）
4. **conclude** - 结束分析，生成最终结论

请以 JSON 格式返回策略决策：
{
  "strategy": "continue | deep_dive | pivot | conclude",
  "confidence": 0.0-1.0,
  "reasoning": "决策理由",
  "focusArea": "深入分析的领域（仅 deep_dive 需要）",
  "newDirection": "新的分析方向（仅 pivot 需要）",
  "additionalSkills": ["建议额外调用的 skill"],
  "priorityActions": ["优先执行的动作"]
}`;
  }

  /**
   * Validate and normalize AI decision
   */
  private validateDecision(parsed: any, context: IterationContext): StrategyDecision {
    const validStrategies: IterationStrategy[] = ['continue', 'deep_dive', 'pivot', 'conclude'];

    const strategy = validStrategies.includes(parsed.strategy)
      ? parsed.strategy as IterationStrategy
      : 'continue';

    return {
      strategy,
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
      reasoning: parsed.reasoning || 'AI decision',
      focusArea: parsed.focusArea,
      newDirection: parsed.newDirection,
      additionalSkills: Array.isArray(parsed.additionalSkills) ? parsed.additionalSkills : undefined,
      priorityActions: Array.isArray(parsed.priorityActions) ? parsed.priorityActions : undefined,
    };
  }

  /**
   * Get heuristic-based strategy decision (fallback)
   */
  private getHeuristicDecision(context: IterationContext): StrategyDecision {
    const { evaluation, intent, allFindings } = context;

    // Check for critical findings that need deep dive
    const criticalFindings = allFindings.filter(f => f.severity === 'critical');
    if (criticalFindings.length > 0 && evaluation.completenessScore < 0.5) {
      const categories = new Set(criticalFindings.map(f => f.category).filter(Boolean));
      return {
        strategy: 'deep_dive',
        confidence: 0.7,
        reasoning: `Found ${criticalFindings.length} critical issues that need deeper investigation`,
        focusArea: Array.from(categories)[0] || 'performance',
        priorityActions: ['Investigate root cause of critical findings'],
      };
    }

    // Check for missing aspects
    const { missingAspects } = evaluation.feedback;
    if (missingAspects.length > 0 && evaluation.completenessScore < 0.6) {
      return {
        strategy: 'continue',
        confidence: 0.6,
        reasoning: `Missing analysis of: ${missingAspects.join(', ')}`,
        priorityActions: missingAspects.map(a => `Analyze ${a}`),
      };
    }

    // Check quality vs completeness
    if (evaluation.qualityScore < 0.5) {
      return {
        strategy: 'continue',
        confidence: 0.6,
        reasoning: 'Quality score too low, need more detailed analysis',
        priorityActions: ['Improve analysis depth'],
      };
    }

    // Default: conclude if nothing else to do
    return {
      strategy: 'conclude',
      confidence: 0.5,
      reasoning: 'No clear improvement path, concluding with current findings',
    };
  }

  /**
   * Get recommended skills for a focus area
   */
  getSkillsForFocusArea(focusArea: string): string[] {
    const skillMapping: Record<string, string[]> = {
      'scrolling': ['scrolling_analysis', 'jank_frame_detail'],
      'startup': ['startup_analysis', 'startup_detail'],
      'memory': ['memory_analysis', 'gc_analysis', 'lmk_analysis'],
      'cpu': ['cpu_analysis', 'scheduling_analysis', 'cpu_profiling'],
      'binder': ['binder_analysis', 'binder_detail', 'lock_contention_analysis'],
      'frame': ['jank_frame_detail', 'app_frame_production'],
      'interaction': ['click_response_analysis', 'click_response_detail'],
      'anr': ['anr_analysis', 'anr_detail'],
      'system': ['thermal_throttling', 'io_pressure', 'suspend_wakeup_analysis'],
    };

    return skillMapping[focusArea.toLowerCase()] || [];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StrategyPlannerConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Factory function
 */
export function createIterationStrategyPlanner(
  modelRouter: ModelRouter,
  config?: Partial<StrategyPlannerConfig>
): IterationStrategyPlanner {
  return new IterationStrategyPlanner(modelRouter, config);
}

export default IterationStrategyPlanner;
