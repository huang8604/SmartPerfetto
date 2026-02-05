/**
 * Incremental Analyzer
 *
 * Enables incremental analysis based on user focus.
 * Instead of re-running full analysis on every turn, this module:
 * 1. Determines what's already analyzed
 * 2. Identifies what needs to be analyzed based on user focus
 * 3. Merges new findings with previous results
 *
 * This significantly improves multi-turn conversation efficiency.
 *
 * Design principles:
 * - Focus-driven scope determination
 * - Avoid redundant analysis
 * - Merge findings intelligently
 * - Track analysis coverage
 */

import type { Finding } from '../types';
import type { FocusStore, FocusType, FocusEntityType } from '../context/focusStore';
import type { EntityStore, EntityId } from '../context/entityStore';
import type { FocusInterval } from '../strategies/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Scope of incremental analysis
 */
export interface IncrementalScope {
  /** Type of analysis scope */
  type: 'entity' | 'timeRange' | 'question' | 'full';

  /** Entities to analyze (for entity scope) */
  entities?: Array<{
    type: FocusEntityType;
    id: EntityId;
  }>;

  /** Time ranges to analyze (for timeRange scope) */
  timeRanges?: Array<{
    start: string;
    end: string;
  }>;

  /** Focus intervals derived from scope */
  focusIntervals?: FocusInterval[];

  /** Agents to involve */
  relevantAgents: string[];

  /** Skills to use */
  relevantSkills: string[];

  /** Whether this is a new analysis or extension */
  isExtension: boolean;

  /** Reason for scope determination */
  reason: string;
}

/**
 * Result of incremental analysis
 */
export interface IncrementalResult {
  /** Newly discovered findings */
  newFindings: Finding[];

  /** Merged findings (new + previous) */
  mergedFindings: Finding[];

  /** Scope that was analyzed */
  analysisScope: IncrementalScope;

  /** Focuses that drove this analysis */
  focusesUsed: string[];

  /** Coverage tracking */
  coverage: {
    entitiesAnalyzed: number;
    timeRangesCovered: number;
    questionsAddressed: number;
  };
}

/**
 * Previous analysis state for merging
 */
export interface PreviousAnalysisState {
  findings: Finding[];
  analyzedEntityIds: Set<string>;
  analyzedTimeRanges: Array<{ start: string; end: string }>;
  analyzedQuestions: Set<string>;
}

// =============================================================================
// Configuration
// =============================================================================

export interface IncrementalAnalyzerConfig {
  /** Minimum focus weight to include in scope */
  minFocusWeight: number;
  /** Maximum entities to analyze per turn */
  maxEntitiesPerTurn: number;
  /** Maximum time ranges per turn */
  maxTimeRangesPerTurn: number;
  /** Whether to always include primary focus */
  alwaysIncludePrimaryFocus: boolean;
}

const DEFAULT_CONFIG: IncrementalAnalyzerConfig = {
  minFocusWeight: 0.3,
  maxEntitiesPerTurn: 5,
  maxTimeRangesPerTurn: 3,
  alwaysIncludePrimaryFocus: true,
};

// =============================================================================
// Incremental Analyzer
// =============================================================================

/**
 * Manages incremental analysis based on user focus.
 */
export class IncrementalAnalyzer {
  private config: IncrementalAnalyzerConfig;

