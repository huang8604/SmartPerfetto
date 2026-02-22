import { RuntimeModeExecutor } from '../runtimeModeExecutor';
import type { RuntimeModeHandler } from '../runtimeModeContracts';

describe('RuntimeModeExecutor', () => {
  const baseContext = {
    decisionContext: {
      mode: 'initial',
    },
  } as any;

  it('dispatches to the first handler that supports the current mode', async () => {
    const calls: string[] = [];

    const clarifyHandler: RuntimeModeHandler = {
      supports: mode => mode === 'clarify',
      execute: async () => {
        calls.push('clarify');
        return {
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'clarify',
          confidence: 1,
          rounds: 1,
          totalDurationMs: 1,
        };
      },
    };

    const initialHandler: RuntimeModeHandler = {
      supports: mode => mode === 'initial',
      execute: async () => {
        calls.push('initial');
        return {
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'initial',
          confidence: 1,
          rounds: 1,
          totalDurationMs: 1,
        };
      },
    };

    const executor = new RuntimeModeExecutor({
      handlers: [clarifyHandler, initialHandler],
    });

    const result = await executor.execute(
      {
        ...baseContext,
        decisionContext: { mode: 'clarify' },
      } as any,
      'q',
      's1',
      't1'
    );

    expect(result.conclusion).toBe('clarify');
    expect(calls).toEqual(['clarify']);
  });

  it('falls back to initial handler when mode has no direct match', async () => {
    const calls: string[] = [];

    const initialHandler: RuntimeModeHandler = {
      supports: mode => mode === 'initial',
      execute: async () => {
        calls.push('initial');
        return {
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'initial-fallback',
          confidence: 1,
          rounds: 1,
          totalDurationMs: 1,
        };
      },
    };

    const executor = new RuntimeModeExecutor({
      handlers: [initialHandler],
    });

    const result = await executor.execute(
      {
        ...baseContext,
        decisionContext: { mode: 'unknown_mode' },
      } as any,
      'q',
      's1',
      't1'
    );

    expect(result.conclusion).toBe('initial-fallback');
    expect(calls).toEqual(['initial']);
  });

  it('throws when no handler can process the mode', async () => {
    const clarifyHandler: RuntimeModeHandler = {
      supports: mode => mode === 'clarify',
      execute: async () => ({
        sessionId: 's1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'clarify',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      }),
    };

    const executor = new RuntimeModeExecutor({
      handlers: [clarifyHandler],
    });

    await expect(
      executor.execute(
        {
          ...baseContext,
          decisionContext: { mode: 'unknown_mode' },
        } as any,
        'q',
        's1',
        't1'
      )
    ).rejects.toThrow('No runtime mode handler registered for mode: unknown_mode');
  });

  it('supports runtime registration with prepend priority', async () => {
    const calls: string[] = [];

    const initialDefault: RuntimeModeHandler = {
      supports: mode => mode === 'initial',
      execute: async () => {
        calls.push('default');
        return {
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'default',
          confidence: 1,
          rounds: 1,
          totalDurationMs: 1,
        };
      },
    };

    const initialOverride: RuntimeModeHandler = {
      supports: mode => mode === 'initial',
      execute: async () => {
        calls.push('override');
        return {
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'override',
          confidence: 1,
          rounds: 1,
          totalDurationMs: 1,
        };
      },
    };

    const executor = new RuntimeModeExecutor({
      handlers: [initialDefault],
    });
    executor.registerHandler(initialOverride, { prepend: true });

    const result = await executor.execute(
      {
        ...baseContext,
        decisionContext: { mode: 'initial' },
      } as any,
      'q',
      's1',
      't1'
    );

    expect(result.conclusion).toBe('override');
    expect(calls).toEqual(['override']);
  });
});
