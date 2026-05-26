import { TTSProvider, UserConfig, getTTSProvider } from './providers';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TTSClientEvents {
  onAudioChunk: (base64Audio: string) => void;
  onSentenceComplete: () => void;
  onDone: () => void;
  onError: (error: Error) => void;
  onApiQueueDrain: () => void;
}

// ── TTSClient ───────────────────────────────────────────────────────────────

/**
 * Manages TTS sentence queue. Each sentence is processed individually
 * (pipelined): while one sentence is being spoken, the next waits in
 * the queue. This gives fast time-to-first-audio for long responses.
 */
export class TTSClient {
  private provider: TTSProvider;
  private config: UserConfig;
  private events: TTSClientEvents;

  private sentenceQueue: string[] = [];

  private processing = false;
  private cancelled = false;
  private consecutiveErrors = 0;

  constructor(config: UserConfig, events: TTSClientEvents, kokoroCacheDir?: string) {
    this.config = config;
    this.events = events;
    this.provider = getTTSProvider(kokoroCacheDir);
  }

  updateConfig(config: UserConfig): void {
    this.config = config;
    this.consecutiveErrors = 0;
  }

  /**
   * Enqueue a sentence for TTS.
   */
  enqueueSentence(sentence: string, { force = false } = {}): void {
    if (!force && !this.config.voiceResponsesEnabled) { return; }
    if (this.cancelled) { return; }

    this.sentenceQueue.push(sentence);
    if (!this.processing) { this.processQueue(); }
  }

  /**
   * No-op kept for backward compatibility — sentences are now pipelined
   * individually instead of batched.
   */
  flush(): void { /* no-op */ }

  /**
   * Cancel all in-progress and queued TTS.
   */
  cancel(): void {
    this.cancelled = true;
    this.sentenceQueue = [];
    this.processing = false;
    this.provider.cancel();
  }

  /**
   * Called by the host when the webview signals that TTS audio has finished
   * playing (all AudioContext buffers played to completion).
   */
  notifyApiTTSDone(): void {
    if (!this.cancelled) {
      this.events.onDone();
    }
  }

  /**
   * Returns true if the TTS client has sentences queued or is actively
   * processing one. Used to coordinate with the AI streaming state so
   * we don't send premature idle signals between sentence batches.
   */
  hasPendingWork(): boolean {
    return this.sentenceQueue.length > 0 || this.processing;
  }

  /**
   * Returns true if the TTS provider has failed enough times that we've
   * stopped retrying. Used by the host to fall back to text-only mode.
   */
  hasGivenUp(): boolean {
    return this.consecutiveErrors >= 3;
  }

  /**
   * Reset state for a new response cycle.
   */
  reset(): void {
    this.cancelled = false;
    this.sentenceQueue = [];
    this.processing = false;
    this.consecutiveErrors = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.processing || this.cancelled || this.consecutiveErrors >= 3) { return; }
    if (this.sentenceQueue.length === 0) {
      // All audio chunks have been sent, but the webview hasn't finished
      // playing yet. Signal the host to wait for api_tts_done.
      this.events.onApiQueueDrain();
      return;
    }

    this.processing = true;
    const sentence = this.sentenceQueue.shift()!;

    try {
      await this.provider.speak(
        sentence,
        (base64Audio) => {
          if (!this.cancelled) {
            this.events.onAudioChunk(base64Audio);
          }
        },
        () => {
          this.consecutiveErrors = 0;
          this.processing = false;
          if (!this.cancelled) {
            this.events.onSentenceComplete();
            this.processQueue();
          }
        },
        (error) => {
          this.consecutiveErrors++;
          this.processing = false;
          this.events.onError(error);
          if (!this.cancelled && this.consecutiveErrors < 3) {
            this.processQueue();
          }
        }
      );
    } catch (err) {
      this.consecutiveErrors++;
      this.processing = false;
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
      if (!this.cancelled && this.consecutiveErrors < 3) {
        this.processQueue();
      }
    }
  }
}
