// @ts-check
// Transcript rendering: turns each user/companion turn into a DOM entry.
// Keeps state for the in-flight streaming response (so we can update it
// chunk-by-chunk and re-render as markdown when the stream completes).
//
// Dual-loaded: globalThis.ZeeTranscript for the webview <script> tag,
// CommonJS export for vitest unit tests.

'use strict';

(function (global) {
  /**
   * @typedef {object} TranscriptDeps
   * @property {HTMLElement} transcriptEl  The container for entries.
   * @property {HTMLElement} scrollContainer  The scrollable parent (usually the panel).
   * @property {(text: string) => string} renderMarkdown  XSS-safe markdown → HTML.
   * @property {() => void} [onStreamStart]  Optional hook fired when streaming begins.
   * @property {() => void} [onStreamEnd]    Optional hook fired when streaming ends.
   */

  /**
   * @param {TranscriptDeps} deps
   */
  function createTranscript(deps) {
    const { transcriptEl, scrollContainer, renderMarkdown, onStreamStart, onStreamEnd } = deps;
    const doc = transcriptEl.ownerDocument;

    /** @type {HTMLElement | null} */
    let streamingTextEl = null;
    let streamingText = '';

    function scrollToBottom() {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    /**
     * Create a transcript entry. `role` is 'user' or 'companion'; `inputMode`
     * is 'chat', 'voice', or 'initiative' — the latter two get badges on the label.
     */
    function appendEntry(role, inputMode, text, richText) {
      const entry = doc.createElement('div');
      entry.className = 'transcript-entry';
      if (inputMode === 'initiative') {
        entry.classList.add('entry-initiative');
      }

      const label = doc.createElement('div');
      label.className = `entry-label ${role}`;
      if (role === 'user') {
        label.textContent = inputMode === 'voice' ? 'YOU 🎙' : 'YOU';
      } else {
        label.textContent = inputMode === 'initiative' ? 'ZEE ✦' : 'ZEE';
      }
      entry.appendChild(label);

      const textEl = doc.createElement('div');
      textEl.className = 'entry-text md-rendered';
      textEl.innerHTML = renderMarkdown(text);
      entry.appendChild(textEl);

      if (richText) {
        const richEl = doc.createElement('div');
        richEl.className = 'rich-content';
        richEl.innerHTML = renderMarkdown(richText);
        entry.appendChild(richEl);
      }

      transcriptEl.appendChild(entry);
      scrollToBottom();
      return entry;
    }

    /** Render the "thinking..." indicator while the AI is working. */
    function appendThinking() {
      const entry = doc.createElement('div');
      entry.className = 'transcript-entry';
      entry.id = 'thinkingEntry';

      const label = doc.createElement('div');
      label.className = 'entry-label companion';
      label.textContent = 'ZEE';
      entry.appendChild(label);

      const row = doc.createElement('div');
      row.className = 'thinking-row';
      row.innerHTML = '<span class="thinking-label">thinking</span><span class="thinking-dots"><span></span><span></span><span></span></span>';
      entry.appendChild(row);

      transcriptEl.appendChild(entry);
      scrollToBottom();
      return entry;
    }

    function removeThinking() {
      const el = doc.getElementById('thinkingEntry');
      if (el) { el.remove(); }
    }

    /** Begin a streaming companion entry. Subsequent appendChunk calls update it. */
    function startStreamingEntry() {
      removeThinking();
      const entry = doc.createElement('div');
      entry.className = 'transcript-entry';

      const label = doc.createElement('div');
      label.className = 'entry-label companion';
      label.textContent = 'ZEE';
      entry.appendChild(label);

      const textEl = doc.createElement('div');
      textEl.className = 'entry-text';
      entry.appendChild(textEl);

      transcriptEl.appendChild(entry);
      streamingTextEl = textEl;
      streamingText = '';
      scrollToBottom();
      onStreamStart?.();
    }

    /** Append a chunk of plain text to the current streaming entry. */
    function appendStreamChunk(text) {
      if (!streamingTextEl) { startStreamingEntry(); }
      streamingText += text;
      /** @type {HTMLElement} */ (streamingTextEl).textContent = streamingText;
      scrollToBottom();
    }

    /**
     * Complete the streaming entry: re-render as markdown using `finalText`
     * if provided (e.g. in voice mode where the stream is JSON), else the
     * accumulated streamingText. Optional `richText` is rendered as a
     * sibling block.
     */
    function finishStreamingEntry(richText, finalText) {
      if (streamingTextEl) {
        streamingTextEl.classList.add('md-rendered');
        streamingTextEl.innerHTML = renderMarkdown(finalText ?? streamingText);
        if (richText && streamingTextEl.parentElement) {
          const richEl = doc.createElement('div');
          richEl.className = 'rich-content';
          richEl.innerHTML = renderMarkdown(richText);
          streamingTextEl.parentElement.appendChild(richEl);
        }
      }
      streamingTextEl = null;
      streamingText = '';
      onStreamEnd?.();
    }

    /**
     * Dim the trailing turn (user + the error-message companion that
     * follows) and tag both with `.errored`. Used when the LLM request
     * fails: those entries are visual-only — they were rolled out of both
     * the on-disk transcript and the in-memory LLM context — so flagging
     * them lets the undo button peel them off without a host roundtrip.
     */
    function markLastTurnErrored() {
      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      if (entries.length === 0) { return; }
      // Walk back from the tail, marking entries until we hit and include
      // the most recent user entry. Typically that's just one companion
      // (the error message) plus the user bubble before it.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        entry.classList.add('errored');
        if (entry.querySelector('.entry-label.user')) { return; }
      }
    }

    /**
     * Peel off ONE failed turn from the tail — the user bubble plus the
     * error-message companion that follows it, all marked `.errored`.
     * Stops after removing the first user entry it sees, so stacked
     * errors get unwound one click at a time (same cadence as undoing a
     * real pair). Returns the number removed (0 if nothing was errored).
     * No host roundtrip: these entries don't exist in disk/LLM state.
     */
    function removeTrailingErrored() {
      let removed = 0;
      while (transcriptEl.lastElementChild
          && transcriptEl.lastElementChild.classList.contains('errored')) {
        const tail = transcriptEl.lastElementChild;
        const isUser = !!tail.querySelector('.entry-label.user');
        tail.remove();
        removed += 1;
        if (isUser) { break; }
      }
      return removed;
    }

    /**
     * Peel off the trailing (user, companion) pair of entries from the DOM.
     * Mirror of the host-side rollback: removes exactly the two bubbles that
     * correspond to the turn the user is undoing. Skips if the last entry
     * isn't a plain companion reply (e.g. initiative), or if we can't find
     * a preceding user bubble — host and webview agree on the rule so this
     * only differs in edge cases already filtered on the host.
     */
    function removeLastPair() {
      const entries = transcriptEl.querySelectorAll('.transcript-entry');
      if (entries.length < 2) { return false; }
      const last = entries[entries.length - 1];
      const prev = entries[entries.length - 2];
      const lastLabel = last.querySelector('.entry-label');
      const prevLabel = prev.querySelector('.entry-label');
      const lastIsCompanion = lastLabel?.classList.contains('companion')
        && !last.classList.contains('entry-initiative');
      const prevIsUser = prevLabel?.classList.contains('user');
      if (!lastIsCompanion || !prevIsUser) { return false; }
      last.remove();
      prev.remove();
      return true;
    }

    /** Append a "— stopped" suffix to the current streaming entry and finalize. */
    function markStopped() {
      // Capture the element before finalize nulls it; finalize rewrites
      // innerHTML, so appending the suffix BEFORE finalize would nuke it.
      const el = streamingTextEl;
      finishStreamingEntry();
      if (el) {
        const suffix = doc.createElement('span');
        suffix.className = 'stopped-suffix';
        suffix.textContent = ' — stopped';
        el.appendChild(suffix);
      }
    }

    /** Show a "previous session · date" separator before older entries. */
    function appendSessionDivider(timestamp) {
      const div = doc.createElement('div');
      div.className = 'session-divider';
      const date = new Date(timestamp);
      const formatted = date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      }) + ', ' + date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit',
      });
      div.textContent = `previous session · ${formatted}`;
      transcriptEl.appendChild(div);
    }

    function clear() {
      transcriptEl.innerHTML = '';
      streamingTextEl = null;
      streamingText = '';
    }

    function isStreaming() { return streamingTextEl !== null; }

    return {
      appendEntry,
      appendThinking,
      removeThinking,
      startStreamingEntry,
      appendStreamChunk,
      finishStreamingEntry,
      markStopped,
      markLastTurnErrored,
      removeLastPair,
      removeTrailingErrored,
      appendSessionDivider,
      scrollToBottom,
      clear,
      isStreaming,
    };
  }

  if (global) { global.ZeeTranscript = { createTranscript }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTranscript };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
