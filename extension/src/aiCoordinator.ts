// Coordinates the end-to-end AI/voice interaction loop:
//   - user text in (handleUserMessage)  → LLM stream   → handleAIDone → TTS
//   - user voice in (transcribeAndRespond → Moonshine) → handleUserMessage
//   - pending signal/initiative state that gates certain behaviors
//
// Every unit here used to live on CompanionViewProvider; factoring it out
// makes the state machine (user turn → stream → sentence-boundary → TTS →
// idle) inspectable in one place, and makes it possible to unit-test the
// coordination logic without a live VS Code host.

import type { UserConfig, InteractionMode, ImageAttachment } from './providers';
import type { AIClient, ParsedAIResponse } from './aiClient';
import type { TTSClient } from './ttsClient';
import type { MoonshineSTT } from './providers';
import type { MicRecorder } from './micRecorder';
import type { SessionManager } from './sessionManager';
import type { TranscriptStore } from './transcriptStore';
import type { ContextTracker, NotebookContext, SignalType } from './contextTracker';

export interface AICoordinatorDeps {
  /** Always-fresh config getter — handlers need to see live changes. */
  getConfig: () => UserConfig;
  /** Current interaction mode. */
  getInteractionMode: () => InteractionMode;
  aiClient: AIClient;
  ttsClient: TTSClient;
  sttClient: MoonshineSTT;
  micRecorder: MicRecorder;
  session: SessionManager;
  transcriptStore: TranscriptStore;
  tracker: ContextTracker;
  /** Decorate a context with notebook summary + solution hint before sending to the LLM. */
  decorateContext: (ctx: NotebookContext) => NotebookContext;
  /** Post a message to the webview. */
  postMessage: (msg: any) => void;
  /** True if there's an active companion session for the current notebook (or meta-mode). */
  isNoiseTranscription: (text: string) => boolean;
  /** Read the PNG output of the given notebook cell, or null if missing.
   *  Resolved at send-time so we always ship the freshest plot bytes. */
  getCellImage: (cellIndex: number) => ImageAttachment | null;
}

export class AICoordinator {
  // Signal/initiative state mediates between SignalRouter (sets it when an
  // awareness signal fires) and handleUserMessage (consumes it on the next
  // user turn). Owned here so both concerns go through one place.
  private pendingSignal: SignalType | null = null;
  private pendingInitiativePrompt: string | null = null;
  // The cell the signal was fired against — lets the cell-status-bar badge
  // anchor itself to that specific cell (and disappear when state clears).
  private pendingCellIndex: number | null = null;
  // Subscribers (e.g. the cell-badge provider) get notified on every
  // setPending / clearPending so VS Code re-renders the per-cell UI.
  private pendingChangeListeners = new Set<() => void>();
  // Plot-attachment state, set by the webview before the student sends the
  // next message. Consumed and cleared on each handleUserMessage so it's
  // strictly one-shot — the student must re-attach for a follow-up.
  private pendingAttachmentCellIndex: number | null = null;

  constructor(private deps: AICoordinatorDeps) {}

  // ── Pending-initiative lifecycle ─────────────────────────────────────

  setPending(signal: SignalType, prompt: string, cellIndex: number | null = null): void {
    this.pendingSignal = signal;
    this.pendingInitiativePrompt = prompt;
    this.pendingCellIndex = cellIndex;
    this.firePendingChange();
  }

  clearPending(): void {
    const had = this.pendingSignal !== null;
    this.pendingSignal = null;
    this.pendingInitiativePrompt = null;
    this.pendingCellIndex = null;
    if (had) { this.firePendingChange(); }
  }

  getPendingSignal(): SignalType | null { return this.pendingSignal; }
  getPendingPrompt(): string | null { return this.pendingInitiativePrompt; }
  getPendingCellIndex(): number | null { return this.pendingCellIndex; }

  /**
   * Set (or clear when cellIndex is null) the plot attached to the next
   * user message. The webview calls this when the student taps the attach
   * button; it's consumed + cleared in handleUserMessage so attachments
   * are always one-shot.
   */
  setPendingAttachment(cellIndex: number | null): void {
    this.pendingAttachmentCellIndex = cellIndex;
  }
  getPendingAttachment(): number | null { return this.pendingAttachmentCellIndex; }

