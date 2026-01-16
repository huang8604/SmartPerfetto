/**
 * Enhanced Session Context - Phase 5 Multi-turn Dialogue Support
 *
 * Manages conversation history across multiple turns, enabling:
 * - Finding reference tracking between turns
 * - Context-aware response generation
 * - Intelligent context summarization for LLM
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ConversationTurn,
  Finding,
  Intent,
  SubAgentResult,
  ContextSummary,
  FindingReference
} from '../types';

/**
 * Enhanced session context for multi-turn dialogue
 * Tracks conversation history and enables cross-turn finding references
 */
export class EnhancedSessionContext {
  private sessionId: string;
  private traceId: string;
  private turns: ConversationTurn[] = [];
  private findings: Map<string, Finding> = new Map();
  private findingTurnMap: Map<string, string> = new Map(); // findingId -> turnId
  private references: FindingReference[] = [];
  private topicsDiscussed: Set<string> = new Set();
  private openQuestions: string[] = [];

  constructor(sessionId: string, traceId: string) {
    this.sessionId = sessionId;
    this.traceId = traceId;
  }

  /**
   * Add a new conversation turn
   */
  addTurn(
    query: string,
    intent: Intent,
    result?: SubAgentResult,
    turnFindings?: Finding[]
  ): ConversationTurn {
    const turnId = uuidv4();
    const turnIndex = this.turns.length;
    const findings = turnFindings || [];

    // Register findings
    for (const finding of findings) {
      this.findings.set(finding.id, finding);
      this.findingTurnMap.set(finding.id, turnId);
    }

    // Extract topics from intent
    if (intent.primaryGoal) {
      this.topicsDiscussed.add(intent.primaryGoal);
    }
    if (intent.aspects) {
      for (const aspect of intent.aspects) {
        this.topicsDiscussed.add(aspect);
      }
    }

    const turn: ConversationTurn = {
      id: turnId,
      timestamp: Date.now(),
      query,
      intent,
      result,
      findings,
      turnIndex,
      completed: !!result
    };

    this.turns.push(turn);
    return turn;
  }

  /**
   * Mark a turn as completed
   */
  completeTurn(turnId: string, result: SubAgentResult, newFindings?: Finding[]): void {
    const turn = this.turns.find(t => t.id === turnId);
    if (turn) {
      turn.result = result;
      turn.completed = true;

      if (newFindings) {
        for (const finding of newFindings) {
          this.findings.set(finding.id, finding);
          this.findingTurnMap.set(finding.id, turnId);
          turn.findings.push(finding);
        }
      }
    }
  }

