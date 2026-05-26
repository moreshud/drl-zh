import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebviewMessageRouter, WebviewRouteDeps } from '../src/webviewMessages';

function makeDeps(): WebviewRouteDeps {
  const sent: any[] = [];
  return {
    aiCoordinator: {
      handleUserMessage: vi.fn(async () => {}),
      handleStop: vi.fn(),
      handleVoiceAudio: vi.fn(async () => {}),
      setPendingAttachment: vi.fn(),
    } as any,
    onboardingHandler: {
      handleSaveSettings: vi.fn(async () => {}),
      handleValidateKey: vi.fn(async () => {}),
      handleCompleteOnboarding: vi.fn(async () => {}),
      handleResetZee: vi.fn(async () => {}),
      handleToggleCompanion: vi.fn(async () => {}),
    } as any,
    ttsClient: {
      cancel: vi.fn(),
      reset: vi.fn(),
      notifyApiTTSDone: vi.fn(),
      enqueueSentence: vi.fn(),
    } as any,
    tracker: { notifyExternalActivity: vi.fn() } as any,
    setInteractionMode: vi.fn(),
    postMessage: vi.fn((m) => sent.push(m)),
    handleThoughtFollowup: vi.fn(async () => {}),
    handleClearTranscript: vi.fn(),
    handleUndoLastTurn: vi.fn(),
    handleWebviewLoaded: vi.fn(),
    handleWebviewReady: vi.fn(),
    handleLearnMore: vi.fn(async () => {}),
    startMicRecording: vi.fn(),
    stopMicRecording: vi.fn(),
    forceFinishUtterance: vi.fn(),
    showSettings: vi.fn(),
  };
}

