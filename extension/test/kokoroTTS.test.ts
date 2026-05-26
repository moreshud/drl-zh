import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock worker_threads ────────────────────────────────────────────────────
// vi.hoisted runs before all imports. We build a minimal EventEmitter inline
// since we can't reference external modules inside vi.hoisted.

const { MockWorker, getWorkerInstance } = vi.hoisted(() => {
  let instance: any = null;

  class MW {
    private _listeners: Record<string, Function[]> = {};
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { instance = this; }
    on(event: string, fn: Function) {
      (this._listeners[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this._listeners[event] ?? []) fn(...args);
    }
  }

  return { MockWorker: MW, getWorkerInstance: (): any => instance };
});

vi.mock('worker_threads', () => ({
  Worker: MockWorker,
  parentPort: null,
  workerData: null,
}));

// Import AFTER the mock so the module picks up our fake Worker
import { KokoroTTSProvider } from '../src/providers';

// Reset the module-level singleton between tests by clearing the cached worker
// The singleton is `kokoroWorker` inside providers.ts — we can't access it directly,
// but creating a new KokoroTTSProvider and calling speak() will create a new Worker
// only if the old one is null.  We force that by emitting 'error' to clear it.
function resetWorkerSingleton() {
  if (getWorkerInstance()) {
    getWorkerInstance().emit('error', new Error('test reset'));
  }
}

describe('KokoroTTSProvider (worker integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkerSingleton();
  });

  it('posts message to worker with text and voice', async () => {
    const provider = new KokoroTTSProvider('/tmp/cache');
    const onChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const speakPromise = provider.speak('Hello world', onChunk, onDone, onError);

    // Worker should have received a message
    expect(getWorkerInstance().postMessage).toHaveBeenCalledOnce();
    const msg = getWorkerInstance().postMessage.mock.calls[0][0];
    expect(msg.text).toBe('Hello world');
    expect(msg.voice).toBe('af_heart');
    expect(typeof msg.id).toBe('number');

    // Simulate worker responding with PCM audio
    const fakePcm = Buffer.alloc(100);
    getWorkerInstance().emit('message', { id: msg.id, pcm: fakePcm, sampleRate: 24000 });

    await speakPromise;

    expect(onChunk).toHaveBeenCalledOnce();
    // Verify onChunk received a base64 WAV string
    const b64 = onChunk.mock.calls[0][0];
    expect(typeof b64).toBe('string');
    const wav = Buffer.from(b64, 'base64');
    expect(wav.slice(0, 4).toString()).toBe('RIFF');
    expect(wav.slice(8, 12).toString()).toBe('WAVE');

    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError when worker responds with error', async () => {
    const provider = new KokoroTTSProvider();
    const onChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const speakPromise = provider.speak('Fail', onChunk, onDone, onError);

    const msg = getWorkerInstance().postMessage.mock.calls[0][0];
    getWorkerInstance().emit('message', { id: msg.id, error: 'Model load failed' });

    await speakPromise;

    expect(onChunk).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('Model load failed');
  });

  it('cancel suppresses callbacks when worker responds after cancellation', async () => {
    const provider = new KokoroTTSProvider();
    const onChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const speakPromise = provider.speak('Cancel me', onChunk, onDone, onError);

    const msg = getWorkerInstance().postMessage.mock.calls[0][0];

    // Cancel before worker responds
    provider.cancel();

    // Worker responds late — should be ignored
    getWorkerInstance().emit('message', { id: msg.id, pcm: Buffer.alloc(10), sampleRate: 24000 });

    // The promise will reject because cancel removed the callback,
    // so the message handler finds no callback and ignores it.
    // The promise never resolves — but that's OK because cancelled is true.
    // We need to wait a tick for the internal state to settle.
    await new Promise(r => setTimeout(r, 10));

    expect(onChunk).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    // onError should not fire either since cancelled === true
    expect(onError).not.toHaveBeenCalled();
  });

  it('worker crash rejects all pending callbacks and allows recovery', async () => {
    const provider = new KokoroTTSProvider();
    const onError1 = vi.fn();

    const speakPromise = provider.speak('Crash', vi.fn(), vi.fn(), onError1);

    // Simulate worker crash
    getWorkerInstance().emit('error', new Error('WASM OOM'));

    await speakPromise;

    expect(onError1).toHaveBeenCalledOnce();
    expect(onError1.mock.calls[0][0].message).toBe('WASM OOM');

    // After crash, a new speak() should create a new worker
    const onDone2 = vi.fn();
    const onError2 = vi.fn();
    const speakPromise2 = provider.speak('Recovery', vi.fn(), onDone2, onError2);

    // New worker instance should have been created
    const msg2 = getWorkerInstance().postMessage.mock.calls[0][0];
    getWorkerInstance().emit('message', { id: msg2.id, pcm: Buffer.alloc(10), sampleRate: 24000 });

    await speakPromise2;
    expect(onDone2).toHaveBeenCalledOnce();
    expect(onError2).not.toHaveBeenCalled();
  });

  it('reuses the same worker across multiple speak calls', async () => {
    const provider = new KokoroTTSProvider();

    // First call
    const p1 = provider.speak('First', vi.fn(), vi.fn(), vi.fn());
    const msg1 = getWorkerInstance().postMessage.mock.calls[0][0];
    const worker1 = getWorkerInstance();
    getWorkerInstance().emit('message', { id: msg1.id, pcm: Buffer.alloc(10), sampleRate: 24000 });
    await p1;

    // Second call — should reuse same worker
    const p2 = provider.speak('Second', vi.fn(), vi.fn(), vi.fn());
    const msg2 = getWorkerInstance().postMessage.mock.calls[1][0];
    expect(getWorkerInstance()).toBe(worker1); // same instance
    getWorkerInstance().emit('message', { id: msg2.id, pcm: Buffer.alloc(10), sampleRate: 24000 });
    await p2;
  });
});
