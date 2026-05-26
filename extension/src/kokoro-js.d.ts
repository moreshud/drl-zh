declare module 'kokoro-js' {
  export interface KokoroAudio {
    audio: Float32Array;
    sampling_rate: number;
  }

  export interface KokoroGenerateOptions {
    voice?: string;
  }

  export interface KokoroFromPretrainedOptions {
    dtype?: string;
  }

  export class KokoroTTS {
    voices: Record<string, unknown>;
    static from_pretrained(
      modelId: string,
      options?: KokoroFromPretrainedOptions,
    ): Promise<KokoroTTS>;
    generate(text: string, options?: KokoroGenerateOptions): Promise<KokoroAudio>;
  }
}
