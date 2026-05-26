// @ts-check
// Webview-side microphone capture — the fallback used in Docker / code-server
// where the native extension-host recorder isn't available because the
// container has no audio hardware. Browser webviews can reach the user's
// mic via getUserMedia; we decode + resample to 16 kHz Float32, then base64
// the PCM and send to the host via `voice_audio` messages for Moonshine
// to transcribe.
//
// Design:
//   - getUserMedia + MediaStream + MediaRecorder for capture
//   - AnalyserNode for VAD (byte-frequency average over 256-point FFT)
//   - Threshold-based onset + silence detection (simple; the host path
//     has hysteresis + auto-calibration because it uses per-block RMS,
//     but the webview path's analyser average is smoother so thresholds
//     work fine)
//   - MediaRecorder emits a blob per silence → decoded via OfflineAudioContext
//     to 16 kHz Float32 PCM → base64 → host
//
// Dual-loaded: globalThis.ZeeVoiceCapture + CommonJS export.

'use strict';

(function (global) {
  const SILENCE_THRESHOLD = 15;     // 0-255 byte-frequency average
  const SILENCE_DURATION = 1500;    // ms below threshold before we cut
  const MIN_RECORDING = 500;        // shortest utterance we'll send (ms)

  /**
   * @typedef {object} VoiceCaptureDeps
   * @property {{ postMessage: (m: any) => void }} vscodeApi
   * @property {(state: string, text: string) => void} setStatus   updates the voice status pill
   * @property {() => void} onActivity                              called when speech energy detected
   * @property {() => boolean} isVoiceMode                          returns true while the voice input is live
   * @property {() => boolean} isTranscribing                       true while a previous utterance is still being transcribed
   * @property {(busy: boolean) => void} setTranscribing            mark the transcribe-in-flight flag
   */

  /**
   * @param {VoiceCaptureDeps} deps
   */
  function createVoiceCapture(deps) {
    /** @type {AudioContext | null} */
    let audioCtx = null;
    /** @type {AnalyserNode | null} */
    let analyser = null;
    /** @type {MediaStream | null} */
    let micStream = null;
    /** @type {MediaRecorder | null} */
    let mediaRecorder = null;
    /** @type {Blob[]} */
    let recordingChunks = [];
    let isRecording = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let silenceTimer = null;
    let recordingStartedAt = 0;

    async function start() {
      if (audioCtx) { return; }  // already started
      if (!navigator.mediaDevices?.getUserMedia) {
        deps.setStatus('error', 'No mic access available in this browser.');
        throw new Error('getUserMedia unavailable');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream = stream;
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        setupMediaRecorder(stream);
        deps.setStatus('', 'Listening...');
      } catch (err) {
        /** @type {any} */
        const e = err;
        // eslint-disable-next-line no-console
        console.error('[zee] webview getUserMedia failed:', e?.name, e?.message);
        const name = e?.name ?? '';
        let msg;
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
          msg = 'Grant microphone permission in your browser, then click the mic again.';
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          msg = 'No microphone detected in your browser.';
        } else {
          msg = 'Mic unavailable: ' + (e?.message ?? 'unknown error');
        }
        deps.setStatus('error', msg);
        throw err;
      }
    }

    function stop() {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch { /* already stopped */ }
      }
      isRecording = false;
      mediaRecorder = null;
      recordingChunks = [];
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
      if (audioCtx) { audioCtx.close(); audioCtx = null; analyser = null; }
    }

    function isCapturing() { return audioCtx !== null; }

    /**
     * Current local RMS-like value (byte-frequency average), scaled into the
     * same [0, 0.15] range as the host-path mic_volume events so the same
     * visualizer code can draw it without branching on the path.
     */
    function getLocalVolume() {
      if (!analyser) { return 0; }
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      return (avg / 255) * 0.15;
    }

    function setupMediaRecorder(stream) {
      const mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordingChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (!mediaRecorder || recordingChunks.length === 0 || deps.isTranscribing()) {
          recordingChunks = [];
          return;
        }
        const elapsed = Date.now() - recordingStartedAt;
        if (elapsed < MIN_RECORDING) { recordingChunks = []; return; }

        const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        recordingChunks = [];
        try {
          const base64 = await encodeToPCM16kBase64(blob);
          if (base64) {
            deps.setTranscribing(true);
            deps.setStatus('transcribing', 'Transcribing...');
            deps.vscodeApi.postMessage({ type: 'voice_audio', audio: base64 });
          }
        } catch {
          deps.setStatus('error', 'Audio decode failed.');
        }
      };

      startVAD();
    }

    function startVAD() {
      if (!analyser || !deps.isVoiceMode()) { return; }
      const data = new Uint8Array(analyser.frequencyBinCount);

      function tick() {
        if (!deps.isVoiceMode() || !analyser) { return; }
        /** @type {AnalyserNode} */ (analyser).getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;

        if (avg > SILENCE_THRESHOLD) { deps.onActivity(); }

        if (!isRecording && avg > SILENCE_THRESHOLD && !deps.isTranscribing()) {
          isRecording = true;
          recordingChunks = [];
          recordingStartedAt = Date.now();
          try { /** @type {MediaRecorder} */ (mediaRecorder).start(100); } catch { /* already started */ }
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
          deps.setStatus('recording', 'Recording...');
        } else if (isRecording && avg <= SILENCE_THRESHOLD) {
          if (!silenceTimer) {
            silenceTimer = setTimeout(() => {
              if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
                isRecording = false;
                try { mediaRecorder.stop(); } catch { /* ok */ }
              }
              silenceTimer = null;
            }, SILENCE_DURATION);
          }
        } else if (isRecording && avg > SILENCE_THRESHOLD) {
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    return { start, stop, isCapturing, getLocalVolume };
  }

  /**
   * Decode a browser-recorded audio blob to 16 kHz Float32 mono PCM and
   * return it base64-encoded — the shape Moonshine expects on the host.
   * Exported for testing; callers normally shouldn't need to touch it.
   */
  async function encodeToPCM16kBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const Ctor = (typeof AudioContext !== 'undefined')
      ? AudioContext
      : /** @type {any} */ (global).webkitAudioContext;
    const decodeCtx = new Ctor();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    } finally {
      decodeCtx.close();
    }
    const targetRate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const OfflineCtor = (typeof OfflineAudioContext !== 'undefined')
      ? OfflineAudioContext
      : /** @type {any} */ (global).webkitOfflineAudioContext;
    const offline = new OfflineCtor(1, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
  }

  if (global) { global.ZeeVoiceCapture = { createVoiceCapture, encodeToPCM16kBase64 }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createVoiceCapture, encodeToPCM16kBase64 };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
