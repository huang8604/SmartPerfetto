# PerfettoSqlSkill SOP Enhancement Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完善 PerfettoSqlSkill 的标准操作流程、添加更多预定义分析模式、优化 Prompt 工程模板

**Architecture:**
- 扩展现有 Skill 模式识别系统
- 统一 Prompt 模板管理
- 添加新的预定义分析技能
- 改进 SOP 文档化

**Tech Stack:**
- TypeScript + Node.js
- 现有 PerfettoSqlSkill 架构

---

## Current State Analysis

### 现有分析技能 (12个)
| 技能 | 方法 | 状态 |
|------|------|------|
| STARTUP | analyzeStartup | ✅ |
| SCROLLING | analyzeScrolling | ✅ |
| MEMORY | analyzeMemory | ✅ |
| CPU | analyzeCpu | ✅ |
| SURFACE_FLINGER | analyzeSurfaceFlinger | ✅ |
| NAVIGATION | analyzeNavigation | ✅ |
| CLICK_RESPONSE | analyzeClickResponse | ✅ |
| INPUT | analyzeInput | ✅ |
| BINDER | analyzeBinder | ✅ |
| BUFFER_FLOW | analyzeBufferFlow | ✅ |
| SYSTEM_SERVER | analyzeSystemServer | ✅ |
| SLOW_FUNCTIONS | analyzeSlowFunctions | ✅ |

### Prompt 模板分布
- `traceAnalysisSkill.ts` - buildSystemPrompt
- `advancedAIService.ts` - buildContextPrompt
- `aiService.ts` - 请求提示词生成
- `perfettoAnalysisOrchestrator.ts` - basePrompt, buildFixPrompt, buildAdjustPrompt

### 问题识别
1. Prompt 模板分散在多个服务中
2. 缺少统一的 Prompt 模板管理
3. 部分常用分析场景缺少预定义技能
4. SOP 文档化不完善

---

## Task 1: 统一 Prompt 模板管理

**Files:**
- Create: `backend/src/services/promptTemplateService.ts`
- Modify: `backend/src/services/perfettoAnalysisOrchestrator.ts`
- Modify: `backend/src/services/traceAnalysisSkill.ts`

**Step 1: Create PromptTemplateService**

创建 `backend/src/services/promptTemplateService.ts`:

```typescript
/**
 * Prompt Template Service
 * Centralized management of all AI prompt templates for Perfetto analysis
 */

export interface PromptTemplate {
  name: string;
  system: string;
  user: string;
  temperature?: number;
}

export class PromptTemplateService {
  private static instance: PromptTemplateService;
  private templates: Map<string, PromptTemplate>;

  private constructor() {
    this.templates = new Map();
    this.initializeDefaultTemplates();
  }

  static getInstance(): PromptTemplateService {
    if (!PromptTemplateService.instance) {
      PromptTemplateService.instance = new PromptTemplateService();
    }
    return PromptTemplateService.instance;
  }

  private initializeDefaultTemplates(): void {
    // Base SQL generation prompt
    this.templates.set('sql-generation', {
      name: 'sql-generation',
      system: `You are a Perfetto SQL expert. Generate accurate SQL queries to analyze trace data.

IMPORTANT RULES:
1. Use ONLY tables and columns that exist in Perfetto trace schema
2. Never invent tables or columns
3. Always use proper JOIN syntax with explicit JOIN conditions
4. Use WHERE clauses to filter relevant data
5. Use LIMIT to prevent excessive result sets
6. Convert timestamps from nanoseconds to milliseconds for readability

Common tables:
- slice - function execution slices
- thread - thread information
- process - process information
- thread_track - track to thread mapping
- clock_sync - clock synchronization events
- instants - instant events`,
      user: `Generate a Perfetto SQL query for: {query}

Requirements:
- Return ONLY the SQL query, no explanation
- Query must be executable in Perfetto UI
- Include proper time conversions (ts / 1e6 for milliseconds)`,
      temperature: 0.2,
    });

    // Fix prompt
    this.templates.set('sql-fix', {
      name: 'sql-fix',
      system: `You are a SQL debugging expert. Fix SQL queries for Perfetto trace analysis.`,
      user: `The previous SQL query failed:
{sql}

Error: {error}