  /**
   * Get a specific finding by ID
   */
  getFinding(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  /**
   * Get all findings from a specific turn
   */
  getFindingsFromTurn(turnId: string): Finding[] {
    const turn = this.turns.find(t => t.id === turnId);
    return turn?.findings || [];
  }

  /**
   * Get the turn where a finding was discovered
   */
  getTurnForFinding(findingId: string): ConversationTurn | undefined {
    const turnId = this.findingTurnMap.get(findingId);
    if (!turnId) return undefined;
    return this.turns.find(t => t.id === turnId);
  }

  /**
   * Add a reference between findings
   */
  addFindingReference(
    fromFindingId: string,
    toFindingId: string,
    refType: FindingReference['refType']
  ): void {
    const fromTurnId = this.findingTurnMap.get(fromFindingId);
    if (fromTurnId) {
      this.references.push({
        findingId: toFindingId,
        turnId: fromTurnId,
        refType
      });
    }
  }

  /**
   * Query context by keywords - returns relevant turns
   */
  queryContext(keywords: string[]): ConversationTurn[] {
    if (!keywords || keywords.length === 0) {
      return [...this.turns];
    }

    const lowerKeywords = keywords.map(k => k.toLowerCase());

    return this.turns.filter(turn => {
      // Check query
      const queryMatch = lowerKeywords.some(kw =>
        turn.query.toLowerCase().includes(kw)
      );

      // Check intent
      const intentMatch = lowerKeywords.some(kw =>
        turn.intent.primaryGoal.toLowerCase().includes(kw) ||
        turn.intent.aspects.some(a => a.toLowerCase().includes(kw))
      );

      // Check findings
      const findingMatch = turn.findings.some(f =>
        lowerKeywords.some(kw =>
          f.title.toLowerCase().includes(kw) ||
          f.description.toLowerCase().includes(kw)
        )
      );

      return queryMatch || intentMatch || findingMatch;
    });
  }

  /**
   * Add an open question
   */
  addOpenQuestion(question: string): void {
    if (!this.openQuestions.includes(question)) {
      this.openQuestions.push(question);
    }
  }

  /**
   * Resolve/remove an open question
   */
  resolveQuestion(question: string): void {
    const index = this.openQuestions.indexOf(question);
    if (index > -1) {
      this.openQuestions.splice(index, 1);
    }
  }

  /**
   * Generate a context summary for LLM consumption
   * This creates a compact representation for context-aware prompts
   */
  generateContextSummary(): ContextSummary {
    // Build conversation summary
    const conversationParts: string[] = [];
    for (const turn of this.turns) {
      const findingsSummary = turn.findings.length > 0
        ? `发现 ${turn.findings.length} 个问题`
        : '无重要发现';
      conversationParts.push(
        `[Turn ${turn.turnIndex + 1}] 用户问: "${turn.query.substring(0, 50)}..." → ${findingsSummary}`
      );
    }

    // Extract key findings (high severity)
    const keyFindings = Array.from(this.findings.values())
      .filter(f => ['critical', 'high', 'warning'].includes(f.severity))
      .map(f => {
        const turnId = this.findingTurnMap.get(f.id);
        const turn = this.turns.find(t => t.id === turnId);
        return {
          id: f.id,
          title: f.title,
          severity: f.severity,
          turnIndex: turn?.turnIndex ?? -1
        };
      })
      .slice(0, 10); // Limit to top 10

    return {
      turnCount: this.turns.length,
      conversationSummary: conversationParts.join('\n'),
      keyFindings,
      topicsDiscussed: Array.from(this.topicsDiscussed),
      openQuestions: [...this.openQuestions]
    };
  }

  /**
   * Generate a prompt-friendly context string
   * Used for injecting context into LLM prompts
   */
  generatePromptContext(maxTokens: number = 500): string {
    const summary = this.generateContextSummary();

    const parts: string[] = [];

    // Add turn count
    parts.push(`## 对话历史 (${summary.turnCount} 轮)`);

    // Add conversation summary
    if (summary.conversationSummary) {
      parts.push(summary.conversationSummary);
    }

    // Add key findings
    if (summary.keyFindings.length > 0) {
      parts.push('\n## 关键发现');
      for (const finding of summary.keyFindings.slice(0, 5)) {
        parts.push(`- [${finding.severity}] ${finding.title}`);
      }
    }

    // Add topics
    if (summary.topicsDiscussed.length > 0) {
      parts.push(`\n## 讨论主题: ${summary.topicsDiscussed.slice(0, 5).join(', ')}`);
    }

    // Add open questions
    if (summary.openQuestions.length > 0) {
      parts.push('\n## 待回答问题');
      for (const q of summary.openQuestions.slice(0, 3)) {
        parts.push(`- ${q}`);
      }
    }

    const result = parts.join('\n');

    // Rough token estimation (4 chars ≈ 1 token for Chinese)
    const estimatedTokens = Math.ceil(result.length / 4);
    if (estimatedTokens > maxTokens) {
      // Truncate if too long
      const ratio = maxTokens / estimatedTokens;
      return result.substring(0, Math.floor(result.length * ratio)) + '...';
    }

    return result;
  }

  /**
   * Get all turns
   */
  getAllTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /**
   * Get the last N turns
   */
  getRecentTurns(n: number): ConversationTurn[] {
    return this.turns.slice(-n);
  }

  /**
   * Get all findings
   */
  getAllFindings(): Finding[] {
    return Array.from(this.findings.values());
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get trace ID
   */
  getTraceId(): string {
    return this.traceId;
  }

  /**
   * Serialize context for persistence
   */
  serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      traceId: this.traceId,
      turns: this.turns,
      findings: Array.from(this.findings.entries()),
      findingTurnMap: Array.from(this.findingTurnMap.entries()),
      references: this.references,
      topicsDiscussed: Array.from(this.topicsDiscussed),
      openQuestions: this.openQuestions
    });
  }

  /**
   * Deserialize context from persistence
   */
  static deserialize(json: string): EnhancedSessionContext {
    const data = JSON.parse(json);
    const ctx = new EnhancedSessionContext(data.sessionId, data.traceId);
    ctx.turns = data.turns;
    ctx.findings = new Map(data.findings);
    ctx.findingTurnMap = new Map(data.findingTurnMap);
    ctx.references = data.references;
    ctx.topicsDiscussed = new Set(data.topicsDiscussed);
    ctx.openQuestions = data.openQuestions;
    return ctx;
  }
}

/**
 * Session context manager - manages multiple sessions
 */
export class SessionContextManager {
  private sessions: Map<string, EnhancedSessionContext> = new Map();

  /**
   * Get or create a session context
   */
  getOrCreate(sessionId: string, traceId: string): EnhancedSessionContext {
    let ctx = this.sessions.get(sessionId);
    if (!ctx) {
      ctx = new EnhancedSessionContext(sessionId, traceId);
      this.sessions.set(sessionId, ctx);
    }
    return ctx;
  }

  /**
   * Get a session context
   */
  get(sessionId: string): EnhancedSessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove a session context
   */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * List all session IDs
   */
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

// Singleton instance
export const sessionContextManager = new SessionContextManager();
