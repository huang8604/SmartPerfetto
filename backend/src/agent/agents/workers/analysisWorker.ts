/**
 * SmartPerfetto Analysis Worker Agent
 *
 * 桥接层，负责：
 * 1. 将 Pipeline 阶段委托给现有的 Skill 系统执行
 * 2. 转换结果格式为统一的 Finding 结构
 * 3. 不重复实现分析逻辑，复用 YAML Skills
 *
 * 架构位置：
 *   MasterOrchestrator
 *        ↓
 *   PipelineExecutor
 *        ↓
 *   AnalysisWorker (本文件 - 桥接层)
 *        ↓
 *   SkillInvokerTool → SkillAnalysisAdapter → YAML Skills
 */

import { EventEmitter } from 'events';
import {
  PipelineStage,
  SubAgentContext,
  SubAgentResult,
  Finding,
} from '../../types';
import { StageExecutor } from '../../core/pipelineExecutor';
import { ModelRouter } from '../../core/modelRouter';
import { skillInvokerTool, getSkillIdForSceneType } from '../../tools/skillInvoker';

/**
 * Intent 到 Skill 的映射规则
 */
const INTENT_TO_SKILLS: Record<string, string[]> = {
  // 性能问题关键词 -> 对应的 Skills
  '卡顿': ['scrolling_analysis', 'janky_frame_analysis'],
  'jank': ['scrolling_analysis', 'janky_frame_analysis'],
  '滑动': ['scrolling_analysis'],
  'scroll': ['scrolling_analysis'],
  '掉帧': ['janky_frame_analysis', 'scrolling_analysis'],
  'frame': ['janky_frame_analysis'],
  '启动': ['startup_analysis'],
  'startup': ['startup_analysis'],
  'launch': ['startup_analysis'],
  '响应': ['click_response_analysis'],
  'click': ['click_response_analysis'],
  'tap': ['click_response_analysis'],
  'cpu': ['cpu_analysis'],
  '内存': ['memory_analysis'],
  'memory': ['memory_analysis'],
  'anr': ['anr_analysis'],
  'binder': ['binder_analysis'],
  '场景': ['scene_reconstruction'],
  'scene': ['scene_reconstruction'],
};

/**
 * 默认分析 Skills（当无法匹配时使用）
 */
const DEFAULT_SKILLS = ['scrolling_analysis', 'scene_reconstruction'];

/**
 * 分析 Worker - 桥接 Pipeline 和 Skill 系统
 */
export class AnalysisWorker extends EventEmitter implements StageExecutor {
  private modelRouter: ModelRouter;

  // 去重：跟踪已 emit 过 skill_data 的 skill（session 级别）
  private emittedSkillIds: Set<string> = new Set();
  private currentSessionId: string | null = null;

  constructor(modelRouter: ModelRouter) {
    super();
    this.modelRouter = modelRouter;
  }

