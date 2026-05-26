// ── Transcript ──────────────────────────────────────────────────────────────
export const CONTEXT_TOKEN_BUDGET         = 3000; // approx tokens of history sent to LLM per call
export const TRANSCRIPT_ROLLING_MAX       = 500;  // entries before auto-archive
export const TRANSCRIPT_ROLLING_KEEP      = 250;  // entries kept after archive
export const TRANSCRIPT_CELL_PREVIEW_LEN  = 120;  // chars of cell content stored
export const TRANSCRIPT_FLUSH_INTERVAL_MS = 10_000; // debounced disk write

// ── Awareness signals ───────────────────────────────────────────────────────
export const STUCK_ERROR_THRESHOLD        = 3;        // consecutive errors before "stuck"
export const IDLE_ON_TODO_MS              = 60_000;   // idle on TODO cell before offering help
export const READING_ON_MARKDOWN_MS       = 1_500;    // dwell on a markdown cell before offering to dig deeper — short enough to feel "always there", long enough to ignore quick skim-throughs

// ── Soft-idle flow state ────────────────────────────────────────────────────
// Global (cell-agnostic) activity signal: first face-only "drowsy" at
// SOFT_IDLE_PRESENCE_MS, then a single gentle templated nudge at
// SOFT_IDLE_NUDGE_MS. Resets on any activity (cell edit, cell run,
// chat typing, voice input).
export const SOFT_IDLE_PRESENCE_MS        = 120_000;  // 2 min: face drifts to drowsy, no text
export const SOFT_IDLE_NUDGE_MS           = 300_000;  // 5 min: one gentle templated nudge

// ── Request-to-speak timeouts ───────────────────────────────────────────────
export const REQUEST_DISMISS_VOICE_MS = 10_000;   // silence timeout in voice mode
export const REQUEST_DISMISS_CHAT_MS  = 30_000;   // no-action timeout in chat mode

// ── Resumption ──────────────────────────────────────────────────────────────
export const RESUMPTION_DELAY_MS = 5_000;         // delay before "welcome back" initiative

// ── TTS sentence boundary ───────────────────────────────────────────────────
export const SENTENCE_BOUNDARY_RE = /[.!?]\s/;

// ── Speech rate bounds ──────────────────────────────────────────────────────
export const SPEECH_RATE_MIN = 0.75;
export const SPEECH_RATE_MAX = 1.5;
export const SPEECH_RATE_DEFAULT = 1.0;

// ── STT ────────────────────────────────────────────────────────────────────
export const STT_CONFIDENCE_THRESHOLD = 0.6;

// ── Context throttle ───────────────────────────────────────────────────────
export const CONTEXT_THROTTLE_MS = 500;

// ── Focus tracking ─────────────────────────────────────────────────────────
export const LEARN_MORE_DELAY_MS    = 5_000;   // show "learn more" pill after 5s on markdown
export const BRIEF_VISIT_MS         = 3_000;   // ignore cell visits shorter than 3s
export const FOCUS_SEQUENCE_MAX     = 10;       // keep last 10 focus transitions

// ── LLM context budgeting ──────────────────────────────────────────────────
// Cap on active-cell content sent to the LLM. A 100-line Jupyter cell with
// comments easily blows past 3k tokens — we keep the LAST N chars (cursor is
// usually near the end of what the student is writing) rather than the first.
export const ACTIVE_CELL_CHAR_CAP = 2000;
// Tail size of a recently-engaged cell sent for deictic resolution.
// Smaller than active-cell because we typically include 1-2 of them.
export const RECENTLY_ENGAGED_CELL_CHAR_CAP = 1200;
// How many recently-engaged code cells to surface (most recent first).
export const RECENTLY_ENGAGED_CELL_LIMIT = 2;

// ── Thought clouds ─────────────────────────────────────────────────────────
// How long a thought stays visible before fading on its own (ms). Long
// enough to read and consider; short enough to feel ephemeral.
export const THOUGHT_TTL_MS = 25_000;
// Minimum gap between thoughts so Zee doesn't feel chatty.
export const THOUGHT_COOLDOWN_MS = 30_000;
// Random ambient thought timer: fires only after this much pure inactivity
// AND only when no real signal has fired for the same period.
export const AMBIENT_THOUGHT_MIN_IDLE_MS = 180_000;  // 3 min
// LLM call budget for `stuck` thoughts. The cheap model is fast but we cap
// to fail open (use the fallback static line) if it gets slow.
export const STUCK_THOUGHT_LLM_TIMEOUT_MS = 4_000;

// ── Workspace state keys ────────────────────────────────────────────────────
export const KEY_ONBOARDING_COMPLETE = 'drlzh.onboardingComplete';
export const KEY_LLM_PROVIDER        = 'drlzh.llmProvider';
export const KEY_GROQ_MODEL          = 'drlzh.groqModel';
export const KEY_GEMINI_MODEL        = 'drlzh.geminiModel';
export const KEY_OPENAI_MODEL        = 'drlzh.openaiModel';
export const KEY_ANTHROPIC_MODEL     = 'drlzh.anthropicModel';
export const KEY_SPEECH_RATE          = 'drlzh.speechRate';
export const KEY_VOICE_RESPONSES      = 'drlzh.voiceResponsesEnabled';
export const KEY_MIC_SENSITIVITY      = 'drlzh.micSensitivity';
export const KEY_DEFAULT_MODE         = 'drlzh.defaultInteractionMode';
export const KEY_COMPANION_ENABLED      = 'drlzh.companionEnabled';

// ── Default chat models ─────────────────────────────────────────────────────
// These are defaults, not policy: settings can override each provider's
// chat model without requiring a code release when provider naming evolves.
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

// ── Secret storage keys ─────────────────────────────────────────────────────
export const SECRET_GROQ_KEY        = 'drlzh.groqApiKey';
export const SECRET_GEMINI_KEY      = 'drlzh.geminiApiKey';
export const SECRET_OPENAI_KEY      = 'drlzh.openaiApiKey';
export const SECRET_ANTHROPIC_KEY   = 'drlzh.anthropicApiKey';

// ── Companion directory ─────────────────────────────────────────────────────
export const COMPANION_DIR = '.companion';

// ── Meta-mode copy (no notebook open) ──────────────────────────────────────
// Single source of truth for what the student sees AND what Zee is told
// about meta mode. Keeping these together prevents the 3-way drift we had
// (empty-state card vs. system prompt vs. context pill) and ensures we
// never again refer to a "chapters/" folder that doesn't exist.
export const META_MODE_COPY = {
  /** Multi-sentence description shown in the empty-state card and used to
   *  steer the LLM in meta mode. Reference real chapter notebook names. */
  description:
    "Ask me where to start, what's in a chapter, or what you need to know before tackling a topic. " +
    "Open any of the numbered chapter notebooks (e.g. 00_Intro.ipynb, 03_DQN.ipynb) and I'll follow along as you work.",
  /** Compact pill text shown in the context bar when no notebook is open. */
  pill: 'No notebook open — ask me anything about the course.',
};
