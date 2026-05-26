import * as vscode from 'vscode';

export type SkillLevel = 'none' | 'some' | 'experienced' | 'unknown';

export interface LearnerProfile {
  skillLevel: SkillLevel;
  goal: string;                   // free-form, may be empty
  chaptersTouched: string[];      // notebook filenames the learner has opened
  stuckConcepts: string[];        // TODO text / concept snippets where 'stuck' fired
  createdAt: number;
  lastActiveAt: number;
}

export const EMPTY_LEARNER_PROFILE: LearnerProfile = {
  skillLevel: 'unknown',
  goal: '',
  chaptersTouched: [],
  stuckConcepts: [],
  createdAt: 0,
  lastActiveAt: 0,
};

const STORAGE_KEY = 'drlzh.learnerProfile';
const MAX_STUCK_CONCEPTS = 20;
const MAX_CHAPTERS_TOUCHED = 64;

export class LearnerProfileStore {
  private cache: LearnerProfile;

  constructor(private storage: vscode.Memento) {
    const raw = storage.get<Partial<LearnerProfile>>(STORAGE_KEY);
    this.cache = normalize(raw);
  }

  get(): LearnerProfile {
    return { ...this.cache, chaptersTouched: [...this.cache.chaptersTouched], stuckConcepts: [...this.cache.stuckConcepts] };
  }

  async update(patch: Partial<LearnerProfile>): Promise<void> {
    const now = Date.now();
    this.cache = {
      ...this.cache,
      ...patch,
      createdAt: this.cache.createdAt || now,
      lastActiveAt: now,
    };
    await this.persist();
  }

  async recordChapterTouched(filename: string): Promise<void> {
    if (!filename) { return; }
    const existing = this.cache.chaptersTouched.filter(f => f !== filename);
    const next = [filename, ...existing].slice(0, MAX_CHAPTERS_TOUCHED);
    this.cache = { ...this.cache, chaptersTouched: next, lastActiveAt: Date.now() };
    await this.persist();
  }

  async recordStuckConcept(concept: string): Promise<void> {
    const trimmed = (concept || '').trim();
    if (!trimmed) { return; }
    const existing = this.cache.stuckConcepts.filter(c => c !== trimmed);
    const next = [trimmed, ...existing].slice(0, MAX_STUCK_CONCEPTS);
    this.cache = { ...this.cache, stuckConcepts: next, lastActiveAt: Date.now() };
    await this.persist();
  }

  async reset(): Promise<void> {
    this.cache = { ...EMPTY_LEARNER_PROFILE };
    await this.storage.update(STORAGE_KEY, undefined);
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.cache);
  }
}

function normalize(raw: Partial<LearnerProfile> | undefined): LearnerProfile {
  if (!raw) { return { ...EMPTY_LEARNER_PROFILE }; }
  const skill = raw.skillLevel;
  const skillLevel: SkillLevel = (skill === 'none' || skill === 'some' || skill === 'experienced') ? skill : 'unknown';
  return {
    skillLevel,
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    chaptersTouched: Array.isArray(raw.chaptersTouched) ? raw.chaptersTouched.filter(x => typeof x === 'string') : [],
    stuckConcepts: Array.isArray(raw.stuckConcepts) ? raw.stuckConcepts.filter(x => typeof x === 'string') : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    lastActiveAt: typeof raw.lastActiveAt === 'number' ? raw.lastActiveAt : 0,
  };
}

/**
 * Format the profile as a short system-prompt block. Returns empty string
 * when there's nothing useful to say (unknown skill, empty goal, no history).
 */
export function formatLearnerSection(profile: LearnerProfile): string {
  const parts: string[] = [];

  if (profile.skillLevel !== 'unknown') {
    const labels: Record<Exclude<SkillLevel, 'unknown'>, string> = {
      none: 'new to reinforcement learning',
      some: 'has some RL background',
      experienced: 'is already comfortable with RL fundamentals',
    };
    parts.push(`The student ${labels[profile.skillLevel]}.`);
  }

  if (profile.goal) {
    parts.push(`Their stated goal: ${profile.goal}`);
  }

  if (profile.chaptersTouched.length > 0) {
    const recent = profile.chaptersTouched.slice(0, 6).join(', ');
    parts.push(`Recently touched notebooks: ${recent}.`);
  }

  if (profile.stuckConcepts.length > 0) {
    const recent = profile.stuckConcepts.slice(0, 5).map(c => `"${c}"`).join(', ');
    parts.push(`Recent stuck points: ${recent}.`);
  }

  if (parts.length === 0) { return ''; }
  return `What you know about this student:\n${parts.join(' ')}`;
}
