/**
 * SQL Generation Capability
 *
 * Enables agents to dynamically generate SQL queries based on analysis objectives.
 * This gives agents true autonomy to explore data beyond predefined Skills.
 *
 * Key features:
 * 1. Schema context injection - LLM knows available tables/columns
 * 2. Safety constraints - read-only, table whitelist, max rows
 * 3. Explanation generation - each query comes with reasoning
 * 4. Risk assessment - flags potentially expensive queries
 *
 * Design principles:
 * - Agent proposes, validator validates, executor runs
 * - LLM generates SQL, not arbitrary code
 * - All queries are SELECT-only (enforced by validator)
 * - Schema context prevents hallucinated table names
 */

import { ModelRouter } from '../core/modelRouter';
import { parseLlmJson, isPlainObject, isStringArray } from '../../utils/llmJson';

// =============================================================================
// Types
// =============================================================================

/**
 * Schema information for a Perfetto table
 */
export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
  description?: string;
  /** Approximate row count (for query optimization hints) */
  estimatedRows?: number;
}

/**
 * Column information
 */
export interface ColumnInfo {
  name: string;
  type: 'INTEGER' | 'TEXT' | 'REAL' | 'BLOB' | 'ANY';
  nullable?: boolean;
  description?: string;
}

/**
 * Schema context provided to the LLM
 */
export interface SchemaContext {
  tables: TableSchema[];
  /** Common Perfetto idioms and patterns */
  hints?: string[];
}

/**
 * Safety constraints for SQL generation
 */
export interface SQLConstraints {
  /** Maximum rows to return (default: 1000) */
  maxRows: number;
  /** Allowed tables (whitelist) */
  allowedTables: string[];
  /** Forbidden SQL patterns (regex) */
  forbiddenPatterns: RegExp[];
  /** Query timeout in milliseconds */
  timeout: number;
  /** Maximum query complexity (joins, subqueries) */
  maxComplexity?: number;
}

/**
 * Generated SQL result
 */
export interface GeneratedSQL {
  /** The SQL query string */
  sql: string;
  /** Explanation of what this query does */
  explanation: string;
  /** Expected column names in result */
  expectedColumns: string[];
  /** Risk assessment */
  riskLevel: 'safe' | 'moderate' | 'high';
  /** Risk factors if any */
  riskFactors?: string[];
  /** Suggested LIMIT clause if not present */
  suggestedLimit?: number;
}

/**
 * SQL generation result (may include validation errors)
 */
export interface SQLGenerationResult {
  success: boolean;
  sql?: GeneratedSQL;
  error?: string;
  /** Validation errors if any */
  validationErrors?: string[];
}

// =============================================================================
// LLM JSON Schema
// =============================================================================

interface SQLGenerationPayload {
  sql?: string;
  explanation?: string;
  expectedColumns?: string[];
  riskLevel?: string;
  riskFactors?: string[];
}

const SQL_GENERATION_SCHEMA = {
  name: 'sql_generation@1.0.0',
  validate: (value: unknown): value is SQLGenerationPayload => {
    if (!isPlainObject(value)) return false;
    const v = value as any;
    if (v.sql !== undefined && typeof v.sql !== 'string') return false;
    if (v.explanation !== undefined && typeof v.explanation !== 'string') return false;
    if (v.expectedColumns !== undefined && !isStringArray(v.expectedColumns)) return false;
    if (v.riskLevel !== undefined && typeof v.riskLevel !== 'string') return false;
    return true;
  },
};

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONSTRAINTS: SQLConstraints = {
  maxRows: 1000,
  allowedTables: [], // Empty means all tables allowed (filled by schema detection)
  forbiddenPatterns: [
    /\bDROP\b/i,
    /\bDELETE\b/i,
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bCREATE\b/i,
    /\bALTER\b/i,
    /\bTRUNCATE\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bEXEC\b/i,
    /\bEXECUTE\b/i,
    /--/,  // SQL comments (potential injection)
    /\/\*/,  // Block comments
  ],
  timeout: 30000,
  maxComplexity: 5,
};

// =============================================================================
// SQL Generator
// =============================================================================

/**
 * SQL generation capability for agents.
 * Uses LLM to generate Perfetto SQL queries based on analysis objectives.
 */
export class SQLGenerator {
  private modelRouter: ModelRouter;
  private defaultConstraints: SQLConstraints;

  constructor(modelRouter: ModelRouter, constraints?: Partial<SQLConstraints>) {
    this.modelRouter = modelRouter;
    this.defaultConstraints = { ...DEFAULT_CONSTRAINTS, ...constraints };
  }

