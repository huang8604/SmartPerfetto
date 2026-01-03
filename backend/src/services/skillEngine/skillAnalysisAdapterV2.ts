/**
 * Skill Analysis Adapter v2.0
 *
 * Integrates SkillExecutorV2 with the orchestrator.
 * Provides intent detection, skill execution, and result conversion.
 */

import { TraceProcessorService } from '../traceProcessorService';
import { SkillExecutorV2, createSkillExecutorV2 } from './skillExecutorV2';
import { skillRegistryV2, ensureSkillRegistryV2Initialized, getSkillsDir } from './skillLoaderV2';
import { SkillDefinitionV2, SkillEvent, DisplayLevel } from './types_v2';
import { smartSummaryGenerator } from './smartSummaryGenerator';
import { answerGenerator, GeneratedAnswer } from './answerGenerator';
import { SkillEventCollector, createEventCollector, EventSummary, ProgressInfo } from './eventCollector';

// =============================================================================
// Types
// =============================================================================

export interface SkillAnalysisRequestV2 {
  traceId: string;
  skillId?: string;
  question?: string;
  packageName?: string;
}

export interface SkillAnalysisResponseV2 {
  skillId: string;
  skillName: string;
  success: boolean;
  sections: Record<string, any>;
  diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    suggestions?: string[];
  }>;
  summary: string;
  executionTimeMs: number;
  vendor?: string;

  // v2 新增
  displayResults?: Array<{
    stepId: string;
    title: string;
    level: DisplayLevel;
    format: string;
    data: any;
  }>;
  aiSummary?: string;

  /** 直接回答用户问题的自然语言 */
  directAnswer?: string;
  /** 回答的问题类型 */
  questionType?: string;
  /** 回答置信度 */
  answerConfidence?: 'high' | 'medium' | 'low';

  /** 执行事件列表（用于前端进度展示） */
  executionEvents?: SkillEvent[];
  /** 事件摘要 */
  eventSummary?: EventSummary;
}

export interface SkillListItemV2 {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  keywords: string[];
  tags?: string[];
}

// =============================================================================
// Skill Analysis Adapter V2
// =============================================================================

export class SkillAnalysisAdapterV2 {
  private traceProcessor: TraceProcessorService;
  private executor: SkillExecutorV2;
  private initialized = false;
  private eventHandler?: (event: SkillEvent) => void;
  private currentEventCollector?: SkillEventCollector;

  constructor(
    traceProcessor: TraceProcessorService,
    eventHandler?: (event: SkillEvent) => void
  ) {
    this.traceProcessor = traceProcessor;
    this.eventHandler = eventHandler;

    // 创建 executor，传入事件处理器
    this.executor = createSkillExecutorV2(
      traceProcessor,
      undefined,  // AI service 稍后注入
      eventHandler
    );
  }

  /**
   * 设置 AI 服务（用于 ai_decision 和 ai_summary 步骤）
   */
  setAIService(aiService: any): void {
    // SkillExecutorV2 需要支持 setAIService 方法
    (this.executor as any).aiService = aiService;
  }

  /**
   * 设置事件处理器
   */
  setEventHandler(handler: (event: SkillEvent) => void): void {
    this.eventHandler = handler;
    (this.executor as any).eventEmitter = handler;
  }

  /**
   * 确保 skill registry 已初始化
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await ensureSkillRegistryV2Initialized();

    // 将所有 skills 注册到 executor
    const skills = skillRegistryV2.getAllSkills();
    this.executor.registerSkills(skills);

    this.initialized = true;
    console.log(`[SkillAnalysisAdapterV2] Initialized with ${skills.length} skills`);
  }

  /**
   * 从自然语言问题检测意图
   * 返回匹配的 skill ID 或 null
   */
  detectIntent(question: string): string | null {
    const skill = skillRegistryV2.findMatchingSkill(question);
    return skill ? skill.name : null;
  }