Please provide the corrected SQL query. Return ONLY the SQL, no explanation.`,
    });

    // Adjust prompt
    this.templates.set('sql-adjust', {
      name: 'sql-adjust',
      system: `You are a SQL optimization expert. Adjust queries that return no results.`,
      user: `The previous SQL query returned no results:
{sql}

Explanation: {explanation}

Please provide an adjusted SQL query that might return results. Consider:
- Different time ranges
- Alternative tables or joins
- Different filtering conditions

Return ONLY the SQL, no explanation.`,
    });

    // Analysis summary prompt
    this.templates.set('analysis-summary', {
      name: 'analysis-summary',
      system: `You are a performance analysis expert. Summarize trace analysis results.`,
      user: `Based on the following analysis results, provide a concise summary:

{results}

Summary should include:
1. Key findings (2-3 bullet points)
2. Performance impact assessment
3. Recommended next steps

Keep summary under 200 words.`,
    });
  }

  getTemplate(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  formatTemplate(name: string, vars: Record<string, string>): string | undefined {
    const template = this.templates.get(name);
    if (!template) return undefined;

    let formatted = template.user;
    for (const [key, value] of Object.entries(vars)) {
      formatted = formatted.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return formatted;
  }

  addTemplate(template: PromptTemplate): void {
    this.templates.set(template.name, template);
  }
}

export default PromptTemplateService;
```

**Step 2: Update perfettoAnalysisOrchestrator**

修改 `perfettoAnalysisOrchestrator.ts` 使用 PromptTemplateService。

**Step 3: Update traceAnalysisSkill**

修改 `traceAnalysisSkill.ts` 使用 PromptTemplateService。

---

## Task 2: 添加新的预定义分析技能

**Files:**
- Modify: `backend/src/types/perfettoSql.ts`
- Modify: `backend/src/services/perfettoSqlSkill.ts`
- Modify: `backend/src/routes/traceAnalysisRoutes.ts`

**Step 1: 添加新的技能类型**

在 `types/perfettoSql.ts` 中添加：

```typescript
export enum PerfettoSkillType {
  // ... existing types ...
  NETWORK = 'network',           // NEW: 网络请求分析
  DATABASE = 'database',         // NEW: 数据库查询分析
  FILE_IO = 'file_io',           // NEW: 文件IO分析
  THREAD_SYNC = 'thread_sync',   // NEW: 线程同步分析
  POWER = 'power',               // NEW: 功耗分析
}
```

**Step 2: 添加技能模式**

在 `perfettoSqlSkill.ts` SKILL_PATTERNS 中添加：

```typescript
{
  skillType: PerfettoSkillType.NETWORK,
  keywords: ['network', 'http', 'request', 'socket', '网络', '请求', 'HTTP'],
  patterns: [
    /network|http.*request|socket/i,
    /网络|网络请求|HTTP/i,
  ],
},
{
  skillType: PerfettoSkillType.DATABASE,
  keywords: ['database', 'sqlite', 'room', 'db', '数据库', 'SQL'],
  patterns: [
    /database|sqlite|room.*db/i,
    /数据库|SQLite/i,
  ],
},
{
  skillType: PerfettoSkillType.FILE_IO,
  keywords: ['file', 'io', 'read', 'write', '文件', '读写'],
  patterns: [
    /file.*io|read.*write|disk/i,
    /文件|IO|读写/i,
  ],
},
```

**Step 3: 实现分析方法**

为每个新技能实现 analyze 方法：

```typescript
async analyzeNetwork(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
  // 网络请求分析 SQL
  const sql = `
    SELECT
      net.name,
      net.slice_id,
      net.ts / 1e6 as ts_ms,
      net.dur / 1e6 as dur_ms,
      t.name as thread_name,
      p.name as process_name
    FROM network_traffic_slice net
    JOIN thread_track tt ON net.track_id = tt.id
    JOIN thread t ON tt.utid = t.utid
    JOIN process p ON t.upid = p.upid
    WHERE 1=1
    ${packageName ? `AND p.name GLOB '${packageName}*'` : ''}
    ORDER BY net.dur DESC
    LIMIT 100
  `;

  const queryResult = await this.traceProcessor.query(traceId, sql);
  // ... 返回结果
}

async analyzeDatabase(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
  // 数据库查询分析
}

async analyzeFileIO(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
  // 文件IO分析
}
```