describe('createWebviewMessageRouter', () => {
  let deps: WebviewRouteDeps;
  let dispatch: (m: any) => Promise<void>;

  beforeEach(() => {
    deps = makeDeps();
    dispatch = createWebviewMessageRouter(deps);
  });

  describe('AI coordinator routes', () => {
    it('user_message → aiCoordinator.handleUserMessage(text, mode)', async () => {
      await dispatch({ type: 'user_message', text: 'hi', mode: 'chat' });
      expect(deps.aiCoordinator.handleUserMessage).toHaveBeenCalledWith('hi', 'chat');
    });

    it('stop_speaking → aiCoordinator.handleStop()', async () => {
      await dispatch({ type: 'stop_speaking' });
      expect(deps.aiCoordinator.handleStop).toHaveBeenCalled();
    });

    it('voice_audio → aiCoordinator.handleVoiceAudio(base64)', async () => {
      await dispatch({ type: 'voice_audio', audio: 'aGVsbG8=' });
      expect(deps.aiCoordinator.handleVoiceAudio).toHaveBeenCalledWith('aGVsbG8=');
    });
  });

  describe('onboarding routes', () => {
    it('save_settings → handleSaveSettings(msg)', async () => {
      const msg = { type: 'save_settings', settings: { speechRate: 1.2 } };
      await dispatch(msg);
      expect(deps.onboardingHandler.handleSaveSettings).toHaveBeenCalledWith(msg);
    });

    it('validate_key → handleValidateKey(provider, key)', async () => {
      await dispatch({ type: 'validate_key', provider: 'gemini', key: 'AIza...' });
      expect(deps.onboardingHandler.handleValidateKey).toHaveBeenCalledWith('gemini', 'AIza...');
    });

    it('complete_onboarding → handleCompleteOnboarding(msg)', async () => {
      const msg = { type: 'complete_onboarding', skillLevel: 'some' };
      await dispatch(msg);
      expect(deps.onboardingHandler.handleCompleteOnboarding).toHaveBeenCalledWith(msg);
    });

    it('reset_zee → handleResetZee()', async () => {
      await dispatch({ type: 'reset_zee' });
      expect(deps.onboardingHandler.handleResetZee).toHaveBeenCalled();
    });

    it('toggle_companion → handleToggleCompanion(enabled)', async () => {
      await dispatch({ type: 'toggle_companion', enabled: false });
      expect(deps.onboardingHandler.handleToggleCompanion).toHaveBeenCalledWith(false);
    });
  });

  describe('set_mode', () => {
    it('updates interaction mode', async () => {
      await dispatch({ type: 'set_mode', mode: 'voice' });
      expect(deps.setInteractionMode).toHaveBeenCalledWith('voice');
    });

    it('switching to chat cancels TTS and posts idle', async () => {
      await dispatch({ type: 'set_mode', mode: 'chat' });
      expect(deps.ttsClient.cancel).toHaveBeenCalled();
      expect(deps.postMessage).toHaveBeenCalledWith({ type: 'status', state: 'idle' });
    });

    it('switching to voice resets TTS (no cancel)', async () => {
      await dispatch({ type: 'set_mode', mode: 'voice' });
      expect(deps.ttsClient.reset).toHaveBeenCalled();
      expect(deps.ttsClient.cancel).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle routes', () => {
    it('webview_loaded and webview_ready call their handlers', async () => {
      await dispatch({ type: 'webview_loaded' });
      expect(deps.handleWebviewLoaded).toHaveBeenCalled();
      await dispatch({ type: 'webview_ready' });
      expect(deps.handleWebviewReady).toHaveBeenCalled();
    });

    it('thought_followup routes through with the expand hint', async () => {
      await dispatch({ type: 'thought_followup', expandHint: 'help me debug this' });
      expect(deps.handleThoughtFollowup).toHaveBeenCalledWith('help me debug this');
    });

    it('thought_followup with no hint passes empty string (defensive)', async () => {
      await dispatch({ type: 'thought_followup' });
      expect(deps.handleThoughtFollowup).toHaveBeenCalledWith('');
    });

    it('clear_transcript routes through', async () => {
      await dispatch({ type: 'clear_transcript' });
      expect(deps.handleClearTranscript).toHaveBeenCalled();
    });

    it('undo_last_turn routes through', async () => {
      await dispatch({ type: 'undo_last_turn' });
      expect(deps.handleUndoLastTurn).toHaveBeenCalled();
    });

    it('show_settings routes through', async () => {
      await dispatch({ type: 'show_settings' });
      expect(deps.showSettings).toHaveBeenCalled();
    });
  });

  describe('mic control', () => {
    it('start_recording and stop_recording route through', async () => {
      await dispatch({ type: 'start_recording' });
      expect(deps.startMicRecording).toHaveBeenCalled();
      await dispatch({ type: 'stop_recording' });
      expect(deps.stopMicRecording).toHaveBeenCalled();
    });

    it('force_finish_utterance routes through to the recorder', async () => {
      await dispatch({ type: 'force_finish_utterance' });
      expect(deps.forceFinishUtterance).toHaveBeenCalled();
    });

    it('set_pending_attachment with a number stores that cell index', async () => {
      await dispatch({ type: 'set_pending_attachment', cellIndex: 7 });
      expect(deps.aiCoordinator.setPendingAttachment).toHaveBeenCalledWith(7);
    });

    it('set_pending_attachment with null clears the slot', async () => {
      await dispatch({ type: 'set_pending_attachment', cellIndex: null });
      expect(deps.aiCoordinator.setPendingAttachment).toHaveBeenCalledWith(null);
    });

    it('activity_ping notifies the context tracker', async () => {
      await dispatch({ type: 'activity_ping' });
      expect(deps.tracker.notifyExternalActivity).toHaveBeenCalled();
    });

    it('api_tts_done notifies TTS', async () => {
      await dispatch({ type: 'api_tts_done' });
      expect(deps.ttsClient.notifyApiTTSDone).toHaveBeenCalled();
    });
  });

  describe('test_voice', () => {
    it('with text → reset TTS + enqueue the provided sentence forced', async () => {
      await dispatch({ type: 'test_voice', text: 'custom' });
      expect(deps.ttsClient.reset).toHaveBeenCalled();
      expect(deps.ttsClient.enqueueSentence).toHaveBeenCalledWith('custom', { force: true });
    });

    it('with no text → uses the default sentence', async () => {
      await dispatch({ type: 'test_voice' });
      expect(deps.ttsClient.enqueueSentence).toHaveBeenCalledWith(
        'Hello, this is a voice test.',
        { force: true },
      );
    });
  });

  it('unknown message types are silently ignored', async () => {
    // No throws, no calls
    await expect(dispatch({ type: 'nonexistent' })).resolves.toBeUndefined();
  });
});
