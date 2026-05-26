// @ts-check
// Formats the context pill so the student can SEE that Zee is watching.
// Returns a structured list of segments rather than a single string so
// chat.js can render bold "labels" alongside plain text — e.g.:
//
//     👁 [Cell] 2 - L47 - [TODO]: Store a list of lists ...
//
// (where [..] denotes bold). Pure data + no DOM; chat.js does the
// rendering. Tooltip is still a single string for the title= attribute.
//
// Dual-loaded: globalThis.ZeeAwarenessPill for the webview <script>,
// CommonJS export for vitest unit tests.

'use strict';

(function (global) {
  // Keep pill short enough to fit on one line without wrapping even on a
  // narrow sidebar. TODO text past this is ellipsized; tooltip carries the
  // full thing.
  const MAX_DESCRIPTOR_CHARS = 40;

  /**
   * @typedef {object} AwarenessInput
   * @property {string | null | undefined} notebook
   * @property {number | undefined} cell          Active cell index, -1 if none.
   * @property {'code' | 'markdown' | undefined} cellType
   * @property {string | undefined} todoText       Non-empty iff the active cell has a TODO.
   * @property {string | null | undefined} errors  Last execution error text, if any.
   * @property {number | undefined} consecutiveErrors
   * @property {number | undefined} chapter
   * @property {string | undefined} chapterTitle
   * @property {{cellIndex: number, todoText: string} | undefined} [scopeTodo]
   *           Most recent TODO at-or-before the active cell. Surfaced when
   *           the active cell itself isn't a TODO — keeps the pill anchored
   *           to what the student is implementing rather than what they're
   *           currently looking at.
   * @property {number | undefined} [cursorLine]
   *           1-based cursor line within the active cell, or -1 when
   *           unknown (Monaco isn't focused on the cell). When known, the
   *           pill shows an "L<n>" segment; when unknown, the segment is
   *           dropped entirely (no more "?" suffix that flickered while
   *           the snapshot was warming up).
   */

  /**
   * @typedef {{ kind: 'plain' | 'label'; text: string }} PillSegment
   * @property {'plain' | 'label'} kind
   * @property {string} text
   */

  /**
   * @typedef {object} AwarenessPill
   * @property {PillSegment[]} segments  Render label segments as <strong>.
   * @property {string} tooltip          Fuller context shown on hover.
   */

  /** @returns {string} */
  function truncate(s, max) {
    if (s.length <= max) { return s; }
    return s.slice(0, max - 1).trimEnd() + '…';
  }

  /** @param {string} text @returns {PillSegment} */
  function plain(text) { return { kind: 'plain', text }; }
  /** @param {string} text @returns {PillSegment} */
  function label(text) { return { kind: 'label', text }; }

  /**
   * @param {AwarenessInput} ctx
   * @returns {AwarenessPill}
   */
  function formatAwarenessPill(ctx) {
    // Meta mode: empty pill. Caller decides what to display.
    if (!ctx.notebook) {
      return { segments: [], tooltip: '' };
    }

    const cellIdx = ctx.cell;
    // Notebook open but no cell selected yet (e.g. just-after-focus):
    // fall back to a less detailed pill.
    if (cellIdx === undefined || cellIdx < 0) {
      const t = ctx.chapterTitle ?? ctx.notebook;
      return {
        segments: [plain('👁 '), plain(t)],
        tooltip: ctx.notebook,
      };
    }

    // Display cell numbers 1-based — the student counts cells starting at
    // 1 ("the second cell" = cell 2). The internal `cellIdx` is 0-based
    // (it's a notebook API index); we shift only at the display boundary.
    const cellLabel = cellIdx + 1;

    /** @type {PillSegment[]} */
    const segments = [
      plain('👁 '),
      label('Cell'),
      plain(' ' + cellLabel),
    ];

    // Cursor line — only included when known. Sits between cell and the
    // descriptor so the eye reads "Cell 2 - L47 - TODO: …" left-to-right.
    const cursorKnown = typeof ctx.cursorLine === 'number' && ctx.cursorLine > 0;
    if (cursorKnown) {
      segments.push(plain(' - L' + ctx.cursorLine));
    }

    // Descriptor: priority is errors → active TODO → scope TODO → reading/coding.
    if (ctx.errors) {
      segments.push(plain(' - '), label('Debugging'));
      if (ctx.consecutiveErrors && ctx.consecutiveErrors > 1) {
        segments.push(plain(` (${ctx.consecutiveErrors} errors)`));
      }
    } else if (ctx.todoText) {
      segments.push(plain(' - '), label('TODO:'), plain(' ' + truncate(ctx.todoText, MAX_DESCRIPTOR_CHARS)));
    } else if (ctx.scopeTodo) {
      segments.push(plain(' - '), label('TODO:'), plain(' ' + truncate(ctx.scopeTodo.todoText, MAX_DESCRIPTOR_CHARS)));
    } else if (ctx.cellType === 'markdown') {
      segments.push(plain(' - '), label('Reading'));
    } else {
      segments.push(plain(' - '), label('Coding'));
    }

    const tooltipParts = [];
    if (ctx.chapter !== undefined && ctx.chapterTitle) {
      tooltipParts.push(`Chapter ${ctx.chapter}: ${ctx.chapterTitle}`);
    }
    tooltipParts.push(`cell ${cellLabel}`);
    if (cursorKnown) { tooltipParts.push(`line ${ctx.cursorLine}`); }
    if (ctx.todoText) {
      tooltipParts.push(`TODO: ${ctx.todoText}`);
    } else if (ctx.scopeTodo) {
      tooltipParts.push(`scope TODO (cell ${ctx.scopeTodo.cellIndex + 1}): ${ctx.scopeTodo.todoText}`);
    }
    if (ctx.errors) {
      const errLine = (ctx.errors.split('\n')[0] || '').slice(0, 120);
      tooltipParts.push(`last error: ${errLine}`);
    }
    if (!cursorKnown) {
      tooltipParts.push('cursor not focused — TODO inference may be imprecise');
    }

    return { segments, tooltip: tooltipParts.join(' · ') };
  }

  /**
   * Helper for tests: flatten segments to a single plain string so existing
   * `.toContain('cell 2')`-style assertions work without segment iteration.
   * @param {PillSegment[]} segs
   * @returns {string}
   */
  function plainText(segs) {
    return segs.map(s => s.text).join('');
  }

  if (global) { global.ZeeAwarenessPill = { formatAwarenessPill, plainText }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatAwarenessPill, plainText };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