---

## Task 3: 优化 Prompt 工程模板

**Files:**
- Modify: `backend/src/services/promptTemplateService.ts`
- Create: `backend/src/config/prompts.ts`

**Step 1: 创建 Prompt 配置文件**

创建 `backend/src/config/prompts.ts`：

```typescript
/**
 * Prompt Engineering Templates
 * Optimized prompts for different analysis scenarios
 */

export const PROMPTS = {
  // SQL Generation Prompts
  SQL_GENERATION: {
    basic: `Generate a Perfetto SQL query for: {query}

Rules:
- Use ONLY existing Perfetto tables
- Return ONLY the SQL query
- Convert timestamps: ts / 1e6 for milliseconds`,

    withContext: `Generate a Perfetto SQL query for: {query}

Context:
- Package: {package}
- Time Range: {timeRange}

Rules:
- Use ONLY existing Perfetto tables
- Return ONLY the SQL query`,

    withSchema: `Generate a Perfetto SQL query for: {query}

Available Schema:
{schema}

Rules:
- Use ONLY the tables listed above
- Return ONLY the SQL query`,
  },

  // Analysis Prompts
  ANALYSIS_SUMMARY: {
    basic: `Summarize the analysis results:
{results}

Include:
1. Key findings
2. Performance impact
3. Recommendations`,

    detailed: `Provide a detailed performance analysis:
{results}

Include:
1. Executive Summary
2. Detailed Findings
3. Root Cause Analysis
4. Recommendations
5. SQL queries for further investigation`,
  },

  // Error Recovery Prompts
  ERROR_FIX: {
    syntax: `Fix this SQL syntax error:
{sql}
Error: {error}`,
    noResults: `This query returned no results:
{sql}

Suggest an alternative approach.`,
  },
};
```

**Step 2: 集成到 PromptTemplateService**

---

## Task 4: 完善 SOP 文档

**Files:**
- Create: `docs/sops/perfettoSqlSkill.md`
- Create: `docs/sops/promptEngineering.md`

**Step 1: 创建 Skill SOP 文档**

创建 `docs/sops/perfettoSqlSkill.md`：

```markdown
# PerfettoSqlSkill Standard Operating Procedure

## Overview
PerfettoSqlSkill 是一个智能 SQL 生成和分析服务，能够根据自然语言问题自动识别分析意图并生成对应的 SQL 查询。

## 支持的分析技能

### 1. 启动分析 (STARTUP)
- **触发词**: startup, launch, 启动, 启动时间, 冷启动, 热启动
- **分析内容**: 应用启动时间、启动阶段分解
- **SQL 模式**: 查询 slice 表中的启动相关事件

### 2. 滑动/掉帧分析 (SCROLLING)
- **触发词**: scroll, jank, fps, 滑动, 卡顿, 帧率
- **分析内容**: 帧率统计、掉帧检测、卡顿原因
- **SQL 模式**: frame_timeline, actual_frame_timeline

### 3. 内存分析 (MEMORY)
- **触发词**: memory, heap, gc, 内存, OOM
- **分析内容**: GC 事件、堆内存分配、内存泄漏
- **SQL 模式**: heap_graph_object, stats

### 4. CPU 分析 (CPU)
- **触发词**: cpu, utilization, core, CPU利用率
- **分析内容**: CPU 使用率、核心调度
- **SQL 模式**: sched, cpu

### 5. 慢函数分析 (SLOW_FUNCTIONS)
- **触发词**: slow, function, method, 慢函数, 耗时
- **分析内容**: 检测超过16ms的函数调用
- **SQL 模式**: slice with dur > 16ms

## 添加新技能的步骤

1. 在 `PerfettoSkillType` enum 中添加新类型
2. 在 `SKILL_PATTERNS` 数组中添加关键词和正则模式
3. 实现 `analyze` 方法
4. 在 `analyze` 方法的 switch 语句中添加 case
5. 编写测试用例
6. 更新本文档
```

---

## Summary

**Files Created:** 5
**Files Modified:** 4
**New Skills:** 3 (Network, Database, File_IO)
**Prompt Templates:** Centralized and optimized

**Estimated Effort:** 2-3 hours per task
