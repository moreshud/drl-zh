import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  computeRMS, computeNoiseFloor, s16ToFloat32, thresholdsFromFloor,
  findRecorderCommand, MicRecorder, MicRecorderEvents,
} from '../src/micRecorder';

// ── Pure helper tests ─────────────────────────────────────────────────────

describe('computeRMS', () => {
  it('returns 0 for a silent (all-zero) buffer', () => {
    expect(computeRMS(Buffer.alloc(800))).toBe(0);
  });

  it('returns a value in [0, 1] for full-scale alternating samples', () => {
    const buf = Buffer.alloc(800);
    for (let i = 0; i < 400; i++) {
      buf.writeInt16LE(i % 2 === 0 ? 16000 : -16000, i * 2);
    }
    const rms = computeRMS(buf);
    expect(rms).toBeGreaterThan(0.4);
    expect(rms).toBeLessThanOrEqual(1);
  });

  it('returns 0 for too-small buffers', () => {
    expect(computeRMS(Buffer.alloc(1))).toBe(0);
  });
});

describe('computeNoiseFloor', () => {
  it('returns the safe minimum for an empty sample set', () => {
    expect(computeNoiseFloor([])).toBe(0.01);
  });

  it('uses p80 (not max), so a single spike does not peg it', () => {
    const samples = Array(19).fill(0.02).concat([0.5]);
    expect(computeNoiseFloor(samples)).toBeLessThan(0.05);
  });

  it('clamps to a safe minimum so dead-silent rooms do not return zero', () => {
    expect(computeNoiseFloor([0, 0, 0, 0, 0])).toBeGreaterThanOrEqual(0.008);
  });

  it('tracks the noise floor when the room is genuinely noisy', () => {
    expect(computeNoiseFloor(Array(20).fill(0.045))).toBeCloseTo(0.045, 2);
  });
});

describe('s16ToFloat32', () => {
  it('scales signed-16-bit samples into [-1, 1]', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(32767, 2);
    buf.writeInt16LE(-32768, 4);
    const f = s16ToFloat32(buf);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(32767 / 32768, 5);
    expect(f[2]).toBe(-1);
  });

  it('returns empty Float32Array for empty buffer', () => {
    expect(s16ToFloat32(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('thresholdsFromFloor', () => {
  it('produces stable hysteresis (start > stop + margin)', () => {
    const { start, stop } = thresholdsFromFloor(0.04, 'normal');
    expect(start).toBeGreaterThan(stop);
    expect(start - stop).toBeGreaterThan(0.02);
  });

  it('scales with sensitivity: quiet < normal < noisy', () => {
    const q = thresholdsFromFloor(0.04, 'quiet').start;
    const n = thresholdsFromFloor(0.04, 'normal').start;
    const loud = thresholdsFromFloor(0.04, 'noisy').start;
    expect(q).toBeLessThan(n);
    expect(n).toBeLessThan(loud);
  });

  it('floor near zero still produces usable thresholds (no div-by-zero)', () => {
    const { start, stop } = thresholdsFromFloor(0.001, 'normal');
    expect(stop).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(stop);
  });
});

// ── State-machine tests via mocked child_process ──────────────────────────

// We mock child_process so we can drive the recorder's stdout from tests
// without needing a real audio recorder installed.

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ''),  // treat any `which X` as success
}));

import { spawn, execSync } from 'child_process';

describe('findRecorderCommand', () => {
  beforeEach(() => { vi.mocked(execSync).mockReset(); });

  it('returns the first recorder whose `which` succeeds', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('pw-record')) { return ''; }
      throw new Error('not found');
    });
    expect(findRecorderCommand()?.cmd).toBe('pw-record');
  });

  it('falls through to the next candidate when earlier ones are missing', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      // `which arecord` matches arecord exactly, not parecord/pw-record
      if (/\s+arecord$/.test(String(cmd).trim())) { return ''; }
      throw new Error('not found');
    });
    expect(findRecorderCommand()?.cmd).toBe('arecord');
  });

  it('returns null if no recorder is found anywhere', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    expect(findRecorderCommand()).toBeNull();
  });
});

