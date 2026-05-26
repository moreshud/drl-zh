// Pool of short, deliberately-under-articulated utterances Zee speaks at
// the moment a thought cloud appears in voice mode. Played slightly
// slower than normal speech rate so it reads as "thinking aloud" rather
// than committing to a full sentence — much less disruptive than
// announcing a complete offer.
//
// Pure data + a pure picker — easy to tweak without touching the
// orchestrator or the TTS pipeline.

/** Speech rate for thought utterances — slightly slower than the user's
 *  configured rate, to feel pensive. The TTS client multiplies. */
export const THOUGHT_UTTERANCE_RATE = 0.9;

/**
 * The pool. Keep entries short, hedged, lowercase-ish. Trailing ellipses
 * are intentional — they read as half-thoughts.
 */
export const THOUGHT_UTTERANCES: ReadonlyArray<string> = [
  'Hmm…',
  'Mmm…',
  'Oh — ',
  'Wait…',
  'Hmm, maybe…',
  'Huh…',
];

/**
 * Pick one utterance from the pool. Deterministic given `rand` — pass a
 * seeded function in tests.
 */
export function pickThoughtUtterance(
  rand: () => number = Math.random,
  pool: ReadonlyArray<string> = THOUGHT_UTTERANCES,
): string {
  if (pool.length === 0) { return ''; }
  return pool[Math.floor(rand() * pool.length)];
}