  /** Subscribe to pending-state changes. Returns an unsubscribe fn. */
  onPendingChange(fn: () => void): () => void {
    this.pendingChangeListeners.add(fn);
    return () => { this.pendingChangeListeners.delete(fn); };
  }

  private firePendingChange(): void {
    for (const fn of this.pendingChangeListeners) {
      try { fn(); } catch (e) { console.error('[zee] pending-change listener threw:', e); }
    }
  }

  // ── User turn → AI ─────────────────────────────────────────────────────

  /**
   * Student typed or spoke something. Cancels any in-flight AI response
   * (so the new message barges in), persists the user turn (when a notebook
   * is open), and dispatches to the LLM.
   */
  async handleUserMessage(text: string, mode: InteractionMode): Promise<void> {
    if (!text.trim()) { return; }
    if (!this.deps.getConfig().companionEnabled) { return; }

    // Student interruption — cancel any in-progress AI response and/or TTS
    if (this.deps.aiClient.isStreaming()) {
      this.deps.aiClient.cancel();
    }
    this.deps.ttsClient.cancel();

    this.deps.tracker.notifyInteraction();
    this.clearPending();

    const ctx = this.deps.decorateContext(this.deps.tracker.getContext());

    // Persist to the per-notebook transcript only when a notebook is open.
    // Meta-mode chats (no notebook) are ephemeral by design.
    const currentFile = this.deps.session.getCurrent();
    if (ctx.notebookFile && currentFile) {
      this.deps.transcriptStore.addEntry(
        currentFile,
        'user',
        mode === 'voice' ? 'voice' : 'chat',
        text,
        undefined,
        ctx.activeCellIndex,
        this.deps.tracker.getCellPreview(),
        ctx.isTodoCell,
        ctx.todoText,
      );
    }

    this.deps.postMessage({ type: 'status', state: 'thinking' });
    this.deps.ttsClient.reset();

    // One-shot consumption of any pending plot attachment. Resolve the
    // bytes from the actual notebook cell at send-time so we never ship
    // stale image data, and clear the state so a follow-up turn starts
    // empty (the student must explicitly re-attach).
    let attachments: ImageAttachment[] | undefined;
    if (this.pendingAttachmentCellIndex !== null) {
      const img = this.deps.getCellImage(this.pendingAttachmentCellIndex);
      if (img) { attachments = [img]; }
      this.pendingAttachmentCellIndex = null;
    }

    await this.deps.aiClient.sendMessage(text, ctx, this.deps.getInteractionMode(), attachments);
  }

  /** Called when the LLM finishes streaming. Persist, render, post idle/speaking. */
  handleAIDone(parsed: ParsedAIResponse): void {
    const ctx = this.deps.tracker.getContext();
    const currentFile = this.deps.session.getCurrent();
    if (currentFile) {
      this.deps.transcriptStore.addEntry(
        currentFile,
        'companion',
        this.pendingSignal ? 'initiative' : (this.deps.getInteractionMode() === 'voice' ? 'voice' : 'chat'),
        parsed.text,
        parsed.richText,
        ctx.activeCellIndex,
        this.deps.tracker.getCellPreview(),
        ctx.isTodoCell,
        ctx.todoText,
      );
    }

    this.pendingSignal = null;
    this.deps.tracker.resetCooldown();

    this.deps.postMessage({
      type: 'ai_response_complete',
      text: parsed.text,
      richText: parsed.richText,
    });

    const cfg = this.deps.getConfig();
    if (!cfg.voiceResponsesEnabled || this.deps.getInteractionMode() !== 'voice') {
      this.deps.postMessage({ type: 'status', state: 'idle' });
    } else {
      this.deps.ttsClient.flush();
      // If TTS has already drained, post idle now. Otherwise the TTS onDone
      // callback will post idle when the last audio finishes playing.
      if (!this.deps.ttsClient.hasPendingWork()) {
        this.deps.postMessage({ type: 'status', state: 'idle' });
      }
    }
  }

  /** One sentence from the LLM. In voice mode, trigger TTS + speaking status. */
  handleSentenceBoundary(sentence: string): void {
    const cfg = this.deps.getConfig();
    if (cfg.voiceResponsesEnabled && this.deps.getInteractionMode() === 'voice') {
      this.deps.postMessage({ type: 'status', state: 'speaking' });
      this.deps.ttsClient.enqueueSentence(sentence);
    }
  }

