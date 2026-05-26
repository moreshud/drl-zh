import * as path from 'path';
import { Worker } from 'worker_threads';
import { pcmToWav } from './audioUtils';

export interface TTSProvider {
  name: string;
  speak(
    text: string,
    onAudioChunk: (base64Audio: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
  ): Promise<void>;
  cancel(): void;
}

// ── Worker lifecycle (module-scoped singleton) ────────────────────────────

let kokoroWorker: Worker | null = null;
let kokoroMsgId = 0;
const kokoroCallbacks = new Map<number, {
  resolve: (pcm: Buffer, sampleRate: number) => void;
  reject: (err: Error) => void;
}>();

function getKokoroWorker(cacheDir?: string): Worker {
  if (kokoroWorker) { return kokoroWorker; }

  const workerPath = path.join(__dirname, 'kokoroWorker.js');
  kokoroWorker = new Worker(workerPath, { workerData: { cacheDir } });

  kokoroWorker.on('message', (msg: { id: number; pcm?: Buffer; sampleRate?: number; error?: string }) => {
    const cb = kokoroCallbacks.get(msg.id);
    if (!cb) { return; }
    kokoroCallbacks.delete(msg.id);
    if (msg.error) {
      cb.reject(new Error(msg.error));
    } else {
      cb.resolve(msg.pcm!, msg.sampleRate!);
    }
  });

  kokoroWorker.on('error', (err) => {
    console.error('[zee:kokoro] worker error:', err);
    // Worker crashed — reject all pending, allow recreation
    for (const cb of kokoroCallbacks.values()) { cb.reject(err); }
    kokoroCallbacks.clear();
    kokoroWorker = null;
  });

  // Abnormal exit (OOM, crashed native module, etc.) — 'error' doesn't fire
  // in all such cases. Without this, pending speak() calls would hang.
  kokoroWorker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[zee:kokoro] worker exited abnormally (code=${code})`);
      const err = new Error(`Kokoro worker exited abnormally (code=${code})`);
      for (const cb of kokoroCallbacks.values()) { cb.reject(err); }
      kokoroCallbacks.clear();
    }
    kokoroWorker = null;
  });

  return kokoroWorker;
}

// ── KokoroTTSProvider ─────────────────────────────────────────────────────

/**
 * Local neural text-to-speech via Kokoro ONNX in a worker thread. One WAV
 * blob per sentence, streamed back to the webview as base64.
 */
export class KokoroTTSProvider implements TTSProvider {
  name = 'Kokoro';
  private cancelled = false;
  private cacheDir: string | undefined;
  private pendingId: number | null = null;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  async speak(
    text: string,
    onAudioChunk: (base64Audio: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    this.cancelled = false;
    try {
      const worker = getKokoroWorker(this.cacheDir);
      const id = ++kokoroMsgId;
      this.pendingId = id;

      const { pcm, sampleRate } = await new Promise<{ pcm: Buffer; sampleRate: number }>((resolve, reject) => {
        kokoroCallbacks.set(id, {
          resolve: (p, sr) => resolve({ pcm: p, sampleRate: sr }),
          reject,
        });
        worker.postMessage({ id, text, voice: 'af_heart' });
      });

      if (this.cancelled) { return; }

      const wav = pcmToWav(pcm, sampleRate);
      onAudioChunk(wav.toString('base64'));
      onDone();
    } catch (err: unknown) {
      if (this.cancelled) { return; }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  cancel(): void {
    this.cancelled = true;
    if (this.pendingId !== null) {
      kokoroCallbacks.delete(this.pendingId);
      this.pendingId = null;
    }
  }
}

export function getTTSProvider(kokoroCacheDir?: string): TTSProvider {
  return new KokoroTTSProvider(kokoroCacheDir);
}