  /**
   * Generate SQL query for an analysis objective.
   *
   * @param objective - What the agent wants to analyze
   * @param schemaContext - Available tables and columns
   * @param constraints - Safety constraints (optional, uses defaults)
   * @returns Generated SQL with metadata
   */
  async generateSQL(
    objective: string,
    schemaContext: SchemaContext,
    constraints?: Partial<SQLConstraints>
  ): Promise<SQLGenerationResult> {
    const effectiveConstraints = {
      ...this.defaultConstraints,
      ...constraints,
    };

    // If no allowed tables specified, use all from schema
    if (effectiveConstraints.allowedTables.length === 0) {
      effectiveConstraints.allowedTables = schemaContext.tables.map(t => t.name);
    }

    const prompt = this.buildGenerationPrompt(objective, schemaContext, effectiveConstraints);

    try {
      const response = await this.modelRouter.callWithFallback(
        prompt,
        'sql_generation',
        {
          jsonMode: true,
          promptId: 'sql_generator.generate',
          promptVersion: '1.0.0',
          contractVersion: SQL_GENERATION_SCHEMA.name,
        }
      );

      const parsed = parseLlmJson<SQLGenerationPayload>(
        response.response,
        SQL_GENERATION_SCHEMA
      );

      return this.processLLMResponse(parsed, effectiveConstraints);
    } catch (error: any) {
      return {
        success: false,
        error: `SQL generation failed: ${error.message}`,
      };
    }
  }

  /**
   * Repair an SQL query based on an execution/validation error.
   *
   * The LLM receives:
   * - objective
   * - schema
   * - constraints
   * - previous SQL
   * - concrete error message
   */
  async repairSQL(params: {
    objective: string;
    schemaContext: SchemaContext;
    previousSQL: string;
    error: string;
    constraints?: Partial<SQLConstraints>;
  }): Promise<SQLGenerationResult> {
    const effectiveConstraints = {
      ...this.defaultConstraints,
      ...params.constraints,
    };

    if (effectiveConstraints.allowedTables.length === 0) {
      effectiveConstraints.allowedTables = params.schemaContext.tables.map(t => t.name);
    }

    const prompt = this.buildRepairPrompt(
      params.objective,
      params.previousSQL,
      params.error,
      params.schemaContext,
      effectiveConstraints
    );

    try {
      const response = await this.modelRouter.callWithFallback(
        prompt,
        'sql_generation',
        {
          jsonMode: true,
          promptId: 'sql_generator.repair',
          promptVersion: '1.0.0',
          contractVersion: SQL_GENERATION_SCHEMA.name,
        }
      );

      const parsed = parseLlmJson<SQLGenerationPayload>(
        response.response,
        SQL_GENERATION_SCHEMA
      );

      return this.processLLMResponse(parsed, effectiveConstraints);
    } catch (error: any) {
      return {
        success: false,
        error: `SQL repair failed: ${error.message}`,
      };
    }
  }

  /**
   * Build the LLM prompt for SQL generation.
   */
  private buildGenerationPrompt(
    objective: string,
    schemaContext: SchemaContext,
    constraints: SQLConstraints
  ): string {
    const schemaText = schemaContext.tables.map(t => {
      const columnsText = t.columns
        .map(c => `    ${c.name} (${c.type})${c.description ? ` -- ${c.description}` : ''}`)
        .join('\n');
      return `表名: ${t.name}${t.description ? ` -- ${t.description}` : ''}
${columnsText}`;
    }).join('\n\n');

    const hintsText = schemaContext.hints?.length
      ? `\n## Perfetto SQL 常用模式\n${schemaContext.hints.map(h => `- ${h}`).join('\n')}`
      : '';

    return `你是 Perfetto SQL 专家。根据分析目标生成 SQL 查询。

## 分析目标
${objective}

## 可用 Schema
${schemaText}
${hintsText}

## 约束
- 只能使用 SELECT 语句（只读查询）
- 最多返回 ${constraints.maxRows} 行（请添加 LIMIT 子句）
- 只能查询以下表: ${constraints.allowedTables.slice(0, 20).join(', ')}${constraints.allowedTables.length > 20 ? '...' : ''}
- 时间戳单位为纳秒 (ns)
- 避免全表扫描，尽量使用 WHERE 条件

## 任务
生成能够回答分析目标的 SQL 查询。

请以 JSON 格式返回：
{
  "sql": "SELECT ... FROM ... WHERE ... LIMIT ${constraints.maxRows}",
  "explanation": "这个查询的作用是...",
  "expectedColumns": ["列名1", "列名2"],
  "riskLevel": "safe/moderate/high",
  "riskFactors": ["如果有风险因素，列出"]
}

注意：
- SQL 必须是有效的 SQLite 语法
- 不要使用 Perfetto 不存在的表或列
- 优先使用简单查询，避免复杂嵌套
- 如果目标不明确，生成探索性查询而非猜测`;
  }