describe('MicRecorder state machine', () => {
  let fakeProc: FakeChildProcess;
  let events: MicRecorderEvents;

  function makeEvents(): MicRecorderEvents {
    return {
      onVolume: vi.fn(),
      onSpeechStart: vi.fn(),
      onSpeechEnd: vi.fn(),
      onError: vi.fn(),
      onStderr: vi.fn(),
      onCalibrated: vi.fn(),
    };
  }

  /**
   * Push a 50ms block (1600 bytes) of constant-amplitude S16 PCM to the
   * recorder's stdout. `amplitude` is a fraction of full-scale (0..1).
   */
  function pushBlock(amplitude: number): void {
    const buf = Buffer.alloc(1600);
    const sample = Math.round(amplitude * 16000);
    for (let i = 0; i < 800; i++) {
      // alternating +/- gives non-zero RMS
      buf.writeInt16LE(i % 2 === 0 ? sample : -sample, i * 2);
    }
    fakeProc.stdout.emit('data', buf);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
    vi.mocked(execSync).mockReturnValue('' as any);   // any which succeeds
    events = makeEvents();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('start() → no_recorder when findRecorderCommand returns null', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    expect(rec.start()).toBe('no_recorder');
    expect(rec.isActive()).toBe(false);
  });

  it('start() → started when recorder is available', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    expect(rec.start()).toBe('started');
    expect(rec.isActive()).toBe(true);
  });

  it('emits onVolume for every block', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    pushBlock(0.05);
    expect(events.onVolume).toHaveBeenCalledTimes(1);
    pushBlock(0.05);
    expect(events.onVolume).toHaveBeenCalledTimes(2);
  });

  it('ignores speech during calibration window, then calibrates once quiet samples land', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();

    // 10 quiet blocks (500ms of ambient at amplitude ~0.04)
    for (let i = 0; i < 10; i++) {
      pushBlock(0.04);
    }

    // No speech-start yet — calibration is still running
    expect(events.onSpeechStart).not.toHaveBeenCalled();
    expect(events.onCalibrated).not.toHaveBeenCalled();

    // Advance past the calibration window and push one more block
    vi.advanceTimersByTime(600);
    pushBlock(0.04);
    expect(events.onCalibrated).toHaveBeenCalledOnce();
  });

  it('emits onSpeechStart when a block crosses the START threshold post-calibration', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    // Calibrate against quiet ambient
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    // First post-calibration block runs calibration + processes speech in the
    // same call. Push a loud block — should trigger onSpeechStart.
    pushBlock(0.4);
    expect(events.onSpeechStart).toHaveBeenCalledOnce();
  });

  it('emits onSpeechEnd after silence duration elapses', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    pushBlock(0.5);  // speech onset
    pushBlock(0.5);
    pushBlock(0.5);
    expect(events.onSpeechStart).toHaveBeenCalledOnce();

    // Drop below STOP threshold — silence countdown begins
    pushBlock(0.01);
    expect(events.onSpeechEnd).not.toHaveBeenCalled();

    // Advance past the silence hold
    vi.advanceTimersByTime(1000);
    expect(events.onSpeechEnd).toHaveBeenCalledOnce();

    const pcm = (events.onSpeechEnd as ReturnType<typeof vi.fn>).mock.calls[0][0] as Float32Array;
    expect(pcm.length).toBeGreaterThan(0);
  });

  it('skips transcription when the loudest block is below MIN_PEAK_RMS threshold', () => {
    // Simulates VAD false-tripping on a brief spike then ambient noise —
    // the chunk is "long enough" timewise but too quiet to be real speech.
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    // Onset pushes a block slightly over START (which is 0.036 from a
    // 0.008 calibrated floor — but with floor * 3.0 * 1.0 = 0.024 min clamped
    // to 0.036). We cross it once, then drop.
    pushBlock(0.05);                // brief spike above START threshold
    vi.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) { pushBlock(0.02); }   // rest is ambient
    pushBlock(0.01);                // triggers silence timer
    vi.advanceTimersByTime(1000);

    // Even though the timer fired, the peak-RMS gate rejected the chunk.
    expect(events.onSpeechEnd).not.toHaveBeenCalled();
  });

  it('emits onSpeechEnd with PCM sized to real utterance duration', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    pushBlock(0.5);
    pushBlock(0.5);
    pushBlock(0.5);
    pushBlock(0.01);
    vi.advanceTimersByTime(1000);

    expect(events.onSpeechEnd).toHaveBeenCalledOnce();
    const pcm = (events.onSpeechEnd as ReturnType<typeof vi.fn>).mock.calls[0][0] as Float32Array;
    // 4 blocks captured (3 speech + 1 silence-trigger) × 800 samples @ 16 kHz
    // = ~200ms of audio. Just sanity-check it's in the right ballpark.
    expect(pcm.length).toBeGreaterThan(1000);
    expect(pcm.length).toBeLessThan(16000 * 2);
  });

  it('stop() kills the process and discards in-flight audio (no flush)', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    pushBlock(0.5);
    pushBlock(0.5);
    rec.stop();

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    // No flush — utterance is discarded on mute
    expect(events.onSpeechEnd).not.toHaveBeenCalled();
    expect(rec.isActive()).toBe(false);
  });

  describe('forceFinishUtterance', () => {
    it('commits an in-flight utterance immediately without waiting for silence', () => {
      const rec = new MicRecorder({ sensitivity: 'normal' }, events);
      rec.start();
      for (let i = 0; i < 10; i++) { pushBlock(0.03); }
      vi.advanceTimersByTime(600);   // finish calibration

      // Speech onset
      pushBlock(0.5);
      expect(events.onSpeechStart).toHaveBeenCalledOnce();
      // Continue speaking — advance past MIN_RECORDING_MS so finishChunk
      // doesn't drop the chunk as too-short.
      vi.advanceTimersByTime(500);
      pushBlock(0.5);
      pushBlock(0.5);
      expect(events.onSpeechEnd).not.toHaveBeenCalled();

      // User clicks "send now" before VAD ever sees silence.
      const emitted = rec.forceFinishUtterance();
      expect(emitted).toBe(true);
      expect(events.onSpeechEnd).toHaveBeenCalledOnce();
    });

    it('returns false (no-op) when not recording speech', () => {
      const rec = new MicRecorder({ sensitivity: 'normal' }, events);
      rec.start();
      for (let i = 0; i < 10; i++) { pushBlock(0.03); }
      vi.advanceTimersByTime(600);

      // Only ambient — no onset fired yet
      expect(rec.forceFinishUtterance()).toBe(false);
      expect(events.onSpeechEnd).not.toHaveBeenCalled();
    });

    it('returns false when the recorder has not been started', () => {
      const rec = new MicRecorder({ sensitivity: 'normal' }, events);
      expect(rec.forceFinishUtterance()).toBe(false);
    });

    it('cancels any pending silence timer on force-finish', () => {
      const rec = new MicRecorder({ sensitivity: 'normal' }, events);
      rec.start();
      for (let i = 0; i < 10; i++) { pushBlock(0.03); }
      vi.advanceTimersByTime(600);

      pushBlock(0.5);
      vi.advanceTimersByTime(500);   // past MIN_RECORDING_MS
      pushBlock(0.5);
      pushBlock(0.01);   // kicks off the silence timer
      rec.forceFinishUtterance();
      expect(events.onSpeechEnd).toHaveBeenCalledOnce();

      // Advance past when the silence timer would have fired — if we didn't
      // cancel it, finishChunk would run a second time.
      vi.advanceTimersByTime(2000);
      expect(events.onSpeechEnd).toHaveBeenCalledOnce();   // still only once
    });
  });

  it('does not start a new utterance while busy (between onSpeechEnd and ready())', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    for (let i = 0; i < 10; i++) { pushBlock(0.03); }
    vi.advanceTimersByTime(600);

    pushBlock(0.5);
    pushBlock(0.5);
    pushBlock(0.5);
    pushBlock(0.01);
    vi.advanceTimersByTime(1000);
    expect(events.onSpeechEnd).toHaveBeenCalledOnce();

    // New loud block arrives while caller is still "transcribing" — ignored
    pushBlock(0.5);
    expect(events.onSpeechStart).toHaveBeenCalledOnce();  // still just the first

    // Caller finishes transcribing → ready() → next onset fires
    rec.ready();
    pushBlock(0.5);
    expect(events.onSpeechStart).toHaveBeenCalledTimes(2);
  });

  it('sensitivity multiplier changes the calibrated START threshold', () => {
    const recQuiet = new MicRecorder({ sensitivity: 'quiet' }, makeEvents());
    recQuiet.start();
    for (let i = 0; i < 10; i++) {
      const buf = Buffer.alloc(1600);
      for (let j = 0; j < 800; j++) { buf.writeInt16LE(j % 2 === 0 ? 1200 : -1200, j * 2); }
      fakeProc.stdout.emit('data', buf);
    }
    vi.advanceTimersByTime(600);
    const quietEvents = (recQuiet as any).events as MicRecorderEvents;
    // Re-calibrate one more push
    fakeProc.stdout.emit('data', Buffer.alloc(1600));
    const quietStart = (quietEvents.onCalibrated as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];

    fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
    const noisyEvents = makeEvents();
    const recNoisy = new MicRecorder({ sensitivity: 'noisy' }, noisyEvents);
    recNoisy.start();
    for (let i = 0; i < 10; i++) {
      const buf = Buffer.alloc(1600);
      for (let j = 0; j < 800; j++) { buf.writeInt16LE(j % 2 === 0 ? 1200 : -1200, j * 2); }
      fakeProc.stdout.emit('data', buf);
    }
    vi.advanceTimersByTime(600);
    fakeProc.stdout.emit('data', Buffer.alloc(1600));
    const noisyStart = (noisyEvents.onCalibrated as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];

    expect(noisyStart).toBeGreaterThan(quietStart);
  });

  it('forwards stderr lines through onStderr', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    fakeProc.stderr.emit('data', Buffer.from('ALSA: device busy\n'));
    expect(events.onStderr).toHaveBeenCalledWith('ALSA: device busy');
  });

  it('surfaces process errors via onError', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.start();
    const err = new Error('EPIPE');
    fakeProc.emit('error', err);
    expect(events.onError).toHaveBeenCalledWith(err);
  });

  it('updateConfig() takes effect on the next recording session', () => {
    const rec = new MicRecorder({ sensitivity: 'normal' }, events);
    rec.updateConfig({ sensitivity: 'noisy' });
    // Sensitivity is read during processBlock, so effectively applied on
    // the next calibration — nothing to assert directly, just that no throw
    expect(rec.isActive()).toBe(false);
  });
});
