// @ts-check
// FaceController — drives the Zee avatar SVG state machine.
//
// Dual-loaded:
//  - in the VS Code webview via <script src="face.js">, where it attaches
//    FaceController to globalThis so chat.js can reach it;
//  - in vitest via `import { FaceController } from '../src/webview/face.js'`,
//    where the CommonJS export is picked up.
//
// The class is DOM-agnostic: it only needs an element-like object exposing
// `setAttribute(name, value)` and (optionally) `style.setProperty(name, value)`.
// This keeps the unit tests light — they hand in a tiny stub.

'use strict';

(function (global) {
  const VALID_STATES = ['idle', 'drowsy', 'listening', 'thinking', 'speaking'];

  /**
   * Collapse a set of flags into the single face state.
   * Priority: speaking > listening > thinking > drowsy > idle.
   *
   * Speaking wins because TTS playback pauses the mic (so listening is impossible
   * during speech) and the LLM response has already completed (so thinking is
   * done). Drowsy (soft-idle presence) is a subtle variant of idle that's
   * overridden by any active interaction flag.
   *
   * @param {{ isSpeaking?: boolean, isListening?: boolean, isThinking?: boolean, isDrowsy?: boolean }} flags
   * @returns {'idle' | 'drowsy' | 'listening' | 'thinking' | 'speaking'}
   */
  function deriveFaceState(flags) {
    if (!flags) { return 'idle'; }
    if (flags.isSpeaking) { return 'speaking'; }
    if (flags.isListening) { return 'listening'; }
    if (flags.isThinking) { return 'thinking'; }
    if (flags.isDrowsy) { return 'drowsy'; }
    return 'idle';
  }

  class FaceController {
    /**
     * @param {{ setAttribute: (name: string, value: string) => void, style?: { setProperty: (name: string, value: string) => void } }} svg
     */
    constructor(svg) {
      if (!svg || typeof svg.setAttribute !== 'function') {
        throw new Error('FaceController requires an element with setAttribute');
      }
      this.svg = svg;
      this._state = 'idle';
      this._mouthIntensity = 0;
      // Push the initial attribute so the element reflects default state.
      this.svg.setAttribute('data-state', 'idle');
    }

    /**
     * @param {string} state
     * @returns {boolean} true if the state was applied, false if rejected
     */
    setState(state) {
      if (!VALID_STATES.includes(state)) { return false; }
      if (this._state === state) { return true; }
      this._state = /** @type {'idle' | 'drowsy' | 'listening' | 'thinking' | 'speaking'} */ (state);
      this.svg.setAttribute('data-state', state);
      return true;
    }

    /**
     * Seam for amplitude-reactive mouth. Value clamped to [0, 1]; writes to
     * the --mouth-intensity CSS custom property so CSS can scale the waveform.
     *
     * @param {number} value
     */
    setMouthIntensity(value) {
      const n = Number(value);
      const clamped = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
      this._mouthIntensity = clamped;
      if (this.svg.style && typeof this.svg.style.setProperty === 'function') {
        this.svg.style.setProperty('--mouth-intensity', clamped.toFixed(3));
      }
    }

    getState() { return this._state; }
    getMouthIntensity() { return this._mouthIntensity; }
  }

  FaceController.VALID_STATES = VALID_STATES;
  FaceController.deriveFaceState = deriveFaceState;

  // Webview: attach to global so chat.js can reach it.
  if (global) { global.FaceController = FaceController; }

  // Node / vitest: CommonJS export.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FaceController, deriveFaceState };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
