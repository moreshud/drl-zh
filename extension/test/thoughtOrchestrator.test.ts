import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThoughtOrchestrator, ThoughtEvent } from '../src/thoughtOrchestrator';
import type { LLMProvider, UserConfig } from '../src/providers';
import { DEFAULT_CONFIG } from '../src/providers';
import type { NotebookContext } from '../src/contextTracker';
import {
  THOUGHT_COOLDOWN_MS, AMBIENT_THOUGHT_MIN_IDLE_MS, STUCK_THOUGHT_LLM_TIMEOUT_MS,
} from '../src/constants';

function ctx(overrides: Partial<NotebookContext> = {}): NotebookContext {
  return {
    notebookFile: '03_DQN.ipynb',
    chapterNumber: 3,
    chapterTitle: 'Deep Q-Learning',
    activeCellIndex: 5,
    activeCellContent: '# TODO: implement\nbuf = []',
    activeCellType: 'code',
    isTodoCell: true,
    todoText: 'implement replay',
    lastError: null,
    consecutiveErrors: 0,
    cellRunCount: 0,
    lastInteractionAt: 0,
    focusSummary: '',
    surroundingCells: [],
    ...overrides,
  };
}

interface Harness {
  orchestrator: ThoughtOrchestrator;
  emitted: ThoughtEvent[];
  config: UserConfig;
  cheapProviderSendMessage: ReturnType<typeof vi.fn>;
  setNow: (t: number) => void;
}

function harness(opts: { withCheapLLM?: boolean; cheapResponse?: string | 'timeout' | 'error' } = {}): Harness {
  const emitted: ThoughtEvent[] = [];
  const config: UserConfig = { ...DEFAULT_CONFIG };
  let now = 1_000_000;

  const cheapProviderSendMessage = vi.fn(async (
    _sys: any, _hist: any, _msg: any,
    onChunk: (s: string) => void,
    onDone: () => void,
    onError: (e: Error) => void,
  ) => {
    if (opts.cheapResponse === 'timeout') {
      // Never resolves — orchestrator's timeout fires.
      return new Promise<void>(() => {});
    }
    if (opts.cheapResponse === 'error') {
      onError(new Error('llm down'));
      return;
    }
    onChunk(opts.cheapResponse ?? 'shape mismatch on the value head?');
    onDone();
  });
  const cheapProvider: LLMProvider | null = opts.withCheapLLM ? {
    name: 'CheapMock',
    sendMessage: cheapProviderSendMessage as any,
    cancel: vi.fn(),
  } : null;

  const orchestrator = new ThoughtOrchestrator({
    getConfig: () => config,
    getContext: () => ctx({ consecutiveErrors: 3, lastError: 'NameError: x' }),
    getCheapProvider: () => cheapProvider,
    onThought: (e) => emitted.push(e),
    now: () => now,
    rand: () => 0,
  });

  return {
    orchestrator,
    emitted,
    config,
    cheapProviderSendMessage,
    setNow: (t) => { now = t; },
  };
}

