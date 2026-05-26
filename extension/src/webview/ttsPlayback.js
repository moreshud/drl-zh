// @ts-check
// Webview-side TTS audio playback. Kokoro (in the extension host worker)
// emits one full WAV buffer per sentence as base64, which lands here via
// tts_chunk messages. This module decodes, queues, and plays them through
// a shared AudioContext.
//
// Design notes:
//   - A SINGLE AudioContext is reused across playback. Chromium's autoplay
//     policy requires a user gesture to resume suspended contexts, and
//     creating a fresh context per sentence fails when audio arrives seconds
//     after the gesture. We create it lazily on first need.
//   - Sentences are played sequentially. A queue lets the next sentence be
//     decoded while the current one plays.
//   - When the queue empties, we notify the host via `api_tts_done` so it
//     knows the audio finished playing (synthesis may have completed earlier).
//
// Dual-loaded:
//   - webview: attaches TTSPlayback to globalThis
//   - vitest:  CommonJS export for unit testing with a stubbed AudioContext

'use strict';

(function (global) {
  /**
   * @typedef {object} TTSPlaybackDeps
   * @property {() => { postMessage: (msg: any) => void }} vscodeApi  returns the acquired VS Code webview API
   * @property {() => number} getSpeechRate  current playback rate (1.0 = normal)
   * @property {typeof AudioContext} [audioContextCtor]  override for tests
   */

  /**
   * @param {TTSPlaybackDeps} deps
   */
  function createTTSPlayback(deps) {
    const AudioContextCtor = deps.audioContextCtor ?? (typeof AudioContext !== 'undefined' ? AudioContext : null);
    if (!AudioContextCtor) {
      throw new Error('TTSPlayback requires AudioContext');
    }

    /** @type {Uint8Array[]} */
    let pendingChunks = [];
    /** @type {ArrayBuffer[]} */
    let playQueue = [];
    let isPlaying = false;
    /** @type {AudioBufferSourceNode | null} */
    let activeSource = null;
    /** @type {AudioContext | null} */
    let ctx = null;

    function getCtx() {
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContextCtor();
      }
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      return ctx;
    }

    /**
     * Called on user gesture to ensure the context is ready. Does nothing if
     * already primed. Safe to call many times.
     */
    function prime() {
      getCtx();
    }

    /**
     * Queue a base64-encoded audio chunk for the current sentence.
     */
    function enqueueChunk(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      pendingChunks.push(bytes);
    }

    /**
     * Concatenate all pending chunks into a complete sentence buffer and
     * queue it for playback. Starts playback if nothing is currently playing.
     */
    function finalizeSentence() {
      if (pendingChunks.length === 0) return;
      const totalLen = pendingChunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of pendingChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      pendingChunks = [];
      playQueue.push(merged.buffer);
      if (!isPlaying) { playNext(); }
    }

    function playNext() {
      if (playQueue.length === 0) {
        isPlaying = false;
        activeSource = null;
        deps.vscodeApi().postMessage({ type: 'api_tts_done' });
        return;
      }
      isPlaying = true;
      const audioData = /** @type {ArrayBuffer} */ (playQueue.shift());

      const audioCtx = getCtx();
      audioCtx.decodeAudioData(audioData).then((buffer) => {
        const source = audioCtx.createBufferSource();
        activeSource = source;
        source.buffer = buffer;
        source.playbackRate.value = deps.getSpeechRate();
        source.connect(audioCtx.destination);
        source.onended = () => {
          activeSource = null;
          playNext();
        };
        source.start();
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[zee:tts] decode/play error:', err);
        playNext();
      });
    }

    /**
     * Hard-cancel all playback: stop the current source, drop the queue,
     * discard any pending chunks. The AudioContext is NOT closed so future
     * playback can resume without requiring a fresh user gesture.
     */
    function cancelAll() {
      pendingChunks = [];
      playQueue = [];
      isPlaying = false;
      if (activeSource) {
        try { activeSource.stop(); } catch { /* already stopped */ }
        activeSource = null;
      }
    }

    function isActive() { return isPlaying; }
    function pendingCount() { return pendingChunks.length + playQueue.length; }

    return {
      prime,
      enqueueChunk,
      finalizeSentence,
      cancelAll,
      isActive,
      pendingCount,
    };
  }

  if (global) { global.ZeeTTSPlayback = { createTTSPlayback }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTTSPlayback };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
