import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-expect-error — webview module exports CommonJS for vitest
import { createTTSPlayback } from '../src/webview/ttsPlayback.js';

// ── Fakes: AudioContext + globals ─────────────────────────────────────────

class FakeBufferSource {
  buffer: any = null;
  playbackRate = { value: 1 };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  destination = {};
  resume = vi.fn();
  decodeAudioData = vi.fn(async (_buf: ArrayBuffer) => ({}));
  createBufferSource = vi.fn(() => new FakeBufferSource());
}

function setupGlobals() {
  (globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
}

describe('createTTSPlayback', () => {
  let sentMessages: any[];
  let speechRate: number;

  beforeEach(() => {
    setupGlobals();
    sentMessages = [];
    speechRate = 1.0;
  });

  function factory(opts: { AudioContextCtor?: any } = {}) {
    return createTTSPlayback({
      vscodeApi: () => ({ postMessage: (m: any) => sentMessages.push(m) }),
      getSpeechRate: () => speechRate,
      audioContextCtor: opts.AudioContextCtor ?? FakeAudioContext,
    });
  }

  it('enqueueChunk + finalizeSentence queues playback', () => {
    const tts = factory();
    tts.enqueueChunk(Buffer.from([1, 2, 3]).toString('base64'));
    tts.finalizeSentence();
    expect(tts.isActive()).toBe(true);
  });

  it('finalizeSentence with no chunks is a no-op', () => {
    const tts = factory();
    tts.finalizeSentence();
    expect(tts.isActive()).toBe(false);
  });

  it('notifies api_tts_done when queue drains', async () => {
    let capturedSource: FakeBufferSource | null = null;
    class Ctx extends FakeAudioContext {
      createBufferSource = vi.fn(() => {
        capturedSource = new FakeBufferSource();
        return capturedSource;
      });
    }
    const tts = factory({ AudioContextCtor: Ctx });

    tts.enqueueChunk(Buffer.from('abc').toString('base64'));
    tts.finalizeSentence();
    // Wait for the decodeAudioData microtask chain
    await new Promise(r => setTimeout(r, 10));

    // Simulate audio playback ending
    capturedSource!.onended?.();

    expect(sentMessages.some(m => m.type === 'api_tts_done')).toBe(true);
  });

  it('cancelAll stops active source and clears queue', async () => {
    let source: FakeBufferSource | null = null;
    class Ctx extends FakeAudioContext {
      createBufferSource = vi.fn(() => { source = new FakeBufferSource(); return source; });
    }
    const tts = factory({ AudioContextCtor: Ctx });

    tts.enqueueChunk(Buffer.from('abc').toString('base64'));
    tts.finalizeSentence();
    await new Promise(r => setTimeout(r, 10));

    tts.cancelAll();
    expect(source!.stop).toHaveBeenCalled();
    expect(tts.isActive()).toBe(false);
    expect(tts.pendingCount()).toBe(0);
  });

  it('cancelAll is safe when nothing is playing', () => {
    const tts = factory();
    expect(() => tts.cancelAll()).not.toThrow();
  });

  it('resumes a suspended AudioContext on next use', () => {
    const resume = vi.fn();
    class Ctx extends FakeAudioContext {
      state: 'suspended' | 'running' | 'closed' = 'suspended';
      resume = resume;
    }
    const tts = factory({ AudioContextCtor: Ctx });
    tts.prime();
    expect(resume).toHaveBeenCalled();
  });

  it('uses the current speech rate at playback time', async () => {
    let source: FakeBufferSource | null = null;
    class Ctx extends FakeAudioContext {
      createBufferSource = vi.fn(() => { source = new FakeBufferSource(); return source; });
    }
    speechRate = 1.25;
    const tts = factory({ AudioContextCtor: Ctx });
    tts.enqueueChunk(Buffer.from('abc').toString('base64'));
    tts.finalizeSentence();
    await new Promise(r => setTimeout(r, 10));
    expect(source!.playbackRate.value).toBe(1.25);
  });

  it('multiple sentences play sequentially, not in parallel', async () => {
    const sources: FakeBufferSource[] = [];
    class Ctx extends FakeAudioContext {
      createBufferSource = vi.fn(() => {
        const s = new FakeBufferSource();
        sources.push(s);
        return s;
      });
    }
    const tts = factory({ AudioContextCtor: Ctx });

    tts.enqueueChunk(Buffer.from('a').toString('base64'));
    tts.finalizeSentence();
    await new Promise(r => setTimeout(r, 10));

    tts.enqueueChunk(Buffer.from('b').toString('base64'));
    tts.finalizeSentence();
    await new Promise(r => setTimeout(r, 10));

    // Only the first is playing; second waits for first to end
    expect(sources).toHaveLength(1);

    // End first — second now starts
    sources[0].onended?.();
    await new Promise(r => setTimeout(r, 10));
    expect(sources).toHaveLength(2);
  });

  it('decode failure skips to the next queued sentence', async () => {
    const sources: FakeBufferSource[] = [];
    class Ctx extends FakeAudioContext {
      decodeAudioData = vi.fn()
        .mockRejectedValueOnce(new Error('bad wav'))
        .mockResolvedValue({});
      createBufferSource = vi.fn(() => { const s = new FakeBufferSource(); sources.push(s); return s; });
    }
    const tts = factory({ AudioContextCtor: Ctx });

    tts.enqueueChunk(Buffer.from('bad').toString('base64'));
    tts.finalizeSentence();
    tts.enqueueChunk(Buffer.from('good').toString('base64'));
    tts.finalizeSentence();
    await new Promise(r => setTimeout(r, 20));

    // First failed, second succeeded
    expect(sources.length).toBe(1);
  });
});
