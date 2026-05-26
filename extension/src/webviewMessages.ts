// Routes incoming webview messages to the right handler. Extracting this
// table flattens what used to be a 100-line switch inside CompanionViewProvider
// into a small dispatcher whose shape (message type → action) is the clearest
// contract between the webview and the host.
//
// Each route runs against an already-wired WebviewRouteDeps so the handler
// itself stays tiny. For tests, pass a mock deps object and invoke
// `dispatch({ type: 'foo', ... })` directly — no VS Code mocks needed.

import type { AICoordinator } from './aiCoordinator';
import type { OnboardingHandler } from './onboardingHandler';
import type { TTSClient } from './ttsClient';
import type { ContextTracker } from './contextTracker';
import type { InteractionMode } from './providers';

export interface WebviewRouteDeps {
  aiCoordinator: AICoordinator;
  onboardingHandler: OnboardingHandler;
  ttsClient: TTSClient;
  tracker: ContextTracker;
  setInteractionMode: (m: InteractionMode) => void;
  postMessage: (msg: any) => void;
  /** Click on Zee's thought cloud — escalates to a "Tell me more — …"
   *  user message. */
  handleThoughtFollowup: (expandHint: string) => Promise<void>;
  handleClearTranscript: () => void;
  handleUndoLastTurn: () => void;
  handleWebviewLoaded: () => void;
  handleWebviewReady: () => void;
  handleLearnMore: () => Promise<void>;
  startMicRecording: () => void;
  stopMicRecording: () => void;
  forceFinishUtterance: () => void;
  showSettings: () => void;
}

/**
 * Build a typed dispatch function for webview messages. Unknown message
 * types are silently ignored (same behavior as the original switch).
 */
export function createWebviewMessageRouter(deps: WebviewRouteDeps): (msg: any) => Promise<void> {
  return async function dispatch(msg: any): Promise<void> {
    switch (msg.type) {
      case 'user_message':
        await deps.aiCoordinator.handleUserMessage(msg.text, msg.mode);
        break;

      case 'thought_followup':
        // Click on a thought cloud — escalate to a real chat exchange.
        await deps.handleThoughtFollowup(typeof msg.expandHint === 'string' ? msg.expandHint : '');
        break;

      case 'save_settings':
        await deps.onboardingHandler.handleSaveSettings(msg);
        break;

      case 'validate_key':
        await deps.onboardingHandler.handleValidateKey(msg.provider, msg.key);
        break;

      case 'complete_onboarding':
        await deps.onboardingHandler.handleCompleteOnboarding(msg);
        break;

      case 'reset_zee':
        await deps.onboardingHandler.handleResetZee();
        break;

      case 'toggle_companion':
        await deps.onboardingHandler.handleToggleCompanion(msg.enabled);
        break;

      case 'stop_speaking':
        deps.aiCoordinator.handleStop();
        break;

      case 'set_mode':
        deps.setInteractionMode(msg.mode);
        if (msg.mode !== 'voice') {
          deps.ttsClient.cancel();
          deps.postMessage({ type: 'status', state: 'idle' });
        } else {
          deps.ttsClient.reset();   // clear cancelled state for a new voice session
        }
        break;

      case 'clear_transcript':
        deps.handleClearTranscript();
        break;

      case 'undo_last_turn':
        deps.handleUndoLastTurn();
        break;

      case 'webview_loaded':
        deps.handleWebviewLoaded();
        break;

      case 'webview_ready':
        deps.handleWebviewReady();
        break;

      case 'api_tts_done':
        deps.ttsClient.notifyApiTTSDone();
        break;

      case 'learn_more':
        await deps.handleLearnMore();
        break;

      case 'start_recording':
        deps.startMicRecording();
        break;

      case 'stop_recording':
        deps.stopMicRecording();
        break;

      case 'force_finish_utterance':
        // User clicked "send now" — force the current utterance to commit
        // without waiting for VAD silence. Useful in noisy environments.
        deps.forceFinishUtterance();
        break;

      case 'set_pending_attachment':
        // Webview-side attach/detach of a nearby plot. The cellIndex is
        // applied to the NEXT user message (chat or voice), then cleared.
        deps.aiCoordinator.setPendingAttachment(
          typeof msg.cellIndex === 'number' ? msg.cellIndex : null,
        );
        break;

      case 'voice_audio':
        // Webview-capture path (Docker / browser): webview has captured a
        // speech segment, decoded to Float32 16 kHz mono PCM, and base64-
        // encoded it. Host runs Moonshine and returns the transcription.
        await deps.aiCoordinator.handleVoiceAudio(msg.audio);
        break;

      case 'test_voice':
        deps.ttsClient.reset();
        deps.ttsClient.enqueueSentence(
          msg.text || 'Hello, this is a voice test.',
          { force: true },
        );
        break;

      case 'show_settings':
        deps.showSettings();
        break;

      case 'activity_ping':
        // Webview-originated activity (chat typing, mic speech) — counts
        // toward the same idle clock as in-editor events.
        deps.tracker.notifyExternalActivity();
        break;

      // Unknown types silently ignored (matches prior switch behavior).
    }
  };
}
