// @ts-check
// Pure decision logic for voice-mode status transitions. Given the incoming
// status + current UI state, returns the action chat.js should take. Pulled
// out so the gating rules (don't restart mic while TTS plays, route to
// "Muted" when muted, etc.) are unit-testable.
//
// Dual-loaded: globalThis.ZeeVoiceStatusReducer for the webview <script> tag,
// CommonJS export for vitest unit tests.

'use strict';

(function (global) {
  /**
   * @typedef {object} VoiceStatusInput
   * @property {string} state       - 'thinking' | 'speaking' | 'idle' | ...
   * @property {boolean} micMuted   - true if the user has the mic muted
   * @property {boolean} ttsActive  - true if local TTS is still playing audio
   */

  /**
   * @typedef {'speaking' | 'idle_start_mic' | 'idle_muted' | 'idle_wait_tts' | 'none'} VoiceStatusAction
   */

  /**
   * @param {VoiceStatusInput} input
   * @returns {VoiceStatusAction}
   */
  function decideVoiceStatusAction({ state, micMuted, ttsActive }) {
    if (state === 'speaking') { return 'speaking'; }
    if (state === 'idle') {
      if (micMuted)   { return 'idle_muted'; }
      if (ttsActive)  { return 'idle_wait_tts'; }
      return 'idle_start_mic';
    }
    return 'none';
  }

  if (global) { global.ZeeVoiceStatusReducer = { decideVoiceStatusAction }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decideVoiceStatusAction };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
