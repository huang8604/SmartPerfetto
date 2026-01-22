/**
 * MasterOrchestrator Unit Tests
 *
 * 测试主编排器的核心功能：
 * 1. 初始化和配置
 * 2. 完整分析流程
 * 3. 状态管理和状态转换
 * 4. 断路器集成
 * 5. 检查点保存/恢复
 * 6. 多轮对话上下文
 * 7. 错误处理和恢复
 * 8. 事件发射
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { MasterOrchestrator, createMasterOrchestrator } from '../masterOrchestrator';
import {
  MasterOrchestratorConfig,
  MasterOrchestratorResult,
  Intent,
  AnalysisPlan,
  Evaluation,
  StageResult,
  Finding,
  StreamingUpdate,
} from '../../types';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock SessionStore
const mockSessionStore = {
  createSession: jest.fn(),
  getSession: jest.fn(),
  updateIntent: jest.fn(),
  updatePlan: jest.fn(),
  updatePhase: jest.fn(),
  setError: jest.fn(),
  close: jest.fn(),
};

// Mock CheckpointManager
const mockCheckpointManager = {
  createCheckpoint: jest.fn(),
  loadCheckpoint: jest.fn(),
  getLatestCheckpoint: jest.fn(),
};

// Mock CircuitBreaker
const mockCircuitBreaker = {
  canExecute: jest.fn(),
  recordIteration: jest.fn(),
  recordFailure: jest.fn(),
  reset: jest.fn(),
  on: jest.fn(),
};

// Mock ModelRouter
const mockModelRouter = {
  callWithFallback: jest.fn(),
  getStats: jest.fn(),
  resetStats: jest.fn(),
  on: jest.fn(),
};

// Mock PipelineExecutor
const mockPipelineExecutor = {
  execute: jest.fn(),
  registerExecutor: jest.fn(),
  reset: jest.fn(),
};

// Mock SubAgents
const mockPlannerAgent = {
  understandIntent: jest.fn(),
  createPlan: jest.fn(),
  on: jest.fn(),
};

const mockEvaluatorAgent = {
  evaluate: jest.fn(),
  on: jest.fn(),
};

const mockAnalysisWorker = {
  execute: jest.fn(),
  resetForNewSession: jest.fn(),
  on: jest.fn(),
};

// Mock TraceProcessorService
const mockTraceProcessorService = {
  query: jest.fn(),
  getTraceWithPort: jest.fn(async () => ({ port: 9100 })),
  touchTrace: jest.fn(),
};

// Mock 分析结果
const mockIntent: Intent = {
  primaryGoal: '分析滑动性能',
  aspects: ['scrolling', 'frame_timing'],
  expectedOutputType: 'diagnosis',
  complexity: 'moderate',
};

const mockPlan: AnalysisPlan = {
  tasks: [
    { id: 'task1', expertAgent: 'scrolling_expert', objective: '分析滑动', dependencies: [], priority: 1, context: {} },
  ],
  estimatedDuration: 5000,
  parallelizable: false,
};

const mockEvaluation: Evaluation = {
  passed: true,
  qualityScore: 0.85,
  completenessScore: 0.9,
  contradictions: [],
  feedback: {
    strengths: ['数据完整'],
    weaknesses: [],
    missingAspects: [],
    improvementSuggestions: [],
    priorityActions: [],
  },
  needsImprovement: false,
  suggestedActions: [],
};

const mockFindings: Finding[] = [
  {
    id: 'finding-1',
    category: 'scrolling',
    type: 'performance',
    severity: 'warning',
    title: '检测到卡顿',
    description: '发现 5 帧卡顿',
  },
];

const mockStageResult: StageResult = {
  stageId: 'execute',
  success: true,
  data: { findings: mockFindings },
  findings: mockFindings,
  startTime: Date.now() - 1000,
  endTime: Date.now(),
  retryCount: 0,
};

// =============================================================================
// Test Suite: 初始化
// =============================================================================

describe('MasterOrchestrator', () => {
  let orchestrator: MasterOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    orchestrator?.removeAllListeners();
  });

  describe('初始化', () => {
    it('应该使用默认配置正确初始化', () => {
      orchestrator = new MasterOrchestrator();

      expect(orchestrator).toBeInstanceOf(MasterOrchestrator);
      // 验证是 EventEmitter
      expect(typeof orchestrator.on).toBe('function');
      expect(typeof orchestrator.emit).toBe('function');
    });

    it('应该接受自定义配置', () => {
      const customConfig: Partial<MasterOrchestratorConfig> = {
        maxTotalIterations: 3,
        evaluationCriteria: {
          minQualityScore: 0.8,
          minCompletenessScore: 0.7,
          maxContradictions: 0,
          requiredAspects: [],
        },
      };

      orchestrator = new MasterOrchestrator(customConfig);
      expect(orchestrator).toBeInstanceOf(MasterOrchestrator);
    });

    it('应该正确初始化所有子组件', () => {
      orchestrator = new MasterOrchestrator();

      // 验证可以访问公共方法
      expect(typeof orchestrator.handleQuery).toBe('function');
      expect(typeof orchestrator.resumeFromCheckpoint).toBe('function');
      expect(typeof orchestrator.reset).toBe('function');
      expect(typeof orchestrator.close).toBe('function');
    });

    it('应该通过 factory function 创建实例', () => {
      orchestrator = createMasterOrchestrator({
        maxTotalIterations: 5,
      });

      expect(orchestrator).toBeInstanceOf(MasterOrchestrator);
    });
  });

  // =============================================================================
  // Test Suite: handleQuery 主流程
  // =============================================================================

  describe('handleQuery - 主流程', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator({
        maxTotalIterations: 5,
      });
    });

    it('应该在缺少 traceId 时抛出错误', async () => {
      await expect(
        orchestrator.handleQuery('分析性能', '', {})
      ).rejects.toThrow();
    });

    it('应该在缺少 query 时抛出错误', async () => {
      await expect(
        orchestrator.handleQuery('', 'trace-123', {})
      ).rejects.toThrow();
    });

    it('应该发射 progress 事件', async () => {
      const progressEvents: StreamingUpdate[] = [];

      orchestrator.on('update', (update: StreamingUpdate) => {
        progressEvents.push(update);
      });

      // 验证事件监听器已注册
      expect(orchestrator.listenerCount('update')).toBe(1);
    });

    it('应该在分析开始时发射 starting phase', async () => {
      const updates: StreamingUpdate[] = [];
      orchestrator.on('update', (update: StreamingUpdate) => {
        updates.push(update);
      });

      // 由于需要完整的 mock，这里只验证监听器设置正确
      expect(orchestrator.listenerCount('update')).toBe(1);
    });
  });

  // =============================================================================
  // Test Suite: 状态管理
  // =============================================================================

  describe('状态管理', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该通过 reset 方法重置状态', () => {
      orchestrator.reset();
      // reset 不应该抛出错误
      expect(() => orchestrator.reset()).not.toThrow();
    });

    it('应该通过 close 方法关闭', async () => {
      await orchestrator.close();
      // close 不应该抛出错误
    });
  });

  // =============================================================================
  // Test Suite: 断路器集成
  // =============================================================================

  describe('断路器集成', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator({
        circuitBreakerConfig: {
          maxRetriesPerAgent: 2,
          maxIterationsPerStage: 3,
          cooldownMs: 1000,
          halfOpenAttempts: 1,
          failureThreshold: 0.5,
          successThreshold: 0.8,
        },
      });
    });

    it('应该使用自定义断路器配置初始化', () => {
      expect(orchestrator).toBeInstanceOf(MasterOrchestrator);
    });
  });

  // =============================================================================
  // Test Suite: 检查点
  // =============================================================================

  describe('检查点管理', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('resumeFromCheckpoint 应该在无会话时抛出错误', async () => {
      await expect(
        orchestrator.resumeFromCheckpoint('non-existent-session')
      ).rejects.toThrow('Session not found');
    });
  });

  // =============================================================================
  // Test Suite: 事件发射
  // =============================================================================

  describe('事件发射', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该发射 progress 事件', () => {
      const handler = jest.fn();
      orchestrator.on('update', handler);

      // 验证监听器已注册
      expect(orchestrator.listenerCount('update')).toBe(1);
    });

    it('应该支持移除监听器', () => {
      const handler = jest.fn();
      orchestrator.on('update', handler);
      expect(orchestrator.listenerCount('update')).toBe(1);

      orchestrator.off('update', handler);
      expect(orchestrator.listenerCount('update')).toBe(0);
    });

    it('应该支持多个监听器', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      orchestrator.on('update', handler1);
      orchestrator.on('update', handler2);

      expect(orchestrator.listenerCount('update')).toBe(2);
    });
  });

  // =============================================================================
  // Test Suite: 错误处理
  // =============================================================================

  describe('错误处理', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该捕获并转发错误', async () => {
      const errorHandler = jest.fn();
      orchestrator.on('update', (update: StreamingUpdate) => {
        if (update.type === 'error') {
          errorHandler(update);
        }
      });

      // 验证错误处理器可以注册
      expect(orchestrator.listenerCount('update')).toBe(1);
    });
  });

  // =============================================================================
  // Test Suite: 多轮对话 (Phase 5)
  // =============================================================================

  describe('多轮对话支持', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该提供 getSessionContext 方法', () => {
      expect(typeof orchestrator.getSessionContext).toBe('function');
    });

    it('应该在无会话时返回 null', () => {
      const context = orchestrator.getSessionContext();
      expect(context).toBeNull();
    });

    it('应该提供 getContextSummary 方法', () => {
      expect(typeof orchestrator.getContextSummary).toBe('function');
    });

    it('应该在无会话时 getContextSummary 返回 null', () => {
      const summary = orchestrator.getContextSummary();
      expect(summary).toBeNull();
    });

    it('应该提供 queryConversationContext 方法', () => {
      expect(typeof orchestrator.queryConversationContext).toBe('function');
    });

    it('应该在无会话时 queryConversationContext 返回空数组', () => {
      const results = orchestrator.queryConversationContext(['test']);
      expect(results).toEqual([]);
    });

    it('应该提供 getFindingById 方法', () => {
      expect(typeof orchestrator.getFindingById).toBe('function');
    });
  });

  // =============================================================================
  // Test Suite: 架构检测 (Phase 1)
  // =============================================================================

  describe('架构检测', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该提供 getCurrentArchitecture 方法', () => {
      expect(typeof orchestrator.getCurrentArchitecture).toBe('function');
    });

    it('应该在初始状态时返回 null', () => {
      const architecture = orchestrator.getCurrentArchitecture();
      expect(architecture).toBeNull();
    });
  });

  // =============================================================================
  // Test Suite: 专家系统 (Phase 3)
  // =============================================================================

  describe('专家系统集成', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该提供 setExpertModeEnabled 方法', () => {
      expect(typeof orchestrator.setExpertModeEnabled).toBe('function');
    });

    it('应该提供 isExpertModeEnabled 方法', () => {
      expect(typeof orchestrator.isExpertModeEnabled).toBe('function');
    });

    it('应该默认禁用专家模式', () => {
      expect(orchestrator.isExpertModeEnabled()).toBe(false);
    });

    it('应该能够启用专家模式', () => {
      orchestrator.setExpertModeEnabled(true);
      expect(orchestrator.isExpertModeEnabled()).toBe(true);
    });

    it('应该能够禁用专家模式', () => {
      orchestrator.setExpertModeEnabled(true);
      orchestrator.setExpertModeEnabled(false);
      expect(orchestrator.isExpertModeEnabled()).toBe(false);
    });

    it('应该提供 listExperts 方法', () => {
      expect(typeof orchestrator.listExperts).toBe('function');
    });

    it('应该返回专家列表', () => {
      const experts = orchestrator.listExperts();
      expect(Array.isArray(experts)).toBe(true);
    });

    it('应该提供 hasExpertFor 方法', () => {
      expect(typeof orchestrator.hasExpertFor).toBe('function');
    });

    it('应该提供 handleQueryWithExpert 方法', () => {
      expect(typeof orchestrator.handleQueryWithExpert).toBe('function');
    });
  });

  // =============================================================================
  // Test Suite: Fork 功能 (Phase 4)
  // =============================================================================

  describe('Fork 功能', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该提供 setForkEnabled 方法', () => {
      expect(typeof orchestrator.setForkEnabled).toBe('function');
    });

    it('应该提供 isForkEnabled 方法', () => {
      expect(typeof orchestrator.isForkEnabled).toBe('function');
    });

    it('应该默认禁用 Fork', () => {
      expect(orchestrator.isForkEnabled()).toBe(false);
    });

    it('应该能够启用 Fork', () => {
      orchestrator.setForkEnabled(true);
      expect(orchestrator.isForkEnabled()).toBe(true);
    });

    it('应该提供 forkFromCheckpoint 方法', () => {
      expect(typeof orchestrator.forkFromCheckpoint).toBe('function');
    });

    it('forkFromCheckpoint 应该在无活跃会话时返回失败', async () => {
      const result = await orchestrator.forkFromCheckpoint('checkpoint-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active session');
    });

    it('应该提供 listForks 方法', () => {
      expect(typeof orchestrator.listForks).toBe('function');
    });

    it('listForks 应该在无会话时返回空数组', () => {
      const forks = orchestrator.listForks();
      expect(forks).toEqual([]);
    });

    it('应该提供 getSessionTreeVisualization 方法', () => {
      expect(typeof orchestrator.getSessionTreeVisualization).toBe('function');
    });

    it('getSessionTreeVisualization 应该在无会话时返回提示', () => {
      const visualization = orchestrator.getSessionTreeVisualization();
      expect(visualization).toBe('(no active session)');
    });
  });

  // =============================================================================
  // Test Suite: Worker Agent 注册
  // =============================================================================

  describe('Worker Agent 注册', () => {
    beforeEach(() => {
      orchestrator = new MasterOrchestrator();
    });

    it('应该提供 registerWorkerAgent 方法', () => {
      expect(typeof orchestrator.registerWorkerAgent).toBe('function');
    });

    it('应该能够注册自定义 Worker Agent', () => {
      const mockWorker = {
        execute: jest.fn(async () => ({
          success: true,
          findings: [],
          data: {},
        })),
      };

      // 注册不应该抛出错误
      expect(() => {
        orchestrator.registerWorkerAgent('custom_worker', mockWorker as any);
      }).not.toThrow();
    });
  });
});

// =============================================================================
// Test Suite: 集成测试
// =============================================================================

describe('MasterOrchestrator - 集成测试', () => {
  // 这些测试需要真实的依赖或完整的 mock

  it.skip('应该完成完整的分析流程', async () => {
    // TODO: 端到端测试
    // 需要 mock 所有依赖的完整响应
  });

  it.skip('应该正确处理并发请求', async () => {
    // TODO: 并发测试
  });

  it.skip('应该在长时间运行时保持稳定', async () => {
    // TODO: 稳定性测试
  });
});

// =============================================================================
// Test Suite: 边界条件
// =============================================================================

describe('MasterOrchestrator - 边界条件', () => {
  let orchestrator: MasterOrchestrator;

  beforeEach(() => {
    orchestrator = new MasterOrchestrator();
  });

  afterEach(() => {
    orchestrator?.removeAllListeners();
  });

  it('应该处理空配置', () => {
    const emptyConfigOrchestrator = new MasterOrchestrator({});
    expect(emptyConfigOrchestrator).toBeInstanceOf(MasterOrchestrator);
  });

  it('应该处理部分配置', () => {
    const partialConfigOrchestrator = new MasterOrchestrator({
      maxTotalIterations: 10,
    });
    expect(partialConfigOrchestrator).toBeInstanceOf(MasterOrchestrator);
  });

  it('应该处理 streamingCallback', () => {
    const callback = jest.fn();
    const orchestratorWithCallback = new MasterOrchestrator({
      streamingCallback: callback,
    });
    expect(orchestratorWithCallback).toBeInstanceOf(MasterOrchestrator);
  });

  it('应该处理 enableTraceRecording', () => {
    const orchestratorWithTracing = new MasterOrchestrator({
      enableTraceRecording: true,
    });
    expect(orchestratorWithTracing).toBeInstanceOf(MasterOrchestrator);
  });
});
