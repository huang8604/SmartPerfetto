/**
 * Skill Invoker Tool
 *
 * 允许 Agent 调用已注册的 YAML Skills 进行分析
 * 将 Skill 系统封装为 Agent 可调用的工具
 */

import { Tool, ToolContext, ToolResult, ToolDefinition } from '../types';

// =============================================================================
// Types
// =============================================================================

interface SkillInvokerParams {
  /** Skill ID (如: startup_analysis, scrolling_analysis) */
  skillId: string;
  /** 可选的时间范围 - 起始时间戳 (纳秒) */
  startTs?: string;
  /** 可选的时间范围 - 结束时间戳 (纳秒) */
  endTs?: string;
  /** 可选的包名过滤 */
  packageName?: string;
  /** 其他自定义参数 */
  params?: Record<string, any>;
}

interface SkillInvokerResult {
  skillId: string;
  skillName: string;
  success: boolean;
  /** 摘要信息 */
  summary: string;
  /** 详细数据 */
  data: Record<string, any>;
  /** 诊断信息 */
  diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    suggestions?: string[];
  }>;
  /** AI 生成的摘要 */
  aiSummary?: string;
  /** 执行耗时 */
  executionTimeMs: number;
}

// =============================================================================
// Tool Definition
// =============================================================================

const definition: ToolDefinition = {
  name: 'invoke_skill',
  description: `调用已注册的 YAML Skill 进行专业分析。可用的 Skills 包括：
- startup_analysis: 应用启动分析（冷启动/温启动/热启动）
- scrolling_analysis: 滑动性能分析（FPS、掉帧率、卡顿原因）
- click_response_analysis: 点击响应分析（输入延迟、处理耗时）
- janky_frame_analysis: 掉帧分析（帧级别详细分析）
- cpu_analysis: CPU 使用分析
- binder_analysis: Binder IPC 分析
- memory_analysis: 内存分析
- anr_analysis: ANR 分析
- scene_reconstruction: 场景还原（用户操作时间线）`,
  category: 'analysis',
  parameters: [
    {
      name: 'skillId',
      type: 'string',
      required: true,
      description: 'Skill ID, 如 startup_analysis, scrolling_analysis 等',
    },
    {
      name: 'startTs',
      type: 'timestamp',
      required: false,
      description: '分析的起始时间戳（纳秒）',
    },
    {
      name: 'endTs',
      type: 'timestamp',
      required: false,
      description: '分析的结束时间戳（纳秒）',
    },
    {
      name: 'packageName',
      type: 'string',
      required: false,
      description: '要分析的应用包名',
    },
    {
      name: 'params',
      type: 'object',
      required: false,
      description: '传递给 Skill 的其他参数',
    },
  ],
  returns: {
    type: 'SkillInvokerResult',
    description: 'Skill 执行结果，包含摘要、详细数据和诊断信息',
  },
};

// =============================================================================
// Tool Implementation
// =============================================================================