  /**
   * 重置会话状态（新分析开始时调用）
   */
  resetForNewSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.emittedSkillIds.clear();
    console.log(`[AnalysisWorker] Reset for new session: ${sessionId}`);
  }

  /**
   * 执行阶段（实现 StageExecutor 接口）
   */
  async execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult> {
    const startTime = Date.now();

    try {
      this.emit('start', { stage: stage.id });

      let findings: Finding[] = [];

      switch (stage.id) {
        case 'execute':
          findings = await this.executeAnalysis(context);
          break;
        case 'refine':
          findings = await this.refineAnalysis(context);
          break;
        case 'conclude':
          findings = await this.synthesizeConclusion(context);
          break;
        default:
          findings = await this.executeAnalysis(context);
      }

      this.emit('complete', { stage: stage.id, findingsCount: findings.length });

      return {
        agentId: `worker-${stage.id}`,
        success: true,
        findings,
        suggestions: this.extractSuggestions(findings),
        confidence: findings.length > 0 ? 0.7 : 0.3,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.emit('error', { stage: stage.id, error: error.message });

      return {
        agentId: `worker-${stage.id}`,
        success: false,
        findings: [],
        suggestions: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 执行主分析 - 通过 Skill 系统
   */
  private async executeAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // 1. 确定要执行的 Skills
    const { skillIds, selectionReason } = this.determineSkillsWithReason(context);
    console.log(`[AnalysisWorker] Determined skills: ${skillIds.join(', ')}`);

    // emit worker_thought：Skill 选择理由
    this.emit('worker_thought', {
      agent: 'AnalysisWorker',
      skillId: skillIds.join(', '),
      step: 'skill_selection',
      reasoning: selectionReason,
      data: {
        selectedSkills: skillIds,
        intent: context.intent?.primaryGoal,
      },
    });

    // 2. 检查是否有 traceProcessorService
    if (!context.traceProcessorService || !context.traceId) {
      console.warn('[AnalysisWorker] No traceProcessorService or traceId, falling back to LLM analysis');
      console.warn(`[AnalysisWorker] Context keys: ${Object.keys(context).join(', ')}`);
      console.warn(`[AnalysisWorker] traceId: ${context.traceId}, hasService: ${!!context.traceProcessorService}`);
      return this.fallbackToLLMAnalysis(context);
    }

    console.log(`[AnalysisWorker] Using Skill system with traceId: ${context.traceId}`);

    // 3. 依次调用 Skills
    for (const skillId of skillIds) {
      try {
        const skillFindings = await this.invokeSkill(skillId, context);
        findings.push(...skillFindings);
      } catch (error: any) {
        console.error(`[AnalysisWorker] Skill ${skillId} failed:`, error.message);
        // 继续尝试其他 skills
      }
    }

    // 4. 如果所有 Skills 都失败了，降级到 LLM 分析
    if (findings.length === 0) {
      return this.fallbackToLLMAnalysis(context);
    }

    return findings;
  }

  /**
   * 调用单个 Skill 并转换结果
   */
  private async invokeSkill(skillId: string, context: SubAgentContext): Promise<Finding[]> {
    const toolContext = {
      traceProcessorService: context.traceProcessorService,
      traceId: context.traceId,
    };

    // 检查是否已经处理过这个 skill（会话级别去重）
    const skillKey = `${context.sessionId || 'default'}:${skillId}`;
    const isAlreadyProcessed = this.emittedSkillIds.has(skillKey);

    if (isAlreadyProcessed) {
      console.log(`[AnalysisWorker.invokeSkill] SKIPPING duplicate skill: ${skillId} (already processed in this session)`);
      // 仍然返回 findings（可能需要用于评估），但不重复 emit skill_data
    }

    // emit worker_thought 事件：正在执行 skill
    this.emit('worker_thought', {
      agent: 'AnalysisWorker',
      skillId,
      step: isAlreadyProcessed ? 'reusing_cached' : 'invoking',
      reasoning: isAlreadyProcessed
        ? `跳过重复执行 ${skillId}，使用缓存结果`
        : `开始执行 ${skillId} 分析`,
    });

    console.log(`[AnalysisWorker.invokeSkill] Invoking skill: ${skillId}`);
    const result = await skillInvokerTool.execute({ skillId }, toolContext);

    console.log(`[AnalysisWorker.invokeSkill] Skill ${skillId} result:`, {
      success: result.success,
      hasData: !!result.data,
      error: result.error,
    });

    if (!result.success || !result.data) {
      console.log(`[AnalysisWorker.invokeSkill] Skill ${skillId} failed or no data`);
      return [];
    }

    // 发出层级数据事件，供前端展示
    // 架构原则：Backend 只做数据规范化，不做显示格式化
    const skillData = result.data;

    // 兼容新旧层级名称
    const layerData = skillData?.data || {};
    const hasOverview = !!layerData.overview || !!layerData.L1;
    const hasList = !!layerData.list || !!layerData.L2;
    const hasDeep = !!layerData.deep || !!layerData.L4;

    console.log(`[AnalysisWorker.invokeSkill] skillData structure:`, {
      hasSkillData: !!skillData,
      hasNestedData: !!layerData,
      dataKeys: Object.keys(layerData),
      hasOverview, hasList, hasDeep,
      overviewKeys: (layerData.overview || layerData.L1) ? Object.keys(layerData.overview || layerData.L1) : [],
      listKeys: (layerData.list || layerData.L2) ? Object.keys(layerData.list || layerData.L2) : [],
      deepKeys: (layerData.deep || layerData.L4) ? Object.keys(layerData.deep || layerData.L4) : [],
    });

    if (skillData?.data) {
      const layers: Record<string, any> = {};

      // 规范化 overview/L1 数据（保持 StepResult 结构）
      // 同时支持新旧命名：优先使用语义名称，回退到旧名称
      const overviewData = layerData.overview || layerData.L1;
      if (overviewData) {
        const normalized = this.normalizeLayerData(overviewData);
        // 同时写入语义名称和兼容名称
        layers.overview = normalized;
        layers.L1 = normalized;
        console.log(`[AnalysisWorker.invokeSkill] Normalized overview/L1:`, {
          inputKeys: Object.keys(overviewData),
          outputKeys: Object.keys(normalized),
        });
      }

      // 规范化 list/L2 数据
      const listData = layerData.list || layerData.L2;
      if (listData) {
        const normalized = this.normalizeLayerData(listData);
        layers.list = normalized;
        layers.L2 = normalized;
        console.log(`[AnalysisWorker.invokeSkill] Normalized list/L2:`, {
          inputKeys: Object.keys(listData),
          outputKeys: Object.keys(normalized),
        });
      }

      // 规范化 deep/L4 数据（保持嵌套结构：sessionId -> frameId -> frameData）
      const deepData = layerData.deep || layerData.L4;
      if (deepData) {
        const normalized = this.normalizeDeepData(deepData);
        layers.deep = normalized;
        layers.L4 = normalized;
        const sessionIds = Object.keys(normalized);
        const frameCountPerSession = sessionIds.map(sid =>
          `${sid}: ${Object.keys(normalized[sid] || {}).length} frames`
        );
        console.log(`[AnalysisWorker.invokeSkill] Normalized deep/L4:`, {
          inputSessionIds: Object.keys(deepData),
          outputSessionIds: sessionIds,
          frameCountPerSession,
        });
      }

      // 只有当有层级数据时才发出事件
      const overviewCount = Object.keys(layers.overview || {}).length;
      const listCount = Object.keys(layers.list || {}).length;
      const deepCount = Object.keys(layers.deep || {}).length;
      const hasLayerData = overviewCount > 0 || listCount > 0 || deepCount > 0;

      console.log(`[AnalysisWorker.invokeSkill] Layer data check:`, {
        overviewCount, listCount, deepCount, hasLayerData,
      });

      if (hasLayerData) {
        // 去重检查：只在首次处理时 emit skill_data
        if (!isAlreadyProcessed) {
          console.log(`[AnalysisWorker.invokeSkill] EMITTING skill_data event for ${skillId}`);
          this.emit('skill_data', {
            skillId,
            skillName: skillData.skillName || skillId,
            layers,
            diagnostics: skillData.diagnostics || [],
          });
          // 标记为已处理
          this.emittedSkillIds.add(skillKey);
          console.log(`[AnalysisWorker.invokeSkill] skill_data event emitted successfully, marked as processed`);

          // emit worker_thought：完成分析
          this.emit('worker_thought', {
            agent: 'AnalysisWorker',
            skillId,
            step: 'completed',
            reasoning: `${skillId} 分析完成`,
            data: {
              overviewCount,
              listCount,
              deepCount,
              diagnosticsCount: skillData.diagnostics?.length || 0,
            },
          });
        } else {
          console.log(`[AnalysisWorker.invokeSkill] SKIPPING duplicate skill_data emit for ${skillId}`);
        }
      } else {
        console.log(`[AnalysisWorker.invokeSkill] NO DATA to emit for ${skillId} - layers are empty`);
      }
    } else {
      console.log(`[AnalysisWorker.invokeSkill] skillData.data is undefined for ${skillId}`);
    }

    // 转换 Skill 结果为 Finding 格式
    return this.convertSkillResultToFindings(skillId, result.data);
  }

  /**
   * 规范化层级数据结构
   *
   * 架构原则：
   * - Backend 只负责数据结构规范化，不做显示格式化
   * - 保持原始数据完整性，由 Frontend 决定如何展示
   * - 使用统一的 StepResult 格式：{ stepId, data, display, ... }
   *
   * @param layerData 来自 Skill 系统的层级数据 (stepId -> StepResult)
   * @returns 规范化后的数据，保持 StepResult 结构
   */
  private normalizeLayerData(layerData: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = {};

    console.log(`[normalizeLayerData] Processing ${Object.keys(layerData).length} entries`);

    for (const [stepId, stepResult] of Object.entries(layerData)) {
      console.log(`[normalizeLayerData] Processing step: ${stepId}`, {
        hasStepResult: !!stepResult,
        stepResultType: typeof stepResult,
        isArray: Array.isArray(stepResult),
        hasData: !!stepResult?.data,
        dataIsArray: Array.isArray(stepResult?.data),
        dataLength: Array.isArray(stepResult?.data) ? stepResult.data.length : 'N/A',
        stepResultKeys: stepResult ? Object.keys(stepResult) : [],
      });

      if (!stepResult || typeof stepResult !== 'object') {
        console.log(`[normalizeLayerData] Skipping ${stepId}: invalid stepResult`);
        continue;
      }

      // 提取数据数组
      let dataArray: any[] = [];
      if (Array.isArray(stepResult.data)) {
        dataArray = stepResult.data;
      } else if (Array.isArray(stepResult)) {
        dataArray = stepResult;
      }

      if (dataArray.length === 0) {
        console.log(`[normalizeLayerData] Skipping ${stepId}: empty dataArray`);
        continue;
      }

      // 保持 StepResult 结构，只做必要的规范化
      normalized[stepId] = {
        stepId,
        data: dataArray,
        display: stepResult.display || { title: stepId },
        // 保留原始元数据
        ...(stepResult.executionTimeMs && { executionTimeMs: stepResult.executionTimeMs }),
      };

      console.log(`[normalizeLayerData] Added ${stepId} with ${dataArray.length} rows`);
    }

    console.log(`[normalizeLayerData] Normalized ${Object.keys(normalized).length} entries`);
    return normalized;
  }

  /**
   * 规范化 deep/L4 帧级数据
   *
   * deep 数据结构特殊：{ sessionId: { frameId: StepResult } }
   * 每个 StepResult.data 包含 { diagnosis_summary, full_analysis }
   *
   * 架构原则：
   * - 保持嵌套结构：{ sessionId: { frameId: frameData } }
   * - list 层的 SessionList 期望 deepData[sessionId][frameId] 的格式
   * - 保留完整的分析数据和诊断信息
   * - 不做显示格式化（列名翻译等由 Frontend 处理）
   */
  private normalizeDeepData(deepData: Record<string, Record<string, any>>): Record<string, Record<string, any>> {
    const normalized: Record<string, Record<string, any>> = {};

    for (const [sessionId, frames] of Object.entries(deepData)) {
      if (!frames || typeof frames !== 'object') continue;

      // 保持嵌套结构: normalized[sessionId][frameId]
      normalized[sessionId] = {};

      for (const [frameId, stepResult] of Object.entries(frames)) {
        if (!stepResult || typeof stepResult !== 'object') continue;

        const item = (stepResult as any).item || {};
        const data = stepResult.data || {};

        // 规范化的帧数据结构，保持在嵌套位置
        normalized[sessionId][frameId] = {
          stepId: `${sessionId}_${frameId}`,
          // 帧基础信息（来自 item）
          item: {
            frame_id: item.frame_id || frameId,
            session_id: item.session_id || sessionId,
            jank_type: item.jank_type,
            dur_ms: item.dur_ms,
            start_ts: item.start_ts,
            end_ts: item.end_ts,
          },
          // 诊断结论
          diagnosis: data.diagnosis_summary || null,
          // 完整分析数据
          analysis: data.full_analysis || null,
          // 原始 data 数组（如果是表格形式）
          data: Array.isArray(data) ? data : null,
          // 显示配置
          display: stepResult.display || {
            title: `Frame ${item.frame_id || frameId}`,
            layer: 'deep',  // 使用语义名称
          },
        };
      }
    }

    return normalized;
  }

  /**
   * 将 Skill 结果转换为 Finding 格式
   */
  private convertSkillResultToFindings(skillId: string, skillResult: any): Finding[] {
    const findings: Finding[] = [];

    // 1. 从诊断信息创建 Findings
    // 只显示关键问题，不包含优化建议
    if (skillResult.diagnostics && Array.isArray(skillResult.diagnostics)) {
      for (const diag of skillResult.diagnostics) {
        findings.push({
          id: `${skillId}-${diag.id}`,
          category: skillId.replace('_analysis', ''),
          severity: this.mapSeverity(diag.severity),
          title: diag.message,
          description: diag.message,  // 只显示问题本身，不包含 suggestions
          evidence: [diag],
        });
      }
    }

    // 2. 从 overview/L1 摘要数据创建概览 Finding
    // 同时支持新旧命名
    const overviewData = skillResult.data?.overview || skillResult.data?.L1;
    if (overviewData) {
      const summary = this.buildOverviewSummary(skillId, overviewData);
      if (summary) {
        findings.push({
          id: `${skillId}-summary`,
          category: skillId.replace('_analysis', ''),
          severity: 'info',
          title: `${skillResult.skillName || skillId} 分析摘要`,
          description: summary,
          evidence: [overviewData],
        });
      }
    }

    // 3. 如果没有诊断但有 AI 摘要
    if (findings.length === 0 && skillResult.aiSummary) {
      findings.push({
        id: `${skillId}-ai-summary`,
        category: skillId.replace('_analysis', ''),
        severity: 'info',
        title: `${skillResult.skillName || skillId} 分析结果`,
        description: skillResult.aiSummary,
        evidence: [],
      });
    }

    return findings;
  }

  /**
   * 构建 overview/L1 层摘要
   */
  private buildOverviewSummary(skillId: string, overviewData: Record<string, any>): string | null {
    const parts: string[] = [];

    // 根据不同的 Skill 提取关键指标
    if (skillId === 'scrolling_analysis') {
      if (overviewData.scroll_summary?.data?.[0]) {
        const summary = overviewData.scroll_summary.data[0];
        parts.push(`总帧数: ${summary.total_frames || 0}`);
        parts.push(`卡顿帧: ${summary.jank_frames || 0}`);
        if (summary.jank_rate) parts.push(`卡顿率: ${summary.jank_rate}`);
        if (summary.avg_fps) parts.push(`平均 FPS: ${summary.avg_fps}`);
      }
    } else if (skillId === 'startup_analysis') {
      if (overviewData.startup_summary?.data?.[0]) {
        const summary = overviewData.startup_summary.data[0];
        if (summary.total_time_ms) parts.push(`启动耗时: ${summary.total_time_ms}ms`);
        if (summary.startup_type) parts.push(`启动类型: ${summary.startup_type}`);
      }
    } else if (skillId === 'janky_frame_analysis') {
      if (overviewData.jank_summary?.data?.[0]) {
        const summary = overviewData.jank_summary.data[0];
        parts.push(`严重卡顿帧数: ${summary.severe_jank_count || 0}`);
        if (summary.max_jank_duration_ms) {
          parts.push(`最长卡顿: ${summary.max_jank_duration_ms}ms`);
        }
      }
    }

    // 通用处理：遍历 overview 数据寻找关键字段
    if (parts.length === 0) {
      for (const [key, value] of Object.entries(overviewData)) {
        if (value?.data?.[0]) {
          const row = value.data[0];
          const keyMetrics = Object.entries(row)
            .filter(([k]) => !k.startsWith('_'))
            .slice(0, 5)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          if (keyMetrics) {
            parts.push(keyMetrics);
            break;
          }
        }
      }
    }

    return parts.length > 0 ? parts.join(' | ') : null;
  }

  /**
   * 确定要执行的 Skills（带选择理由）
   */
  private determineSkillsWithReason(context: SubAgentContext): { skillIds: string[]; selectionReason: string } {
    const { intent, plan } = context;
    const skills = new Set<string>();
    const matchedKeywords: string[] = [];

    // 1. 从 intent 的 primaryGoal 匹配
    if (intent?.primaryGoal) {
      const goal = intent.primaryGoal.toLowerCase();
      for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
        if (goal.includes(keyword)) {
          skillList.forEach(s => skills.add(s));
          matchedKeywords.push(`intent:${keyword}`);
        }
      }
    }

    // 2. 从 intent 的 aspects 匹配
    if (intent?.aspects) {
      for (const aspect of intent.aspects) {
        const lowerAspect = aspect.toLowerCase();
        for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
          if (lowerAspect.includes(keyword)) {
            skillList.forEach(s => skills.add(s));
            matchedKeywords.push(`aspect:${keyword}`);
          }
        }
      }
    }

    // 3. 从 plan 的 tasks 匹配
    if (plan?.tasks) {
      for (const task of plan.tasks) {
        const objective = task.objective.toLowerCase();
        for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
          if (objective.includes(keyword)) {
            skillList.forEach(s => skills.add(s));
            matchedKeywords.push(`task:${keyword}`);
          }
        }
      }
    }

    // 4. 如果没有匹配到任何 skill，使用默认
    let selectionReason: string;
    if (skills.size === 0) {
      DEFAULT_SKILLS.forEach(s => skills.add(s));
      selectionReason = `未匹配到特定关键词，使用默认分析 Skills: ${DEFAULT_SKILLS.join(', ')}`;
    } else {
      selectionReason = `基于关键词 [${matchedKeywords.join(', ')}] 选择 Skills: ${Array.from(skills).join(', ')}`;
    }

    return { skillIds: Array.from(skills), selectionReason };
  }

  /**
   * 确定要执行的 Skills（简化版，兼容旧代码）
   */
  private determineSkills(context: SubAgentContext): string[] {
    return this.determineSkillsWithReason(context).skillIds;
  }

  /**
   * 映射严重程度
   */
  private mapSeverity(severity: string): 'info' | 'warning' | 'critical' {
    const lower = severity?.toLowerCase() || '';
    if (lower.includes('critical') || lower.includes('error') || lower.includes('severe')) {
      return 'critical';
    }
    if (lower.includes('warning') || lower.includes('warn')) {
      return 'warning';
    }
    return 'info';
  }

  /**
   * 降级到 LLM 分析（当 Skill 系统不可用时）
   */
  private async fallbackToLLMAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const primaryGoal = context.intent?.primaryGoal || '性能分析';

    const prompt = `你是 Android 性能分析专家。用户询问: "${primaryGoal}"

基于用户的问题，生成一个分析结果。由于无法访问实际的 trace 数据，请提供通用的分析指导。

以 JSON 格式回复:
{
  "title": "分析结果标题",
  "description": "详细描述和建议",
  "severity": "info"
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return [{
          id: 'llm-analysis',
          category: 'analysis',
          title: parsed.title || '分析结果',
          description: parsed.description || '请确保 trace 数据已正确加载',
          severity: (parsed.severity as 'info' | 'warning' | 'critical') || 'info',
          evidence: [],
        }];
      }
    } catch (error) {
      // 静默失败
    }

    return [{
      id: 'fallback',
      category: 'system',
      title: '分析进行中',
      description: `正在分析: ${primaryGoal}。请确保 trace 数据已正确加载。`,
      severity: 'info',
      evidence: [],
    }];
  }

  /**
   * 优化分析 - 基于之前的结果深化
   */
  private async refineAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const previousResults = context.previousResults || [];
    const existingFindings: Finding[] = [];

    for (const result of previousResults) {
      if (result.findings) {
        existingFindings.push(...result.findings);
      }
    }

    // 如果已有发现，保持现有结果
    if (existingFindings.length > 0) {
      return existingFindings;
    }

    // 否则重新执行分析
    return this.executeAnalysis(context);
  }

  /**
   * 综合结论 - 去重并合并所有发现
   */
  private async synthesizeConclusion(context: SubAgentContext): Promise<Finding[]> {
    const previousResults = context.previousResults || [];
    const allFindings: Finding[] = [];

    for (const result of previousResults) {
      if (result.findings) {
        allFindings.push(...result.findings);
      }
    }

    // 去重
    const seen = new Set<string>();
    return allFindings.filter(f => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  }

  /**
   * 从 Findings 提取建议
   */
  private extractSuggestions(findings: Finding[]): string[] {
    const suggestions: string[] = [];

    for (const finding of findings) {
      if (finding.severity === 'critical') {
        suggestions.push(`[严重] ${finding.title}`);
      } else if (finding.severity === 'warning') {
        suggestions.push(`[警告] ${finding.title}`);
      }
    }

    if (suggestions.length === 0 && findings.length > 0) {
      suggestions.push('查看详细分析结果');
    }

    return suggestions.slice(0, 5); // 最多 5 条
  }
}

export default AnalysisWorker;