  /** Hard stop: cancel AI + TTS, drop to idle. */
  handleStop(): void {
    this.deps.aiClient.cancel();
    this.deps.ttsClient.cancel();
    this.deps.postMessage({ type: 'status', state: 'idle' });
    this.deps.postMessage({ type: 'ai_stopped' });
  }

  // ── Voice turn → AI ────────────────────────────────────────────────────

  /**
   * Invoked by MicRecorder when VAD detects a complete utterance. Runs
   * transcription, routes the text into handleUserMessage, then tells
   * the recorder it's ready for the next utterance.
   *
   * Three isolation layers protect against the "stuck at Transcribing…" bug:
   * 1. sttClient.transcribe has its own 30s timeout → always resolves.
   * 2. handleUserMessage is fire-and-forget but explicitly caught so an
   *    async rejection can't escape up to the default unhandled-rejection
   *    handler.
   * 3. The outer finally guarantees micRecorder.ready() runs no matter what.
   */
  async transcribeAndRespond(pcm: Float32Array): Promise<void> {
    console.log(`[zee:mic] transcribeAndRespond: start (${pcm.length} samples)`);
    this.deps.postMessage({ type: 'stt_status', state: 'transcribing' });

    const durationSec = pcm.length / 16000;
    const t0 = Date.now();
    try {
      const text = await this.deps.sttClient.transcribe(pcm);
      const elapsedMs = Date.now() - t0;
      console.log(`[zee:mic] transcribed ${durationSec.toFixed(2)}s in ${elapsedMs}ms → ${text ? JSON.stringify(text) : '(empty)'}`);

      if (text && !this.deps.isNoiseTranscription(text)) {
        this.deps.postMessage({ type: 'stt_result', text });
        this.handleUserMessage(text, 'voice').catch((err) => {
          console.error('[zee:mic] handleUserMessage failed:', err);
          this.deps.postMessage({
            type: 'ai_chunk',
            text: `Something went wrong processing your message: ${(err as Error).message}`,
            done: true,
          });
          this.deps.postMessage({ type: 'ai_response_complete' });
          this.deps.postMessage({ type: 'status', state: 'idle' });
        });
      } else {
        this.deps.postMessage({ type: 'stt_status', state: 'listening' });
      }
    } catch (err) {
      console.error('[zee:mic] transcription failed:', err);
      this.deps.postMessage({
        type: 'stt_status', state: 'error',
        message: (err as Error).message || 'Transcription failed',
      });
      this.deps.postMessage({ type: 'status', state: 'idle' });
    } finally {
      this.deps.micRecorder.ready();
      console.log('[zee:mic] transcribeAndRespond: done');
    }
  }

  /**
   * Webview-capture fallback (Docker / code-server): the browser recorded
   * a speech segment and forwarded it as base64-encoded Float32 16 kHz PCM.
   * We decode, run Moonshine locally, handle the result like a normal voice input.
   */
  async handleVoiceAudio(base64Audio: string): Promise<void> {
    if (!this.deps.getConfig().companionEnabled) { return; }
    // Meta-mode voice is fine — same path as meta-mode text chat.

    this.deps.postMessage({ type: 'stt_status', state: 'transcribing' });

    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      const pcm = new Float32Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset,
        audioBuffer.byteLength / 4,
      );
      const text = await this.deps.sttClient.transcribe(pcm);

      if (text && !this.deps.isNoiseTranscription(text)) {
        this.deps.postMessage({ type: 'stt_result', text });
        this.handleUserMessage(text, 'voice').catch((err) => {
          console.error('[zee:voice] handleUserMessage failed:', err);
          this.deps.postMessage({
            type: 'ai_chunk',
            text: `Something went wrong: ${(err as Error).message}`,
            done: true,
          });
          this.deps.postMessage({ type: 'ai_response_complete' });
          this.deps.postMessage({ type: 'status', state: 'idle' });
        });
      } else {
        this.deps.postMessage({ type: 'stt_status', state: 'listening' });
      }
    } catch (err) {
      this.deps.postMessage({
        type: 'stt_status', state: 'error',
        message: (err as Error).message || 'Transcription failed',
      });
    }
  }
}
