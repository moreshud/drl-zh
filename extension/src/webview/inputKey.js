// @ts-check
// Tiny pure helper for deciding what a key event in the chat textarea
// should do. Pulled out so the rule (Enter sends, Shift+Enter inserts a
// newline, modifier-Enter or autocomplete passes through) is unit-testable.
//
// Dual-loaded: globalThis.ZeeInputKey for the webview, CommonJS for tests.

'use strict';

(function (global) {
  /**
   * @typedef {object} KeyLikeEvent
   * @property {string} key
   * @property {boolean} [shiftKey]
   * @property {boolean} [ctrlKey]
   * @property {boolean} [metaKey]
   * @property {boolean} [altKey]
   * @property {boolean} [isComposing]   // IME composition in progress
   */

  /** @typedef {'send' | 'newline' | 'pass'} KeyAction */

  /**
   * @param {KeyLikeEvent} ev
   * @returns {KeyAction}
   */
  function decideKeyAction(ev) {
    if (ev.key !== 'Enter') { return 'pass'; }
    // Don't trigger send while an IME composition is open — pressing Enter
    // there means "commit the candidate", not "send the message".
    if (ev.isComposing) { return 'pass'; }
    if (ev.shiftKey) { return 'newline'; }
    // Ctrl/Cmd/Alt + Enter falls through to whatever the platform does.
    if (ev.ctrlKey || ev.metaKey || ev.altKey) { return 'pass'; }
    return 'send';
  }

  if (global) { global.ZeeInputKey = { decideKeyAction }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decideKeyAction };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
