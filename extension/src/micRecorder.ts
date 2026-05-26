// Host-side microphone capture.
//
// VS Code webviews (sidebar WebviewView + WebviewPanel) block
// navigator.mediaDevices.getUserMedia via an iframe Permissions Policy,
// so for native VS Code we capture audio in the Node.js extension host via
// a system recorder (pw-record / parecord / arecord / sox / ffmpeg).
//
// This module owns the full state machine: recorder lifecycle, per-session
// ambient noise calibration, hysteresis-based VAD, and PCM block handoff to
// whoever is transcribing. It emits events; it doesn't know about Moonshine,
// the webview, or the VS Code API.

import { spawn, execSync, ChildProcess } from 'child_process';
import { MicSensitivity, micSensitivityMultiplier } from './providers';

// ── Public constants ─────────────────────────────────────────────────────

export const MIC_SAMPLE_RATE = 16000;

// 50ms @ 16 kHz mono S16 = 1600 bytes per VAD block
const BLOCK_SIZE = 1600;

// Floor / ceiling used until calibration finishes on each session
const FALLBACK_START = 0.055;
const FALLBACK_STOP = 0.030;

// How long the calibration window is (ms); we sample ambient during this
// window to set per-session thresholds.
const CALIBRATION_MS = 500;

// How long RMS must stay below STOP threshold to end an utterance (ms).
const SILENCE_DURATION_MS = 800;

// Shortest utterance we'll transcribe; anything shorter is treated as a
// cough / bump and silently dropped.
const MIN_RECORDING_MS = 300;

// Skip transcription when the loudest block in the recording is below this
// threshold — near-silent audio either produces noise-level hallucinations
// from Moonshine ("thank", "you") or, in rare cases, has caused the ONNX
// inference to hang. Empirically, clearly-audible speech peaks above 0.1;
// 0.05 is a conservative floor that still accepts soft-spoken input.
const MIN_PEAK_RMS_FOR_TRANSCRIBE = 0.05;

// Heartbeat for diagnostic logging (blocks / peakRMS / bytes per second)
const HEARTBEAT_MS = 1000;

// ── Pure helpers (exported for testing) ──────────────────────────────────

/**
 * Locate an available system audio recorder. Returns the command + args,
 * or null if nothing is installed. Order is roughly Linux → macOS.
 */
export function findRecorderCommand(sampleRate = MIC_SAMPLE_RATE): { cmd: string; args: string[] } | null {
  const rate = sampleRate.toString();
  const candidates: Array<{ bin: string; cmd: string; args: string[] }> = [
    { bin: 'pw-record',  cmd: 'pw-record',  args: ['--format', 's16', '--rate', rate, '--channels', '1', '-'] },
    { bin: 'parecord',   cmd: 'parecord',   args: ['--format=s16le', `--rate=${rate}`, '--channels=1', '--raw', '/dev/stdout'] },
    { bin: 'arecord',    cmd: 'arecord',    args: ['-f', 'S16_LE', '-r', rate, '-c', '1', '-t', 'raw', '-q', '-'] },
    { bin: 'sox',        cmd: 'sox',        args: ['-d', '-t', 'raw', '-b', '16', '-e', 'signed-integer', '-r', rate, '-c', '1', '-'] },
    { bin: 'ffmpeg',     cmd: 'ffmpeg',     args: ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', rate, '-f', 's16le', 'pipe:1'] },
  ];
  for (const c of candidates) {
    try { execSync(`which ${c.bin}`, { stdio: 'ignore' }); return { cmd: c.cmd, args: c.args }; } catch { /* not found */ }
  }
  return null;
}

/**
 * RMS volume in [0, 1] from a raw 16-bit LE PCM buffer.
 */
export function computeRMS(block: Buffer): number {
  if (block.length < 2) { return 0; }
  let sumSquares = 0;
  const samples = block.length / 2;
  for (let i = 0; i < block.length; i += 2) {
    const sample = block.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples) / 32768;
}

/**
 * Estimate the ambient noise floor from a window of RMS samples. Uses the
 * 80th percentile rather than max so a single keystroke during calibration
 * doesn't peg the floor artificially high. Clamped to a safe minimum so a
 * dead-silent room doesn't leave thresholds at zero (which would trigger
 * on the tiniest ADC jitter).
 */
export function computeNoiseFloor(samples: number[]): number {
  if (samples.length === 0) { return 0.01; }
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8));
  return Math.max(0.008, sorted[idx]);
}

/**
 * Convert a signed 16-bit LE PCM buffer to Float32Array in [-1, 1].
 * Moonshine (and most ASR models) expect Float32 mono 16 kHz.
 */