  /**
   * Build the LLM prompt for SQL repair.
   */
  private buildRepairPrompt(
    objective: string,
    previousSQL: string,
    error: string,
    schemaContext: SchemaContext,
    constraints: SQLConstraints
  ): string {
    const schemaText = schemaContext.tables.map(t => {
      const columnsText = t.columns
        .map(c => `    ${c.name} (${c.type})${c.description ? ` -- ${c.description}` : ''}`)
        .join('\n');
      return `表名: ${t.name}${t.description ? ` -- ${t.description}` : ''}
${columnsText}`;
    }).join('\n\n');

    const hintsText = schemaContext.hints?.length
      ? `\n## Perfetto SQL 常用模式\n${schemaContext.hints.map(h => `- ${h}`).join('\n')}`
      : '';

    return `你是 Perfetto SQL 专家。下面是一条失败的 SQL，请基于错误信息修复它。

## 分析目标
${objective}

## 上一次 SQL
${previousSQL}

## 错误信息
${error}

## 可用 Schema
${schemaText}
${hintsText}

## 约束
- 只能生成 SELECT 查询（禁止写操作）
- 只能使用 schema 中存在的表和列
- 必须包含 LIMIT（建议 LIMIT ${constraints.maxRows}）
- 优先最小修改：在满足目标的前提下，尽量保留原 SQL 结构
- 如果原 SQL 引用不存在的表/列：请替换为正确的表/列，或用可用表重新构建等价查询

请以 JSON 格式返回：
{
  "sql": "SELECT ... FROM ... WHERE ... LIMIT ${constraints.maxRows}",
  "explanation": "你修复了什么、为什么这样修复",
  "expectedColumns": ["列名1", "列名2"],
  "riskLevel": "safe/moderate/high",
  "riskFactors": ["如果有风险因素，列出"]
}

注意：
- 只输出 JSON。`;
  }

  /**
   * Process LLM response and validate the generated SQL.
   */
  private processLLMResponse(
    payload: SQLGenerationPayload,
    constraints: SQLConstraints
  ): SQLGenerationResult {
    if (!payload.sql || payload.sql.trim().length === 0) {
      return {
        success: false,
        error: 'LLM did not generate SQL',
      };
    }

    const sql = payload.sql.trim();
    const validationErrors = this.quickValidate(sql, constraints);

    if (validationErrors.length > 0) {
      return {
        success: false,
        error: `SQL validation failed`,
        validationErrors,
      };
    }

    // Determine risk level
    let riskLevel: 'safe' | 'moderate' | 'high' = 'safe';
    const riskFactors: string[] = payload.riskFactors?.filter(r => typeof r === 'string') || [];

    // Check for expensive operations
    if (/\bJOIN\b/i.test(sql)) {
      riskFactors.push('Contains JOIN operation');
      riskLevel = 'moderate';
    }
    if (/\bGROUP BY\b/i.test(sql) && /\bHAVING\b/i.test(sql)) {
      riskFactors.push('Contains GROUP BY with HAVING');
      riskLevel = 'moderate';
    }
    if (!/\bLIMIT\b/i.test(sql)) {
      riskFactors.push('Missing LIMIT clause');
      riskLevel = 'moderate';
    }
    if (/\bCROSS\s+JOIN\b/i.test(sql)) {
      riskFactors.push('Contains CROSS JOIN (potentially expensive)');
      riskLevel = 'high';
    }
    if ((sql.match(/\bJOIN\b/gi) || []).length > 3) {
      riskFactors.push('Multiple JOINs (4+)');
      riskLevel = 'high';
    }

    // Override with LLM assessment if higher
    const llmRisk = payload.riskLevel?.toLowerCase();
    if (llmRisk === 'high' && riskLevel !== 'high') {
      riskLevel = 'high';
    } else if (llmRisk === 'moderate' && riskLevel === 'safe') {
      riskLevel = 'moderate';
    }

    // Suggest LIMIT if missing
    let suggestedLimit: number | undefined;
    if (!/\bLIMIT\b/i.test(sql)) {
      suggestedLimit = constraints.maxRows;
    }

    return {
      success: true,
      sql: {
        sql,
        explanation: payload.explanation || 'Generated SQL query',
        expectedColumns: payload.expectedColumns || [],
        riskLevel,
        riskFactors: riskFactors.length > 0 ? riskFactors : undefined,
        suggestedLimit,
      },
    };
  }

