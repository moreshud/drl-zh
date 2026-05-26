/**
 * Kokoro TTS worker thread.
 * Runs ONNX inference off the main thread so the VS Code extension host
 * event loop stays responsive during speech generation.
 */
import { parentPort, workerData } from 'worker_threads';

let tts: any = null;
let loading: Promise<any> | null = null;

async function ensureModel(): Promise<any> {
  if (tts) { return tts; }
  if (loading) { return loading; }
  loading = (async () => {
    // Set HuggingFace cache dir before importing kokoro-js
    if (workerData?.cacheDir) {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
    }
    const { KokoroTTS } = await import('kokoro-js');
    tts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: 'q8' },
    );
    return tts;
  })();
  try {
    return await loading;
  } catch {
    loading = null;
    throw new Error('Failed to load Kokoro model');
  }
}

parentPort!.on('message', async (msg: { id: number; text: string; voice: string }) => {
  try {
    const model = await ensureModel();
    const result = await model.generate(msg.text, { voice: msg.voice });

    // Convert Float32 → Int16 PCM
    const float32: Float32Array = result.audio;
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    parentPort!.postMessage({
      id: msg.id,
      pcm: Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength),
      sampleRate: result.sampling_rate,
    });
  } catch (err: unknown) {
    parentPort!.postMessage({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
