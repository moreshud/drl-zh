import { describe, it, expect } from 'vitest';
import {
  CONTEXT_TOKEN_BUDGET, TRANSCRIPT_ROLLING_MAX, TRANSCRIPT_ROLLING_KEEP,
  TRANSCRIPT_CELL_PREVIEW_LEN, TRANSCRIPT_FLUSH_INTERVAL_MS,
  STUCK_ERROR_THRESHOLD, IDLE_ON_TODO_MS, READING_ON_MARKDOWN_MS,
  REQUEST_DISMISS_VOICE_MS, REQUEST_DISMISS_CHAT_MS,
  RESUMPTION_DELAY_MS, SENTENCE_BOUNDARY_RE, SPEECH_RATE_MIN, SPEECH_RATE_MAX,
  SPEECH_RATE_DEFAULT, STT_CONFIDENCE_THRESHOLD, CONTEXT_THROTTLE_MS,
  LEARN_MORE_DELAY_MS, BRIEF_VISIT_MS, FOCUS_SEQUENCE_MAX,
  KEY_ONBOARDING_COMPLETE, KEY_LLM_PROVIDER, KEY_COMPANION_ENABLED,
  SECRET_GEMINI_KEY, SECRET_OPENAI_KEY, SECRET_ANTHROPIC_KEY,
  COMPANION_DIR, META_MODE_COPY,
} from '../src/constants';