export function s16ToFloat32(pcm: Buffer): Float32Array {
  const samples = pcm.length / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Compute the two hysteresis thresholds from a calibrated ambient floor.
 * Pulled out so tests can pin the math without running a live recorder.
 */
export function thresholdsFromFloor(floor: number, sensitivity: MicSensitivity): { start: number; stop: number } {
  const mult = micSensitivityMultiplier(sensitivity);
  // START: 3× the floor, clearly above any ambient peak. Speech energy is
  // typically 10-100× the noise floor, so this triggers reliably on real
  // voice and rejects fan/keyboard noise.
  const start = Math.max(FALLBACK_STOP * 1.2, floor * 3.0 * mult);
  // STOP: 2× the floor with a minimum margin. The old 1.4× multiplier was
  // too tight — the 80th-percentile floor means 20 % of ambient blocks
  // exceed it, and those bursts reset the silence timer indefinitely. 2×
  // leaves enough headroom that routine ambient spikes read as "silent".
  const stop = Math.max(floor * 2.0 * mult, floor + 0.010);
  return { start, stop };
}

// ── Events ───────────────────────────────────────────────────────────────

export interface MicRecorderEvents {
  onVolume: (rms: number) => void;
  onSpeechStart: () => void;
  onSpeechEnd: (pcm: Float32Array) => void;
  onError: (error: Error) => void;
  onStderr?: (line: string) => void;
  onCalibrated?: (floor: number, start: number, stop: number) => void;
}

export interface MicRecorderConfig {
  sensitivity: MicSensitivity;
}

export type MicStartResult = 'started' | 'no_recorder' | 'spawn_failed';

// ── MicRecorder — owns the recording lifecycle + VAD state ───────────────

export class MicRecorder {
  private process: ChildProcess | null = null;

  // VAD state
  private pcmChunks: Buffer[] = [];
  private isRecordingSpeech = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private recordingStartedAt = 0;

  // When true, the caller is busy transcribing — we stop capturing new
  // speech until ready() is called. Prevents overlapping captures.
  private busy = false;

  // Per-session calibration
  private startThreshold = FALLBACK_START;
  private stopThreshold = FALLBACK_STOP;
  private calibrationSamples: number[] = [];
  private calibrationEndsAt = 0;

  // Diagnostics
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pendingBuffer: Buffer = Buffer.alloc(0);

  constructor(
    private config: MicRecorderConfig,
    private events: MicRecorderEvents,
  ) {}

  updateConfig(config: MicRecorderConfig): void {
    this.config = config;
  }

  isActive(): boolean {
    return this.process !== null;
  }

  /**
   * Start a fresh recording session. Each call runs its own calibration.
   * Returns 'no_recorder' when no native recorder is installed — caller
   * should fall back to webview getUserMedia in that case.
   */
  start(): MicStartResult {
    if (this.process) { return 'started'; }
    const recorder = findRecorderCommand(MIC_SAMPLE_RATE);
    if (!recorder) {
      console.log('[zee:mic] no native recorder found');
      return 'no_recorder';
    }
    console.log('[zee:mic] spawning recorder:', recorder.cmd, recorder.args.join(' '));
    try {
      this.process = spawn(recorder.cmd, recorder.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.error('[zee:mic] spawn failed:', err);
      return 'spawn_failed';
    }
    this.resetSession();
    this.attachHandlers(recorder.cmd);
    return 'started';
  }

  /**
   * Hard stop — kill the recorder process, clear buffers. No flush: any
   * in-flight utterance is discarded (the caller's mic-button is pure mute).
   */
  stop(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch { /* already dead */ }
      this.process = null;
    }
    this.resetSession();
  }

  /**
   * Tell the recorder the caller has finished transcribing and is ready to
   * accept the next speech segment. No-op if we're not busy.
   */
  ready(): void {
    this.busy = false;
  }

  /**
   * Force-finish the current utterance without waiting for VAD silence.
   * Used when the user clicks "send now" — lets them commit their speech
   * immediately in environments where ambient noise is high enough to keep
   * resetting the silence timer. No-op if no speech is being captured or
   * if the chunk is shorter than the minimum length.
   *
   * Returns true if a chunk was emitted, false otherwise.
   */
  forceFinishUtterance(): boolean {
    if (!this.process) { return false; }
    if (!this.isRecordingSpeech) { return false; }
    if (this.pcmChunks.length === 0) { return false; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    console.log(`[zee:mic] VAD: force-finish → finishing chunk (${this.pcmChunks.length} blocks)`);
    this.isRecordingSpeech = false;
    this.finishChunk();
    return true;
  }

  // ── Private: session lifecycle ────────────────────────────────────────

  private resetSession(): void {
    this.pcmChunks = [];
    this.isRecordingSpeech = false;
    this.busy = false;
    this.recordingStartedAt = 0;
    this.startThreshold = FALLBACK_START;
    this.stopThreshold = FALLBACK_STOP;
    this.calibrationSamples = [];
    this.calibrationEndsAt = Date.now() + CALIBRATION_MS;
    this.pendingBuffer = Buffer.alloc(0);
  }

  private attachHandlers(cmd: string): void {
    let blockCount = 0;
    let peakRms = 0;
    let bytesReceived = 0;
    this.heartbeat = setInterval(() => {
      console.log(`[zee:mic] blocks=${blockCount} peakRms=${peakRms.toFixed(4)} bytes=${bytesReceived}`);
      blockCount = 0;
      peakRms = 0;
    }, HEARTBEAT_MS);

    this.process!.stdout!.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      this.pendingBuffer = Buffer.concat([this.pendingBuffer, chunk]);
      while (this.pendingBuffer.length >= BLOCK_SIZE) {
        const block = this.pendingBuffer.subarray(0, BLOCK_SIZE);
        this.pendingBuffer = this.pendingBuffer.subarray(BLOCK_SIZE);
        const rms = computeRMS(block);
        blockCount++;
        if (rms > peakRms) { peakRms = rms; }
        this.processBlock(block, rms);
      }
    });

    this.process!.stderr?.on('data', (buf: Buffer) => {
      const line = buf.toString().trim();
      if (line) {
        console.warn(`[zee:mic] ${cmd} stderr:`, line);
        this.events.onStderr?.(line);
      }
    });

    this.process!.on('error', (err) => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.events.onError(err);
    });

    this.process!.on('close', () => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.process = null;
    });
  }

  // ── Private: per-block VAD state machine ──────────────────────────────

  /**
   * Runs on every 50ms block. Emits onVolume always; drives calibration and
   * VAD transitions. Kept as a single method so the control flow is linear
   * and easy to follow.
   */
  private processBlock(block: Buffer, rms: number): void {
    this.events.onVolume(rms);

    // Calibration window: just collect ambient samples, don't trigger speech
    if (Date.now() < this.calibrationEndsAt) {
      this.calibrationSamples.push(rms);
      return;
    }
    // First block after calibration — derive per-session thresholds
    if (this.calibrationSamples.length > 0) {
      const floor = computeNoiseFloor(this.calibrationSamples);
      const { start, stop } = thresholdsFromFloor(floor, this.config.sensitivity);
      this.startThreshold = start;
      this.stopThreshold = stop;
      this.calibrationSamples = [];
      console.log(
        `[zee:mic] calibrated: floor=${floor.toFixed(4)} ` +
        `sensitivity=${this.config.sensitivity} ` +
        `START=${start.toFixed(4)} STOP=${stop.toFixed(4)}`,
      );
      this.events.onCalibrated?.(floor, start, stop);
    }

    if (this.busy) { return; }

    if (!this.isRecordingSpeech && rms > this.startThreshold) {
      // Speech onset: RMS crossed the high threshold, unambiguous voice energy
      this.isRecordingSpeech = true;
      this.pcmChunks = [];
      this.recordingStartedAt = Date.now();
      console.log(`[zee:mic] VAD: speech onset (rms=${rms.toFixed(4)})`);
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      this.events.onSpeechStart();
    }

    if (this.isRecordingSpeech) {
      this.pcmChunks.push(Buffer.from(block));

      // Below STOP threshold for SILENCE_DURATION_MS = sentence boundary
      if (rms <= this.stopThreshold) {
        if (!this.silenceTimer) {
          this.silenceTimer = setTimeout(() => {
            this.silenceTimer = null;
            if (this.isRecordingSpeech) {
              console.log(`[zee:mic] VAD: silence detected → finishing chunk (${this.pcmChunks.length} blocks)`);
              this.isRecordingSpeech = false;
              this.finishChunk();
            }
          }, SILENCE_DURATION_MS);
        }
      } else if (this.silenceTimer) {
        // Speech resumed mid-pause — cancel the countdown
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    }
  }

  private finishChunk(): void {
    if (this.pcmChunks.length === 0) { return; }
    const elapsed = Date.now() - this.recordingStartedAt;
    if (elapsed < MIN_RECORDING_MS) {
      // Too short — likely a cough, keystroke, or bump. Drop silently.
      this.pcmChunks = [];
      return;
    }

    // Peak-RMS gate: if the loudest block in the recording is quiet, this is
    // probably VAD false-tripping on a brief ambient spike, not real speech.
    // Skip Moonshine entirely — it either hallucinates words or (observed on
    // specific inputs) hangs inside ONNX inference, which wedges all future
    // transcriptions until the 20s timeout forces a worker restart.
    let peakRms = 0;
    for (const block of this.pcmChunks) {
      const r = computeRMS(block);
      if (r > peakRms) { peakRms = r; }
    }
    if (peakRms < MIN_PEAK_RMS_FOR_TRANSCRIBE) {
      console.log(`[zee:mic] finishChunk: peakRms=${peakRms.toFixed(4)} below ${MIN_PEAK_RMS_FOR_TRANSCRIBE} — skipping transcription`);
      this.pcmChunks = [];
      return;
    }

    const pcm = s16ToFloat32(Buffer.concat(this.pcmChunks));
    this.pcmChunks = [];
    this.busy = true;  // block new captures until caller calls ready()
    this.events.onSpeechEnd(pcm);
  }
}