  /**
   * Quick validation of generated SQL (basic checks before full validation).
   */
  private quickValidate(sql: string, constraints: SQLConstraints): string[] {
    const errors: string[] = [];

    // Check for forbidden patterns
    for (const pattern of constraints.forbiddenPatterns) {
      if (pattern.test(sql)) {
        errors.push(`Forbidden pattern detected: ${pattern.toString()}`);
      }
    }

    // Must start with SELECT
    if (!/^\s*SELECT\b/i.test(sql)) {
      errors.push('Query must be a SELECT statement');
    }

    // Check for semicolons (potential multi-statement)
    const semiCount = (sql.match(/;/g) || []).length;
    if (semiCount > 1) {
      errors.push('Multiple statements not allowed');
    }

    return errors;
  }

  /**
   * Update default constraints.
   */
  setDefaultConstraints(constraints: Partial<SQLConstraints>): void {
    this.defaultConstraints = { ...this.defaultConstraints, ...constraints };
  }
}

// =============================================================================
// Schema Detection
// =============================================================================

/**
 * Detect schema from a Perfetto trace.
 * Returns commonly used tables relevant for performance analysis.
 */
export async function detectSchema(
  traceProcessorService: any,
  traceId: string
): Promise<SchemaContext> {
  const tables: TableSchema[] = [];

  // Query for available tables
  try {
    const tablesResult = await traceProcessorService.query(
      traceId,
      "SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name"
    );

    const availableTables = new Set<string>();
    if (tablesResult?.rows) {
      for (const row of tablesResult.rows) {
        availableTables.add(String(row[0]));
      }
    }

    // Get schema for common performance tables
    const priorityTables = [
      'slice',
      'thread_slice',
      'process',
      'thread',
      'sched_slice',
      'actual_frame_timeline_slice',
      'expected_frame_timeline_slice',
      'android_binder_txns',
      'counter',
      'cpu_counter_track',
      'heap_profile_allocation',
    ];

    for (const tableName of priorityTables) {
      if (!availableTables.has(tableName)) continue;

      try {
        const columnsResult = await traceProcessorService.query(
          traceId,
          `PRAGMA table_info(${tableName})`
        );

        if (columnsResult?.rows && columnsResult.rows.length > 0) {
          const columns: ColumnInfo[] = columnsResult.rows.map((row: any) => ({
            name: String(row[1]),
            type: mapSqliteType(String(row[2])),
            nullable: row[3] !== 1,
          }));

          tables.push({
            name: tableName,
            columns,
            description: getTableDescription(tableName),
          });
        }
      } catch (e) {
        // Skip tables that fail to query
      }
    }
  } catch (error: any) {
    console.warn(`[detectSchema] Failed to detect schema: ${error.message}`);
  }

  return {
    tables,
    hints: getPerfettoHints(),
  };
}

/**
 * Map SQLite type to simplified type.
 */
function mapSqliteType(sqliteType: string): ColumnInfo['type'] {
  const upper = sqliteType.toUpperCase();
  if (upper.includes('INT')) return 'INTEGER';
  if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('CLOB')) return 'TEXT';
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL';
  if (upper.includes('BLOB')) return 'BLOB';
  return 'ANY';
}

/**
 * Get description for common Perfetto tables.
 */
function getTableDescription(tableName: string): string | undefined {
  const descriptions: Record<string, string> = {
    slice: '通用 slice 事件表，包含所有 track 类型的 slice',
    thread_slice: '线程 slice 事件，包含函数调用和 atrace 事件',
    process: '进程信息表',
    thread: '线程信息表',
    sched_slice: 'CPU 调度切片，记录线程在 CPU 上的运行',
    actual_frame_timeline_slice: '实际帧时间线，记录帧的实际渲染时间',
    expected_frame_timeline_slice: '预期帧时间线，记录帧的预期完成时间',
    android_binder_txns: 'Android Binder 事务表',
    counter: '计数器事件表',
    cpu_counter_track: 'CPU 计数器轨道',
    heap_profile_allocation: '堆内存分配事件',
  };
  return descriptions[tableName];
}

/**
 * Get common Perfetto SQL patterns and hints.
 */
function getPerfettoHints(): string[] {
  return [
    '时间戳字段 (ts, dur) 单位为纳秒 (ns)',
    '使用 slice.ts + slice.dur 计算 slice 结束时间',
    'thread.utid 和 process.upid 是唯一标识符',
    'actual_frame_timeline_slice.jank_type != "None" 表示掉帧',
    'sched_slice.ts 是调度开始时间，dur 是持续时间',
    '使用 process.name LIKE "%package%" 过滤应用进程',
    'frame_slice.layer_name 包含 Surface 名称',
  ];
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an SQL generator instance.
 */
export function createSQLGenerator(
  modelRouter: ModelRouter,
  constraints?: Partial<SQLConstraints>
): SQLGenerator {
  return new SQLGenerator(modelRouter, constraints);
}

export default SQLGenerator;
