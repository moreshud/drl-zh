import type { NotebookContext, SignalType } from './contextTracker';

// ── Canned openers for the three awareness signals ───────────────────────

/**
 * One offer per awareness signal. `line` is the canned opener we post
 * verbatim — it goes straight into the transcript. `acceptPrompt` is what
 * we send to the LLM when the student accepts, so the AI continues the
 * thread with a concrete hint/explanation instead of paraphrasing itself.
 */
export interface SignalOffer {
  line: string;
  acceptPrompt: string;
}

export const SIGNAL_OFFERS: Record<SignalType, SignalOffer> = {
  stuck: {
    line: 'Looks like you might be stuck — want a nudge?',
    acceptPrompt: 'The student accepted your offer of help after multiple consecutive errors on this TODO. Give a gentle, concrete nudge that points to the relevant concept or a likely pitfall — without revealing the solution. Keep it to 1-2 sentences.',
  },
  idle: {
    line: 'Need a hint or a suggestion on this one?',
    acceptPrompt: 'The student accepted your offer of help — they have been sitting on this TODO without making progress. Offer a brief hint about where to start or which concept applies. Keep it to 1-2 sentences, no full solution.',
  },
  reading: {
    line: 'Want me to dig deeper into this section?',
    acceptPrompt: 'The student accepted your offer — they are reading a theory or explanation cell. Offer a deeper explanation, an intuitive analogy, or a practical connection for the content in the active markdown cell. Be conversational, not lecturing; 2-4 sentences.',
  },
  success: {
    line: 'Nice — that worked. Want a quick reflection or a hint for the next TODO?',
    acceptPrompt: 'The student just got their TODO running cleanly after a struggle. Briefly celebrate (one short sentence, not gushing), then either ask them to summarize the fix in their own words OR point them to the next TODO in the notebook — whichever fits the chapter arc better. Keep it to 1-2 sentences total; do not repeat the solution.',
  },
};

// ── Soft-idle nudge lines (zero-LLM presence) ────────────────────────────

/**
 * Short, context-aware lines for the soft-idle nudge. Zero LLM cost — the
 * point is to feel present, not to generate novel content. A handful of
 * variants per bucket keeps it from feeling scripted.
 */
const SOFT_IDLE_LINES: Record<'meta' | 'afterError' | 'reading' | 'coding', string[]> = {
  meta: [
    'Still here — ping me when you want to dive into a chapter.',
    'No rush. Let me know when you\'re ready to pick something to work on.',
  ],
  afterError: [
    'Still stuck on that one? Happy to walk through it with you.',
    'That traceback still giving you trouble? Say the word.',
  ],
  reading: [
    'Take your time with that — shout when you want to dig deeper.',
    'Still reading? I can unpack any part of it if you want.',
  ],
  coding: [
    'Still thinking? No pressure — I\'m here when you need a hand.',
    'Take your time. I\'m here whenever you want to bounce ideas.',
  ],
};

/**
 * Pick a soft-idle nudge line based on the current notebook context.
 * Deterministic by bucket, randomized within the bucket for variety.
 */
export function pickSoftIdleNudgeLine(ctx: NotebookContext): string {
  const bucket = !ctx.notebookFile
    ? SOFT_IDLE_LINES.meta
    : ctx.lastError
      ? SOFT_IDLE_LINES.afterError
      : ctx.activeCellType === 'markdown'
        ? SOFT_IDLE_LINES.reading
        : SOFT_IDLE_LINES.coding;
  return bucket[Math.floor(Math.random() * bucket.length)];
}
