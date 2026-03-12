import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { TraceProcessorService } from '../services/traceProcessorService';
import { createSkillExecutor } from '../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../services/skillEngine/skillLoader';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../agent/types';
import type { AnalysisResult, AnalysisOptions, IOrchestrator } from '../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../agent/detectors/types';

import { createClaudeMcpServer, loadLearnedSqlFixPairs, MCP_NAME_PREFIX } from './claudeMcpServer';
import { buildSystemPrompt } from './claudeSystemPrompt';
import { createSseBridge } from './claudeSseBridge';
import { extractFindingsFromText, extractFindingsFromSkillResult, mergeFindings } from './claudeFindingExtractor';
import { loadClaudeConfig, resolveEffort, type ClaudeAgentConfig } from './claudeConfig';
import { detectFocusApps } from './focusAppDetector';
import { classifyScene } from './sceneClassifier';
import { buildAgentDefinitions } from './claudeAgentDefinitions';
import { getExtendedKnowledgeBase } from '../services/sqlKnowledgeBase';
import type { AnalysisNote, AnalysisPlanV3, FailedApproach, Hypothesis, UncertaintyFlag } from './types';
import { ArtifactStore } from './artifactStore';
import {
  extractTraceFeatures,
  extractKeyInsights,
  saveAnalysisPattern,
  saveNegativePattern,
  buildPatternContextSection,
  buildNegativePatternSection,
} from './analysisPatternMemory';
import { verifyConclusion, generateCorrectionPrompt } from './claudeVerifier';
import {
  captureEntitiesFromResponses,
  applyCapturedEntities,
} from '../agent/core/entityCapture';

const SESSION_MAP_FILE = path.resolve(__dirname, '../../logs/claude_session_map.json');
/** Max age for session map entries before pruning (24 hours). */
const SESSION_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SessionMapEntry {
  sdkSessionId: string;
  updatedAt: number;
}

function loadPersistedSessionMap(): Map<string, SessionMapEntry> {
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const map = new Map<string, SessionMapEntry>();
      for (const [key, value] of Object.entries(data)) {
        // Migration: old format stored plain string, new format stores {sdkSessionId, updatedAt}
        if (typeof value === 'string') {
          map.set(key, { sdkSessionId: value, updatedAt: Date.now() });
        } else if (value && typeof value === 'object') {
          map.set(key, value as SessionMapEntry);
        }
      }
      return map;
    }
  } catch {
    // Ignore — start with empty map
  }
  return new Map();
}

/** Debounce timer for session map persistence — avoids blocking event loop on every SDK message. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 2000;

function savePersistedSessionMap(map: Map<string, SessionMapEntry>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePersistedSessionMapSync(map);
  }, SAVE_DEBOUNCE_MS);
}

/** Immediate save — used by debounce timer and for critical operations (session removal). */
function savePersistedSessionMapSync(map: Map<string, SessionMapEntry>): void {
  try {
    const dir = path.dirname(SESSION_MAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Prune stale entries before saving
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.updatedAt > SESSION_MAP_MAX_AGE_MS) {
        map.delete(key);
      }
    }

    const tmpFile = SESSION_MAP_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmpFile, SESSION_MAP_FILE);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to persist session map:', (err as Error).message);
  }
}

// P2-G21: Session notes persistence — survives backend restart
const SESSION_NOTES_DIR = path.resolve(__dirname, '../../logs/session_notes');

