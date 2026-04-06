// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 分析报告生成器
 * 将分析结果生成为 Markdown 格式的报告
 */

import { FourQuadrantResult } from './analysisTemplates/fourQuadrantAnalysis';
import { CpuCoreDistribution } from './analysisTemplates/cpuCoreAnalysis';
import { FrameStatsResult } from './analysisTemplates/frameStatsAnalysis';

export interface AnalysisReport {
  title: string;
  timestamp: Date;
  sections: ReportSection[];
}

export interface ReportSection {
  title: string;
  content: string;
  subsections?: ReportSection[];
}

export class ReportGenerator {
  /**
   * 生成完整的分析报告
   */
  generateReport(
    traceFile: string,
    analyses: {
      fourQuadrant?: FourQuadrantResult;
      cpuCore?: CpuCoreDistribution;
      frameStats?: FrameStatsResult;
      customAnalyses?: any[];
    }
  ): string {
    const report: AnalysisReport = {
      title: `Perfetto Trace 分析报告`,
      timestamp: new Date(),
      sections: [],
    };

    // 添加头部信息
    report.sections.push({
      title: '概览',
      content: this.generateOverview(traceFile, analyses),
    });

    // 添加各个分析部分
    if (analyses.fourQuadrant) {
      report.sections.push({
        title: '四大象限分析',
        content: this.generateFourQuadrantReport(analyses.fourQuadrant),
      });
    }

    if (analyses.cpuCore) {
      report.sections.push({
        title: 'CPU 核心分布分析',
        content: this.generateCpuCoreReport(analyses.cpuCore),
      });
    }

    if (analyses.frameStats) {
      report.sections.push({
        title: '帧率统计分析',
        content: this.generateFrameStatsReport(analyses.frameStats),
      });
    }

    // 添加建议部分
    report.sections.push({
      title: '优化建议',
      content: this.generateRecommendations(analyses),
    });

    return this.formatAsMarkdown(report);
  }

  /**
   * 生成概览部分
   */
  private generateOverview(traceFile: string, analyses: any): string {
    const sections: string[] = [];

    sections.push(`**Trace 文件**: ${traceFile}`);
    sections.push(`**分析时间**: ${new Date().toLocaleString('zh-CN')}`);
    sections.push('');

    const analysisTypes: string[] = [];
    if (analyses.fourQuadrant) analysisTypes.push('四大象限');
    if (analyses.cpuCore) analysisTypes.push('CPU核心分布');
    if (analyses.frameStats) analysisTypes.push('帧率统计');

    sections.push(`**执行的分析**: ${analysisTypes.join('、')}`);

    return sections.join('\n');
  }

  /**
   * 生成四大象限分析报告
   */
  private generateFourQuadrantReport(result: FourQuadrantResult): string {
    const sections: string[] = [];

    // 总结
    sections.push(`**总耗时**: ${result.summary.totalMs.toFixed(2)} ms`);
    sections.push('');

    // 时间分布表格
    sections.push('### 时间分布');
    sections.push('');
    sections.push('| 类别 | 耗时(ms) | 占比(%) | 次数 |');
    sections.push('|------|----------|---------|------|');

    result.summary.breakdown
      .sort((a, b) => b.durationMs - a.durationMs)
      .forEach(b => {
        const label = this.getCategoryLabel(b.category);
        sections.push(`| ${label} | ${b.durationMs.toFixed(2)} | ${b.percentage.toFixed(1)} | ${b.count} |`);
      });

    sections.push('');

    // 各类别详情
    const categories: Array<keyof typeof result.details> = ['binder', 'lock', 'io', 'computation'];

    categories.forEach(cat => {
      const detail = result.details[cat];
      if (detail.count > 0) {
        sections.push(`### ${this.getCategoryLabel(cat)} 详情`);
        sections.push('');
        sections.push(`- 总耗时: ${detail.totalMs.toFixed(2)} ms`);
        sections.push(`- 次数: ${detail.count}`);
        sections.push(`- 平均耗时: ${detail.avgMs.toFixed(2)} ms`);

        if (detail.topSlices.length > 0) {
          sections.push('');
          sections.push('**Top 5 耗时操作**:');
          sections.push('');
          detail.topSlices.forEach((slice, idx) => {
            sections.push(`${idx + 1}. ${slice.name}: ${slice.durationMs.toFixed(2)} ms`);
          });
        }

        sections.push('');
      }
    });

    return sections.join('\n');
  }

