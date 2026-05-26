import { describe, it, expect } from 'vitest';
import { pickThought, buildStuckThoughtPrompt, ThoughtTrigger } from '../src/thoughtPolicy';
import type { NotebookContext } from '../src/contextTracker';

function ctx(overrides: Partial<NotebookContext> = {}): NotebookContext {
  return {
    notebookFile: '03_DQN.ipynb',
    chapterNumber: 3,
    chapterTitle: 'Deep Q-Learning',
    activeCellIndex: 5,
    activeCellContent: '# TODO: implement replay buffer\nbuf = []',
    activeCellType: 'code',
    isTodoCell: true,
    todoText: 'implement replay buffer',
    lastError: null,
    consecutiveErrors: 0,
    cellRunCount: 0,
    lastInteractionAt: 0,
    focusSummary: '',
    surroundingCells: [],
    ...overrides,
  };
}

// Deterministic rand — always returns the same low value so we pick the
// first item in each pool. Lets us assert exact text per trigger.
const rand0 = () => 0;

describe('pickThought', () => {
  describe('static-source triggers (no LLM)', () => {
    it('reading → asks if Zee should unpack the section, marked as a callout', () => {
      // Reading is the one trigger we render as a callout (warmer, more
      // attentive) — the student is RECEPTIVE to a "delve deeper" offer
      // when they're stopped on theory, so it's worth pulling some
      // attention. Other static triggers stay as plain thoughts.
      const t = pickThought('reading', ctx({ activeCellType: 'markdown' }), rand0);
      expect(t.source).toBe('static');
      expect(t.kind).toBe('callout');
      expect(t.text.toLowerCase()).toContain('unpack');
    });

    it('non-reading static triggers default to "thought" (subtle, easy to ignore)', () => {
      // The kind field is optional; absence means thought (default in the
      // orchestrator). All these triggers should leave it unset OR set to
      // "thought" — definitely not callout.
      for (const tr of ['idle', 'success', 'soft-idle', 'ambient'] as const) {
        const t = pickThought(tr, ctx(), rand0);
        expect(t.kind ?? 'thought').toBe('thought');
      }
    });

    it('idle on a TODO without a known solution → "where to start" pool', () => {
      const t = pickThought('idle', ctx({ solutionHint: undefined }), rand0);
      expect(t.source).toBe('static');
      expect(t.text.toLowerCase()).toMatch(/start|nudge|hint/);
    });

    it('idle on a TODO that HAS a reference solution → softer "this one\'s fiddly" pool', () => {
      // The student is sitting on a known-tricky TODO; we want a different
      // framing than the generic "where to start?" — gentler.
      const t = pickThought('idle', ctx({ solutionHint: 'def replay():...' }), rand0);
      expect(t.text.toLowerCase()).toMatch(/fiddly|approaches/);
    });

    it('success → celebrates briefly', () => {
      const t = pickThought('success', ctx(), rand0);
      expect(t.text.toLowerCase()).toMatch(/works|nice|solid|running/);
    });

    it('soft-idle in meta mode → "still here, ping me" bucket', () => {
      const t = pickThought('soft-idle', ctx({ notebookFile: null }), rand0);
      expect(t.text.toLowerCase()).toMatch(/still here|chapter|whenever/);
    });

    it('soft-idle with a recent error → afterError bucket', () => {
      const t = pickThought('soft-idle', ctx({ lastError: 'NameError' }), rand0);
      expect(t.text.toLowerCase()).toMatch(/traceback|error|chewing/);
    });

    it('soft-idle on markdown → reading bucket', () => {
      const t = pickThought('soft-idle', ctx({ activeCellType: 'markdown' }), rand0);
      expect(t.text.toLowerCase()).toMatch(/take your time|reading|fuzzy/);
    });

    it('soft-idle on code with no error → coding bucket', () => {
      const t = pickThought('soft-idle', ctx({ activeCellType: 'code', lastError: null }), rand0);
      expect(t.text.toLowerCase()).toMatch(/thinking|pressure|bounce/);
    });

    it('ambient on a TODO cell uses the TODO-flavored pool', () => {
      const t = pickThought('ambient', ctx({ isTodoCell: true }), rand0);
      expect(t.text.toLowerCase()).toMatch(/todo|hint|approach/);
    });

    it('ambient elsewhere uses the generic pool', () => {
      const t = pickThought('ambient', ctx({ isTodoCell: false }), rand0);
      expect(t.text.toLowerCase()).toMatch(/wondering|curious|connect|frame/);
    });
  });

  describe('LLM-source triggers', () => {
    it('stuck returns source=llm with a fallback line and expand hint', () => {
      // The actual phrasing comes from the cheap-LLM call (orchestrator's
      // job); pickThought just supplies a safe fallback in case the call
      // fails or hasn't returned yet.
      const t = pickThought('stuck', ctx({ consecutiveErrors: 3, lastError: 'NameError' }), rand0);
      expect(t.source).toBe('llm');
      expect(t.text.length).toBeGreaterThan(0);
      expect(t.expandHint).toBeTruthy();
    });
  });

  describe('rand-driven variety', () => {
    it('using rand=0.99 picks the LAST entry in a pool, proving rotation works', () => {
      const t1 = pickThought('reading', ctx(), () => 0);
      const t2 = pickThought('reading', ctx(), () => 0.99);
      expect(t1.text).not.toBe(t2.text);
    });
  });
});

describe('buildStuckThoughtPrompt', () => {
  it('packs the cell tail + recent error + error count into the user prompt', () => {
    const c = ctx({
      activeCellContent: 'def replay():\n    return None  # broken',
      lastError: 'TypeError: unhashable type',
      consecutiveErrors: 4,
    });
    const { system, user } = buildStuckThoughtPrompt(c);
    expect(system.toLowerCase()).toContain('thought');
    expect(system).toMatch(/≤\s*90/);
    expect(user).toContain('TypeError: unhashable type');
    expect(user).toContain('Consecutive errors: 4');
    expect(user).toContain('# broken');
  });

  it('truncates very long cell content (only the tail matters for the error)', () => {
    const c = ctx({ activeCellContent: 'x'.repeat(5000) + '\nLATE_MARK' });
    const { user } = buildStuckThoughtPrompt(c);
    expect(user).toContain('LATE_MARK');
    // Keep the prompt cheap — should be well under the raw 5000 chars.
    expect(user.length).toBeLessThan(2000);
  });
});
