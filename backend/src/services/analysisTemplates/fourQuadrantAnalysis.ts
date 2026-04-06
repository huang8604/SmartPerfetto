// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 四大象限分析模板
 * 分析 Trace 中的时间分布：Binder / Lock / IO / Computation
 */

import { TraceProcessorService } from '../traceProcessorService';

export interface FourQuadrantResult {
  summary: {
    totalMs: number;
    breakdown: QuadrantBreakdown[];
  };
  visualization: {
    type: 'pie_chart' | 'bar_chart';
    data: VisualizationDataPoint[];
  };
  details: {
    binder: CategoryDetail;
    lock: CategoryDetail;
    io: CategoryDetail;
    computation: CategoryDetail;
  };
}

export interface QuadrantBreakdown {
  category: 'binder' | 'lock' | 'io' | 'computation';
  durationMs: number;
  percentage: number;
  count: number;
}

export interface VisualizationDataPoint {
  label: string;
  value: number;
  percentage: number;
  color: string;
}

export interface CategoryDetail {
  totalMs: number;
  count: number;
  avgMs: number;
  topSlices: {
    name: string;
    durationMs: number;
    timestamp: number;
  }[];
}

export class FourQuadrantAnalyzer {
  constructor(private traceProcessor: TraceProcessorService) {}

  /**
   * 执行四大象限分析
   * @param traceId Trace ID
   * @param startTs 开始时间戳（纳秒），可选
   * @param endTs 结束时间戳（纳秒），可选
   * @param threadId 线程ID，可选（如果只分析特定线程）
   */
  async analyze(
    traceId: string,
    startTs?: number,
    endTs?: number,
    threadId?: number
  ): Promise<FourQuadrantResult> {
    // 构建时间范围条件
    const timeCondition = this.buildTimeCondition(startTs, endTs);
    const threadCondition = threadId ? `AND utid = ${threadId}` : '';

    // 1. Binder 耗时分析
    const binderResult = await this.analyzeBinder(traceId, timeCondition, threadCondition);

    // 2. Lock 等待分析
    const lockResult = await this.analyzeLock(traceId, timeCondition, threadCondition);

    // 3. IO 操作分析
    const ioResult = await this.analyzeIO(traceId, timeCondition, threadCondition);

    // 4. CPU 计算分析（排除上述类型）
    const computationResult = await this.analyzeComputation(
      traceId,
      timeCondition,
      threadCondition
    );

    // 计算总时间和百分比
    const total = binderResult.totalMs + lockResult.totalMs + ioResult.totalMs + computationResult.totalMs;

    const breakdown: QuadrantBreakdown[] = [
      {
        category: 'binder',
        durationMs: binderResult.totalMs,
        percentage: (binderResult.totalMs / total) * 100,
        count: binderResult.count,
      },
      {
        category: 'lock',
        durationMs: lockResult.totalMs,
        percentage: (lockResult.totalMs / total) * 100,
        count: lockResult.count,
      },
      {
        category: 'io',
        durationMs: ioResult.totalMs,
        percentage: (ioResult.totalMs / total) * 100,
        count: ioResult.count,
      },
      {
        category: 'computation',
        durationMs: computationResult.totalMs,
        percentage: (computationResult.totalMs / total) * 100,
        count: computationResult.count,
      },
    ];

    return {
      summary: {
        totalMs: total,
        breakdown,
      },
      visualization: {
        type: 'pie_chart',
        data: breakdown.map(b => ({
          label: this.getCategoryLabel(b.category),
          value: b.durationMs,
          percentage: b.percentage,
          color: this.getCategoryColor(b.category),
        })),
      },
      details: {
        binder: binderResult,
        lock: lockResult,
        io: ioResult,
        computation: computationResult,
      },
    };
  }

  private buildTimeCondition(startTs?: number, endTs?: number): string {
    if (!startTs && !endTs) return '';
    if (startTs && !endTs) return `AND ts >= ${startTs}`;
    if (!startTs && endTs) return `AND ts <= ${endTs}`;
    return `AND ts >= ${startTs} AND ts <= ${endTs}`;
  }

