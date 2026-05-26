import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock child_process.fork ───────────────────────────────────────────────
// MoonshineSTT spawns a child process (not a worker thread) because ORT's
// native state conflicts with Kokoro's when shared across worker threads.

const { MockChild, getChildInstance } = vi.hoisted(() => {
  let instance: any = null;

  class MC {
    private _listeners: Record<string, Function[]> = {};
    send = vi.fn((_msg: any, cb?: (err: Error | null) => void) => { cb?.(null); return true; });
    kill = vi.fn();
    constructor() { instance = this; }
    on(event: string, fn: Function) {
      (this._listeners[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this._listeners[event] ?? []) fn(...args);
    }
  }

  return { MockChild: MC, getChildInstance: (): any => instance };
});

vi.mock('child_process', () => ({
  fork: vi.fn(() => new MockChild()),
}));

import { MoonshineSTT } from '../src/providers';

function resetChildSingleton() {
  if (getChildInstance()) {
    getChildInstance().emit('error', new Error('test reset'));
  }
}

describe('MoonshineSTT (child-process integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChildSingleton();
  });

  it('sends PCM to child and returns text', async () => {
    const stt = new MoonshineSTT('/tmp/cache');
    const pcm = new Float32Array([0.1, -0.2, 0.3, 0]);

    const promise = stt.transcribe(pcm);

    expect(getChildInstance().send).toHaveBeenCalledOnce();
    const msg = getChildInstance().send.mock.calls[0][0];
    expect(typeof msg.id).toBe('number');
    expect(msg.pcm).toBe(pcm);

    getChildInstance().emit('message', { id: msg.id, text: 'hello world' });

    const text = await promise;
    expect(text).toBe('hello world');
  });

  it('returns null for empty transcription', async () => {
    const stt = new MoonshineSTT();
    const promise = stt.transcribe(new Float32Array(16));

    const msg = getChildInstance().send.mock.calls[0][0];
    getChildInstance().emit('message', { id: msg.id, text: '' });

    expect(await promise).toBeNull();
  });

  it('rejects when child responds with an error', async () => {
    const stt = new MoonshineSTT();
    const promise = stt.transcribe(new Float32Array(16));

    const msg = getChildInstance().send.mock.calls[0][0];
    getChildInstance().emit('message', { id: msg.id, error: 'Model load failed' });

    await expect(promise).rejects.toThrow('Model load failed');
  });

  it('rejects with timeout error if the child never responds', async () => {
    // Regression guard for the "stuck at Transcribing" hang: even if the
    // child deadlocks mid-inference, transcribe() must unblock after
    // timeoutMs so the caller can surface an error instead of spinning.
    const stt = new MoonshineSTT();
    const promise = stt.transcribe(new Float32Array(16), /* timeoutMs */ 20);

    await expect(promise).rejects.toThrow(/timed out after 20ms/);
  });

  it('cancel resolves the pending transcribe with null so the caller unblocks', async () => {
    // Regression: previously cancel() removed the callback from the map
    // and the Promise hung forever, which caused the webview to get stuck
    // on "Transcribing…" any time anything triggered a cancel.
    const stt = new MoonshineSTT();

    const promise = stt.transcribe(new Float32Array(16));
    stt.cancel();

    const result = await Promise.race([
      promise,
      new Promise<'TIMEOUT'>(r => setTimeout(() => r('TIMEOUT'), 100)),
    ]);
    expect(result).toBeNull();
  });

  it('child crash rejects all pending callbacks and allows recovery', async () => {
    const stt = new MoonshineSTT();
    const promise = stt.transcribe(new Float32Array(16));

    getChildInstance().emit('error', new Error('native crash'));

    await expect(promise).rejects.toThrow('native crash');

    // Next call should create a fresh child
    const promise2 = stt.transcribe(new Float32Array(16));
    const msg2 = getChildInstance().send.mock.calls[0][0];
    getChildInstance().emit('message', { id: msg2.id, text: 'back' });
    expect(await promise2).toBe('back');
  });

  it('reuses the same child across multiple transcribe calls', async () => {
    const stt = new MoonshineSTT();

    const p1 = stt.transcribe(new Float32Array(16));
    const child1 = getChildInstance();
    const msg1 = child1.send.mock.calls[0][0];
    child1.emit('message', { id: msg1.id, text: 'one' });
    await p1;

    const p2 = stt.transcribe(new Float32Array(16));
    expect(getChildInstance()).toBe(child1);
    const msg2 = child1.send.mock.calls[1][0];
    child1.emit('message', { id: msg2.id, text: 'two' });
    expect(await p2).toBe('two');
  });
});