function loadPersistedNotes(sessionId: string): AnalysisNote[] {
  try {
    const filePath = path.join(SESSION_NOTES_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* start fresh */ }
  return [];
}

function savePersistedNotes(sessionId: string, notes: AnalysisNote[]): void {
  if (notes.length === 0) return;
  try {
    if (!fs.existsSync(SESSION_NOTES_DIR)) fs.mkdirSync(SESSION_NOTES_DIR, { recursive: true });
    const tmpFile = path.join(SESSION_NOTES_DIR, `${sessionId}.json.tmp`);
    const filePath = path.join(SESSION_NOTES_DIR, `${sessionId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(notes));
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to persist notes:', (err as Error).message);
  }
}

function deletePersistedNotes(sessionId: string): void {
  try {
    const filePath = path.join(SESSION_NOTES_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* non-fatal */ }
}

// P2-G1: ALLOWED_TOOLS is now auto-derived from createClaudeMcpServer() return value.
// No longer hardcoded — adding a new MCP tool automatically includes it.

/** Check if an error is retryable (API overload/server errors). */
function isRetryableError(err: Error): boolean {
  const msg = err.message || '';
  // Anthropic API errors: 529 (overload), 500 (server), 503 (service unavailable)
  return /529|overload|500|server error|503|service unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap sdkQuery with exponential backoff retry for transient API errors.
 * Only retries the initial call — mid-stream errors are handled by existing try/catch.
 */
function sdkQueryWithRetry(
  params: Parameters<typeof sdkQuery>[0],
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    emitUpdate?: (update: StreamingUpdate) => void;
  } = {},
): ReturnType<typeof sdkQuery> {
  const { maxRetries = 2, baseDelayMs = 2000, emitUpdate } = options;

  // We can't directly retry an async iterable, so we use a generator wrapper.
  // On the first call to next(), we attempt sdkQuery. If it throws, we retry.
  async function* retryableStream() {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const stream = sdkQuery(params);
        // Yield all messages from the stream
        for await (const msg of stream) {
          yield msg;
        }
        return; // Success — exit generator
      } catch (err) {
        lastErr = err as Error;
        if (isRetryableError(lastErr) && attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(`[ClaudeRuntime] API error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastErr.message}. Retrying in ${delay}ms...`);
          emitUpdate?.({
            type: 'progress',
            content: { phase: 'starting', message: `API 暂时不可用，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${maxRetries})...` },
            timestamp: Date.now(),
          });
          await sleep(delay);
          continue;
        }
        throw lastErr; // Non-retryable or max retries exceeded
      }
    }
    if (lastErr) throw lastErr;
  }

  return retryableStream() as ReturnType<typeof sdkQuery>;
}

/**
 * Claude Agent SDK runtime for SmartPerfetto.
 * Replaces the agentv2 governance pipeline with Claude-as-orchestrator.
 * Implements the same EventEmitter + analyze() interface as AgentRuntime.
 */
export class ClaudeRuntime extends EventEmitter implements IOrchestrator {
  private traceProcessorService: TraceProcessorService;
  private config: ClaudeAgentConfig;
  private sessionMap: Map<string, SessionMapEntry>;
  /** Cache architecture detection results per traceId (deterministic per trace). */
  private architectureCache: Map<string, ArchitectureInfo> = new Map();
  /** Per-session artifact stores — persist across turns within a session. */
  private artifactStores: Map<string, ArtifactStore> = new Map();
  /** Per-session analysis notes — persist across turns within a session. */
  private sessionNotes: Map<string, AnalysisNote[]> = new Map();
  /** Per-session SQL error tracking for error-fix pair learning. */
  private sessionSqlErrors: Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number }>> = new Map();
  /** Per-session analysis plans for plan adherence tracking. */
  private sessionPlans: Map<string, { current: AnalysisPlanV3 | null }> = new Map();
  /** Per-session hypotheses for hypothesis-verify cycle (P0-G4). */
  private sessionHypotheses: Map<string, Hypothesis[]> = new Map();
  /** Per-session uncertainty flags for non-blocking human interaction (P1-G1). */
  private sessionUncertaintyFlags: Map<string, UncertaintyFlag[]> = new Map();
  /** Guard against concurrent analyze() calls for the same session. */
  private activeAnalyses: Set<string> = new Set();

  constructor(traceProcessorService: TraceProcessorService, config?: Partial<ClaudeAgentConfig>) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.config = loadClaudeConfig(config);
    this.sessionMap = loadPersistedSessionMap();
  }

  /** Restore a previously persisted SDK session mapping (e.g., after server restart). */
  restoreSessionMapping(smartPerfettoSessionId: string, sdkSessionId: string): void {
    this.sessionMap.set(smartPerfettoSessionId, { sdkSessionId, updatedAt: Date.now() });
  }

  /** Get SDK session ID for persistence. */
  getSdkSessionId(smartPerfettoSessionId: string): string | undefined {
    return this.sessionMap.get(smartPerfettoSessionId)?.sdkSessionId;
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    // Prevent concurrent analyze() calls for the same session
    if (this.activeAnalyses.has(sessionId)) {
      throw new Error(`Analysis already in progress for session ${sessionId}`);
    }
    this.activeAnalyses.add(sessionId);

    const startTime = Date.now();
    const allFindings: Finding[][] = [];
    let conclusionText = '';
    let sdkSessionId: string | undefined;
    let rounds = 0;

    try {
      const ctx = await this.prepareAnalysisContext(query, sessionId, traceId, options);

      const bridge = createSseBridge((update: StreamingUpdate) => {
        this.emitUpdate(update);
        if (update.type === 'agent_response' && update.content?.result) {
          try {
            const parsed = typeof update.content.result === 'string'
              ? JSON.parse(update.content.result)
              : update.content.result;
            if (parsed?.success && parsed?.skillId) {
              allFindings.push(extractFindingsFromSkillResult(parsed));
            }
            if (parsed?.success && parsed?.displayResults) {
              this.captureEntitiesFromSkillDisplayResults(parsed.displayResults, ctx.entityStore);
            }
          } catch {
            // Not a skill result — ignore
          }
        }
      });

      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: `使用 ${this.config.model} 开始分析 (effort: ${ctx.effectiveEffort})...` },
        timestamp: Date.now(),
      });

      const existingSdkSessionId = this.sessionMap.get(sessionId)?.sdkSessionId;
      const stream = sdkQueryWithRetry({
        prompt: query,
        options: {
          model: this.config.model,
          maxTurns: this.config.maxTurns,
          systemPrompt: ctx.systemPrompt,
          mcpServers: { smartperfetto: ctx.mcpServer },
          includePartialMessages: true,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          cwd: this.config.cwd,
          effort: ctx.effectiveEffort,
          allowedTools: ctx.allowedTools,
          ...(this.config.maxBudgetUsd ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
          ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
          ...(ctx.agents ? { agents: ctx.agents } : {}),
        },
      }, { emitUpdate: (update) => this.emitUpdate(update) });

      let finalResult: string | undefined;

      // Safety timeout with stream cancellation via Promise.race
      const timeoutMs = (this.config.maxTurns || 15) * 20_000; // 20s per turn, not 60s
      let timedOut = false;

      // Sub-agent timeout tracking — stop tasks that exceed subAgentTimeoutMs
      const activeSubAgentTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
      const subAgentTimeoutMs = this.config.subAgentTimeoutMs;

      // P2-1: Turn-level autonomy watchdog — detect repetitive tool failures
      // P1-G2: Per-tool tracking — each tool gets its own failure tracking
      const toolCallHistory: Array<{ name: string; success: boolean }> = [];
      const WATCHDOG_WINDOW = 3; // consecutive same-tool failures to trigger warning
      const watchdogFiredTools = new Set<string>(); // tracks which tools have triggered warnings

      // P0-G16: Circuit breaker — overall tool call failure rate monitoring
      let circuitBreakerFires = 0;
      const MAX_CIRCUIT_BREAKER_FIRES = 2;
      const CIRCUIT_BREAKER_WINDOW = 5;
      const CIRCUIT_BREAKER_THRESHOLD = 0.6; // 60% failure rate
      let lastCircuitBreakerFireIdx = -Infinity;

      // P1: Negative memory — collect failed approaches for cross-session learning
      const failedApproaches: FailedApproach[] = [];

      const processStream = async () => {
        for await (const msg of stream) {
          if (timedOut) break; // P0-1: Actually cancel stream on timeout
          if (msg.session_id && !sdkSessionId) {
            sdkSessionId = msg.session_id;
            this.sessionMap.set(sessionId, { sdkSessionId, updatedAt: Date.now() });
            savePersistedSessionMap(this.sessionMap);
          }

          // Track sub-agent lifecycle for per-agent timeouts
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_started') {
            const taskId = (msg as any).task_id;
            if (taskId && subAgentTimeoutMs > 0) {
              const timer = setTimeout(() => {
                console.warn(`[ClaudeRuntime] Sub-agent timeout: stopping task ${taskId} after ${subAgentTimeoutMs / 1000}s`);
                activeSubAgentTimers.delete(taskId);
                if (typeof (stream as any).stopTask === 'function') {
                  (stream as any).stopTask(taskId).catch((err: Error) => {
                    console.warn(`[ClaudeRuntime] Failed to stop sub-agent task ${taskId}:`, err.message);
                  });
                }
                // P1-6: Record timeout as a finding so it's reflected in confidence
                allFindings.push([{
                  id: `sub-agent-timeout-${taskId}`,
                  title: `子代理超时`,
                  severity: 'medium' as const,
                  category: 'sub-agent',
                  description: `子代理 ${taskId} 超时 (${subAgentTimeoutMs / 1000}s)，分析可能不完整`,
                  confidence: 0.3,
                }]);
                this.emitUpdate({
                  type: 'progress',
                  content: { phase: 'analyzing', message: `子代理超时 (${subAgentTimeoutMs / 1000}s)，已停止` },
                  timestamp: Date.now(),
                });
              }, subAgentTimeoutMs);
              activeSubAgentTimers.set(taskId, timer);
            }
          }
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_notification') {
            const taskId = (msg as any).task_id;
            if (taskId) {
              const timer = activeSubAgentTimers.get(taskId);
              if (timer) {
                clearTimeout(timer);
                activeSubAgentTimers.delete(taskId);
              }
            }
            // P1-5: Extract findings from sub-agent completion summaries.
            // Without this, sub-agent evidence is only in the conclusion text
            // and not merged into allFindings for confidence estimation.
            const summary = (msg as any).summary || '';
            const status = (msg as any).status || 'completed';
            if (status === 'completed' && summary) {
              allFindings.push(extractFindingsFromText(summary));
            }
          }

          // Bridge SDK messages to SSE events
          try {
            bridge(msg);
          } catch (bridgeErr) {
            console.warn('[ClaudeRuntime] SSE bridge error (non-fatal):', (bridgeErr as Error).message);
          }

          // P2-1: Watchdog — track tool calls for repetitive failure detection
          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            for (const block of (msg as any).message.content) {
              if (block.type === 'tool_use') {
                toolCallHistory.push({ name: block.name, success: true }); // assume success, update on result
              }
            }
          }
          if (msg.type === 'user' && (msg as any).tool_use_result !== undefined) {
            const result = (msg as any).tool_use_result;
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const isFailed = resultStr.includes('"success":false') || resultStr.includes('"isError":true');
            if (toolCallHistory.length > 0) {
              toolCallHistory[toolCallHistory.length - 1].success = !isFailed;
            }
            // Check for consecutive same-tool failures (P1-G2: per-tool tracking)
            if (toolCallHistory.length >= WATCHDOG_WINDOW) {
              const recent = toolCallHistory.slice(-WATCHDOG_WINDOW);
              const allSameTool = recent.every(t => t.name === recent[0].name);
              const allFailed = recent.every(t => !t.success);
              const toolName = recent[0].name.replace(MCP_NAME_PREFIX, '');
              if (allSameTool && allFailed && !watchdogFiredTools.has(toolName)) {
                watchdogFiredTools.add(toolName);
                console.warn(`[ClaudeRuntime] Watchdog: ${WATCHDOG_WINDOW} consecutive failures for ${toolName}`);
                // P1-2: Inject warning into next MCP tool result (Claude reads this)
                ctx.watchdogWarning.current = `${toolName} 已连续失败 ${WATCHDOG_WINDOW} 次。请切换分析策略：尝试不同的 SQL 查询、使用其他 skill、或调整参数。不要重复相同的失败操作。`;
                // P1: Record for negative memory
                failedApproaches.push({
                  type: 'tool_failure',
                  approach: `连续调用 ${toolName} ${WATCHDOG_WINDOW} 次均失败`,
                  reason: '同一工具重复失败，需要切换策略',
                });
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: `⚠ 检测到 ${toolName} 连续 ${WATCHDOG_WINDOW} 次失败，已注入策略切换指令`,
                  },
                  timestamp: Date.now(),
                });
              }
            }
            // Track tool call for plan adherence with phase matching (P0-1 + P1-1)
            // P1-G5: Best-fit phase-tool matching — search all eligible phases, not just first
            if (ctx.analysisPlan.current && toolCallHistory.length > 0) {
              const lastTool = toolCallHistory[toolCallHistory.length - 1];
              const plan = ctx.analysisPlan.current;
              const shortToolName = lastTool.name.replace(MCP_NAME_PREFIX, '');
              // Priority: in_progress phase first, then any pending phase with matching expectedTools
              const activePhase = plan.phases.find(p => p.status === 'in_progress');
              let matchedPhaseId: string | undefined;
              if (activePhase?.expectedTools.includes(shortToolName)) {
                matchedPhaseId = activePhase.id;
              } else {
                // Search all pending phases for the one expecting this tool
                const pendingMatch = plan.phases.find(p =>
                  p.status === 'pending' && p.expectedTools.includes(shortToolName)
                );
                matchedPhaseId = pendingMatch?.id;
              }
              plan.toolCallLog.push({
                toolName: lastTool.name,
                timestamp: Date.now(),
                matchedPhaseId,
              });
            }

            // P0-G16: Circuit breaker — overall failure rate monitoring
            // Unlike watchdog (same-tool consecutive failures), this monitors aggregate health.
            // Fires when >60% of recent tool calls fail, regardless of which tools.
            // P1-G9: Circuit breaker can fire even with pending watchdog warning
            // (CB is higher priority — its "simplify scope" message overwrites per-tool warnings)
            if (circuitBreakerFires < MAX_CIRCUIT_BREAKER_FIRES
                && toolCallHistory.length >= CIRCUIT_BREAKER_WINDOW
                && toolCallHistory.length - lastCircuitBreakerFireIdx >= 3) {
              const recentWindow = toolCallHistory.slice(-CIRCUIT_BREAKER_WINDOW);
              const failCount = recentWindow.filter(t => !t.success).length;
              const failRate = failCount / recentWindow.length;
              if (failRate >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitBreakerFires++;
                lastCircuitBreakerFireIdx = toolCallHistory.length;
                ctx.watchdogWarning.current =
                  `⚠️ 分析断路器触发：最近 ${CIRCUIT_BREAKER_WINDOW} 次工具调用中 ${failCount} 次失败 (${(failRate * 100).toFixed(0)}%)。` +
                  `请：1) 简化分析范围，2) 使用更基础的查询，3) 如果数据不可用则基于已有证据出结论。不要继续尝试失败的操作。`;
                failedApproaches.push({
                  type: 'strategy_failure',
                  approach: `整体工具调用失败率过高 (${(failRate * 100).toFixed(0)}%)`,
                  reason: `最近 ${CIRCUIT_BREAKER_WINDOW} 次调用中 ${failCount} 次失败`,
                });
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: `⚠ 分析断路器触发：工具调用失败率 ${(failRate * 100).toFixed(0)}%，建议简化分析范围`,
                  },
                  timestamp: Date.now(),
                });
              }
            }
          }

          if (msg.type === 'result') {
            rounds = (msg as any).num_turns || rounds;
            if ((msg as any).subtype === 'success') {
              finalResult = (msg as any).result;
            }
          }
        }
        // Clean up any remaining sub-agent timers
        for (const timer of activeSubAgentTimers.values()) clearTimeout(timer);
        activeSubAgentTimers.clear();
      };

      let safetyTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((_, reject) => {
        safetyTimer = setTimeout(() => {
          timedOut = true;
          // Cancel the SDK stream to stop consuming API credits.
          // Try async generator .return() first, then .abort() if available.
          // Use .then/.catch instead of await (setTimeout callback is not async).
          const cancelStream = () => {
            try {
              if (typeof (stream as any).return === 'function') {
                const ret = (stream as any).return();
                if (ret && typeof ret.catch === 'function') ret.catch(() => {});
              }
              if (typeof (stream as any).abort === 'function') {
                (stream as any).abort();
              }
            } catch (cancelErr) {
              console.warn('[ClaudeRuntime] Stream cancellation error (non-fatal):', (cancelErr as Error).message);
            }
          };
          cancelStream();
          reject(new Error(`Analysis safety timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      try {
        await Promise.race([processStream(), timeoutPromise]);
      } catch (err) {
        if (timedOut) {
          console.error('[ClaudeRuntime] Analysis safety timeout reached — stream may still be active');
          this.emitUpdate({
            type: 'progress',
            content: { phase: 'concluding', message: '分析超时，正在生成已有结果的结论...' },
            timestamp: Date.now(),
          });
        } else {
          throw err;
        }
      } finally {
        // Clear the safety timer to prevent memory leak on normal completion
        if (safetyTimer) clearTimeout(safetyTimer);
      }

      conclusionText = finalResult || '';
      allFindings.push(extractFindingsFromText(conclusionText));
      let mergedFindings = mergeFindings(allFindings);

      // Verification + reflection-driven retry (P0-2 + P2-2)
      // Default ON. Up to 2 correction retries, but second only if new/different errors.
      // Run unconditionally when enabled — plan adherence, hypothesis resolution,
      // and conclusion-length checks must fire even when zero findings are extracted.
      if (this.config.enableVerification) {
        const MAX_CORRECTION_ATTEMPTS = 2;
        let previousErrorSignatures = new Set<string>();

        try {
          for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt++) {
            const verification = await verifyConclusion(mergedFindings, conclusionText, {
              emitUpdate: (update) => this.emitUpdate(update),
              enableLLM: true, // P1-G6: LLM verification on all passes — 2nd correction quality is most uncertain
              plan: ctx.analysisPlan.current,
              hypotheses: ctx.hypotheses,
              sceneType: ctx.sceneType,
            });
            console.log(`[ClaudeRuntime] Verification (attempt ${attempt + 1}): ${verification.passed ? 'PASSED' : 'ISSUES FOUND'} (${verification.durationMs}ms, ${verification.heuristicIssues.length} heuristic + ${verification.llmIssues?.length || 0} LLM issues)`);

            if (verification.passed || !sdkSessionId) break;

            const allIssues = [...verification.heuristicIssues, ...(verification.llmIssues || [])];
            const errorIssues = allIssues.filter(i => i.severity === 'error');
            if (errorIssues.length === 0) break;

            // P2-2: Check if these are the SAME errors as last attempt — if so, stop retrying
            const currentSignatures = new Set(errorIssues.map(i => `${i.type}:${i.message.substring(0, 60)}`));
            if (attempt > 0) {
              const newErrors = [...currentSignatures].filter(s => !previousErrorSignatures.has(s));
              if (newErrors.length === 0) {
                console.log(`[ClaudeRuntime] Reflection retry: same ${errorIssues.length} errors persist after correction, stopping`);
                // P1: Record persistent verification failures as negative memory
                for (const issue of errorIssues) {
                  failedApproaches.push({
                    type: 'verification_failure',
                    approach: issue.message.substring(0, 150),
                    reason: `验证发现持续性问题 (${issue.type})，修正重试未能解决`,
                  });
                }
                break;
              }
              console.log(`[ClaudeRuntime] Reflection retry: ${newErrors.length} new errors detected, attempting correction ${attempt + 1}`);
            }
            previousErrorSignatures = currentSignatures;

            this.emitUpdate({
              type: 'progress',
              content: {
                phase: 'concluding',
                message: `发现 ${errorIssues.length} 个 ERROR 级问题，启动修正重试 (${attempt + 1}/${MAX_CORRECTION_ATTEMPTS})...`,
              },
              timestamp: Date.now(),
            });

            try {
              const correctionPrompt = generateCorrectionPrompt(allIssues, conclusionText);
              // P2-2: Give more turn budget on second attempt (may need additional data)
              const correctionTurns = attempt === 0 ? 5 : 8;
              const correctionStream = sdkQueryWithRetry({
                prompt: correctionPrompt,
                options: {
                  model: this.config.model,
                  maxTurns: correctionTurns,
                  systemPrompt: ctx.systemPrompt,
                  mcpServers: { smartperfetto: ctx.mcpServer },
                  includePartialMessages: true,
                  permissionMode: 'bypassPermissions' as const,
                  allowDangerouslySkipPermissions: true,
                  cwd: this.config.cwd,
                  effort: ctx.effectiveEffort,
                  allowedTools: ctx.allowedTools,
                  resume: sdkSessionId,
                },
              }, { emitUpdate: (update) => this.emitUpdate(update) });

              // P1-G8: Independent timeout for correction retries — prevents indefinite hangs.
              // Each turn gets 10s budget (correction is focused work, not open exploration).
              const correctionTimeoutMs = correctionTurns * 10_000;
              let correctionTimedOut = false;
              const correctionTimer = setTimeout(() => {
                correctionTimedOut = true;
                console.warn(`[ClaudeRuntime] Correction retry ${attempt + 1} timed out after ${correctionTimeoutMs}ms`);
              }, correctionTimeoutMs);

              let correctedResult = '';
              try {
                for await (const msg of correctionStream) {
                  if (correctionTimedOut) break;
                  if (msg.type === 'result' && (msg as any).subtype === 'success') {
                    correctedResult = (msg as any).result || '';
                    rounds += (msg as any).num_turns || 0;
                  }
                  // Bridge tool call events (agent_task_dispatched, agent_response)
                  // but suppress text/conclusion events to avoid duplicating the report.
                  // The corrected conclusion is captured in correctedResult and will
                  // replace conclusionText below — no need to stream it again.
                  if (msg.type !== 'stream_event' && msg.type !== 'assistant' && msg.type !== 'result') {
                    try { bridge(msg); } catch { /* non-fatal */ }
                  }
                }
              } finally {
                clearTimeout(correctionTimer);
              }

              if (correctionTimedOut) {
                console.warn(`[ClaudeRuntime] Correction attempt ${attempt + 1} timed out, using partial result (${correctedResult.length} chars)`);
              }

              // P2-G13: Compare correction quality by finding count and coverage, not text length.
              // A shorter corrected conclusion with more findings is better than a longer empty one.
              const correctedFindings = correctedResult ? extractFindingsFromText(correctedResult) : [];
              const previousFindingCount = mergedFindings.length;
              const hasSubstantiveCorrection = correctedResult && (
                correctedFindings.length >= previousFindingCount ||
                correctedResult.length > 100
              );

              if (hasSubstantiveCorrection) {
                conclusionText = correctedResult;
                // Re-extract findings from corrected conclusion and re-merge
                allFindings.push(correctedFindings);
                mergedFindings = mergeFindings(allFindings);
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: conclusion corrected (findings: ${previousFindingCount} → ${mergedFindings.length})`);
              } else {
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: correction insufficient (findings: ${correctedFindings.length} vs ${previousFindingCount}), keeping previous`);
                break; // No point retrying if correction failed to improve
              }
            } catch (correctionErr) {
              console.warn(`[ClaudeRuntime] Reflection retry ${attempt + 1} failed (non-blocking):`, (correctionErr as Error).message);
              break;
            }
          }
        } catch (err) {
          console.warn('[ClaudeRuntime] Verification failed (non-blocking):', (err as Error).message);
        }
      }

      const turnConfidence = this.estimateConfidence(mergedFindings);

      ctx.sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'complex',
          followUpType: ctx.previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: true,
          findings: mergedFindings,
          confidence: turnConfidence,
          message: conclusionText,
        },
        mergedFindings,
      );

      ctx.sessionContext.updateWorkingMemoryFromConclusion({
        turnIndex: ctx.previousTurns.length,
        query,
        conclusion: conclusionText,
        confidence: turnConfidence,
      });

      // P2-2: Save analysis pattern to long-term memory (fire-and-forget)
      const sceneType = ctx.sceneType;
      const fullFeatures = extractTraceFeatures({
        architectureType: ctx.architecture?.type,
        sceneType,
        packageName: options.packageName,
        findingTitles: mergedFindings.map(f => f.title),
        findingCategories: mergedFindings.map(f => f.category).filter(Boolean) as string[],
      });
      if (mergedFindings.length > 0 && turnConfidence > 0.3) {
        const insights = extractKeyInsights(mergedFindings, conclusionText);
        saveAnalysisPattern(fullFeatures, insights, sceneType, ctx.architecture?.type, turnConfidence)
          .catch(err => console.warn('[ClaudeRuntime] Pattern save failed:', (err as Error).message));
      }

      // Derive sql_error FailedApproach entries from persistent SQL errors
      // (errors that were never auto-fixed during the session — still in the array)
      const persistentSqlErrors = this.sessionSqlErrors.get(sessionId)?.filter(
        (e: any) => !e.fixedSql && e.errorMessage,
      ) || [];
      for (const sqlErr of persistentSqlErrors.slice(-3)) { // cap at 3 to avoid noise
        failedApproaches.push({
          type: 'sql_error',
          approach: sqlErr.errorSql?.substring(0, 150) || 'unknown SQL',
          reason: sqlErr.errorMessage?.substring(0, 150) || 'SQL query error',
        });
      }

      // P1: Save negative patterns to long-term memory (fire-and-forget)
      if (failedApproaches.length > 0 && fullFeatures.length > 0) {
        saveNegativePattern(fullFeatures, failedApproaches, sceneType, ctx.architecture?.type)
          .catch(err => console.warn('[ClaudeRuntime] Negative pattern save failed:', (err as Error).message));
      }

      // P2-G21: Persist notes to disk after each successful analysis
      const sessionNotes = this.sessionNotes.get(sessionId);
      if (sessionNotes && sessionNotes.length > 0) {
        savePersistedNotes(sessionId, sessionNotes);
      }

      return {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: [],
        conclusion: conclusionText,
        confidence: turnConfidence,
        rounds,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errMsg = (error as Error).message || 'Unknown error';
      console.error('[ClaudeRuntime] Analysis failed:', errMsg);

      // P1-3: Preserve partial findings and generate partial conclusion on mid-stream errors
      const partialFindings = mergeFindings(allFindings);
      const hasPartialResults = partialFindings.length > 0;

      if (hasPartialResults) {
        const partialConclusion = `分析过程中出错 (${errMsg})，以下是已收集的部分发现：\n\n` +
          partialFindings.map(f => `- **[${f.severity.toUpperCase()}]** ${f.title}: ${f.description || ''}`).join('\n');
        this.emitUpdate({
          type: 'progress',
          content: { phase: 'concluding', message: `分析中断，已保留 ${partialFindings.length} 个部分发现` },
          timestamp: Date.now(),
        });
        return {
          sessionId,
          success: true, // partial success — downstream can check confidence < 1
          findings: partialFindings,
          hypotheses: [],
          conclusion: partialConclusion,
          confidence: this.estimateConfidence(partialFindings) * 0.7, // penalize for incomplete
          rounds,
          totalDurationMs: Date.now() - startTime,
        };
      }

      this.emitUpdate({ type: 'error', content: { message: `分析失败: ${errMsg}` }, timestamp: Date.now() });
      return {
        sessionId,
        success: false,
        findings: partialFindings,
        hypotheses: [],
        conclusion: `分析过程中出错: ${errMsg}`,
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
      };
    } finally {
      this.activeAnalyses.delete(sessionId);
    }
  }

  removeSession(sessionId: string): void {
    // Cancel any pending debounced save to prevent stale write after sync save
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    this.sessionMap.delete(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    deletePersistedNotes(sessionId); // P2-G21
    this.sessionSqlErrors.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
    // Use immediate save — session is being removed, must persist before cleanup completes
    savePersistedSessionMapSync(this.sessionMap);
  }

  /** Clean up all session-scoped state for a given session. */
  cleanupSession(sessionId: string): void {
    this.removeSession(sessionId);
  }

  reset(): void {
    this.architectureCache.clear();
    // Also clear all session-scoped stores to prevent unbounded growth
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.activeAnalyses.clear();
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }

  /**
   * Collect the most recent findings from previous turns for system prompt injection.
   * Caps at 5 findings to prevent unbounded prompt growth.
   */
  private collectPreviousFindings(sessionContext: any, maxTurns?: number): Finding[] {
    try {
      let turns = sessionContext.getAllTurns?.() || [];
      if (maxTurns && maxTurns > 0) {
        turns = turns.slice(-maxTurns);
      }
      return turns.flatMap((turn: any) => turn.findings || []).slice(-5);
    } catch {
      return [];
    }
  }

  /**
   * Build a compact entity context string for the system prompt.
   * Gives Claude awareness of known frames/sessions for drill-down resolution.
   */
  private buildEntityContext(entityStore: any): string | undefined {
    try {
      const stats = entityStore.getStats();
      if (stats.totalEntityCount === 0) return undefined;

      const lines: string[] = [];

      const frames = entityStore.getAllFrames?.() || [];
      if (frames.length > 0) {
        lines.push(`**帧 (${frames.length})**:`);
        for (const f of frames.slice(0, 15)) {
          const parts = [`frame_id=${f.frame_id}`];
          if (f.start_ts) parts.push(`ts=${f.start_ts}`);
          if (f.jank_type) parts.push(`jank=${f.jank_type}`);
          if (f.dur_ms) parts.push(`dur=${f.dur_ms}ms`);
          if (f.process_name) parts.push(`proc=${f.process_name}`);
          lines.push(`- ${parts.join(', ')}`);
        }
        if (frames.length > 15) lines.push(`- ...及其他 ${frames.length - 15} 帧`);
      }

      const sessions = entityStore.getAllSessions?.() || [];
      if (sessions.length > 0) {
        lines.push(`**滑动会话 (${sessions.length})**:`);
        for (const s of sessions.slice(0, 8)) {
          const parts = [`session_id=${s.session_id}`];
          if (s.start_ts) parts.push(`ts=${s.start_ts}`);
          if (s.jank_count) parts.push(`janks=${s.jank_count}`);
          if (s.process_name) parts.push(`proc=${s.process_name}`);
          lines.push(`- ${parts.join(', ')}`);
        }
      }

      return lines.length > 0 ? lines.join('\n') : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Prepare all context needed for a Claude analysis run.
   * Extracts focus app detection, architecture detection, session context,
   * scene classification, MCP server creation, and system prompt building
   * into a single cohesive preparation phase.
   */
  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
  ) {
    // Phase 0: Selection context logging
    if (options.selectionContext) {
      const sc = options.selectionContext;
      const detail = sc.kind === 'area'
        ? `startNs=${sc.startNs}, endNs=${sc.endNs}`
        : `eventId=${sc.eventId}, ts=${sc.ts}`;
      console.log(`[ClaudeRuntime] Selection context received: kind=${sc.kind}, ${detail}`);
    }

    // Phase 0.5: Detect focus apps from trace data
    let effectivePackageName = options.packageName;
    const focusResult = await detectFocusApps(this.traceProcessorService, traceId);

    if (focusResult.primaryApp) {
      if (!effectivePackageName) {
        effectivePackageName = focusResult.primaryApp;
        console.log(`[ClaudeRuntime] Auto-detected focus app: ${effectivePackageName} (via ${focusResult.method})`);
      } else {
        console.log(`[ClaudeRuntime] User-provided packageName: ${effectivePackageName}, also detected: ${focusResult.apps.map(a => a.packageName).join(', ')}`);
      }
      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})` },
        timestamp: Date.now(),
      });
    }

    // Phase 1: Skill executor setup
    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    await ensureSkillRegistryInitialized();
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    // Phase 2: Architecture detection (LRU cached per traceId)
    let architecture = this.architectureCache.get(traceId);
    if (architecture) {
      // LRU touch: delete and re-insert to move to end of Map iteration order
      this.architectureCache.delete(traceId);
      this.architectureCache.set(traceId, architecture);
    } else {
      try {
        const detector = createArchitectureDetector();
        architecture = await detector.detect({
          traceId,
          traceProcessorService: this.traceProcessorService,
          packageName: effectivePackageName,
        });
        if (architecture) {
          this.architectureCache.set(traceId, architecture);
          // LRU eviction: remove oldest entry (first key in Map)
          if (this.architectureCache.size > 50) {
            const firstKey = this.architectureCache.keys().next().value;
            if (firstKey) this.architectureCache.delete(firstKey);
          }
        }
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      } catch (err) {
        console.warn('[ClaudeRuntime] Architecture detection failed:', (err as Error).message);
      }
    }

    // Phase 3: Session context + conversation history
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    // Always include previous context regardless of SDK resume status.
    // When SDK resume succeeds, these add ~200-500 redundant tokens (harmless).
    // When SDK session has expired and resume fails silently, they prevent context loss.
    const previousFindings = this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0
      ? sessionContext.generatePromptContext(2000)
      : undefined;

    // Phase 4: Entity store + entity context for drill-down
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);

    // Phase 5: Scene classification + effort resolution
    const sceneType = classifyScene(query);
    const effectiveEffort = resolveEffort(this.config, sceneType);

    // Phase 5.5: Pattern memory — match similar historical traces (P2-2)
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const patternContext = buildPatternContextSection(traceFeatures);
    const negativePatternContext = buildNegativePatternSection(traceFeatures);

    // Phase 6: Session-scoped artifact store + analysis notes
    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;
    // P2-G21: Load persisted notes from disk if not in memory (survives restart)
    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = loadPersistedNotes(sessionId);
      this.sessionNotes.set(sessionId, notes);
    }

    // Phase 6.5: Session-scoped analysis plan (P0-1: Planning capability)
    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    // P1-G12: Preserve previous plan for cross-turn context before resetting
    const previousPlan = analysisPlan.current ?? undefined;
    analysisPlan.current = null;

    // Phase 6.6: Watchdog feedback ref — shared between runtime watchdog and MCP tools
    const watchdogWarning: { current: string | null } = { current: null };

    // Phase 6.7: Session-scoped hypotheses for hypothesis-verify cycle (P0-G4)
    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    // Reset for new turn (hypotheses are per-turn, resolved within each analysis cycle)
    hypotheses.splice(0);

    // Phase 6.8: Session-scoped uncertainty flags (P1-G1)
    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0); // Reset per turn

    // Phase 7: SQL error tracking for in-context learning
    // Seed new sessions with previously learned fix pairs from disk (cross-session learning)
    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = loadLearnedSqlFixPairs(5);
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    // Phase 8: MCP server with all session-scoped state
    // P2-G1: Destructure to get both server and auto-derived allowedTools
    const { server: mcpServer, allowedTools } = createClaudeMcpServer({
      traceId,
      traceProcessorService: this.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      emitUpdate: (update) => this.emitUpdate(update),
      onSkillResult: (result) => {
        if (result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      recentSqlErrors: sqlErrors,
      analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
    });

    // Phase 9: (removed — skillCatalog was populated but never used in prompt;
    //           Claude uses list_skills MCP tool on demand instead)

    // Phase 10: Knowledge base context (non-fatal — Claude can use lookup_sql_schema tool)
    let knowledgeBaseContext: string | undefined;
    try {
      const kb = await getExtendedKnowledgeBase();
      knowledgeBaseContext = kb.getContextForAI(query, 8);
    } catch {
      // Non-fatal
    }

    // Phase 11: Sub-agent definitions (feature-gated)
    let agents: Record<string, any> | undefined;
    if (this.config.enableSubAgents && sceneType !== 'anr') {
      agents = buildAgentDefinitions(sceneType, {
        architecture,
        packageName: effectivePackageName,
        allowedTools,
      });
    }

    // Phase 12: SQL error-fix pairs for prompt injection
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));

    // Phase 13: System prompt assembly
    const systemPrompt = buildSystemPrompt({
      query,
      architecture,
      packageName: effectivePackageName,
      focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
      focusMethod: focusResult.method,
      previousFindings,
      conversationSummary,
      knowledgeBaseContext,
      entityContext,
      sceneType,
      analysisNotes: notes.length > 0 ? notes : undefined,
      availableAgents: agents ? Object.keys(agents) : undefined,
      sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
      patternContext,
      negativePatternContext,
      previousPlan,
      selectionContext: options.selectionContext,
    });

    return {
      mcpServer,
      systemPrompt,
      effectiveEffort,
      agents,
      sessionContext,
      previousTurns,
      entityStore,
      analysisPlan,
      architecture,
      watchdogWarning,
      hypotheses,
      sceneType,
      allowedTools, // P2-G1: auto-derived from MCP server registration
    };
  }

  private estimateConfidence(findings: Finding[]): number {
    if (findings.length === 0) return 0.3;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }

  /** Capture entities from skill displayResults into EntityStore for multi-turn drill-down. */
  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    try {
      const data: Record<string, any> = {};
      for (const dr of displayResults) {
        if (dr.stepId && dr.data) {
          data[dr.stepId] = dr.data;
        }
      }
      const captured = captureEntitiesFromResponses([{
        agentId: 'claude-agent',
        success: true,
        toolResults: [{ toolName: 'invoke_skill', data }],
      } as any]);
      applyCapturedEntities(entityStore, captured);
    } catch (err) {
      console.warn('[ClaudeRuntime] Entity capture failed:', (err as Error).message);
    }
  }
}