  /**
   * 生成 CPU 核心分布报告
   */
  private generateCpuCoreReport(result: CpuCoreDistribution): string {
    const sections: string[] = [];

    // 总结
    sections.push(`**总运行时间**: ${result.summary.totalMs.toFixed(2)} ms`);
    sections.push(`**大核时间**: ${result.summary.bigCoreMs.toFixed(2)} ms (${result.summary.bigCorePercentage.toFixed(1)}%)`);
    sections.push(`**小核时间**: ${result.summary.littleCoreMs.toFixed(2)} ms (${result.summary.littleCorePercentage.toFixed(1)}%)`);
    sections.push('');

    // 各核心详情
    sections.push('### 各核心运行时间');
    sections.push('');
    sections.push('| CPU | 类型 | 耗时(ms) | 占比(%) | 调度次数 |');
    sections.push('|-----|------|----------|---------|----------|');

    result.breakdown
      .sort((a, b) => b.totalMs - a.totalMs)
      .forEach(b => {
        const coreType = b.coreType === 'big' ? '大核' : b.coreType === 'little' ? '小核' : '未知';
        sections.push(`| CPU ${b.cpu} | ${coreType} | ${b.totalMs.toFixed(2)} | ${b.percentage.toFixed(1)} | ${b.sliceCount} |`);
      });

    sections.push('');

    return sections.join('\n');
  }

  /**
   * 生成帧率统计报告
   */
  private generateFrameStatsReport(result: FrameStatsResult): string {
    const sections: string[] = [];

    // 总结
    sections.push(`**总帧数**: ${result.summary.totalFrames}`);
    sections.push(`**平均帧率**: ${result.summary.avgFps.toFixed(1)} FPS`);
    sections.push(`**掉帧数**: ${result.summary.jankCount} (${result.summary.jankPercentage.toFixed(1)}%)`);
    sections.push(`**平均帧耗时**: ${result.summary.avgFrameDurationMs.toFixed(2)} ms`);
    sections.push('');

    // 百分位数
    sections.push('### 帧耗时百分位数');
    sections.push('');
    sections.push('| 百分位 | 耗时(ms) |');
    sections.push('|--------|----------|');
    sections.push(`| P50 | ${result.percentiles.p50Ms.toFixed(2)} |`);
    sections.push(`| P90 | ${result.percentiles.p90Ms.toFixed(2)} |`);
    sections.push(`| P95 | ${result.percentiles.p95Ms.toFixed(2)} |`);
    sections.push(`| P99 | ${result.percentiles.p99Ms.toFixed(2)} |`);
    sections.push(`| Max | ${result.percentiles.maxMs.toFixed(2)} |`);
    sections.push('');

    // 掉帧详情（显示前10个）
    if (result.jankFrames.length > 0) {
      sections.push('### 掉帧详情 (前10个)');
      sections.push('');
      sections.push('| 序号 | 耗时(ms) | 丢失Vsync |');
      sections.push('|------|----------|-----------|');

      result.jankFrames.slice(0, 10).forEach((jank, idx) => {
        sections.push(`| ${idx + 1} | ${jank.durationMs.toFixed(2)} | ${jank.vsyncsMissed} |`);
      });

      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(analyses: any): string {
    const recommendations: string[] = [];

    // 基于四大象限分析的建议
    if (analyses.fourQuadrant) {
      const { breakdown } = analyses.fourQuadrant.summary;
      const sorted = [...breakdown].sort((a, b) => b.percentage - a.percentage);

      if (sorted[0].category === 'binder' && sorted[0].percentage > 30) {
        recommendations.push('- **减少 Binder 调用**: Binder 占用较高，考虑批量处理或使用本地缓存减少跨进程通信');
      }

      if (sorted[0].category === 'lock' && sorted[0].percentage > 20) {
        recommendations.push('- **优化锁竞争**: Lock 等待时间较长，检查是否有不必要的锁，或使用更细粒度的锁');
      }

      if (sorted[0].category === 'io' && sorted[0].percentage > 25) {
        recommendations.push('- **异步 IO**: IO 操作占比较高，考虑异步处理或使用 WorkManager');
      }
    }

    // 基于 CPU 核心分布的建议
    if (analyses.cpuCore) {
      const { summary } = analyses.cpuCore;

      if (summary.littleCorePercentage > 70) {
        recommendations.push('- **CPU 调度**: 大部分时间运行在小核，考虑使用 Thread#setPriority 提升重要线程优先级');
      }
    }

    // 基于帧率的建议
    if (analyses.frameStats) {
      const { summary } = analyses.frameStats;

      if (summary.jankPercentage > 5) {
        recommendations.push(`- **优化渲染性能**: 掉帧率 ${summary.jankPercentage.toFixed(1)}% 偏高，检查主线程耗时操作`);
      }

      if (summary.avgFps < 55) {
        recommendations.push(`- **提升帧率**: 平均帧率 ${summary.avgFps.toFixed(1)} FPS 低于60，检查是否有过度绘制或复杂布局`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('- 整体性能表现良好，无明显瓶颈');
    }

    return recommendations.join('\n');
  }

  /**
   * 格式化为 Markdown
   */
  private formatAsMarkdown(report: AnalysisReport): string {
    const lines: string[] = [];

    // 标题
    lines.push(`# ${report.title}`);
    lines.push('');

    // 各个部分
    report.sections.forEach(section => {
      lines.push(`## ${section.title}`);
      lines.push('');
      lines.push(section.content);
      lines.push('');
    });

    // 页脚
    lines.push('---');
    lines.push('');
    lines.push('*本报告由 SmartPerfetto AI 自动生成*');

    return lines.join('\n');
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
}