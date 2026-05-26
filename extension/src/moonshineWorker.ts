/**
 * Moonshine STT in a child process (NOT a worker thread).
 *
 * Why a child process? Kokoro TTS and Moonshine both use onnxruntime-node
 * (via @huggingface/transformers). That native addon has process-wide state
 * that isn't safe to share across worker threads — if Kokoro runs inference
 * and then Moonshine tries to run inference in the same process, V8 crashes
 * with "Check failed: maybe_code.has_value()". Putting Moonshine in its own
 * OS process gives it a separate onnxruntime instance, which sidesteps the
 * conflict entirely. Verified with a minimal repro before this change.
 *
 * Input: Float32 PCM @ 16kHz mono (sent via IPC with advanced serialization
 * so Float32Array round-trips without a JSON copy).
 * Output: transcribed text (or error).
 */

let transcriber: any = null;
let loading: Promise<any> | null = null;
const cacheDir = process.env.ZEE_MOONSHINE_CACHE_DIR;

async function ensureModel(): Promise<any> {
  if (transcriber) { return transcriber; }
  if (loading) { return loading; }
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/moonshine-base-ONNX',
      { dtype: 'q8' },
    );
    return transcriber;
  })();
  try {
    return await loading;
  } catch {
    loading = null;
    throw new Error('Failed to load Moonshine model');
  }
}

process.on('message', async (msg: { id: number; pcm: Float32Array }) => {
  // eslint-disable-next-line no-console
  console.log(`[moonshineWorker] id=${msg.id} received, ${msg.pcm.byteLength} bytes`);
  try {
    const modelStart = Date.now();
    const model = await ensureModel();
    const modelElapsed = Date.now() - modelStart;
    if (modelElapsed > 50) {
      // eslint-disable-next-line no-console
      console.log(`[moonshineWorker] id=${msg.id} model ready in ${modelElapsed}ms`);
    }
    const inferStart = Date.now();
    const result = await model(msg.pcm);
    const inferElapsed = Date.now() - inferStart;
    const text: string = typeof result?.text === 'string' ? result.text : '';
    // eslint-disable-next-line no-console
    console.log(`[moonshineWorker] id=${msg.id} inference done in ${inferElapsed}ms → ${text.length} chars`);
    process.send!({ id: msg.id, text: text.trim() });
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[moonshineWorker] id=${msg.id} failed:`, err);
    process.send!({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
