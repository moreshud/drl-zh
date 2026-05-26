import { describe, it, expect } from 'vitest';
import { SIGNAL_OFFERS, pickSoftIdleNudgeLine } from '../src/signalRouter';
import type { NotebookContext } from '../src/contextTracker';

function ctx(overrides: Partial<NotebookContext> = {}): NotebookContext {
  return {
    notebookFile: '03_DQN.ipynb',
    chapterNumber: 3,
    chapterTitle: 'Deep Q-Learning',
    activeCellIndex: 0,
    activeCellContent: '',
    activeCellType: 'code',
    isTodoCell: false,
    todoText: '',
    lastError: null,
    consecutiveErrors: 0,
    cellRunCount: 0,
    lastInteractionAt: 0,
    focusSummary: '',
    surroundingCells: [],
    ...overrides,
  };
}

describe('SIGNAL_OFFERS', () => {
  it('has an entry for every signal type', () => {
    expect(SIGNAL_OFFERS.stuck).toBeDefined();
    expect(SIGNAL_OFFERS.idle).toBeDefined();
    expect(SIGNAL_OFFERS.reading).toBeDefined();
    expect(SIGNAL_OFFERS.success).toBeDefined();
  });

  it('success offer celebrates without re-spilling the solution', () => {
    // Regression guard: the success initiative is the moment after a TODO
    // finally runs clean — Zee should congratulate + nudge forward, not
    // re-explain the fix the student just wrote themselves.
    const offer = SIGNAL_OFFERS.success;
    expect(offer.line.toLowerCase()).toMatch(/nice|worked|next/);
    expect(offer.acceptPrompt.toLowerCase()).toContain('do not repeat the solution');
  });

  it('every offer has both a visible line and an acceptPrompt', () => {
    for (const offer of Object.values(SIGNAL_OFFERS)) {
      expect(offer.line.length).toBeGreaterThan(0);
      expect(offer.acceptPrompt.length).toBeGreaterThan(0);
    }
  });

  it('acceptPrompts instruct the LLM to keep answers short (avoids paragraph walls)', () => {
    for (const offer of Object.values(SIGNAL_OFFERS)) {
      expect(offer.acceptPrompt.toLowerCase()).toMatch(/\b(sentences?|keep|brief|short)\b/);
    }
  });
});

describe('pickSoftIdleNudgeLine', () => {
  it('no notebook → meta bucket', () => {
    const line = pickSoftIdleNudgeLine(ctx({ notebookFile: null }));
    expect(line).toMatch(/(ping me|start|pick|dive)/i);
  });

  it('notebook + recent error → afterError bucket', () => {
    const line = pickSoftIdleNudgeLine(ctx({ lastError: 'NameError: x not defined' }));
    expect(line.toLowerCase()).toMatch(/(stuck|traceback)/);
  });

  it('notebook + markdown cell → reading bucket', () => {
    const line = pickSoftIdleNudgeLine(ctx({ activeCellType: 'markdown' }));
    expect(line.toLowerCase()).toMatch(/(read|dig|unpack)/);
  });

  it('notebook + code cell + no error → coding bucket', () => {
    const line = pickSoftIdleNudgeLine(ctx({ activeCellType: 'code', lastError: null }));
    expect(line.toLowerCase()).toMatch(/(thinking|bounce|hand|take your time)/);
  });

  it('error takes precedence over cell type (afterError beats reading)', () => {
    const line = pickSoftIdleNudgeLine(ctx({
      activeCellType: 'markdown',
      lastError: 'Oops',
    }));
    expect(line.toLowerCase()).toMatch(/(stuck|traceback)/);
  });

  it('every bucket returns a non-empty string', () => {
    const variants: NotebookContext[] = [
      ctx({ notebookFile: null }),
      ctx({ lastError: 'x' }),
      ctx({ activeCellType: 'markdown' }),
      ctx({ activeCellType: 'code', lastError: null }),
    ];
    for (const c of variants) {
      const line = pickSoftIdleNudgeLine(c);
      expect(line.length).toBeGreaterThan(0);
    }
  });
});
