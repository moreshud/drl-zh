import * as vscode from 'vscode';
import * as path from 'path';
import {
  UserConfig, DEFAULT_CONFIG, InteractionMode,
  loadConfig, saveConfig, MoonshineSTT, getCheapProvider,
  validateGroqKey, validateGeminiKey, validateOpenAIKey, validateAnthropicKey,
} from './providers';
import { MicRecorder } from './micRecorder';
import { pickSoftIdleNudgeLine } from './signalRouter';
import { buildWebviewHtml } from './webviewHtml';
import { NotebookPrep } from './notebookPrep';
import { SessionManager } from './sessionManager';
import { AICoordinator } from './aiCoordinator';
import { ThoughtOrchestrator, ThoughtEvent } from './thoughtOrchestrator';
import { pickThoughtUtterance } from './thoughtUtterance';
import { OnboardingHandler } from './onboardingHandler';
import { createWebviewMessageRouter } from './webviewMessages';
import { ContextTracker, NotebookContext, SignalType, FlowState } from './contextTracker';

// Re-export for test compatibility — tests import pickSoftIdleNudgeLine
// from '../src/extension' from its previous location here.
export { pickSoftIdleNudgeLine };
import { LearnerProfileStore, SkillLevel } from './learnerProfile';
import { AIClient, ParsedAIResponse } from './aiClient';
import { TTSClient } from './ttsClient';
import { TranscriptStore } from './transcriptStore';
import {
  KEY_ONBOARDING_COMPLETE, RESUMPTION_DELAY_MS,
  KEY_COMPANION_ENABLED,
} from './constants';

/**
 * Extract a compact error detail string from an API error message.
 * Providers throw errors like "Gemini API error 429: {\"error\":{\"code\":429,\"message\":\"...\"}}".
 * Returns e.g. "HTTP 429 · Resource has been exhausted" or falls back to the raw message.
 */
export function extractErrorDetail(message: string): string {
  const colonIdx = message.indexOf(': ');
  if (colonIdx === -1) { return message; }
  const prefix = message.slice(0, colonIdx);   // e.g. "Gemini API error 429"
  const body = message.slice(colonIdx + 2);    // JSON string

  // Extract HTTP status from prefix
  const statusMatch = prefix.match(/(\d{3})$/);
  const status = statusMatch ? statusMatch[1] : null;

  // Try to extract code + message from the JSON body
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error ?? parsed;
    const code = err?.code ?? err?.type ?? status;
    const msg = err?.message;
    if (msg) {
      return code ? `HTTP ${code} · ${msg}` : msg;
    }
  } catch { /* fall through */ }

  return status ? `HTTP ${status} · ${body}` : message;
}

export function isNoiseTranscription(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length > 4) { return false; }
  const lower = text.toLowerCase();
  return lower.includes('thank');
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const provider = new CompanionViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('drlCompanion.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('drlCompanion.open', () => {
      vscode.commands.executeCommand('drlCompanion.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('drlCompanion.clearHistory', () => {
      provider.clearContextWindow();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('drlCompanion.settings', () => {
      provider.showSettings();
    })
  );
}

export function deactivate() {}

// ── Companion View Provider ─────────────────────────────────────────────────

class CompanionViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private config: UserConfig = { ...DEFAULT_CONFIG };
  private interactionMode: InteractionMode = 'chat';
  private tracker!: ContextTracker;
  private aiClient!: AIClient;
  private ttsClient!: TTSClient;
  private sttClient!: MoonshineSTT;
  private transcriptStore: TranscriptStore;
  private session = new SessionManager();
  private aiCoordinator!: AICoordinator;
  private thoughtOrchestrator!: ThoughtOrchestrator;
  private onboardingHandler!: OnboardingHandler;
  private handleWebviewMessage!: (msg: any) => Promise<void>;
  private notebookPrep!: NotebookPrep;
  private ttsFailureWarned = false; // show the Kokoro-failure toast at most once per session
  private learnerProfile!: LearnerProfileStore;

  // Token accounting. lastContextTokens = input tokens of the most recent
  // request (approximates what the next request will carry). sessionTotal =
  // cumulative input + output across the whole session, for rate-limit
  // awareness.
  private lastContextTokens = 0;
  private sessionTotalTokens = 0;

  // ── Host-side mic recording ─────────────────────────────────────────────
  // The MicRecorder owns the VAD state machine, calibration, and recorder
  // process; the provider only wires events to Moonshine + the webview.
  private micRecorder!: MicRecorder;
  // true when capture is happening in the webview (browser/Docker path)
  // because no native recorder is available on the host.
  private webviewMicMode = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.transcriptStore = new TranscriptStore();
    context.subscriptions.push(this.transcriptStore);
    this.learnerProfile = new LearnerProfileStore(context.globalState);
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'out', 'webview')),
      ],
    };

    // Load config
    this.config = await loadConfig(this.context.workspaceState, this.context.globalState);
    this.interactionMode = this.config.defaultInteractionMode;

    // Initialize components
    this.initializeComponents();

    // Set webview HTML
    webviewView.webview.html = buildWebviewHtml(this.context.extensionPath, webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg));

    // Init/onboarding is deferred until 'webview_loaded' arrives from the webview JS
  }

  clearContextWindow(): void {
    this.aiClient?.clearContextWindow();
    vscode.window.showInformationMessage('DRL-ZH Companion: Conversation history cleared.');
  }

  showSettings(): void {
    this.postMessage({ type: 'show_settings' });
  }

  // ── Private: Initialization ─────────────────────────────────────────────

  private initializeComponents(): void {
    // AI Client
    this.aiClient = new AIClient(this.config, {
      onChunk: (text, richText, done) => {
        this.postMessage({ type: 'ai_chunk', text, richText, done: done ?? false });
      },
      onDone: (parsed) => {
        this.aiCoordinator.handleAIDone(parsed);
      },
      onError: (error) => {
        const detail = error?.message ? `\nDetails: \`${extractErrorDetail(error.message)}\`` : '';
        this.postMessage({
          type: 'ai_chunk',
          text: `Couldn't reach the AI — check your API key in settings or try again.${detail}`,
          done: true,
        });
        this.postMessage({ type: 'ai_response_complete' });
        // Dim the trailing turn — both the user bubble AND the error
        // message that just rendered. They're visual-only: aiClient has
        // already rolled the user turn out of the LLM context window, no
        // assistant reply was added, and we drop the user entry from disk
        // below. Tagging both lets the ↶ button peel them off without a
        // round-trip (nothing on the host side to undo).
        this.postMessage({ type: 'mark_last_turn_errored' });
        // ALSO drop the orphan user entry from the on-disk transcript.
        // handleUserMessage persisted it before the LLM call, and without
        // this cleanup the failed turn would come back to life on the next
        // notebook reopen (re-loaded into both the chat UI and the LLM
        // context window). The in-session dim ⚠ visual stays — that's
        // useful feedback for the current session.
        const errFile = this.session.getCurrent();
        if (errFile) {
          this.transcriptStore.removeLastUserEntry(errFile);
        }
        // In voice mode, speak a short apology instead of leaving the user
        // wondering why nothing was said.
        if (this.config.voiceResponsesEnabled && this.interactionMode === 'voice') {
          this.ttsClient.reset();
          this.ttsClient.enqueueSentence(
            "My language model is unavailable right now. Let's try again in a moment.",
            { force: true },
          );
        }
        this.postMessage({ type: 'status', state: 'idle' });
      },
      onSentenceBoundary: (sentence) => {
        this.aiCoordinator.handleSentenceBoundary(sentence);
      },
      onUsage: (usage) => {
        this.lastContextTokens = usage.inputTokens;
        this.sessionTotalTokens += usage.totalTokens;
        this.postMessage({
          type: 'token_usage',
          context: this.lastContextTokens,
          sessionTotal: this.sessionTotalTokens,
        });
      },
    });
    this.aiClient.setLearnerProfile(this.learnerProfile.get());

    // Notebook prep: summary (cached) + solution cells. Intro initiative
    // fires when the summary becomes available.
    this.notebookPrep = new NotebookPrep(
      () => this.config,
      {
        onSummaryReady: () => this.offerIntroInitiative(),
        onStatus: (state) => this.postMessage({ type: 'status', state }),
      },
    );

    // Mic recorder: VAD + calibration + process lifecycle. Emits PCM when a
    // complete utterance is detected; we transcribe and route that text into
    // handleUserMessage just like a text chat message.
    this.micRecorder = new MicRecorder(
      { sensitivity: this.config.micSensitivity },
      {
        onVolume: (rms) => this.postMessage({ type: 'mic_volume', volume: rms }),
        onSpeechStart: () => this.postMessage({ type: 'stt_status', state: 'recording' }),
        onSpeechEnd: (pcm) => this.aiCoordinator.transcribeAndRespond(pcm),
        onError: (err) => {
          this.postMessage({ type: 'stt_status', state: 'error', message: `Recorder error: ${err.message}` });
        },
      },
    );

    // TTS + STT (both use the same local-assets cache dir)
    const kokoroCacheDir = this.getLocalAssetsDir();
    this.sttClient = new MoonshineSTT(kokoroCacheDir);
    this.ttsClient = new TTSClient(this.config, {
      onAudioChunk: (base64Audio) => {
        this.postMessage({ type: 'tts_chunk', audio: base64Audio, done: false });
      },
      onSentenceComplete: () => {
        this.postMessage({ type: 'tts_sentence_done' });
      },
      onDone: () => {
        // Only go idle when the AI has finished streaming AND TTS has
        // no more sentences queued. During streaming, api_tts_done can
        // fire between sentence batches — if we went idle then, the mic
        // would start recording the AI's own audio output.
        if (!this.aiClient.isStreaming() && !this.ttsClient.hasPendingWork()) {
          this.postMessage({ type: 'status', state: 'idle' });
        }
      },
      onError: (error) => {
        this.postMessage({ type: 'status', state: 'idle' });
        this.handleTTSError(error);
      },
      onApiQueueDrain: () => {
        // All audio chunks sent to webview — wait for api_tts_done from webview
        // when it finishes playing. Don't set idle yet.
      },
    }, kokoroCacheDir);

    // Context Tracker
    this.tracker = new ContextTracker(
      {
        onContextUpdate: (ctx) => this.handleContextUpdate(ctx),
        onRequestToSpeak: (signal) => this.handleRequestToSpeak(signal),
        onFlowStateChange: (state) => this.handleFlowStateChange(state),
      },
      this.config,
    );
    this.context.subscriptions.push(this.tracker);

    // AI Coordinator: owns handleUserMessage / handleAIDone / handleStop
    // / transcribeAndRespond / handleVoiceAudio — everything that ties the
    // LLM, TTS, mic, and transcript together. Thin layer over the other
    // clients; the provider just delegates.
    this.aiCoordinator = new AICoordinator({
      getConfig: () => this.config,
      getInteractionMode: () => this.interactionMode,
      aiClient: this.aiClient,
      ttsClient: this.ttsClient,
      sttClient: this.sttClient,
      micRecorder: this.micRecorder,
      session: this.session,
      transcriptStore: this.transcriptStore,
      tracker: this.tracker,
      decorateContext: (ctx) => this.decorateContext(ctx),
      postMessage: (m) => this.postMessage(m),
      isNoiseTranscription,
      getCellImage: (cellIndex) => this.getCellImage(cellIndex),
    });

    // Thought-cloud orchestrator: turns awareness signals + soft-idle +
    // long-idle ambient ticks into hedged "thoughts" surfaced near Zee's
    // face. Replaces the chat-bubble initiative + Accept/Dismiss bar.
    this.thoughtOrchestrator = new ThoughtOrchestrator({
      getConfig: () => this.config,
      getContext: () => this.tracker.getContext(),
      getCheapProvider: () => getCheapProvider(this.config),
      onThought: (event) => this.handleThoughtEvent(event),
    });

    // Settings / onboarding / pause-resume lifecycle
    this.onboardingHandler = new OnboardingHandler({
      context: this.context,
      getConfig: () => this.config,
      setConfig: (c) => { this.config = c; },
      aiClient: this.aiClient,
      ttsClient: this.ttsClient,
      tracker: this.tracker,
      learnerProfile: this.learnerProfile,
      aiCoordinator: this.aiCoordinator,
      transcriptStore: this.transcriptStore,
      notebookPrep: this.notebookPrep,
      session: this.session,
      getInteractionMode: () => this.interactionMode,
      postMessage: (m) => this.postMessage(m),
      sanitizedConfig: () => this.sanitizeConfig(),
    });

    // Webview message dispatcher — flat table of { type → action }
    this.handleWebviewMessage = createWebviewMessageRouter({
      aiCoordinator: this.aiCoordinator,
      onboardingHandler: this.onboardingHandler,
      ttsClient: this.ttsClient,
      tracker: this.tracker,
      setInteractionMode: (m) => { this.interactionMode = m; },
      postMessage: (m) => this.postMessage(m),
      handleThoughtFollowup: (hint) => this.handleThoughtFollowup(hint),
      handleClearTranscript: () => this.handleClearTranscript(),
      handleUndoLastTurn: () => this.handleUndoLastTurn(),
      handleWebviewLoaded: () => this.handleWebviewLoaded(),
      handleWebviewReady: () => this.handleWebviewReady(),
      handleLearnMore: () => this.handleLearnMore(),
      startMicRecording: () => this.startMicRecording(),
      stopMicRecording: () => this.stopMicRecording(),
      forceFinishUtterance: () => this.forceFinishUtterance(),
      showSettings: () => this.showSettings(),
    });
  }

  // handleWebviewMessage is assembled by createWebviewMessageRouter
  // in initializeComponents — see src/webviewMessages.ts.

  // handleUserMessage / handleAIDone / handleSentenceBoundary / handleStop
  // all moved to src/aiCoordinator.ts.

  private handleContextUpdate(ctx: NotebookContext): void {
    const previousNotebook = this.session.getCurrent();

    if (ctx.notebookFile) {
      this.session.setCurrent(ctx.notebookFile);

      // Load transcript for this notebook if not already loaded
      const editor = vscode.window.activeNotebookEditor;
      if (editor) {
        this.transcriptStore.load(
          editor.notebook.uri,
          ctx.chapterNumber,
          ctx.chapterTitle,
        );

        // If switching notebooks, update AI context window and webview transcript
        if (previousNotebook !== ctx.notebookFile) {
          // Cross-session memory: remember that the student has touched this
          // notebook, and refresh the profile that the LLM sees.
          this.learnerProfile.recordChapterTouched(ctx.notebookFile).then(() => {
            this.aiClient.setLearnerProfile(this.learnerProfile.get());
          });
          const entries = this.transcriptStore.getEntries(ctx.notebookFile);

          if (entries.length > 0) {
            this.session.activate(ctx.notebookFile);
            const history = this.transcriptStore.getContextWindow(ctx.notebookFile);
            this.aiClient.setContextWindow(history);
            this.postMessage({ type: 'transcript_loaded', entries, truncated: false });
            // Always mark the boundary between the prior session's turns
            // and the new ones — the LLM has those prior turns in its
            // context window, and without the divider the student sees
            // the chat history as one continuous conversation and gets
            // confused when Zee references "what we discussed earlier".
            const lastTimestamp = this.transcriptStore.getLastEntryTimestamp(ctx.notebookFile);
            if (lastTimestamp) {
              this.postMessage({ type: 'session_divider', timestamp: lastTimestamp });
            }

            // Prepare notebook: load summary + solution cells
            this.notebookPrep.clear();
            this.notebookPrep.prepare(ctx.notebookFile, editor.notebook.uri);
          } else {
            // No prior transcript — wipe any meta-mode chat that might be
            // visible (the webview no longer clears on context_update; we
            // drive content explicitly), then start the welcome flow.
            this.postMessage({ type: 'transcript_cleared' });
            this.handleStartSession();
          }
        }
      }
    } else {
      this.session.clearCurrent();
      // Entering meta-mode: discard the notebook's LLM context so meta-chat
      // doesn't get contaminated with cell-specific history.
      this.aiClient.clearContextWindow();
      // Cancel any playing audio + stop mic when notebook closes.
      this.ttsClient.cancel();
      this.stopMicRecording();
      if (this.aiClient.isStreaming()) {
        this.aiClient.cancel();
        this.postMessage({ type: 'ai_stopped' });
      }
      this.postMessage({ type: 'status', state: 'idle' });
    }

    this.postMessage({
      type: 'context_update',
      notebook: ctx.notebookFile,
      cell: ctx.activeCellIndex,
      cellType: ctx.activeCellType,
      todoText: ctx.todoText,
      errors: ctx.lastError,
      consecutiveErrors: ctx.consecutiveErrors,
      chapter: ctx.chapterNumber,
      chapterTitle: ctx.chapterTitle,
      attachablePlot: ctx.attachablePlot,
      scopeTodo: ctx.scopeTodo,
      // -1 means "cursor unknown" (no Monaco focus on the cell). The pill
      // appends a "?" hint so you can tell at a glance when Zee is operating
      // without a precise cursor anchor.
      cursorLine: ctx.activeCellCursorLine,
    });
  }

  private handleRequestToSpeak(signal: SignalType): void {
    if (!this.session.isActive()) { return; }
    if (!this.session.getCurrent()) { return; }

    // Cross-session memory: a 'stuck' signal means the student hit repeated
    // errors on this TODO. Record the concept so future sessions know.
    const ctx = this.tracker.getContext();
    if (signal === 'stuck' && ctx.todoText) {
      this.learnerProfile.recordStuckConcept(ctx.todoText).then(() => {
        this.aiClient.setLearnerProfile(this.learnerProfile.get());
      });
    }

    // Orchestrator owns the rest: cooldown, LLM phrasing for `stuck`,
    // emit-to-webview via handleThoughtEvent.
    void this.thoughtOrchestrator.fire(signal);
  }

  private handleFlowStateChange(state: FlowState): void {
    // Forward to the webview in all cases so the face reflects the flow.
    this.postMessage({ type: 'flow_state', state });

    if (state === 'soft-idle-nudge') {
      void this.thoughtOrchestrator.fire('soft-idle');
    }
  }

  /**
   * Bridge: orchestrator → webview cloud + voice utterance. Single place
   * that turns a ThoughtEvent into the side-effects (DOM + TTS).
   */
  private handleThoughtEvent(event: ThoughtEvent): void {
    this.postMessage({
      type: 'thought_cloud',
      trigger: event.trigger,
      kind: event.kind,
      text: event.text,
      expandHint: event.expandHint,
      ttlMs: event.ttlMs,
    });

    // Voice tag: a short, hedged utterance ("hmm…", "wait…") played
    // slightly slower than normal speech. Never speaks the full thought —
    // that's what the cloud is for.
    if (this.config.voiceResponsesEnabled && this.interactionMode === 'voice') {
      const utterance = pickThoughtUtterance();
      if (utterance) {
        // TODO: thread THOUGHT_UTTERANCE_RATE through ttsClient when we
        // add per-sentence rate control. For now we use the configured rate.
        this.ttsClient.reset();
        this.ttsClient.enqueueSentence(utterance, { force: true });
      }
    }
  }

  /**
   * Click handler for the thought cloud's follow-up. The webview sends the
   * hedged thought as the expandHint; we wrap it in a "Tell me more — "<...>""
   * user message and route through the normal chat path.
   */
  private async handleThoughtFollowup(expandHint: string): Promise<void> {
    if (!expandHint) { return; }
    const text = `Tell me more — "${expandHint}"`;
    this.postMessage({ type: 'echo_user_message', text });
    await this.aiCoordinator.handleUserMessage(text, this.interactionMode);
  }

  // handleSaveSettings / handleValidateKey / handleCompleteOnboarding /
  // handleResetOnboarding / handleToggleCompanion → see src/onboardingHandler.ts

  private async handleLearnMore(): Promise<void> {
    if (!this.config.companionEnabled) { return; }

    const ctx = this.decorateContext(this.tracker.getContext());
    if (!ctx.notebookFile || ctx.activeCellType !== 'markdown') { return; }

    this.tracker.notifyLearnMoreClicked(ctx.activeCellIndex);

    const cellContent = ctx.activeCellContent || '';
    const focusInfo = ctx.focusSummary ? `\nRecent focus: ${ctx.focusSummary}` : '';

    const prompt = `The student clicked "Learn more" while reading a markdown cell. Help them engage with this content. The cell says:\n\n${cellContent}${focusInfo}\n\nOffer a deeper explanation, an intuitive analogy, or connect this concept to something practical. Be conversational, not lecturing.`;

    this.aiCoordinator.clearPending();

    this.postMessage({ type: 'status', state: 'thinking' });
    this.ttsClient.reset();

    await this.aiClient.generateInitiative(prompt, ctx, this.interactionMode);
  }

  private handleTTSError(error: Error): void {
    // Kokoro failures fall through the consecutiveErrors gate inside TTSClient;
    // after 3 strikes, TTS stops trying. Let the user know once per session so
    // they aren't stuck in silence, but don't spam a toast on every failure.
    if (this.ttsFailureWarned) { return; }
    if (!this.ttsClient.hasGivenUp()) { return; }
    this.ttsFailureWarned = true;
    vscode.window.showWarningMessage(
      `Voice output unavailable (${error.message}). Continuing in text-only mode — check the transcript panel for the AI's reply.`,
    );
  }

  // ── Host-side mic recording ─────────────────────────────────────────────
  //
  // Native VS Code: MicRecorder spawns pw-record/parecord/arecord/sox/ffmpeg
  // and streams PCM into Moonshine via onSpeechEnd.
  //
  // Docker / code-server: no audio hardware in the container → MicRecorder's
  // start() returns 'no_recorder' and we hand capture to the webview, which
  // uses browser getUserMedia and forwards base64 PCM via `voice_audio`.

  private startMicRecording(): void {
    if (!this.config.companionEnabled) { return; }
    if (this.micRecorder.isActive() || this.webviewMicMode) { return; }
    // Voice works with or without a notebook open — meta-mode voice chat is
    // the same code path as meta-mode text chat, just spoken.

    this.micRecorder.updateConfig({ sensitivity: this.config.micSensitivity });
    const result = this.micRecorder.start();
    if (result === 'no_recorder') {
      this.webviewMicMode = true;
      this.postMessage({ type: 'mic_use_webview' });
      return;
    }
    if (result === 'spawn_failed') {
      this.postMessage({ type: 'stt_status', state: 'error', message: 'Failed to start recorder.' });
      return;
    }
    this.postMessage({ type: 'mic_started' });
  }

  private stopMicRecording(): void {
    if (this.webviewMicMode) {
      // Webview owns its own teardown; we just drop the flag and notify the UI.
      this.webviewMicMode = false;
      this.postMessage({ type: 'mic_stopped' });
      return;
    }
    // "Mute" means mute: no flush, in-flight utterance is discarded. VAD
    // handles normal send-on-silence.
    this.micRecorder.stop();
    this.postMessage({ type: 'mic_stopped' });
  }

  /**
   * Force the current utterance to finish and transcribe immediately,
   * without waiting for VAD silence. Wired to the "send now" button so
   * users with background noise can commit their speech manually.
   */
  private forceFinishUtterance(): void {
    if (this.webviewMicMode) {
      // Webview path can't easily force-flush from here — users on the
      // Docker path will need to stop speaking; VAD will fire on its own.
      // (Could wire a host→webview message later if needed.)
      return;
    }
    this.micRecorder.forceFinishUtterance();
  }

  // transcribeAndRespond and handleVoiceAudio moved to aiCoordinator.ts.

  private handleStartSession(): void {
    const currentFile = this.session.getCurrent();
    if (!currentFile) { return; }
    this.session.activate(currentFile);
    // Fresh notebook session starts from a clean slate — discard any lingering
    // meta-mode chat turns so they don't bleed into the notebook context.
    this.aiClient.clearContextWindow();
    const ctx = this.tracker.getContext();
    this.sendWelcomeMessage(ctx);

    // Prepare notebook summary + solution cells
    const editor = vscode.window.activeNotebookEditor;
    if (editor) {
      this.notebookPrep.prepare(currentFile, editor.notebook.uri);
    }

    this.postMessage({ type: 'session_started' });
  }

  private handleClearTranscript(): void {
    // Always clear the AI context and webview, even if no notebook is open
    this.aiClient.clearContextWindow();
    this.notebookPrep.clear();
    this.aiCoordinator.clearPending();
    // Context is now empty → next request won't carry old history. Session
    // total stays, since we already paid for those tokens and the user may
    // still want to see the running cost.
    this.lastContextTokens = 0;
    this.postMessage({
      type: 'token_usage',
      context: this.lastContextTokens,
      sessionTotal: this.sessionTotalTokens,
    });

    this.postMessage({ type: 'transcript_cleared' });

    // Clear persistent transcript for current or most recently open notebook
    const targetFile = this.session.getCurrent() ?? this.session.getLastClosed();
    if (!targetFile) { return; }

    // Mark session as not started for the cleared notebook
    this.session.deactivate(targetFile);

    const editor = vscode.window.activeNotebookEditor;
    if (editor) {
      this.transcriptStore.clearTranscript(targetFile, editor.notebook.uri);
      this.notebookPrep.deleteCache(targetFile);
    } else {
      // No active editor (notebook was closed) — clear from store by looking up the URI
      this.transcriptStore.clearInMemory(targetFile);
      this.notebookPrep.deleteCache(targetFile);
    }

    // If the cleared notebook is still open, auto-restart — never leave Zee silent.
    if (this.session.getCurrent() === targetFile) {
      this.handleStartSession();
    }
  }

  /**
   * Undo the last exchange: pop the trailing (user, assistant) pair from
   * both the LLM context window and — when a notebook is open — from the
   * on-disk transcript. Repeatable: the webview can fire this multiple
   * times to peel back further. No-op if there's nothing paired to undo
   * (e.g. only an initiative reply, or an in-flight stream).
   */
  private handleUndoLastTurn(): void {
    if (this.aiClient.isStreaming()) {
      // Mid-stream undo would race with onDone pushing a fresh assistant
      // turn. Safer to cancel first and let the user decide.
      return;
    }
    const popped = this.aiClient.rollbackLastTurn();
    if (!popped) { return; }

    // Remove from disk too when we have a notebook context.
    const targetFile = this.session.getCurrent();
    if (targetFile) {
      this.transcriptStore.removeLastPair(targetFile);
    }

    // Tell the webview to peel the two entries out of the DOM.
    this.postMessage({ type: 'turn_undone' });
  }

  // ── Private: Local assets path (Kokoro + Moonshine model cache) ────────

  private getLocalAssetsDir(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.join(root, '.localassets');
  }

  // Notebook prep (summary + solution loading) lives in NotebookPrep —
  // see notebookPrep.ts.

  private offerIntroInitiative(): void {
    if (!this.session.isActive()) { return; }
    const summary = this.notebookPrep.getSummary();
    const currentFile = this.session.getCurrent();
    if (!currentFile || !summary) { return; }
    // Don't offer intro if there's already a pending initiative (e.g. session resumption)
    if (this.aiCoordinator.getPendingPrompt()) { return; }
    // Don't offer intro if there's already a transcript (returning session)
    const entries = this.transcriptStore.getEntries(currentFile);
    if (entries.length > 0) { return; }

    const ctx = this.tracker.getContext();
    const introText = `Hmm — want a tour of Chapter ${ctx.chapterNumber}, ${ctx.chapterTitle}?`;
    const expandHint = `give me a tour of this chapter`;

    // Use the same cloud surface as awareness signals — single, ephemeral,
    // non-polluting. The voice utterance + cloud rendering is handled by
    // handleThoughtEvent.
    this.handleThoughtEvent({
      trigger: 'reading',
      kind: 'callout',   // intro = a moment they should probably look at
      text: introText,
      expandHint,
      ttlMs: 25_000,
    });
  }

  /**
   * Decorate a NotebookContext with summary and solution hint
   * before passing it to the AI client.
   */
  private decorateContext(ctx: NotebookContext): NotebookContext {
    const decorated: NotebookContext = { ...ctx };
    const summary = this.notebookPrep.getSummary();
    if (summary) {
      decorated.notebookSummary = summary;
    }
    // Always attach the reference solution when one exists for the active
    // TODO. Zee is told (in the system prompt) to use it for Socratic hints
    // only — never spoil it. Keeping it loaded continuously means questions
    // like "is my approach equivalent to the reference?" land an answer in
    // one turn, instead of routing through a struggle threshold.
    if (ctx.isTodoCell && ctx.todoText) {
      const solution = this.notebookPrep.getSolution(ctx.todoText, ctx.activeCellIndex);
      if (solution) {
        decorated.solutionHint = solution;
      }
    }
    return decorated;
  }

  /**
   * Read the latest PNG output of a notebook cell at send-time. Returns
   * null if the cell doesn't exist, isn't a code cell, or has no image
   * output. Resolved fresh per call so we always ship the most recent plot.
   */
  private getCellImage(cellIndex: number): { mimeType: string; dataBase64: string } | null {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) { return null; }
    if (cellIndex < 0 || cellIndex >= editor.notebook.cellCount) { return null; }
    const cell = editor.notebook.cellAt(cellIndex);
    if (cell.kind !== vscode.NotebookCellKind.Code) { return null; }
    if (!cell.outputs || cell.outputs.length === 0) { return null; }
    for (let oi = cell.outputs.length - 1; oi >= 0; oi--) {
      for (const item of cell.outputs[oi].items) {
        if (item.mime === 'image/png') {
          return { mimeType: 'image/png', dataBase64: Buffer.from(item.data).toString('base64') };
        }
      }
    }
    return null;
  }

  private handleWebviewLoaded(): void {
    // Webview JS is ready to receive messages — now safe to send init/onboarding
    const onboarded = this.context.workspaceState.get<boolean>(KEY_ONBOARDING_COMPLETE, false);
    if (!onboarded) {
      this.postMessage({ type: 'show_onboarding', config: this.sanitizeConfig() });
    } else {
      this.postMessage({ type: 'init', config: this.sanitizeConfig(), mode: this.interactionMode });
    }

    // Restore paused state if companion was previously disabled
    if (!this.config.companionEnabled) {
      this.tracker.pause();
      this.postMessage({ type: 'companion_state', enabled: false });
    }
  }

  private handleWebviewReady(): void {
    // Load existing transcript entries if we have a notebook open
    const currentFile = this.session.getCurrent();
    if (currentFile) {
      const entries = this.transcriptStore.getEntries(currentFile);
      const lastTimestamp = this.transcriptStore.getLastEntryTimestamp(currentFile);

      if (entries.length > 0) {
        // Existing session — mark active and restore
        this.session.activate(currentFile);
        this.postMessage({
          type: 'transcript_loaded',
          entries,
          truncated: false,
        });

        if (lastTimestamp) {
          this.postMessage({
            type: 'session_divider',
            timestamp: lastTimestamp,
          });
        }

        // Session resumption — surface as a thought cloud, not a chat entry.
        setTimeout(() => {
          if (!this.session.getCurrent()) { return; }
          const lastEntry = entries[entries.length - 1];
          const topic = lastEntry.context.todoText || lastEntry.context.cellPreview || 'this notebook';
          this.handleThoughtEvent({
            trigger: 'reading',
            kind: 'callout',  // welcome-back = worth their attention
            text: `Hmm — pick up on ${topic} where we left off?`,
            expandHint: `pick up on ${topic} where we left off`,
            ttlMs: 25_000,
          });
        }, RESUMPTION_DELAY_MS);

        // Set AI context window from transcript
        const history = this.transcriptStore.getContextWindow(currentFile);
        this.aiClient.setContextWindow(history);

        // Prepare notebook summary + solution cells
        const editor = vscode.window.activeNotebookEditor;
        if (editor) {
          this.notebookPrep.prepare(currentFile, editor.notebook.uri);
        }
      } else {
        // No prior session — auto-start so Zee greets on webview resume.
        this.handleStartSession();
      }
    }
  }

  private sendWelcomeMessage(ctx: NotebookContext): void {
    const currentFile = this.session.getCurrent();
    if (!ctx.notebookFile || !currentFile) { return; }

    const welcomeText = `Hey — I'm Zee. You're starting Chapter ${ctx.chapterNumber} — ${ctx.chapterTitle}. Ask me anything as you work through it, or just start coding and I'll keep an eye on things.`;

    this.transcriptStore.addEntry(
      currentFile,
      'companion',
      'initiative',
      welcomeText,
      undefined,
      ctx.activeCellIndex,
      this.tracker.getCellPreview(),
      ctx.isTodoCell,
      ctx.todoText,
    );

    this.postMessage({
      type: 'welcome_message',
      text: welcomeText,
    });
  }

  // ── Private: Webview HTML ─────────────────────────────────────────────────

  private postMessage(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private sanitizeConfig(): Omit<UserConfig, 'groqApiKey' | 'geminiApiKey' | 'openaiApiKey' | 'anthropicApiKey'> & {
    hasGroqKey: boolean;
    hasGeminiKey: boolean;
    hasOpenaiKey: boolean;
    hasAnthropicKey: boolean;
  } {
    const { groqApiKey, geminiApiKey, openaiApiKey, anthropicApiKey, ...rest } = this.config;
    return {
      ...rest,
      hasGroqKey: !!groqApiKey,
      hasGeminiKey: !!geminiApiKey,
      hasOpenaiKey: !!openaiApiKey,
      hasAnthropicKey: !!anthropicApiKey,
    };
  }

}
