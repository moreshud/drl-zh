import * as path from 'path';
import { fork, ChildProcess } from 'child_process';

// ── Child-process lifecycle (module-scoped singleton) ────────────────────
//
// Moonshine runs in a separate Node.js process — not a worker thread —
// because onnxruntime-node's native state isn't safe to share with Kokoro
// across worker threads in the same process (V8 crashes with
// "Check failed: maybe_code.has_value()" on the second inference). A child
// process has its own onnxruntime instance, which is the clean fix.

let moonshineChild: ChildProcess | null = null;
let moonshineMsgId = 0;
const moonshineCallbacks = new Map<number, {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}>();

/**
 * Forcefully kill the singleton child and reject every pending callback.
 * Next transcribe() gets a fresh child. Used when we detect a stuck
 * inference — paying the ~1-2s model reload cost is strictly better than
 * hanging.
 */
function terminateMoonshineChild(reason: Error): void {
  if (!moonshineChild) { return; }
  try { moonshineChild.kill('SIGKILL'); } catch { /* already dead */ }
  for (const cb of moonshineCallbacks.values()) { cb.reject(reason); }
  moonshineCallbacks.clear();
  moonshineChild = null;
}

function getMoonshineChild(cacheDir?: string): ChildProcess {
  if (moonshineChild) { return moonshineChild; }

  const workerPath = path.join(__dirname, 'moonshineWorker.js');
  console.log(`[zee:moonshine] forking child (cacheDir=${cacheDir ?? 'default'})`);
  // Strip VS Code extension-host Node flags (like --inspect-port=N) so the
  // child doesn't inherit them and exit with code 9 "Invalid Argument".
  // Also clear NODE_OPTIONS for the same reason. Keep ELECTRON_RUN_AS_NODE
  // — process.execPath is the Electron binary and that env var is what
  // makes it behave as a plain Node runtime.
  const { NODE_OPTIONS: _stripNodeOptions, ...cleanEnv } = process.env;
  moonshineChild = fork(workerPath, [], {
    env: {
      ...cleanEnv,
      ...(cacheDir ? { ZEE_MOONSHINE_CACHE_DIR: cacheDir } : {}),
    },
    execArgv: [],
    // Advanced serialization lets us send Float32Array directly through IPC
    // (structured clone) instead of round-tripping through JSON.
    serialization: 'advanced',
    // Inherit stdio so the child's console logs appear in the same stream
    // as the extension host — useful for debugging turn-by-turn behavior.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  moonshineChild.on('message', (msg: { id: number; text?: string; error?: string }) => {
    const cb = moonshineCallbacks.get(msg.id);
    if (!cb) { return; }
    moonshineCallbacks.delete(msg.id);
    if (msg.error) {
      cb.reject(new Error(msg.error));
    } else {
      cb.resolve(msg.text ?? '');
    }
  });

  moonshineChild.on('error', (err) => {
    console.error('[zee:moonshine] child error:', err);
    for (const cb of moonshineCallbacks.values()) { cb.reject(err); }
    moonshineCallbacks.clear();
    moonshineChild = null;
  });

  moonshineChild.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[zee:moonshine] child exited abnormally (code=${code}, signal=${signal})`);
      const err = new Error(`Moonshine child exited abnormally (code=${code})`);
      for (const cb of moonshineCallbacks.values()) { cb.reject(err); }
      moonshineCallbacks.clear();
    }
    moonshineChild = null;
  });

  return moonshineChild;
}

// ── MoonshineSTT ──────────────────────────────────────────────────────────

/**
 * Local speech-to-text via Moonshine (ONNX) in a child process. Input is
 * Float32 PCM at 16 kHz mono.
 *
 * Design notes:
 * - transcribe() awaits a Promise keyed by a per-call ID. A timeout forces
 *   a child restart so a stuck inference can't starve future calls; cancel()
 *   resolves (not just deletes) the pending promise to guarantee unblocking.
 */
export class MoonshineSTT {
  name = 'Moonshine';
  private cancelled = false;
  private cacheDir: string | undefined;
  private pendingId: number | null = null;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  async transcribe(pcm: Float32Array, timeoutMs = 8_000): Promise<string | null> {
    this.cancelled = false;
    const child = getMoonshineChild(this.cacheDir);
    const id = ++moonshineMsgId;
    this.pendingId = id;

    console.log(`[zee:moonshine] transcribe id=${id} samples=${pcm.length} (${(pcm.length / 16000).toFixed(2)}s)`);

    // Advanced-serialization IPC clones the Float32Array for us, so we can
    // send the caller's view directly — no copy needed here.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    const text = await new Promise<string>((resolve, reject) => {
      moonshineCallbacks.set(id, {
        resolve: (t) => { if (timer) { clearTimeout(timer); } resolve(t); },
        reject: (e) => { if (timer) { clearTimeout(timer); } reject(e); },
      });
      timer = setTimeout(() => {
        moonshineCallbacks.delete(id);
        console.error(`[zee:moonshine] id=${id} timed out after ${timeoutMs}ms — terminating child`);
        terminateMoonshineChild(new Error('stuck on transcription — force restart'));
        reject(new Error(`Moonshine transcription timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.send({ id, pcm }, (err) => {
        if (err) {
          if (timer) { clearTimeout(timer); }
          moonshineCallbacks.delete(id);
          reject(err);
        }
      });
    });

    const elapsed = Date.now() - t0;
    console.log(`[zee:moonshine] transcribe id=${id} completed in ${elapsed}ms → ${text ? JSON.stringify(text.slice(0, 60)) : '(empty)'}`);

    this.pendingId = null;
    if (this.cancelled) { return null; }
    return text || null;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.pendingId !== null) {
      const cb = moonshineCallbacks.get(this.pendingId);
      moonshineCallbacks.delete(this.pendingId);
      // Resolve (rather than just delete) so transcribe() unblocks even if
      // the child never responds — prevents the caller from hanging forever.
      cb?.resolve('');
      this.pendingId = null;
    }
  }
}