  constructor(config?: Partial<IncrementalAnalyzerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Determine the scope of incremental analysis based on user focus.
   *
   * @param query - Current user query
   * @param focusStore - User focus tracking
   * @param entityStore - Entity cache
   * @param previousState - Previous analysis state
   * @returns Scope for incremental analysis
   */
  determineScope(
    query: string,
    focusStore: FocusStore,
    entityStore: EntityStore,
    previousState?: PreviousAnalysisState
  ): IncrementalScope {
    const focusContext = focusStore.buildIncrementalContext();
    const { focusedEntities, focusedTimeRanges, focusedQuestions, primaryFocusType } = focusContext;

    // Determine primary analysis type
    let scopeType: IncrementalScope['type'] = 'full';

    if (primaryFocusType === 'entity' && focusedEntities.length > 0) {
      scopeType = 'entity';
    } else if (primaryFocusType === 'timeRange' && focusedTimeRanges.length > 0) {
      scopeType = 'timeRange';
    } else if (primaryFocusType === 'question' && focusedQuestions.length > 0) {
      scopeType = 'question';
    }

    // Build scope based on type
    switch (scopeType) {
      case 'entity':
        return this.buildEntityScope(focusedEntities, entityStore, previousState);

      case 'timeRange':
        return this.buildTimeRangeScope(focusedTimeRanges, previousState);

      case 'question':
        return this.buildQuestionScope(query, focusedQuestions, previousState);

      default:
        return this.buildFullScope(query);
    }
  }

  /**
   * Build entity-focused scope.
   */
  private buildEntityScope(
    entities: Array<{ type: FocusEntityType; id: EntityId }>,
    entityStore: EntityStore,
    previousState?: PreviousAnalysisState
  ): IncrementalScope {
    // Filter to entities not yet analyzed
    const toAnalyze = entities.filter(e => {
      const key = `${e.type}_${e.id}`;
      return !previousState?.analyzedEntityIds.has(key);
    }).slice(0, this.config.maxEntitiesPerTurn);

    // If all are analyzed, re-analyze the most recent focus
    if (toAnalyze.length === 0 && entities.length > 0) {
      toAnalyze.push(entities[0]);
    }

    // Determine relevant agents based on entity types
    const relevantAgents = this.getAgentsForEntityTypes(toAnalyze.map(e => e.type));

    // Build focus intervals from entities
    const focusIntervals: FocusInterval[] = toAnalyze.map(e => {
      const entity = this.getEntityData(e.type, e.id, entityStore);
      const metadata: Record<string, any> = {
        entityType: e.type,
        entityId: e.id,
        sourceEntityType: e.type,
        sourceEntityId: e.id,
      };

      // Align with DrillDownResolver metadata conventions so downstream executors
      // can infer interval granularity and map params consistently.
      if (e.type === 'frame') {
        metadata.frameId = e.id;
        metadata.frame_id = e.id;
      } else if (e.type === 'session') {
        metadata.sessionId = e.id;
        metadata.session_id = e.id;
      }

      return {
        id: parseInt(String(e.id)) || 0,
        processName: entity?.processName || '',
        startTs: entity?.startTs || '0',
        endTs: entity?.endTs || '0',
        priority: 1,
        label: `${e.type} ${e.id}`,
        metadata,
      };
    }).filter(i => i.startTs !== '0' && i.endTs !== '0');

    return {
      type: 'entity',
      entities: toAnalyze,
      focusIntervals: focusIntervals.length > 0 ? focusIntervals : undefined,
      relevantAgents,
      relevantSkills: this.getSkillsForAgents(relevantAgents),
      isExtension: previousState !== undefined && previousState.findings.length > 0,
      reason: `分析 ${toAnalyze.length} 个聚焦实体 (${toAnalyze.map(e => `${e.type}:${e.id}`).join(', ')})`,
    };
  }

  /**
   * Build time range-focused scope.
   */
  private buildTimeRangeScope(
    timeRanges: Array<{ start: string; end: string }>,
    previousState?: PreviousAnalysisState
  ): IncrementalScope {
    // Filter to non-overlapping new ranges
    const toAnalyze = timeRanges.filter(tr => {
      if (!previousState) return true;
      // Check if this range is already covered
      return !previousState.analyzedTimeRanges.some(ar =>
        this.rangesOverlap(tr, ar)
      );
    }).slice(0, this.config.maxTimeRangesPerTurn);

    // If all covered, use the most recent focus
    if (toAnalyze.length === 0 && timeRanges.length > 0) {
      toAnalyze.push(timeRanges[0]);
    }

    // Build focus intervals
    const focusIntervals: FocusInterval[] = toAnalyze.map((tr, i) => ({
      id: i,
      processName: '', // Will be filled by strategy/executor
      startTs: tr.start,
      endTs: tr.end,
      priority: toAnalyze.length - i,
      label: `时间范围 ${i + 1}`,
      metadata: {},
    }));

    return {
      type: 'timeRange',
      timeRanges: toAnalyze,
      focusIntervals,
      relevantAgents: ['frame_agent', 'cpu_agent'], // Time ranges typically need frame and CPU analysis
      relevantSkills: ['scrolling_analysis', 'cpu_analysis'],
      isExtension: previousState !== undefined && previousState.findings.length > 0,
      reason: `分析 ${toAnalyze.length} 个时间范围`,
    };
  }

  /**
   * Build question-focused scope.
   */
  private buildQuestionScope(
    query: string,
    questions: string[],
    previousState?: PreviousAnalysisState
  ): IncrementalScope {
    // Questions require broader analysis
    // Determine relevant agents based on question content
    const allQuestions = [query, ...questions];
    const relevantAgents = this.inferAgentsFromQuestions(allQuestions);

    return {
      type: 'question',
      relevantAgents,
      relevantSkills: this.getSkillsForAgents(relevantAgents),
      isExtension: previousState !== undefined && previousState.findings.length > 0,
      reason: `回答问题: "${query.slice(0, 50)}${query.length > 50 ? '...' : ''}"`,
    };
  }

  /**
   * Build full analysis scope.
   */
  private buildFullScope(query: string): IncrementalScope {
    return {
      type: 'full',
      relevantAgents: ['frame_agent', 'cpu_agent', 'memory_agent', 'binder_agent'],
      relevantSkills: ['scrolling_analysis', 'cpu_analysis', 'memory_analysis', 'binder_analysis'],
      isExtension: false,
      reason: '完整分析',
    };
  }

  /**
   * Merge new findings with previous findings.
   */
  mergeFindings(
    previousFindings: Finding[],
    newFindings: Finding[]
  ): Finding[] {
    const merged: Finding[] = [...previousFindings];
    const existingIds = new Set(previousFindings.map(f => f.id));

    for (const newFinding of newFindings) {
      if (existingIds.has(newFinding.id)) {
        // Update existing finding
        const index = merged.findIndex(f => f.id === newFinding.id);
        if (index !== -1) {
          merged[index] = this.mergeSingleFinding(merged[index], newFinding);
        }
      } else {
        // Add new finding
        merged.push(newFinding);
      }
    }

    // Sort by severity and recency
    return this.sortFindings(merged);
  }

  /**
   * Merge a single finding (update with new data).
   */
  private mergeSingleFinding(existing: Finding, updated: Finding): Finding {
    return {
      ...existing,
      ...updated,
      // Preserve ID
      id: existing.id,
      // Merge details
      details: {
        ...(existing.details || {}),
        ...(updated.details || {}),
      },
      // Use higher confidence
      confidence: Math.max(existing.confidence || 0, updated.confidence || 0),
    };
  }

  /**
   * Sort findings by importance.
   */
  private sortFindings(findings: Finding[]): Finding[] {
    const severityOrder: Record<string, number> = {
      critical: 4,
      warning: 3,
      info: 2,
      debug: 1,
    };

    return findings.sort((a, b) => {
      // First by severity
      const sevDiff = (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
      if (sevDiff !== 0) return sevDiff;

      // Then by confidence
      return (b.confidence || 0) - (a.confidence || 0);
    });
  }

  /**
   * Check if should do full analysis vs incremental.
   */
  shouldDoFullAnalysis(
    focusStore: FocusStore,
    previousState?: PreviousAnalysisState
  ): boolean {
    // Full analysis if no previous state
    if (!previousState || previousState.findings.length === 0) {
      return true;
    }

    // Full analysis if no significant focus
    const topFocuses = focusStore.getTopFocuses(3);
    if (topFocuses.length === 0 || topFocuses[0].weight < this.config.minFocusWeight) {
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get agents relevant for entity types.
   */
  private getAgentsForEntityTypes(types: FocusEntityType[]): string[] {
    const agents = new Set<string>();

    for (const type of types) {
      switch (type) {
        case 'frame':
        case 'session':
          agents.add('frame_agent');
          break;
        case 'cpu_slice':
          agents.add('cpu_agent');
          break;
        case 'binder':
          agents.add('binder_agent');
          break;
        case 'gc':
        case 'memory':
          agents.add('memory_agent');
          break;
        case 'process':
        case 'thread':
          agents.add('frame_agent');
          agents.add('cpu_agent');
          break;
      }
    }

    return Array.from(agents);
  }

  /**
   * Get skills for given agents.
   */
  private getSkillsForAgents(agents: string[]): string[] {
    const agentSkillMap: Record<string, string[]> = {
      frame_agent: ['jank_frame_detail', 'scrolling_analysis', 'consumer_jank_detection'],
      cpu_agent: ['cpu_analysis', 'scheduling_analysis'],
      memory_agent: ['memory_analysis', 'gc_analysis'],
      binder_agent: ['binder_analysis', 'binder_detail'],
    };

    const skills = new Set<string>();
    for (const agent of agents) {
      const agentSkills = agentSkillMap[agent] || [];
      for (const skill of agentSkills) {
        skills.add(skill);
      }
    }

    return Array.from(skills);
  }

  /**
   * Infer relevant agents from question content.
   */
  private inferAgentsFromQuestions(questions: string[]): string[] {
    const agents = new Set<string>();
    const combined = questions.join(' ').toLowerCase();

    // Frame/scrolling keywords
    if (/滑动|scroll|卡顿|jank|掉帧|fps|帧|frame|渲染|render/.test(combined)) {
      agents.add('frame_agent');
    }

    // CPU keywords
    if (/cpu|调度|sched|频率|freq|负载|load|大核|小核|线程|thread/.test(combined)) {
      agents.add('cpu_agent');
    }

    // Memory keywords
    if (/内存|memory|gc|垃圾回收|oom|lmk|heap|分配|alloc/.test(combined)) {
      agents.add('memory_agent');
    }

    // Binder keywords
    if (/binder|ipc|锁|lock|阻塞|block|事务|transaction/.test(combined)) {
      agents.add('binder_agent');
    }

    // Default to frame if no specific match
    if (agents.size === 0) {
      agents.add('frame_agent');
    }

    return Array.from(agents);
  }

  /**
   * Get entity data from EntityStore.
   */
  private getEntityData(
    type: FocusEntityType,
    id: EntityId,
    entityStore: EntityStore
  ): { processName?: string; startTs?: string; endTs?: string } | null {
    switch (type) {
      case 'frame': {
        const frame = entityStore.getFrame(id);
        return frame ? {
          processName: frame.process_name,
          startTs: frame.start_ts,
          endTs: frame.end_ts,
        } : null;
      }
      case 'session': {
        const session = entityStore.getSession(id);
        return session ? {
          processName: session.process_name,
          startTs: session.start_ts,
          endTs: session.end_ts,
        } : null;
      }
      default:
        return null;
    }
  }

  /**
   * Check if two time ranges overlap.
   */
  private rangesOverlap(
    a: { start: string; end: string },
    b: { start: string; end: string }
  ): boolean {
    try {
      const aStart = BigInt(a.start);
      const aEnd = BigInt(a.end);
      const bStart = BigInt(b.start);
      const bEnd = BigInt(b.end);

      return aStart < bEnd && aEnd > bStart;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an incremental analyzer instance.
 */
export function createIncrementalAnalyzer(
  config?: Partial<IncrementalAnalyzerConfig>
): IncrementalAnalyzer {
  return new IncrementalAnalyzer(config);
}

export default IncrementalAnalyzer;