describe('constants', () => {
  describe('transcript constants', () => {
    it('context token budget is 3000', () => {
      expect(CONTEXT_TOKEN_BUDGET).toBe(3000);
    });

    it('rolling max > rolling keep', () => {
      expect(TRANSCRIPT_ROLLING_MAX).toBeGreaterThan(TRANSCRIPT_ROLLING_KEEP);
    });

    it('rolling max is 500, keep is 250', () => {
      expect(TRANSCRIPT_ROLLING_MAX).toBe(500);
      expect(TRANSCRIPT_ROLLING_KEEP).toBe(250);
    });

    it('cell preview length is 120 chars', () => {
      expect(TRANSCRIPT_CELL_PREVIEW_LEN).toBe(120);
    });

    it('flush interval is 10 seconds', () => {
      expect(TRANSCRIPT_FLUSH_INTERVAL_MS).toBe(10_000);
    });
  });

  describe('awareness signals', () => {
    it('stuck requires 3 consecutive errors', () => {
      expect(STUCK_ERROR_THRESHOLD).toBe(3);
    });

    it('idle-on-TODO fires after 60s', () => {
      expect(IDLE_ON_TODO_MS).toBe(60_000);
    });

    it('reading-on-markdown fires within ~3s — short enough to feel "always there" on markdown cells', () => {
      // Originally 20s (read-and-then-offer model). Once Alessio decided
      // markdown cells should always carry a "dig deeper" cloud, we cut
      // the dwell down. Lower bound keeps a debounce so passing through
      // cells while scrolling doesn't fire; upper bound keeps it feeling
      // immediate rather than "wait for it…".
      expect(READING_ON_MARKDOWN_MS).toBeGreaterThanOrEqual(500);
      expect(READING_ON_MARKDOWN_MS).toBeLessThanOrEqual(3_000);
    });

    it('reading offer is sooner than idle offer', () => {
      expect(READING_ON_MARKDOWN_MS).toBeLessThan(IDLE_ON_TODO_MS);
    });
  });

  describe('request timeouts', () => {
    it('voice dismiss is 10s, chat is 30s', () => {
      expect(REQUEST_DISMISS_VOICE_MS).toBe(10_000);
      expect(REQUEST_DISMISS_CHAT_MS).toBe(30_000);
    });

    it('resumption delay is 5s', () => {
      expect(RESUMPTION_DELAY_MS).toBe(5_000);
    });
  });

  describe('sentence boundary regex', () => {
    it('matches period followed by space', () => {
      expect(SENTENCE_BOUNDARY_RE.test('Hello. World')).toBe(true);
    });

    it('matches exclamation followed by space', () => {
      expect(SENTENCE_BOUNDARY_RE.test('Great! Now')).toBe(true);
    });

    it('matches question mark followed by space', () => {
      expect(SENTENCE_BOUNDARY_RE.test('Really? Yes')).toBe(true);
    });

    it('does not match period without space', () => {
      expect(SENTENCE_BOUNDARY_RE.test('3.14')).toBe(false);
    });

    it('does not match period at end of string', () => {
      expect(SENTENCE_BOUNDARY_RE.test('end.')).toBe(false);
    });
  });

  describe('speech rate', () => {
    it('default is within min/max bounds', () => {
      expect(SPEECH_RATE_DEFAULT).toBeGreaterThanOrEqual(SPEECH_RATE_MIN);
      expect(SPEECH_RATE_DEFAULT).toBeLessThanOrEqual(SPEECH_RATE_MAX);
    });

    it('values match spec', () => {
      expect(SPEECH_RATE_MIN).toBe(0.75);
      expect(SPEECH_RATE_MAX).toBe(1.5);
      expect(SPEECH_RATE_DEFAULT).toBe(1.0);
    });
  });

  describe('focus tracking', () => {
    it('learn more delay is 5s', () => {
      expect(LEARN_MORE_DELAY_MS).toBe(5_000);
    });

    it('brief visit threshold is 3s', () => {
      expect(BRIEF_VISIT_MS).toBe(3_000);
    });

    it('focus sequence keeps last 10 transitions', () => {
      expect(FOCUS_SEQUENCE_MAX).toBe(10);
    });

    it('brief visit < learn more delay', () => {
      expect(BRIEF_VISIT_MS).toBeLessThan(LEARN_MORE_DELAY_MS);
    });
  });

  describe('storage keys', () => {
    it('workspace state keys are namespaced with drlzh', () => {
      expect(KEY_ONBOARDING_COMPLETE).toMatch(/^drlzh\./);
      expect(KEY_LLM_PROVIDER).toMatch(/^drlzh\./);
      expect(KEY_COMPANION_ENABLED).toMatch(/^drlzh\./);
    });

    it('secret keys are namespaced with drlzh', () => {
      expect(SECRET_GEMINI_KEY).toMatch(/^drlzh\./);
      expect(SECRET_OPENAI_KEY).toMatch(/^drlzh\./);
      expect(SECRET_ANTHROPIC_KEY).toMatch(/^drlzh\./);
    });

    it('all secret keys are distinct', () => {
      const keys = [SECRET_GEMINI_KEY, SECRET_OPENAI_KEY, SECRET_ANTHROPIC_KEY];
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('STT confidence', () => {
    it('is 0.6', () => {
      expect(STT_CONFIDENCE_THRESHOLD).toBe(0.6);
    });

    it('is between 0 and 1', () => {
      expect(STT_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
      expect(STT_CONFIDENCE_THRESHOLD).toBeLessThan(1);
    });
  });

  describe('context throttle', () => {
    it('is 500ms', () => {
      expect(CONTEXT_THROTTLE_MS).toBe(500);
    });
  });

  describe('companion directory', () => {
    it('is .companion', () => {
      expect(COMPANION_DIR).toBe('.companion');
    });
  });

  describe('META_MODE_COPY', () => {
    it('exposes both description and pill', () => {
      expect(typeof META_MODE_COPY.description).toBe('string');
      expect(typeof META_MODE_COPY.pill).toBe('string');
      expect(META_MODE_COPY.description.length).toBeGreaterThan(0);
      expect(META_MODE_COPY.pill.length).toBeGreaterThan(0);
    });

    it('does NOT mention a "chapters/" folder (it doesn\'t exist)', () => {
      // Regression guard: previously the static empty-state card and the
      // meta-mode system prompt referred to a "chapters/" folder, but the
      // notebooks live at the workspace root.
      expect(META_MODE_COPY.description).not.toMatch(/chapters\//);
      expect(META_MODE_COPY.pill).not.toMatch(/chapters\//);
    });

    it('references real chapter notebook filenames so Zee can name what to open', () => {
      expect(META_MODE_COPY.description).toMatch(/\d{2}_\w+\.ipynb/);
    });
  });
});
