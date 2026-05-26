// Decides WHAT thought Zee should "think" for a given trigger. Pure, no
// side effects — easy to unit-test and tweak. The orchestrator (separate
// module) owns WHEN to fire and HOW to deliver them; this just maps a
// (trigger, context) pair to a candidate thought.
//
// Policy summary:
//   - Static templates for triggers without a student-specific artifact:
//     idle / reading / success / soft-idle / random ambient.
//   - LLM-generated for triggers whose value depends on referencing the
//     concrete artifact: today, just `stuck` (the specific error). The
//     orchestrator handles the LLM call when source === 'llm'.

import type { NotebookContext, SignalType } from './contextTracker';

/** What kicked off a thought. Signals (peer to today's `SignalType`) plus
 *  one new ambient trigger ("Zee's mind wandering during long idle"). */
export type ThoughtTrigger = SignalType | 'soft-idle' | 'ambient';

export type ThoughtSource = 'static' | 'llm';

/** Visual register — see ThoughtKind in thoughtOrchestrator.ts. The policy
 *  picks per-trigger; the orchestrator forwards it to the cloud. */
export type ThoughtKind = 'thought' | 'callout';

export interface Thought {
  /** Short line shown in the cloud (≤ ~80 chars). */
  text: string;
  /** Where it came from — orchestrator uses this to decide whether to fire
   *  a cheap-LLM call for the final phrasing or use `text` as-is. */
  source: ThoughtSource;
  /** Visual register; defaults to 'thought' when unset. */
  kind?: ThoughtKind;
  /** When the student clicks the cloud, the chat sends a user message of
   *  the form: `Tell me more — "<expandHint>"`. Defaults to `text`; some
   *  thoughts override with a more specific phrase. */
  expandHint?: string;
}

// ── Static template pools ────────────────────────────────────────────────
//
// Multiple variants per pool keep clouds from feeling scripted; the
// orchestrator picks one at random per fire. Lines stay short and hedged
// — they're thoughts, not announcements.

const READING_THOUGHTS = [
  'Hmm — want me to unpack any of this?',
  'Some of this gets clearer with an analogy. Want one?',
  'Could go a level deeper here if you\'re curious.',
];

const IDLE_TODO_THOUGHTS = [
  'Stuck on where to start? I can nudge you.',
  'Want a hint about what concept this TODO is testing?',
  'Need a starting point for this one?',
];

const SUCCESS_THOUGHTS = [
  'Nice — that works! Want to lock in why?',
  'It\'s running. Want to talk through what made it click?',
  'Solid. Ready for the next TODO, or want to reflect on this one?',
];

const SOFT_IDLE_THOUGHTS_META = [
  'Still here when you\'re ready to pick a chapter.',
  'No rush — ping me whenever.',
];

const SOFT_IDLE_THOUGHTS_AFTER_ERROR = [
  'That traceback still bugging you?',
  'Still chewing on the error? I can walk through it.',
];

const SOFT_IDLE_THOUGHTS_READING = [
  'Take your time with this section.',
  'Reading? Shout if anything feels fuzzy.',
];

const SOFT_IDLE_THOUGHTS_CODING = [
  'Still thinking? No pressure.',
  'I\'m here whenever you want to bounce ideas.',
];

const AMBIENT_THOUGHTS_GENERIC = [
  'Wondering how you\'d explain this in your own words…',
  'Curious where this connects to what you already know.',
  'Hmm — thinking about how to frame this.',
];

const AMBIENT_THOUGHTS_TODO = [
  'Wondering if this TODO would benefit from a hint…',
  'Hmm — could sketch an approach if you want.',
];

// Tricky-TODO opener: a TODO with a known reference solution gets a
// gentle "this one's a bit fiddly" templated thought, no LLM cost.
const TRICKY_TODO_THOUGHTS = [
  'This one\'s a bit fiddly — happy to walk through it.',
  'I have a few approaches in mind for this. Want to compare?',
];

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Choose a thought for the given trigger. Deterministic given the random
 * function — pass a seeded one in tests.
 */
export function pickThought(
  trigger: ThoughtTrigger,
  ctx: NotebookContext,
  rand: () => number = Math.random,
): Thought {
  const pickFrom = (pool: string[]): string =>
    pool[Math.floor(rand() * pool.length)];

  switch (trigger) {
    case 'reading':
      // Reading is the one signal where the student is genuinely receptive
      // to a "want to delve deeper?" callout — mark it as the brighter
      // variant so it pulls a touch more attention than ambient drift.
      return {
        text: pickFrom(READING_THOUGHTS),
        source: 'static',
        kind: 'callout',
      };

    case 'idle':
      // Tricky-TODO override: if we have a reference solution, use the
      // gentler "this one's a bit fiddly" framing.
      if (ctx.solutionHint) {
        return { text: pickFrom(TRICKY_TODO_THOUGHTS), source: 'static' };
      }
      return { text: pickFrom(IDLE_TODO_THOUGHTS), source: 'static' };

    case 'success':
      return { text: pickFrom(SUCCESS_THOUGHTS), source: 'static' };

    case 'soft-idle': {
      // Same bucket selection as today's pickSoftIdleNudgeLine.
      const bucket = !ctx.notebookFile      ? SOFT_IDLE_THOUGHTS_META
                   : ctx.lastError          ? SOFT_IDLE_THOUGHTS_AFTER_ERROR
                   : ctx.activeCellType === 'markdown' ? SOFT_IDLE_THOUGHTS_READING
                   :                          SOFT_IDLE_THOUGHTS_CODING;
      return { text: pickFrom(bucket), source: 'static' };
    }

    case 'ambient': {
      const pool = ctx.isTodoCell ? AMBIENT_THOUGHTS_TODO : AMBIENT_THOUGHTS_GENERIC;
      return { text: pickFrom(pool), source: 'static' };
    }

    case 'stuck':
      // The error itself is the most relevant thing the cloud can carry,
      // so the orchestrator generates the line via the cheap LLM.
      // Fallback `text` is shown if the LLM call fails — generic but safe.
      return {
        text: 'Hmm — want me to dig into that error?',
        source: 'llm',
        expandHint: 'help me debug this',
      };
  }
}

/**
 * Build the prompt the cheap LLM uses to produce a `stuck`-trigger thought.
 * Returns the system + user pair so the orchestrator can dispatch it.
 * Kept here (not in the orchestrator) so tweaking the LLM voice is a
 * one-file change.
 */
export function buildStuckThoughtPrompt(ctx: NotebookContext): {
  system: string;
  user: string;
} {
  const cellExcerpt = ctx.activeCellContent.slice(-1000);
  const errorExcerpt = (ctx.lastError ?? '').slice(0, 400);
  return {
    system:
      `You are Zee, an AI tutor. Generate ONE short "thought" (≤ 90 chars, hedged, ` +
      `lowercase-ish, no period if natural) Zee might think to itself when noticing ` +
      `the student is stuck on a specific error. Reference what's actually wrong, ` +
      `gently. No greetings, no full diagnosis — just a thought. Output the line ` +
      `only, no quotes, no preamble.`,
    user:
      `Cell content (tail):\n${cellExcerpt}\n\n` +
      `Most recent error:\n${errorExcerpt}\n\n` +
      `Consecutive errors: ${ctx.consecutiveErrors}\n\n` +
      `One thought:`,
  };
}