describe('ThoughtOrchestrator', () => {
  describe('static-source signals (no LLM)', () => {
    it('fires once on a static trigger and emits a ThoughtEvent', async () => {
      const h = harness();
      await h.orchestrator.fire('reading');
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].trigger).toBe('reading');
      expect(h.emitted[0].text.length).toBeGreaterThan(0);
      expect(h.emitted[0].ttlMs).toBeGreaterThan(0);
      h.orchestrator.dispose();
    });

    it('soft-idle and idle each fire as their own triggers', async () => {
      const h = harness();
      await h.orchestrator.fire('soft-idle');
      h.setNow(1_000_000 + THOUGHT_COOLDOWN_MS + 1);
      await h.orchestrator.fire('idle');
      expect(h.emitted.map(e => e.trigger)).toEqual(['soft-idle', 'idle']);
      h.orchestrator.dispose();
    });

    it('expandHint defaults to the visible text when the policy doesn\'t override', async () => {
      const h = harness();
      await h.orchestrator.fire('success');
      expect(h.emitted[0].expandHint).toBe(h.emitted[0].text);
      h.orchestrator.dispose();
    });

    it('forwards the policy\'s kind verbatim (reading=callout, others=thought)', async () => {
      // Per-trigger visual register lives in the policy; orchestrator just
      // passes it through. Reading is a callout (warmer); others are
      // thoughts (subtle).
      const h = harness();
      await h.orchestrator.fire('reading');
      expect(h.emitted[0].kind).toBe('callout');

      // Wait past cooldown.
      const newH = harness();
      await newH.orchestrator.fire('idle');
      expect(newH.emitted[0].kind).toBe('thought');

      h.orchestrator.dispose();
      newH.orchestrator.dispose();
    });
  });

  describe('cooldown', () => {
    it('drops a second fire that lands inside the cooldown window', async () => {
      const h = harness();
      await h.orchestrator.fire('reading');
      // No clock advance — second call hits the cooldown gate.
      await h.orchestrator.fire('idle');
      expect(h.emitted).toHaveLength(1);
      h.orchestrator.dispose();
    });

    it('allows a second fire after the cooldown elapses', async () => {
      const h = harness();
      await h.orchestrator.fire('reading');
      h.setNow(1_000_000 + THOUGHT_COOLDOWN_MS + 100);
      await h.orchestrator.fire('idle');
      expect(h.emitted).toHaveLength(2);
      h.orchestrator.dispose();
    });
  });

  describe('suppression', () => {
    it('drops fires when companionEnabled is false', async () => {
      const h = harness();
      h.config.companionEnabled = false;
      await h.orchestrator.fire('reading');
      expect(h.emitted).toHaveLength(0);
      h.orchestrator.dispose();
    });

  });

  describe('LLM-source `stuck` thoughts', () => {
    it('uses the cheap-LLM phrasing when available', async () => {
      const h = harness({ withCheapLLM: true, cheapResponse: 'shape-mismatch on the value head?' });
      await h.orchestrator.fire('stuck');
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].text).toBe('shape-mismatch on the value head?');
      expect(h.cheapProviderSendMessage).toHaveBeenCalled();
      h.orchestrator.dispose();
    });

    it('falls back to the policy\'s static line when no cheap provider is configured', async () => {
      const h = harness({ withCheapLLM: false });
      await h.orchestrator.fire('stuck');
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].text.toLowerCase()).toMatch(/dig|error/);
      h.orchestrator.dispose();
    });

    it('falls back when the cheap LLM errors', async () => {
      const h = harness({ withCheapLLM: true, cheapResponse: 'error' });
      await h.orchestrator.fire('stuck');
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].text.toLowerCase()).toMatch(/dig|error/);
      h.orchestrator.dispose();
    });

    it('strips wrapping quotes that the LLM occasionally adds', async () => {
      const h = harness({ withCheapLLM: true, cheapResponse: '"value-head shape mismatch?"' });
      await h.orchestrator.fire('stuck');
      expect(h.emitted[0].text).toBe('value-head shape mismatch?');
      h.orchestrator.dispose();
    });

    it('clamps an over-long LLM line to a sensible length', async () => {
      const h = harness({ withCheapLLM: true, cheapResponse: 'a'.repeat(500) });
      await h.orchestrator.fire('stuck');
      expect(h.emitted[0].text.length).toBeLessThanOrEqual(110);
      h.orchestrator.dispose();
    });
  });

  describe('LLM timeout (uses fake timers)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('falls back when the LLM call exceeds the timeout', async () => {
      const h = harness({ withCheapLLM: true, cheapResponse: 'timeout' });
      const firePromise = h.orchestrator.fire('stuck');
      await vi.advanceTimersByTimeAsync(STUCK_THOUGHT_LLM_TIMEOUT_MS + 100);
      await firePromise;
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].text.toLowerCase()).toMatch(/dig|error/);
      h.orchestrator.dispose();
    });
  });

  describe('ambient timer (uses fake timers)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('fires an ambient thought after the idle threshold elapses', async () => {
      const h = harness();
      h.setNow(1_000_000 + AMBIENT_THOUGHT_MIN_IDLE_MS + 100);
      await vi.advanceTimersByTimeAsync(AMBIENT_THOUGHT_MIN_IDLE_MS + 100);
      const ambient = h.emitted.find(e => e.trigger === 'ambient');
      expect(ambient).toBeDefined();
      h.orchestrator.dispose();
    });

    it('notifyActivity() resets the ambient timer (no fire if reset before threshold)', async () => {
      const h = harness();
      await vi.advanceTimersByTimeAsync(AMBIENT_THOUGHT_MIN_IDLE_MS / 2);
      h.setNow(1_000_000 + AMBIENT_THOUGHT_MIN_IDLE_MS / 2);
      h.orchestrator.notifyActivity();
      // Then advance another quarter — still well short of threshold.
      await vi.advanceTimersByTimeAsync(AMBIENT_THOUGHT_MIN_IDLE_MS / 4);
      const ambient = h.emitted.find(e => e.trigger === 'ambient');
      expect(ambient).toBeUndefined();
      h.orchestrator.dispose();
    });
  });
});