  /**
   * 检测厂商（从 trace 数据）
   */
  async detectVendor(traceId: string): Promise<{ vendor: string; confidence: number }> {
    try {
      // 尝试检测厂商特征
      const result = await this.traceProcessor.query(traceId, `
        SELECT
          CASE
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*miui*') THEN 'xiaomi'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*oppo*' OR name GLOB '*color*') THEN 'oppo'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*vivo*') THEN 'vivo'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*huawei*' OR name GLOB '*honor*') THEN 'huawei'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*samsung*' OR name GLOB '*oneui*') THEN 'samsung'
            ELSE 'aosp'
          END as vendor
      `);

      if (result.rows && result.rows.length > 0) {
        return {
          vendor: result.rows[0][0] as string,
          confidence: 0.8,
        };
      }
    } catch (error) {
      console.warn('[SkillAnalysisAdapterV2] Vendor detection failed:', error);
    }

    return { vendor: 'aosp', confidence: 0.5 };
  }

  /**
   * 执行 skill 分析
   * 这是主要的入口点
   */
  async analyze(request: SkillAnalysisRequestV2): Promise<SkillAnalysisResponseV2> {
    await this.ensureInitialized();

    const { traceId, skillId, question, packageName } = request;

    // 确定使用哪个 skill
    let targetSkillId = skillId;
    if (!targetSkillId && question) {
      targetSkillId = this.detectIntent(question) || undefined;
    }

    if (!targetSkillId) {
      return {
        skillId: 'unknown',
        skillName: 'Unknown',
        success: false,
        sections: {},
        diagnostics: [{
          id: 'no_skill_match',
          severity: 'warning',
          message: '无法匹配到合适的分析技能',
          suggestions: [
            '尝试使用关键词：启动、滑动、卡顿、内存、CPU、Binder',
            '使用 skillId 参数指定具体的技能',
          ],
        }],
        summary: '无法确定使用哪个分析技能',
        executionTimeMs: 0,
      };
    }

    // 获取 skill 信息
    const skill = skillRegistryV2.getSkill(targetSkillId);
    if (!skill) {
      return {
        skillId: targetSkillId,
        skillName: targetSkillId,
        success: false,
        sections: {},
        diagnostics: [{
          id: 'skill_not_found',
          severity: 'critical',
          message: `技能未找到: ${targetSkillId}`,
        }],
        summary: `技能未找到: ${targetSkillId}`,
        executionTimeMs: 0,
      };
    }

    // 检测厂商
    const vendorResult = await this.detectVendor(traceId);

    // 构建参数
    const params: Record<string, any> = {};
    if (packageName) {
      params.package = packageName;
    }

    // 创建事件收集器
    const eventCollector = createEventCollector();
    const totalSteps = skill.steps?.length || 1;
    eventCollector.start(targetSkillId, totalSteps);

    // 设置事件处理器（同时转发到外部处理器和收集器）
    const combinedHandler = (event: SkillEvent) => {
      eventCollector.addEvent(event);
      if (this.eventHandler) {
        this.eventHandler(event);
      }
    };
    (this.executor as any).eventEmitter = combinedHandler;

    // 执行 skill
    const result = await this.executor.execute(
      targetSkillId,
      traceId,
      params,
      { vendor: vendorResult.vendor }
    );

    // 收集事件信息
    const executionEvents = eventCollector.getEvents();
    const eventSummary = eventCollector.getSummary();

    // 转换结果格式
    const sections = this.convertDisplayResultsToSections(result.displayResults);
    const diagnostics = result.diagnostics.map(d => ({
      id: d.id,
      severity: d.severity,
      message: d.diagnosis,
      suggestions: d.suggestions,
    }));

    // 生成智能摘要（优先使用 AI 摘要，否则使用规则生成）
    let summary: string;
    if (result.aiSummary) {
      summary = result.aiSummary;
    } else {
      const generatedSummary = smartSummaryGenerator.generate({
        skillId: targetSkillId,
        skillName: skill.meta.display_name,
        displayResults: result.displayResults,
        diagnostics: result.diagnostics,
        executionTimeMs: result.executionTimeMs,
      });
      summary = generatedSummary.text;
    }

    // 生成直接回答
    const answer = answerGenerator.generateAnswer({
      originalQuestion: question || '',
      skillId: targetSkillId,
      skillName: skill.meta.display_name,
      success: result.success,
      diagnostics,
      sections,
      executionTimeMs: result.executionTimeMs,
    });

    return {
      skillId: targetSkillId,
      skillName: skill.meta.display_name,
      success: result.success,
      sections,
      diagnostics,
      summary,
      executionTimeMs: result.executionTimeMs,
      vendor: vendorResult.vendor !== 'aosp' ? vendorResult.vendor : undefined,
      displayResults: result.displayResults,
      aiSummary: result.aiSummary,
      directAnswer: answer.answer,
      questionType: answer.questionType,
      answerConfidence: answer.confidence,
      // 事件流
      executionEvents,
      eventSummary,
    };
  }

