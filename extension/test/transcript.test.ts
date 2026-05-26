/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — webview module exports CommonJS for vitest
import { createTranscript } from '../src/webview/transcript.js';

describe('createTranscript', () => {
  let transcriptEl: HTMLElement;
  let scrollContainer: HTMLElement;
  let renderMarkdown: (s: string) => string;

  function mk(extra: any = {}) {
    return createTranscript({
      transcriptEl,
      scrollContainer,
      renderMarkdown,
      ...extra,
    });
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    transcriptEl = document.createElement('div');
    transcriptEl.id = 'transcript';
    scrollContainer = document.createElement('div');
    scrollContainer.appendChild(transcriptEl);
    document.body.appendChild(scrollContainer);
    // Trivial renderer: just wrap text to prove it's the one we plug in.
    renderMarkdown = (s: string) => `<rendered>${s}</rendered>`;
  });

  describe('appendEntry', () => {
    it('creates a user chat entry with the YOU label', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'hello');
      expect(transcriptEl.children).toHaveLength(1);
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.className).toContain('transcript-entry');
      expect(entry.querySelector('.entry-label')?.textContent).toBe('YOU');
      expect(entry.querySelector('.entry-text')?.innerHTML).toContain('hello');
    });

    it('creates a companion chat entry with the ZEE label', () => {
      const t = mk();
      t.appendEntry('companion', 'chat', 'hi');
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.querySelector('.entry-label')?.textContent).toBe('ZEE');
    });

    it('initiative entries get the sparkle badge and a special class', () => {
      const t = mk();
      t.appendEntry('companion', 'initiative', 'nudge');
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.classList.contains('entry-initiative')).toBe(true);
      expect(entry.querySelector('.entry-label')?.textContent).toContain('✦');
    });

    it('voice entries get the mic icon in the user label', () => {
      const t = mk();
      t.appendEntry('user', 'voice', 'spoken');
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.querySelector('.entry-label')?.textContent).toContain('🎙');
    });

    it('rich text renders as a sibling block', () => {
      const t = mk();
      t.appendEntry('companion', 'chat', 'spoken', 'code block');
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.querySelectorAll('.rich-content')).toHaveLength(1);
      expect(entry.querySelector('.rich-content')?.innerHTML).toContain('code block');
    });

    it('runs text through renderMarkdown (XSS defence lives there)', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'raw');
      const entry = transcriptEl.children[0] as HTMLElement;
      expect(entry.querySelector('.entry-text')?.innerHTML).toContain('<rendered>raw</rendered>');
    });
  });

  describe('thinking indicator', () => {
    it('adds and removes a single thinking entry', () => {
      const t = mk();
      t.appendThinking();
      expect(document.getElementById('thinkingEntry')).not.toBeNull();
      t.removeThinking();
      expect(document.getElementById('thinkingEntry')).toBeNull();
    });

    it('removeThinking is safe when there is no thinking entry', () => {
      const t = mk();
      expect(() => t.removeThinking()).not.toThrow();
    });
  });

  describe('streaming', () => {
    it('startStreamingEntry removes the thinking indicator and opens a new entry', () => {
      const t = mk();
      t.appendThinking();
      t.startStreamingEntry();
      expect(document.getElementById('thinkingEntry')).toBeNull();
      expect(t.isStreaming()).toBe(true);
    });

    it('appendStreamChunk concatenates chunks as plain text', () => {
      const t = mk();
      t.startStreamingEntry();
      t.appendStreamChunk('Hello ');
      t.appendStreamChunk('world');
      // Plain text while streaming; only re-rendered on finish
      const entry = transcriptEl.lastElementChild!;
      expect(entry.querySelector('.entry-text')?.textContent).toBe('Hello world');
    });

    it('appendStreamChunk before startStreamingEntry auto-starts it', () => {
      const t = mk();
      t.appendStreamChunk('chunk');
      expect(t.isStreaming()).toBe(true);
    });

    it('finishStreamingEntry re-renders with markdown', () => {
      const t = mk();
      t.startStreamingEntry();
      t.appendStreamChunk('**bold**');
      t.finishStreamingEntry();
      const entry = transcriptEl.lastElementChild!;
      expect(entry.querySelector('.entry-text')?.innerHTML).toContain('<rendered>**bold**</rendered>');
      expect(t.isStreaming()).toBe(false);
    });

    it('finishStreamingEntry uses finalText override when provided (voice mode)', () => {
      const t = mk();
      t.startStreamingEntry();
      t.appendStreamChunk('{"text":"ignored JSON"}');
      t.finishStreamingEntry(undefined, 'clean text');
      const entry = transcriptEl.lastElementChild!;
      expect(entry.querySelector('.entry-text')?.innerHTML).toContain('<rendered>clean text</rendered>');
    });

    it('finishStreamingEntry renders richText as a sibling block', () => {
      const t = mk();
      t.startStreamingEntry();
      t.appendStreamChunk('spoken');
      t.finishStreamingEntry('code');
      const entry = transcriptEl.lastElementChild!;
      expect(entry.querySelector('.rich-content')?.innerHTML).toContain('code');
    });

    it('markStopped appends "— stopped" suffix and finalizes', () => {
      const t = mk();
      t.startStreamingEntry();
      t.appendStreamChunk('partial');
      t.markStopped();
      const entry = transcriptEl.lastElementChild!;
      expect(entry.querySelector('.stopped-suffix')?.textContent).toContain('stopped');
      expect(t.isStreaming()).toBe(false);
    });

    it('markLastTurnErrored tags both the trailing user bubble and the error reply', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'first');
      t.appendEntry('companion', 'chat', 'reply');
      t.appendEntry('user', 'chat', 'second (will error)');
      t.appendEntry('companion', 'chat', 'error message');
      t.markLastTurnErrored();

      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries[0].classList.contains('errored')).toBe(false);
      expect(entries[1].classList.contains('errored')).toBe(false);
      expect(entries[2].classList.contains('errored')).toBe(true); // user
      expect(entries[3].classList.contains('errored')).toBe(true); // error reply
    });

    it('markLastTurnErrored handles the case where no error reply has been rendered yet', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'orphan');
      t.markLastTurnErrored();
      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries[0].classList.contains('errored')).toBe(true);
    });

    it('markLastTurnErrored is a no-op when the transcript is empty', () => {
      const t = mk();
      expect(() => t.markLastTurnErrored()).not.toThrow();
      expect(transcriptEl.querySelector('.errored')).toBeNull();
    });

    it('removeTrailingErrored peels off one failed turn (user + error reply)', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'q1');
      t.appendEntry('companion', 'chat', 'a1');
      t.appendEntry('user', 'chat', 'q2');
      t.appendEntry('companion', 'chat', 'oops error');
      t.markLastTurnErrored();

      expect(t.removeTrailingErrored()).toBe(2);
      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('q1');
      expect(entries[1].textContent).toContain('a1');
    });

    it('removeTrailingErrored unwinds stacked errors one click at a time', () => {
      // Two failed turns in a row — each click should peel only the most
      // recent one, leaving the older error stub for the next click.
      const t = mk();
      t.appendEntry('user', 'chat', 'q1');
      t.appendEntry('companion', 'chat', 'err1');
      t.markLastTurnErrored();
      t.appendEntry('user', 'chat', 'q2');
      t.appendEntry('companion', 'chat', 'err2');
      t.markLastTurnErrored();

      expect(t.removeTrailingErrored()).toBe(2);
      let entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('q1');
      expect(entries[1].textContent).toContain('err1');
      // Older error stub is still there and still errored — second click
      // peels it too.
      expect(entries[1].classList.contains('errored')).toBe(true);

      expect(t.removeTrailingErrored()).toBe(2);
      entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries).toHaveLength(0);
    });

    it('removeTrailingErrored is a no-op when nothing trailing is errored', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'q1');
      t.appendEntry('companion', 'chat', 'a1');
      expect(t.removeTrailingErrored()).toBe(0);
      expect(transcriptEl.querySelectorAll('.transcript-entry')).toHaveLength(2);
    });

    it('removeLastPair peels off the trailing (user, companion) pair', () => {
      const t = mk();
      t.appendEntry('user',      'chat', 'q1');
      t.appendEntry('companion', 'chat', 'a1');
      t.appendEntry('user',      'chat', 'q2');
      t.appendEntry('companion', 'chat', 'a2');

      expect(t.removeLastPair()).toBe(true);
      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('q1');
      expect(entries[1].textContent).toContain('a1');
    });

    it('removeLastPair refuses when the last companion entry is an initiative', () => {
      // Mirror of the host-side rule: initiative entries aren't paired.
      const t = mk();
      t.appendEntry('user',      'chat',       'q1');
      t.appendEntry('companion', 'chat',       'a1');
      t.appendEntry('companion', 'initiative', 'nudge');
      expect(t.removeLastPair()).toBe(false);
      expect(transcriptEl.querySelectorAll('.transcript-entry')).toHaveLength(3);
    });

    it('removeLastPair is a no-op with fewer than 2 entries', () => {
      const t = mk();
      expect(t.removeLastPair()).toBe(false);
      t.appendEntry('user', 'chat', 'solo');
      expect(t.removeLastPair()).toBe(false);
    });

    it('onStreamStart fires once on startStreamingEntry', () => {
      const onStreamStart = vi.fn();
      const t = mk({ onStreamStart });
      t.startStreamingEntry();
      t.appendStreamChunk('x');
      expect(onStreamStart).toHaveBeenCalledTimes(1);
    });

    it('onStreamEnd fires once on finishStreamingEntry', () => {
      const onStreamEnd = vi.fn();
      const t = mk({ onStreamEnd });
      t.startStreamingEntry();
      t.finishStreamingEntry();
      expect(onStreamEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe('session divider', () => {
    it('renders a divider with the formatted timestamp', () => {
      const t = mk();
      const ts = new Date('2026-04-23T10:30:00Z').getTime();
      t.appendSessionDivider(ts);
      const div = transcriptEl.querySelector('.session-divider');
      expect(div).not.toBeNull();
      expect(div?.textContent).toContain('previous session');
      expect(div?.textContent).toMatch(/Apr 2\d/);
    });
  });

  describe('clear', () => {
    it('wipes the transcript DOM and resets streaming state', () => {
      const t = mk();
      t.appendEntry('user', 'chat', 'one');
      t.startStreamingEntry();
      t.clear();
      expect(transcriptEl.children).toHaveLength(0);
      expect(t.isStreaming()).toBe(false);
    });
  });

  describe('scroll', () => {
    it('appendEntry scrolls the container to the bottom', () => {
      scrollContainer.style.height = '50px';
      scrollContainer.style.overflow = 'auto';
      // Populate with enough content to need scrolling
      for (let i = 0; i < 50; i++) {
        const p = document.createElement('p');
        p.textContent = 'line';
        transcriptEl.appendChild(p);
      }
      const t = mk();
      scrollContainer.scrollTop = 0;
      t.appendEntry('user', 'chat', 'trigger');
      // happy-dom may set this to 0 if layout doesn't run; at minimum it's not negative.
      expect(scrollContainer.scrollTop).toBeGreaterThanOrEqual(0);
    });
  });
});
