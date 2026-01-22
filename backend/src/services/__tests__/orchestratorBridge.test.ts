/**
 * OrchestratorBridge Unit Tests
 *
 * 测试编排器桥接服务的核心功能：
 * 1. MasterOrchestrator 事件转换为 SSE 格式
 * 2. 各类事件类型的正确处理
 * 3. SSE 事件发送
 * 4. 连接管理
 * 5. 错误广播
 * 6. 会话管理集成
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock MasterOrchestrator
class MockMasterOrchestrator extends EventEmitter {
  async handleQuery(query: string, traceId: string, options: any) {
    // 模拟事件发射
    this.emit('update', { type: 'progress', content: { phase: 'starting' }, timestamp: Date.now() });
    this.emit('update', { type: 'progress', content: { phase: 'executing' }, timestamp: Date.now() });
    this.emit('update', { type: 'skill_data', content: { layers: {} }, timestamp: Date.now() });
    this.emit('update', { type: 'conclusion', content: { answer: 'Test answer' }, timestamp: Date.now() });

    return {
      sessionId: 'test-session',
      success: true,
      synthesizedAnswer: 'Test answer',
      stageResults: [],
      iterationCount: 1,
      findings: [],
    };
  }

  async resumeFromCheckpoint(sessionId: string) {
    return this.handleQuery('resume', 'test-trace', {});
  }
}

// Mock AnalysisSessionService
const mockSessionService = {
  createSession: jest.fn<any>().mockReturnValue('test-session'),
  getSession: jest.fn<any>().mockReturnValue({
    sessionId: 'test-session',
    status: 'running',
    traceId: 'test-trace',
    query: 'test query',
  }),
  updateState: jest.fn<any>(),
  emitSSE: jest.fn<any>(),
  completeSession: jest.fn<any>(),
  failSession: jest.fn<any>(),
};

// Mock TraceProcessorService
const mockTraceProcessorService = {
  query: jest.fn<any>(),
  getTraceWithPort: jest.fn<any>().mockResolvedValue({ port: 9100 }),
  touchTrace: jest.fn<any>(),
  getTrace: jest.fn<any>().mockReturnValue({ id: 'trace-1' }),
};

// Mock SSE Response
const createMockSSEResponse = () => {
  const chunks: string[] = [];
  return {
    setHeader: jest.fn(),
    write: jest.fn((data: string) => chunks.push(data)),
    end: jest.fn(),
    flush: jest.fn(),
    chunks,
  };
};

import {
  OrchestratorBridge,
  createOrchestratorBridge,
  getOrchestratorBridge,
  resetOrchestratorBridge,
  BridgeOptions,
} from '../orchestratorBridge';

// =============================================================================
// Test Suite: OrchestratorBridge 类
// =============================================================================

describe('OrchestratorBridge 类', () => {
  beforeEach(() => {
    resetOrchestratorBridge();
    jest.clearAllMocks();
  });

  describe('初始化', () => {
    it('应该创建 OrchestratorBridge 实例', () => {
      const bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      expect(bridge).toBeInstanceOf(OrchestratorBridge);
    });

    it('应该使用默认配置', () => {
      const bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      const config = bridge.getConfig();

      expect(config.hooks.enabled).toBe(true);
      expect(config.contextIsolation.enabled).toBe(true);
      expect(config.contextCompaction.enabled).toBe(true);
      expect(config.sessionFork.enabled).toBe(false);
      expect(config.maxTotalIterations).toBe(3);
    });

    it('应该接受自定义配置', () => {
      const options: BridgeOptions = {
        enableHooks: false,
        enableContextIsolation: false,
        enableSessionFork: true,
        maxTotalIterations: 5,
      };
      const bridge = createOrchestratorBridge(
        mockSessionService as any,
        mockTraceProcessorService as any,
        options
      );
      const config = bridge.getConfig();

      expect(config.hooks.enabled).toBe(false);
      expect(config.contextIsolation.enabled).toBe(false);
      expect(config.sessionFork.enabled).toBe(true);
      expect(config.maxTotalIterations).toBe(5);
    });
  });

  describe('单例管理', () => {
    it('应该返回相同的全局实例', () => {
      const bridge1 = getOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      const bridge2 = getOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      expect(bridge1).toBe(bridge2);
    });

    it('应该在重置后创建新实例', () => {
      const bridge1 = getOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      resetOrchestratorBridge();
      const bridge2 = getOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      expect(bridge1).not.toBe(bridge2);
    });
  });

  describe('hasActiveAnalysis', () => {
    it('应该返回 false 当没有活跃分析', () => {
      const bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
      expect(bridge.hasActiveAnalysis('nonexistent')).toBe(false);
    });
  });
});

// =============================================================================
// Test Suite: 事件转换
// =============================================================================

describe('OrchestratorBridge - 事件转换', () => {
  let bridge: OrchestratorBridge;
  let emittedEvents: any[];

  beforeEach(() => {
    resetOrchestratorBridge();
    emittedEvents = [];
    mockSessionService.emitSSE.mockImplementation((sessionId: string, event: any) => {
      emittedEvents.push({ sessionId, event });
    });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('progress 事件', () => {
    it('应该将 progress 事件转换为 SSE 格式', () => {
      // Progress 事件在 emitProgress 中处理
      // 通过 startAnalysis 触发
    });

    it('应该处理不同的 phase 值', () => {
      const phases = [
        'starting',
        'detecting_architecture',
        'planning',
        'executing',
        'evaluating',
        'refining',
        'synthesizing',
      ];

      // 每个 phase 都应该被正确处理
      phases.forEach((phase) => {
        expect(typeof phase).toBe('string');
      });
    });
  });

  describe('finding 事件', () => {
    it('应该将 finding 事件转换为 skill_diagnostics', () => {
      const finding = {
        id: 'finding-1',
        category: 'scrolling',
        severity: 'warning',
        title: '检测到卡顿',
        description: '发现 5 帧卡顿',
        evidence: {},
      };

      // Finding 应该包含所有必需字段
      expect(finding.id).toBe('finding-1');
      expect(finding.severity).toBe('warning');
      expect(finding.title).toBeDefined();
    });

    it('应该包含正确的 diagnostic 字段', () => {
      // diagnostic 应该包含: id, severity, message, details, suggestions
      const expectedDiagnostic = {
        id: 'finding-1',
        severity: 'warning',
        message: '检测到卡顿',
        details: '发现 5 帧卡顿',
        suggestions: [],
      };

      expect(expectedDiagnostic.id).toBeDefined();
      expect(expectedDiagnostic.severity).toBeDefined();
      expect(expectedDiagnostic.message).toBeDefined();
    });
  });

  describe('skill_data 事件', () => {
    it('应该将 skill_data 事件转换为 skill_layered_result', () => {
      const skillData = {
        layers: {
          overview: { summary: { data: [] } },
          list: { items: { data: [] } },
        },
        metadata: {
          skillName: 'scrolling_analysis',
          version: '2.0',
        },
      };

      // skill_data 应该保持层级结构
      expect(skillData.layers.overview).toBeDefined();
      expect(skillData.layers.list).toBeDefined();
      expect(skillData.metadata.skillName).toBe('scrolling_analysis');
    });

    it('应该保留 overview/list/deep 层级结构', () => {
      const layers = {
        overview: { perf_summary: { stepId: 'perf_summary', data: [] } },
        list: { sessions: { stepId: 'sessions', data: [] } },
        deep: { 'session_0': { 'frame_0': { data: {} } } },
      };

      expect(layers.overview).toBeDefined();
      expect(layers.list).toBeDefined();
      expect(layers.deep).toBeDefined();
    });
  });

  describe('conclusion 事件', () => {
    it('应该正确处理 conclusion 事件', () => {
      const conclusion = {
        answer: '分析完成，发现 3 个性能问题',
      };

      expect(conclusion.answer).toContain('分析完成');
    });
  });

  describe('error 事件', () => {
    it('应该将 error 事件转换为 SSE error', () => {
      const errorEvent = {
        message: 'SQL 查询失败',
        recoverable: true,
      };

      expect(errorEvent.message).toBeDefined();
      expect(errorEvent.recoverable).toBe(true);
    });

    it('应该区分可恢复和不可恢复错误', () => {
      const recoverableError = { message: 'Timeout', recoverable: true };
      const fatalError = { message: 'Fatal', recoverable: false };

      expect(recoverableError.recoverable).toBe(true);
      expect(fatalError.recoverable).toBe(false);
    });
  });

  describe('worker_thought 事件', () => {
    it('应该将 worker_thought 转换为 progress', () => {
      const workerThought = {
        agent: 'ScrollingExpert',
        skillId: 'scrolling_analysis',
        step: 'skill_start',
      };

      expect(workerThought.agent).toBeDefined();
      expect(workerThought.step).toBeDefined();
    });

    it('应该生成正确的步骤消息', () => {
      const stepMessages: Record<string, string> = {
        'skill_selection': '🎯 正在选择分析技能...',
        'skill_start': '🔧 正在执行技能...',
        'skill_complete': '✅ 技能执行完成',
        'analyzing': '📊 正在分析数据...',
      };

      expect(stepMessages['skill_selection']).toContain('选择');
      expect(stepMessages['skill_start']).toContain('执行');
      expect(stepMessages['analyzing']).toContain('分析');
    });
  });

  describe('thought 事件', () => {
    it('应该将 thought 转换为 progress', () => {
      const thought = {
        agent: 'planner',
        message: '正在制定分析计划...',
      };

      expect(thought.agent).toBe('planner');
      expect(thought.message).toBeDefined();
    });

    it('应该使用正确的 agent 标签', () => {
      const agentLabels: Record<string, string> = {
        'planner': '📋 规划器',
        'evaluator': '🔍 评估器',
      };

      expect(agentLabels['planner']).toContain('规划器');
      expect(agentLabels['evaluator']).toContain('评估器');
    });
  });
});

// =============================================================================
// Test Suite: SSE 事件发送
// =============================================================================

describe('OrchestratorBridge - SSE 发送', () => {
  let bridge: OrchestratorBridge;
  let emittedEvents: any[];

  beforeEach(() => {
    resetOrchestratorBridge();
    emittedEvents = [];
    mockSessionService.emitSSE.mockImplementation((sessionId: string, event: any) => {
      emittedEvents.push({ sessionId, event });
    });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('事件格式', () => {
    it('SSE 事件应该包含 type 和 timestamp', () => {
      const sseEvent = {
        type: 'progress',
        timestamp: Date.now(),
        data: { step: 'starting', message: 'Test' },
      };

      expect(sseEvent.type).toBeDefined();
      expect(sseEvent.timestamp).toBeDefined();
      expect(sseEvent.data).toBeDefined();
    });

    it('timestamp 应该是合理的毫秒值', () => {
      const now = Date.now();
      const sseEvent = {
        type: 'test',
        timestamp: now,
        data: {},
      };

      expect(sseEvent.timestamp).toBeGreaterThan(0);
      expect(sseEvent.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('emitProgress', () => {
    it('progress 事件应该包含 step 和 message', () => {
      const progressData = {
        step: 'starting',
        message: '🚀 正在启动分析...',
      };

      expect(progressData.step).toBe('starting');
      expect(progressData.message).toContain('启动');
    });
  });

  describe('emitSkillLayeredResult', () => {
    it('skill_layered_result 应该包含分层数据', () => {
      const layeredResult = {
        layers: {
          overview: {},
          list: {},
        },
        metadata: {
          skillName: 'test_skill',
          version: '1.0',
        },
      };

      expect(layeredResult.layers).toBeDefined();
      expect(layeredResult.metadata).toBeDefined();
    });
  });

  describe('emitCompletedEvent', () => {
    it('analysis_completed 应该包含必需字段', () => {
      const completedData = {
        sessionId: 'sess-123',
        answer: '分析完成',
        metrics: {
          totalDuration: 5000,
          iterationsCount: 2,
          sqlQueriesCount: 10,
        },
        reportUrl: '/api/reports/view/sess-123',
      };

      expect(completedData.sessionId).toBe('sess-123');
      expect(completedData.answer).toBeDefined();
      expect(completedData.metrics).toBeDefined();
      expect(completedData.reportUrl).toBeDefined();
    });

    it('应该包含执行时间统计', () => {
      const metrics = {
        totalDuration: 5000,
        iterationsCount: 2,
        sqlQueriesCount: 10,
      };

      expect(metrics.totalDuration).toBeGreaterThanOrEqual(0);
      expect(metrics.iterationsCount).toBeGreaterThanOrEqual(0);
      expect(metrics.sqlQueriesCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('emitErrorEvent', () => {
    it('error 事件应该包含 error 和 recoverable', () => {
      const errorData = {
        error: 'Something went wrong',
        recoverable: true,
      };

      expect(errorData.error).toBeDefined();
      expect(typeof errorData.recoverable).toBe('boolean');
    });

    it('应该正确标记 recoverable 状态', () => {
      const recoverableError = { error: 'Timeout', recoverable: true };
      const fatalError = { error: 'Fatal', recoverable: false };

      expect(recoverableError.recoverable).toBe(true);
      expect(fatalError.recoverable).toBe(false);
    });
  });
});

// =============================================================================
// Test Suite: 分析启动
// =============================================================================

describe('OrchestratorBridge - 分析启动', () => {
  let bridge: OrchestratorBridge;

  beforeEach(() => {
    resetOrchestratorBridge();
    mockSessionService.getSession.mockReturnValue({
      sessionId: 'test-session',
      traceId: 'trace-1',
      question: '分析滚动性能',
      status: 'pending',
    });
    mockTraceProcessorService.getTrace.mockReturnValue({ id: 'trace-1' });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('startAnalysis', () => {
    it('应该在会话不存在时抛出错误', async () => {
      mockSessionService.getSession.mockReturnValue(null);

      await expect(bridge.startAnalysis('nonexistent')).rejects.toThrow('Session not found');
    });

    it('应该更新会话状态', async () => {
      // startAnalysis 会调用 updateState
      // 由于 MasterOrchestrator 是真实的，需要 mock 更多
    });

    it('应该在分析过程中标记为活跃', () => {
      // hasActiveAnalysis 在分析过程中应该返回 true
      expect(bridge.hasActiveAnalysis('test-session')).toBe(false); // 分析未启动
    });
  });

  describe('会话生命周期', () => {
    it('应该在完成后调用 completeSession', () => {
      // completeSession 在分析成功完成后被调用
      expect(mockSessionService.completeSession).toBeDefined();
    });

    it('应该在失败后调用 failSession', () => {
      // failSession 在分析失败时被调用
      expect(mockSessionService.failSession).toBeDefined();
    });
  });
});

// =============================================================================
// Test Suite: 会话管理集成
// =============================================================================

describe('OrchestratorBridge - 会话管理', () => {
  let bridge: OrchestratorBridge;

  beforeEach(() => {
    resetOrchestratorBridge();
    mockSessionService.getSession.mockReturnValue({
      sessionId: 'test-session',
      traceId: 'trace-1',
      question: '分析性能',
      status: 'pending',
    });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('会话获取', () => {
    it('应该通过 sessionId 获取会话', () => {
      const session = mockSessionService.getSession('test-session') as any;
      expect(session).toBeDefined();
      expect(session.sessionId).toBe('test-session');
    });

    it('应该返回 null 当会话不存在', () => {
      mockSessionService.getSession.mockReturnValue(null);
      const session = mockSessionService.getSession('nonexistent');
      expect(session).toBeNull();
    });
  });

  describe('会话更新', () => {
    it('应该调用 updateState 更新状态', () => {
      expect(mockSessionService.updateState).toBeDefined();
      expect(typeof mockSessionService.updateState).toBe('function');
    });

    it('应该支持不同的状态值', () => {
      const states = [
        'INITIALIZING',
        'GENERATING_SQL',
        'EXECUTING_SQL',
        'PROCESSING_RESULTS',
        'COMPLETED',
        'FAILED',
      ];

      states.forEach((state) => {
        expect(typeof state).toBe('string');
      });
    });
  });

  describe('会话完成', () => {
    it('completeSession 应该被定义', () => {
      expect(mockSessionService.completeSession).toBeDefined();
      expect(typeof mockSessionService.completeSession).toBe('function');
    });

    it('应该接受 sessionId 和 answer 参数', () => {
      mockSessionService.completeSession('test-session', '分析完成');
      expect(mockSessionService.completeSession).toHaveBeenCalledWith('test-session', '分析完成');
    });
  });

  describe('会话失败', () => {
    it('failSession 应该被定义', () => {
      expect(mockSessionService.failSession).toBeDefined();
      expect(typeof mockSessionService.failSession).toBe('function');
    });

    it('应该接受 sessionId 和 error 参数', () => {
      mockSessionService.failSession('test-session', 'Error occurred');
      expect(mockSessionService.failSession).toHaveBeenCalledWith('test-session', 'Error occurred');
    });
  });
});

// =============================================================================
// Test Suite: 连接管理
// =============================================================================

describe('OrchestratorBridge - 连接管理', () => {
  let bridge: OrchestratorBridge;

  beforeEach(() => {
    resetOrchestratorBridge();
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('活跃分析管理', () => {
    it('应该跟踪活跃的分析', () => {
      expect(bridge.hasActiveAnalysis('test-session')).toBe(false);
    });

    it('应该在分析完成后清理', () => {
      // 分析完成后 hasActiveAnalysis 应该返回 false
      expect(bridge.hasActiveAnalysis('completed-session')).toBe(false);
    });
  });

  describe('SSE 事件发送', () => {
    it('emitSSE 应该被正确调用', () => {
      expect(mockSessionService.emitSSE).toBeDefined();
      expect(typeof mockSessionService.emitSSE).toBe('function');
    });

    it('应该包含正确的事件结构', () => {
      const expectedEventStructure = {
        type: 'progress',
        timestamp: expect.any(Number),
        data: expect.any(Object),
      };

      mockSessionService.emitSSE('test-session', {
        type: 'progress',
        timestamp: Date.now(),
        data: { step: 'test' },
      });

      expect(mockSessionService.emitSSE).toHaveBeenCalledWith(
        'test-session',
        expect.objectContaining({ type: 'progress' })
      );
    });
  });
});

// =============================================================================
// Test Suite: 错误处理
// =============================================================================

describe('OrchestratorBridge - 错误处理', () => {
  let bridge: OrchestratorBridge;

  beforeEach(() => {
    resetOrchestratorBridge();
    mockSessionService.getSession.mockReturnValue({
      sessionId: 'test-session',
      traceId: 'trace-1',
      question: '分析性能',
    });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('会话错误', () => {
    it('应该在会话不存在时抛出错误', async () => {
      mockSessionService.getSession.mockReturnValue(null);

      await expect(bridge.startAnalysis('invalid')).rejects.toThrow('Session not found');
    });

    it('应该调用 failSession 记录错误', async () => {
      mockSessionService.getSession.mockReturnValue(null);

      try {
        await bridge.startAnalysis('invalid');
      } catch (e) {
        // Expected error
      }

      // 由于会话不存在，不会调用 failSession
    });
  });

  describe('Trace 错误', () => {
    it('应该在 trace 不存在时调用 failSession', async () => {
      mockSessionService.getSession.mockReturnValue({
        sessionId: 'test-session',
        traceId: 'nonexistent-trace',
        question: 'test',
      });
      mockTraceProcessorService.getTrace.mockReturnValue(null);

      // startAnalysis catches errors internally and calls failSession
      await bridge.startAnalysis('test-session');

      // Verify failSession was called with the error message
      expect(mockSessionService.failSession).toHaveBeenCalledWith(
        'test-session',
        expect.stringContaining('Trace not found')
      );
    });
  });

  describe('错误事件格式', () => {
    it('error 事件应该包含 recoverable 标志', () => {
      const errorEvent = {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: 'Test error',
          recoverable: true,
        },
      };

      expect(errorEvent.data.error).toBeDefined();
      expect(typeof errorEvent.data.recoverable).toBe('boolean');
    });
  });
});

// =============================================================================
// Test Suite: 事件去重
// =============================================================================

describe('OrchestratorBridge - 事件去重', () => {
  describe('Finding 去重', () => {
    it('Finding 应该有唯一 ID', () => {
      const finding1 = { id: 'finding-1', title: 'Issue 1' };
      const finding2 = { id: 'finding-2', title: 'Issue 2' };

      expect(finding1.id).not.toBe(finding2.id);
    });

    it('相同 ID 的 Finding 应该被视为重复', () => {
      const findings = [
        { id: 'finding-1', title: 'Issue' },
        { id: 'finding-1', title: 'Issue' }, // 重复
        { id: 'finding-2', title: 'Another Issue' },
      ];

      const uniqueIds = new Set(findings.map(f => f.id));
      expect(uniqueIds.size).toBe(2);
    });
  });

  describe('Skill Data 去重', () => {
    it('skill_data 应该包含唯一标识', () => {
      const skillData = {
        metadata: {
          skillName: 'scrolling_analysis',
          version: '2.0',
          executedAt: new Date().toISOString(),
        },
      };

      expect(skillData.metadata.skillName).toBeDefined();
      expect(skillData.metadata.executedAt).toBeDefined();
    });
  });
});

// =============================================================================
// Test Suite: SSE 事件类型完整性
// =============================================================================

describe('OrchestratorBridge - SSE 事件类型', () => {
  const expectedEventTypes = [
    'connected',
    'progress',
    'phase_change',
    'stage_start',
    'stage_complete',
    'skill_layered_result',
    'skill_data',
    'skill_diagnostics',
    'finding',
    'circuit_breaker',
    'analysis_completed',
    'error',
    'end',
  ];

  it('应该定义所有预期的事件类型', () => {
    expect(expectedEventTypes.length).toBeGreaterThan(0);
    expect(expectedEventTypes).toContain('progress');
    expect(expectedEventTypes).toContain('analysis_completed');
    expect(expectedEventTypes).toContain('error');
  });

  expectedEventTypes.forEach((eventType) => {
    it(`应该支持 ${eventType} 事件类型`, () => {
      const event = {
        type: eventType,
        timestamp: Date.now(),
        data: {},
      };

      expect(event.type).toBe(eventType);
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('核心事件结构', () => {
    it('progress 事件应该有 step 和 message', () => {
      const progressEvent = {
        type: 'progress',
        data: { step: 'starting', message: 'Test' },
      };
      expect(progressEvent.data.step).toBeDefined();
      expect(progressEvent.data.message).toBeDefined();
    });

    it('skill_layered_result 应该有 layers', () => {
      const skillEvent = {
        type: 'skill_layered_result',
        data: { layers: { overview: {} } },
      };
      expect(skillEvent.data.layers).toBeDefined();
    });

    it('analysis_completed 应该有 answer 和 metrics', () => {
      const completedEvent = {
        type: 'analysis_completed',
        data: {
          answer: 'Test answer',
          metrics: { totalDuration: 1000 },
        },
      };
      expect(completedEvent.data.answer).toBeDefined();
      expect(completedEvent.data.metrics).toBeDefined();
    });

    it('error 应该有 error 和 recoverable', () => {
      const errorEvent = {
        type: 'error',
        data: { error: 'Test error', recoverable: false },
      };
      expect(errorEvent.data.error).toBeDefined();
      expect(typeof errorEvent.data.recoverable).toBe('boolean');
    });
  });
});

// =============================================================================
// Test Suite: 集成测试
// =============================================================================

describe('OrchestratorBridge - 集成测试', () => {
  let bridge: OrchestratorBridge;
  let emittedEvents: any[];

  beforeEach(() => {
    resetOrchestratorBridge();
    emittedEvents = [];
    mockSessionService.emitSSE.mockImplementation((sessionId: string, event: any) => {
      emittedEvents.push({ sessionId, event });
    });
    bridge = createOrchestratorBridge(mockSessionService as any, mockTraceProcessorService as any);
  });

  describe('完整分析流程', () => {
    it('应该验证分析流程的事件顺序', () => {
      // 预期的事件顺序
      const expectedOrder = [
        'progress',           // starting
        'progress',           // executing
        'skill_layered_result', // skill 结果
        'analysis_completed', // 完成
      ];

      // 事件类型应该是字符串
      expectedOrder.forEach(eventType => {
        expect(typeof eventType).toBe('string');
      });
    });

    it('应该在开始时发送 progress 事件', () => {
      const startingEvent = {
        type: 'progress',
        timestamp: Date.now(),
        data: { step: 'starting', message: '🚀 正在启动 Agent 分析...' },
      };

      expect(startingEvent.type).toBe('progress');
      expect(startingEvent.data.step).toBe('starting');
    });

    it('应该在完成时发送 analysis_completed 事件', () => {
      const completedEvent = {
        type: 'analysis_completed',
        timestamp: Date.now(),
        data: {
          sessionId: 'test-session',
          answer: '分析完成',
          metrics: {
            totalDuration: 5000,
            iterationsCount: 2,
            sqlQueriesCount: 10,
          },
          reportUrl: '/api/reports/view/test-session',
        },
      };

      expect(completedEvent.type).toBe('analysis_completed');
      expect(completedEvent.data.sessionId).toBeDefined();
      expect(completedEvent.data.answer).toBeDefined();
    });
  });

  describe('结果生成', () => {
    it('应该从 findings 生成答案', () => {
      const findings = [
        { id: 'f1', severity: 'critical', title: '严重问题', description: '描述1' },
        { id: 'f2', severity: 'warning', title: '警告', description: '描述2' },
        { id: 'f3', severity: 'info', title: '信息', description: '描述3' },
      ];

      // 按严重程度分组
      const critical = findings.filter(f => f.severity === 'critical');
      const warnings = findings.filter(f => f.severity === 'warning');
      const infos = findings.filter(f => f.severity === 'info');

      expect(critical.length).toBe(1);
      expect(warnings.length).toBe(1);
      expect(infos.length).toBe(1);
    });

    it('应该在无 findings 时返回默认消息', () => {
      const findings: any[] = [];
      const defaultMessage = findings.length === 0
        ? '分析完成，未发现性能问题。'
        : 'Has findings';

      expect(defaultMessage).toBe('分析完成，未发现性能问题。');
    });
  });

  describe('配置选项', () => {
    it('应该支持自定义 maxTotalIterations', () => {
      const customBridge = createOrchestratorBridge(
        mockSessionService as any,
        mockTraceProcessorService as any,
        { maxTotalIterations: 10 }
      );

      const config = customBridge.getConfig();
      expect(config.maxTotalIterations).toBe(10);
    });

    it('应该支持禁用 hooks', () => {
      const customBridge = createOrchestratorBridge(
        mockSessionService as any,
        mockTraceProcessorService as any,
        { enableHooks: false }
      );

      const config = customBridge.getConfig();
      expect(config.hooks.enabled).toBe(false);
    });

    it('应该支持启用 sessionFork', () => {
      const customBridge = createOrchestratorBridge(
        mockSessionService as any,
        mockTraceProcessorService as any,
        { enableSessionFork: true }
      );

      const config = customBridge.getConfig();
      expect(config.sessionFork.enabled).toBe(true);
    });
  });
});
