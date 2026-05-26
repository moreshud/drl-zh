import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LearnerProfileStore, EMPTY_LEARNER_PROFILE, formatLearnerSection, LearnerProfile,
} from '../src/learnerProfile';

function makeMemento(initial?: Record<string, unknown>) {
  const backing = new Map<string, unknown>(initial ? Object.entries(initial) : []);
  return {
    get: vi.fn(<T>(key: string, def?: T) => (backing.has(key) ? backing.get(key) : def) as T),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) { backing.delete(key); }
      else { backing.set(key, value); }
    }),
    keys: () => Array.from(backing.keys()),
    _backing: backing,
  };
}

describe('LearnerProfileStore', () => {
  let memento: ReturnType<typeof makeMemento>;

  beforeEach(() => {
    memento = makeMemento();
  });

  it('returns the empty profile when storage is empty', () => {
    const store = new LearnerProfileStore(memento as any);
    expect(store.get()).toEqual(EMPTY_LEARNER_PROFILE);
  });

  it('reads and normalizes a persisted profile', () => {
    memento = makeMemento({
      'drlzh.learnerProfile': {
        skillLevel: 'some',
        goal: 'robotics',
        chaptersTouched: ['03_DQN.ipynb'],
        stuckConcepts: ['policy gradient'],
        createdAt: 100,
        lastActiveAt: 200,
      },
    });
    const store = new LearnerProfileStore(memento as any);
    expect(store.get().skillLevel).toBe('some');
    expect(store.get().goal).toBe('robotics');
  });

  it('coerces unknown skillLevel to "unknown"', () => {
    memento = makeMemento({
      'drlzh.learnerProfile': { skillLevel: 'guru' },
    });
    const store = new LearnerProfileStore(memento as any);
    expect(store.get().skillLevel).toBe('unknown');
  });

  it('update() persists the patch and bumps lastActiveAt', async () => {
    const store = new LearnerProfileStore(memento as any);
    await store.update({ skillLevel: 'experienced', goal: 'research' });
    const saved: LearnerProfile = (memento as any)._backing.get('drlzh.learnerProfile');
    expect(saved.skillLevel).toBe('experienced');
    expect(saved.goal).toBe('research');
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved.lastActiveAt).toBeGreaterThanOrEqual(saved.createdAt);
  });

  it('recordChapterTouched moves touched chapter to front, no duplicates', async () => {
    const store = new LearnerProfileStore(memento as any);
    await store.recordChapterTouched('01_MDP.ipynb');
    await store.recordChapterTouched('03_DQN.ipynb');
    await store.recordChapterTouched('01_MDP.ipynb');  // re-touch
    expect(store.get().chaptersTouched).toEqual(['01_MDP.ipynb', '03_DQN.ipynb']);
  });

  it('recordStuckConcept deduplicates and caps at 20', async () => {
    const store = new LearnerProfileStore(memento as any);
    for (let i = 0; i < 25; i++) {
      await store.recordStuckConcept(`concept ${i}`);
    }
    const list = store.get().stuckConcepts;
    expect(list).toHaveLength(20);
    expect(list[0]).toBe('concept 24'); // most recent first
  });

  it('recordStuckConcept ignores empty strings', async () => {
    const store = new LearnerProfileStore(memento as any);
    await store.recordStuckConcept('');
    await store.recordStuckConcept('   ');
    expect(store.get().stuckConcepts).toEqual([]);
  });

  it('reset() clears storage and in-memory cache', async () => {
    const store = new LearnerProfileStore(memento as any);
    await store.update({ skillLevel: 'some', goal: 'x' });
    await store.reset();
    expect(store.get()).toEqual(EMPTY_LEARNER_PROFILE);
    expect((memento as any)._backing.has('drlzh.learnerProfile')).toBe(false);
  });
});

describe('formatLearnerSection', () => {
  it('returns empty string for the empty profile', () => {
    expect(formatLearnerSection(EMPTY_LEARNER_PROFILE)).toBe('');
  });

  it('mentions skill level when known', () => {
    const out = formatLearnerSection({
      ...EMPTY_LEARNER_PROFILE,
      skillLevel: 'none',
    });
    expect(out).toContain('new to reinforcement learning');
  });

  it('includes the goal verbatim', () => {
    const out = formatLearnerSection({
      ...EMPTY_LEARNER_PROFILE,
      goal: 'apply RL to robotics control',
    });
    expect(out).toContain('apply RL to robotics control');
  });

  it('shows at most 6 recently touched chapters', () => {
    const chapters = Array.from({ length: 10 }, (_, i) => `ch${i}.ipynb`);
    const out = formatLearnerSection({
      ...EMPTY_LEARNER_PROFILE,
      chaptersTouched: chapters,
    });
    expect(out).toContain('ch0.ipynb');
    expect(out).not.toContain('ch6.ipynb');
    expect(out).not.toContain('ch7.ipynb');
  });

  it('shows at most 5 stuck concepts', () => {
    const concepts = Array.from({ length: 8 }, (_, i) => `concept ${i}`);
    const out = formatLearnerSection({
      ...EMPTY_LEARNER_PROFILE,
      stuckConcepts: concepts,
    });
    expect(out).toContain('"concept 0"');
    expect(out).toContain('"concept 4"');
    expect(out).not.toContain('"concept 5"');
  });
});