  /**
   * 将 displayResults 转换为 sections 格式（兼容 v1）
   */
  private convertDisplayResultsToSections(
    displayResults: Array<{
      stepId: string;
      title: string;
      level: DisplayLevel;
      format: string;
      data: any;
      sql?: string;  // 新增：原始 SQL
    }>
  ): Record<string, any> {
    const sections: Record<string, any> = {};

    for (const result of displayResults) {
      const section: any = {
        title: result.title,
        level: result.level,
        format: result.format,
        data: result.data.rows
          ? this.rowsToObjects(result.data.columns, result.data.rows)
          : result.data.text ? [{ text: result.data.text }] : [],
        rowCount: result.data.rows ? result.data.rows.length : 0,
        columns: result.data.columns,
        sql: result.sql,  // 保存 SQL
      };

      // 包含可展开数据和汇总（用于 iterator 类型的结果）
      if (result.data.expandableData) {
        section.expandableData = result.data.expandableData;
      }
      if (result.data.summary) {
        section.summary = result.data.summary;
      }

      sections[result.stepId] = section;
    }

    return sections;
  }

  /**
   * 将行数组转换为对象数组
   */
  private rowsToObjects(columns: string[], rows: any[][]): Record<string, any>[] {
    return rows.map(row => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * 获取所有可用的 skills 列表
   */
  async listSkills(): Promise<SkillListItemV2[]> {
    await this.ensureInitialized();

    const skills = skillRegistryV2.getAllSkills();

    return skills.map((skill: SkillDefinitionV2) => {
      const triggers = skill.triggers;
      let keywords: string[] = [];

      if (triggers?.keywords) {
        if (Array.isArray(triggers.keywords)) {
          keywords = triggers.keywords;
        } else {
          keywords = [...(triggers.keywords.zh || []), ...(triggers.keywords.en || [])];
        }
      }

      return {
        id: skill.name,
        name: skill.name,
        displayName: skill.meta?.display_name || skill.name,
        description: skill.meta?.description || '',
        type: skill.type,
        keywords,
        tags: skill.meta?.tags,
      };
    });
  }

  /**
   * 获取指定 skill 的详细信息
   */
  async getSkillDetail(skillId: string): Promise<SkillDefinitionV2 | null> {
    await this.ensureInitialized();
    return skillRegistryV2.getSkill(skillId) || null;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let adapterInstanceV2: SkillAnalysisAdapterV2 | null = null;

export function getSkillAnalysisAdapterV2(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapterV2 {
  if (!adapterInstanceV2) {
    adapterInstanceV2 = new SkillAnalysisAdapterV2(traceProcessor, eventHandler);
  }
  return adapterInstanceV2;
}

export function createSkillAnalysisAdapterV2(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapterV2 {
  return new SkillAnalysisAdapterV2(traceProcessor, eventHandler);
}