export const skillInvokerTool: Tool<SkillInvokerParams, SkillInvokerResult> = {
  definition,

  validate(params: SkillInvokerParams) {
    const errors: string[] = [];

    if (!params.skillId || typeof params.skillId !== 'string') {
      errors.push('skillId parameter is required and must be a string');
    }

    if (params.skillId && params.skillId.trim().length === 0) {
      errors.push('skillId parameter cannot be empty');
    }

    // 验证已知的 skill IDs
    const knownSkills = [
      'startup_analysis',
      'scrolling_analysis',
      'click_response_analysis',
      'janky_frame_analysis',
      'jank_frame_detail',
      'cpu_analysis',
      'binder_analysis',
      'memory_analysis',
      'anr_analysis',
      'scene_reconstruction',
      'gc_analysis',
      'network_analysis',
      'gpu_analysis',
      'lock_contention_analysis',
    ];

    if (params.skillId && !knownSkills.includes(params.skillId)) {
      // 不阻止执行，只是警告
      console.warn(`[SkillInvoker] Unknown skill ID: ${params.skillId}`);
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(
    params: SkillInvokerParams,
    context: ToolContext
  ): Promise<ToolResult<SkillInvokerResult>> {
    const startTime = Date.now();

    try {
      // 验证参数
      const validation = this.validate?.(params);
      if (validation && !validation.valid) {
        return {
          success: false,
          error: validation.errors.join('; '),
          executionTimeMs: Date.now() - startTime,
        };
      }

      // 检查 context
      if (!context.traceProcessorService || !context.traceId) {
        return {
          success: false,
          error: 'TraceProcessorService and traceId are required in context',
          executionTimeMs: Date.now() - startTime,
        };
      }

      // 动态导入 SkillAnalysisAdapter 以避免循环依赖
      const { SkillAnalysisAdapter } = await import(
        '../../services/skillEngine/skillAnalysisAdapter'
      );

      // 创建 adapter 实例
      const adapter = new SkillAnalysisAdapter(context.traceProcessorService);

      // 构建请求
      const request = {
        traceId: context.traceId,
        skillId: params.skillId,
        packageName: params.packageName || context.package,
      };

      // 执行 skill
      console.log(`[SkillInvoker] Invoking skill: ${params.skillId}`);
      const response = await adapter.analyze(request);

      // 转换结果
      const result: SkillInvokerResult = {
        skillId: response.skillId,
        skillName: response.skillName,
        success: response.success,
        summary: response.summary || '',
        data: {
          sections: response.sections,
          displayResults: response.displayResults,
          layeredResult: response.layeredResult,
        },
        diagnostics: response.diagnostics || [],
        aiSummary: response.aiSummary,
        executionTimeMs: response.executionTimeMs,
      };

      // 提取关键数据用于 Agent 分析
      // 同时支持语义名称 (overview/list/deep) 和旧名称 (L1/L2/L4)
      if (response.layeredResult?.layers) {
        const layers = response.layeredResult.layers;

        // 扁平化 overview/L1 数据
        const overviewData = layers.overview || layers.L1;
        if (overviewData) {
          const flattened: Record<string, any> = {};
          for (const [key, value] of Object.entries(overviewData)) {
            flattened[key] = value;
          }
          // 同时写入语义名称和兼容名称
          result.data.overview = flattened;
          result.data.L1 = flattened;
        }

        // 扁平化 list/L2 数据
        const listData = layers.list || layers.L2;
        if (listData) {
          const flattened: Record<string, any> = {};
          for (const [key, value] of Object.entries(listData)) {
            flattened[key] = value;
          }
          result.data.list = flattened;
          result.data.L2 = flattened;
        }

        // deep/L4 数据（如果有）
        const deepData = layers.deep || layers.L4;
        if (deepData && Object.keys(deepData).length > 0) {
          result.data.deep = deepData;
          result.data.L4 = deepData;
        }
      }

      return {
        success: true,
        data: result,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          skillId: params.skillId,
          hasLayeredResult: !!response.layeredResult,
        },
      };
    } catch (error: any) {
      console.error(`[SkillInvoker] Error invoking skill ${params.skillId}:`, error);
      return {
        success: false,
        error: error.message || `Failed to invoke skill: ${params.skillId}`,
        executionTimeMs: Date.now() - startTime,
      };
    }
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * 获取所有可用的 Skill IDs
 */
export function getAvailableSkillIds(): string[] {
  return [
    'startup_analysis',
    'scrolling_analysis',
    'click_response_analysis',
    'janky_frame_analysis',
    'jank_frame_detail',
    'cpu_analysis',
    'binder_analysis',
    'memory_analysis',
    'anr_analysis',
    'scene_reconstruction',
    'gc_analysis',
    'network_analysis',
    'gpu_analysis',
    'lock_contention_analysis',
  ];
}

/**
 * 根据场景类型获取推荐的 Skill ID
 */
export function getSkillIdForSceneType(
  sceneType: string
): string | null {
  const mapping: Record<string, string> = {
    cold_start: 'startup_analysis',
    warm_start: 'startup_analysis',
    hot_start: 'startup_analysis',
    scroll: 'scrolling_analysis',
    navigation: 'click_response_analysis',
    tap: 'click_response_analysis',
    jank: 'janky_frame_analysis',
    anr: 'anr_analysis',
    memory: 'memory_analysis',
    cpu: 'cpu_analysis',
    binder: 'binder_analysis',
  };

  return mapping[sceneType] || null;
}
