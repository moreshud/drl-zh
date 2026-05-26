import { describe, it, expect } from 'vitest';
import {
  THOUGHT_UTTERANCES, THOUGHT_UTTERANCE_RATE, pickThoughtUtterance,
} from '../src/thoughtUtterance';

describe('thoughtUtterance', () => {
  it('exposes a non-empty pool of short utterances', () => {
    expect(THOUGHT_UTTERANCES.length).toBeGreaterThan(0);
    for (const u of THOUGHT_UTTERANCES) {
      expect(u.length).toBeGreaterThan(0);
      // Short — half-thoughts, not announcements.
      expect(u.length).toBeLessThan(20);
    }
  });

  it('is rate <= 1 (slower than normal speech) so it reads as pensive', () => {
    expect(THOUGHT_UTTERANCE_RATE).toBeLessThanOrEqual(1);
    expect(THOUGHT_UTTERANCE_RATE).toBeGreaterThan(0.5);
  });

  it('pickThoughtUtterance returns an entry from the pool', () => {
    for (let i = 0; i < 10; i++) {
      const u = pickThoughtUtterance();
      expect(THOUGHT_UTTERANCES).toContain(u);
    }
  });

  it('picks deterministically when given a seeded rand', () => {
    expect(pickThoughtUtterance(() => 0)).toBe(THOUGHT_UTTERANCES[0]);
    const last = THOUGHT_UTTERANCES[THOUGHT_UTTERANCES.length - 1];
    expect(pickThoughtUtterance(() => 0.999)).toBe(last);
  });

  it('returns empty string when the pool is empty (defensive)', () => {
    expect(pickThoughtUtterance(Math.random, [])).toBe('');
  });
});