  private async analyzeBinder(
    traceId: string,
    timeCondition: string,
    threadCondition: string
  ): Promise<CategoryDetail> {
    const query = `
      SELECT
        name,
        SUM(dur) / 1e6 as total_ms,
        COUNT(*) as count,
        AVG(dur) / 1e6 as avg_ms,
        ts
      FROM slice
      WHERE (
        name LIKE '%binder%'
        OR name LIKE '%Binder%'
        OR name LIKE 'IPCThreadState%'
      )
      ${timeCondition}
      ${threadCondition}
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT 10
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      return { totalMs: 0, count: 0, avgMs: 0, topSlices: [] };
    }

    const totalMs = rows.reduce((sum, row) => sum + parseFloat(row.total_ms), 0);
    const totalCount = rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    return {
      totalMs,
      count: totalCount,
      avgMs: totalMs / totalCount,
      topSlices: rows.slice(0, 5).map(row => ({
        name: row.name,
        durationMs: parseFloat(row.total_ms),
        timestamp: parseInt(row.ts),
      })),
    };
  }

  private async analyzeLock(
    traceId: string,
    timeCondition: string,
    threadCondition: string
  ): Promise<CategoryDetail> {
    const query = `
      SELECT
        name,
        SUM(dur) / 1e6 as total_ms,
        COUNT(*) as count,
        AVG(dur) / 1e6 as avg_ms,
        ts
      FROM slice
      WHERE (
        name LIKE '%lock%'
        OR name LIKE '%Lock%'
        OR name LIKE '%mutex%'
        OR name LIKE '%Mutex%'
        OR name LIKE 'monitor%'
      )
      ${timeCondition}
      ${threadCondition}
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT 10
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      return { totalMs: 0, count: 0, avgMs: 0, topSlices: [] };
    }

    const totalMs = rows.reduce((sum, row) => sum + parseFloat(row.total_ms), 0);
    const totalCount = rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    return {
      totalMs,
      count: totalCount,
      avgMs: totalMs / totalCount,
      topSlices: rows.slice(0, 5).map(row => ({
        name: row.name,
        durationMs: parseFloat(row.total_ms),
        timestamp: parseInt(row.ts),
      })),
    };
  }

  private async analyzeIO(
    traceId: string,
    timeCondition: string,
    threadCondition: string
  ): Promise<CategoryDetail> {
    const query = `
      SELECT
        name,
        SUM(dur) / 1e6 as total_ms,
        COUNT(*) as count,
        AVG(dur) / 1e6 as avg_ms,
        ts
      FROM slice
      WHERE (
        name LIKE '%read%'
        OR name LIKE '%write%'
        OR name LIKE '%Read%'
        OR name LIKE '%Write%'
        OR name LIKE '%IO%'
        OR name LIKE '%io%'
        OR name LIKE 'open%'
        OR name LIKE 'close%'
      )
      ${timeCondition}
      ${threadCondition}
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT 10
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      return { totalMs: 0, count: 0, avgMs: 0, topSlices: [] };
    }

    const totalMs = rows.reduce((sum, row) => sum + parseFloat(row.total_ms), 0);
    const totalCount = rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    return {
      totalMs,
      count: totalCount,
      avgMs: totalMs / totalCount,
      topSlices: rows.slice(0, 5).map(row => ({
        name: row.name,
        durationMs: parseFloat(row.total_ms),
        timestamp: parseInt(row.ts),
      })),
    };
  }

  private async analyzeComputation(
    traceId: string,
    timeCondition: string,
    threadCondition: string
  ): Promise<CategoryDetail> {
    // 计算类型：排除 binder, lock, io 的其他所有 slice
    const query = `
      SELECT
        name,
        SUM(dur) / 1e6 as total_ms,
        COUNT(*) as count,
        AVG(dur) / 1e6 as avg_ms,
        ts
      FROM slice
      WHERE name NOT LIKE '%binder%'
        AND name NOT LIKE '%Binder%'
        AND name NOT LIKE '%lock%'
        AND name NOT LIKE '%Lock%'
        AND name NOT LIKE '%mutex%'
        AND name NOT LIKE '%Mutex%'
        AND name NOT LIKE '%read%'
        AND name NOT LIKE '%write%'
        AND name NOT LIKE '%Read%'
        AND name NOT LIKE '%Write%'
        AND name NOT LIKE '%IO%'
        AND name NOT LIKE '%io%'
        ${timeCondition}
        ${threadCondition}
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT 10
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      return { totalMs: 0, count: 0, avgMs: 0, topSlices: [] };
    }

    const totalMs = rows.reduce((sum, row) => sum + parseFloat(row.total_ms), 0);
    const totalCount = rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    return {
      totalMs,
      count: totalCount,
      avgMs: totalMs / totalCount,
      topSlices: rows.slice(0, 5).map(row => ({
        name: row.name,
        durationMs: parseFloat(row.total_ms),
        timestamp: parseInt(row.ts),
      })),
    };
  }

  private resultToRows(result: any): any[] {
    if (!result || !result.columns || !result.rows) {
      return [];
    }

    return result.rows.map((row: any[]) => {
      const obj: any = {};
      result.columns.forEach((col: string, idx: number) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  private getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      binder: 'Binder 调用',
      lock: 'Lock 等待',
      io: 'IO 操作',
      computation: 'CPU 计算',
    };
    return labels[category] || category;
  }

  private getCategoryColor(category: string): string {
    const colors: Record<string, string> = {
      binder: '#3b82f6',    // 蓝色
      lock: '#f59e0b',      // 橙色
      io: '#10b981',        // 绿色
      computation: '#8b5cf6', // 紫色
    };
    return colors[category] || '#6b7280';
  }
}