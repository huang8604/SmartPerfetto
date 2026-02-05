/**
 * Startup Analysis Skill Evaluation Tests
 *
 * 测试 startup_analysis skill 在已知 trace 文件上的行为
 * 验证关键步骤输出结构是否稳定（避免回归）
 *
 * 注意：skill-eval 使用 SkillExecutor（无 AI service），因此 ai_summary 步骤可能失败；
 * 本文件只验证 SQL/规则步骤的稳定性，不依赖 AI 总结。
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('startup_analysis skill', () => {
  let evaluator: SkillEvaluator;

  const TRACE_FILE = 'app_start_heavy.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('startup_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  describe('L1: Overview Layer', () => {
    describe('get_startups step', () => {
      it('should return startup events list', async () => {
        const result = await evaluator.executeStep('get_startups', { package: '' });

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);

        if (result.data.length > 0) {
          const s = result.data[0];
          expect(s.startup_id).toBeDefined();
          expect(s.package).toBeDefined();
          expect(s.startup_type).toBeDefined();
          expect(s.start_ts).toBeDefined();
          expect(s.end_ts).toBeDefined();
          // dur_ms/ttid_ms/ttfd_ms may be null depending on trace contents, so only basic sanity checks
          if (s.dur_ms !== null && s.dur_ms !== undefined) {
            expect(s.dur_ms).toBeGreaterThanOrEqual(0);
          }
        }
      }, 30000);

      it('should handle non-matching package gracefully', async () => {
        const result = await evaluator.executeStep('get_startups', { package: 'com.nonexistent.package' });

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(0);
      }, 30000);
    });

    describe('startup_breakdown step', () => {
      it('should return breakdown rows when data exists', async () => {
        const result = await evaluator.executeStep('startup_breakdown', { package: '' });

        expect(result.success).toBe(true);

        if (result.data.length > 0) {
          const row = result.data[0];
          expect(row.reason).toBeDefined();
          expect(typeof row.reason).toBe('string');
          expect(row.total_dur_ms).toBeGreaterThanOrEqual(0);
          expect(row.percent).toBeGreaterThanOrEqual(0);
          expect(row.percent).toBeLessThanOrEqual(100);
        }
      }, 30000);
    });
  });

  describe('Full Skill Execution', () => {
    it('should execute complete skill without throwing', async () => {
      const result = await evaluator.executeSkill({ package: '' });

      expect(result.success).toBe(true);
      const overview = result.layers.overview;
      expect(overview).toBeDefined();
      expect(Object.keys(overview || {}).length).toBeGreaterThan(0);
    }, 120000);

    it('should populate deep layer when startups exist', async () => {
      const result = await evaluator.executeSkill({ package: '' });

      expect(result.success).toBe(true);
      const startups = result.layers.overview?.get_startups?.data;
      const startupCount = Array.isArray(startups) ? startups.length : 0;

      if (startupCount > 0) {
        expect(result.layers.deep).toBeDefined();
        expect(Object.keys(result.layers.deep || {}).length).toBeGreaterThan(0);
      }
    }, 120000);
  });
});
