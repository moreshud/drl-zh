import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AICoordinator, AICoordinatorDeps } from '../src/aiCoordinator';
import { DEFAULT_CONFIG, UserConfig } from '../src/providers';
import type { NotebookContext } from '../src/contextTracker';

function makeNotebookContext(overrides: Partial<NotebookContext> = {}): NotebookContext {
  return {
    notebookFile: '03_DQN.ipynb',
    chapterNumber: 3,
    chapterTitle: 'Deep Q-Learning',
    activeCellIndex: 0,
    activeCellContent: '',
    activeCellType: 'code',
    isTodoCell: false,
    todoText: '',
    lastError: null,
    consecutiveErrors: 0,
    cellRunCount: 0,
    lastInteractionAt: 0,
    focusSummary: '',
    surroundingCells: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AICoordinatorDeps> = {}): AICoordinatorDeps & {
  __posted: any[];
  __config: UserConfig;
} {
  const posted: any[] = [];
  const config = { ...DEFAULT_CONFIG, voiceResponsesEnabled: true };

  return {
    __posted: posted,
    __config: config,
    getConfig: () => config,
    getInteractionMode: () => 'chat',
    aiClient: {
      isStreaming: vi.fn(() => false),
      cancel: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    } as any,
    ttsClient: {
      cancel: vi.fn(),
      reset: vi.fn(),
      flush: vi.fn(),
      enqueueSentence: vi.fn(),
      hasPendingWork: vi.fn(() => false),
    } as any,
    sttClient: {
      transcribe: vi.fn(async () => 'hello'),
    } as any,
    micRecorder: {
      ready: vi.fn(),
    } as any,
    session: {
      getCurrent: vi.fn(() => '03_DQN.ipynb'),
    } as any,
    transcriptStore: {
      addEntry: vi.fn(),
    } as any,
    tracker: {
      notifyInteraction: vi.fn(),
      resetCooldown: vi.fn(),
      getContext: vi.fn(() => makeNotebookContext()),
      getCellPreview: vi.fn(() => 'preview'),
    } as any,
    decorateContext: (ctx) => ctx,
    postMessage: (m) => posted.push(m),
    isNoiseTranscription: () => false,
    getCellImage: vi.fn(() => null),
    ...overrides,
  } as any;
}

describe('AICoordinator', () => {
  describe('pending-initiative state', () => {
    it('starts with no pending initiative', () => {
      const c = new AICoordinator(makeDeps());
      expect(c.getPendingSignal()).toBeNull();
      expect(c.getPendingPrompt()).toBeNull();
    });

    it('setPending stores both fields', () => {
      const c = new AICoordinator(makeDeps());
      c.setPending('stuck', 'prompt text');
      expect(c.getPendingSignal()).toBe('stuck');
      expect(c.getPendingPrompt()).toBe('prompt text');
    });

    it('clearPending resets both fields', () => {
      const c = new AICoordinator(makeDeps());
      c.setPending('stuck', 'prompt');
      c.clearPending();
      expect(c.getPendingSignal()).toBeNull();
      expect(c.getPendingPrompt()).toBeNull();
    });

    it('setPending records the cell index when given (for the cell badge)', () => {
      const c = new AICoordinator(makeDeps());
      c.setPending('stuck', 'prompt', 5);
      expect(c.getPendingCellIndex()).toBe(5);
      c.clearPending();
      expect(c.getPendingCellIndex()).toBeNull();
    });

    it('setPending without a cell index leaves it null (back-compat)', () => {
      const c = new AICoordinator(makeDeps());
      c.setPending('idle', 'prompt');
      expect(c.getPendingCellIndex()).toBeNull();
    });

    it('onPendingChange fires on every setPending and on clearPending', () => {
      const c = new AICoordinator(makeDeps());
      const fn = vi.fn();
      const unsub = c.onPendingChange(fn);

      c.setPending('stuck', 'p1', 0);
      c.setPending('idle', 'p2', 1);   // re-set: still notifies
      c.clearPending();
      // Clearing again when nothing is pending is a no-op (no spurious event).
      c.clearPending();

      expect(fn).toHaveBeenCalledTimes(3);
      unsub();
      c.setPending('reading', 'p3', 2);
      expect(fn).toHaveBeenCalledTimes(3); // stayed unsubscribed
    });
  });

  describe('handleUserMessage', () => {
    it('empty text is a no-op', async () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      await c.handleUserMessage('   ', 'chat');
      expect(deps.aiClient.sendMessage).not.toHaveBeenCalled();
    });

    it('returns early when companion is disabled', async () => {
      const deps = makeDeps();
      deps.__config.companionEnabled = false;
      const c = new AICoordinator(deps);
      await c.handleUserMessage('hi', 'chat');
      expect(deps.aiClient.sendMessage).not.toHaveBeenCalled();
    });

    it('cancels in-flight AI streaming before starting a new turn (barge-in)', async () => {
      const deps = makeDeps();
      (deps.aiClient.isStreaming as any).mockReturnValue(true);
      const c = new AICoordinator(deps);
      await c.handleUserMessage('new turn', 'chat');
      expect(deps.aiClient.cancel).toHaveBeenCalled();
      expect(deps.ttsClient.cancel).toHaveBeenCalled();
    });

    it('attaches a pending plot once and clears the slot (one-shot)', async () => {
      // The webview signals "attach plot from cell 5" via setPendingAttachment.
      // The next user message should ride with the cell-5 image bytes; the
      // turn after that has nothing attached unless the student re-attaches.
      const deps = makeDeps();
      (deps.getCellImage as any).mockReturnValue({ mimeType: 'image/png', dataBase64: 'AAA' });
      const c = new AICoordinator(deps);
      c.setPendingAttachment(5);

      await c.handleUserMessage('what does this curve mean?', 'chat');
      const firstCall = (deps.aiClient.sendMessage as any).mock.calls[0];
      expect(firstCall[3]).toEqual([{ mimeType: 'image/png', dataBase64: 'AAA' }]);
      expect(deps.getCellImage).toHaveBeenCalledWith(5);
      expect(c.getPendingAttachment()).toBeNull();

      await c.handleUserMessage('and what about variance?', 'chat');
      const secondCall = (deps.aiClient.sendMessage as any).mock.calls[1];
      expect(secondCall[3]).toBeUndefined();
    });

    it('drops the attachment silently if the cell no longer has an image', async () => {
      // Race: user attached, then cleared the cell or the plot was wiped
      // before they sent. Don't ship a stale/empty payload to the LLM.
      const deps = makeDeps();
      (deps.getCellImage as any).mockReturnValue(null);
      const c = new AICoordinator(deps);
      c.setPendingAttachment(5);

      await c.handleUserMessage('hi', 'chat');
      const call = (deps.aiClient.sendMessage as any).mock.calls[0];
      expect(call[3]).toBeUndefined();
      expect(c.getPendingAttachment()).toBeNull();
    });

    it('persists user turn to transcript when notebook is open', async () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      await c.handleUserMessage('hello', 'chat');
      expect(deps.transcriptStore.addEntry).toHaveBeenCalledOnce();
      const call = (deps.transcriptStore.addEntry as any).mock.calls[0];
      expect(call[0]).toBe('03_DQN.ipynb');
      expect(call[1]).toBe('user');
      expect(call[3]).toBe('hello');
    });

    it('does NOT persist in meta-mode (no notebook)', async () => {
      const deps = makeDeps();
      (deps.session.getCurrent as any).mockReturnValue(null);
      // decorateContext returns a ctx with notebookFile=null
      deps.decorateContext = (ctx) => ({ ...ctx, notebookFile: null });
      const c = new AICoordinator(deps);
      await c.handleUserMessage('hi', 'chat');
      expect(deps.transcriptStore.addEntry).not.toHaveBeenCalled();
    });

    it('posts thinking status and calls sendMessage', async () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      await c.handleUserMessage('hello', 'chat');
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'thinking' });
      expect(deps.aiClient.sendMessage).toHaveBeenCalledOnce();
    });

    it('clears any pending initiative (consumed on user turn)', async () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.setPending('stuck', 'prompt');
      await c.handleUserMessage('hi', 'chat');
      expect(c.getPendingSignal()).toBeNull();
    });
  });

  describe('handleAIDone', () => {
    it('persists companion response when notebook is open', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'answer', richText: undefined });
      expect(deps.transcriptStore.addEntry).toHaveBeenCalledOnce();
      const call = (deps.transcriptStore.addEntry as any).mock.calls[0];
      expect(call[1]).toBe('companion');
      expect(call[2]).toBe('chat');   // default interactionMode
      expect(call[3]).toBe('answer');
    });

    it('marks the entry "initiative" when a signal was pending', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.setPending('stuck', 'prompt');
      c.handleAIDone({ text: 'a hint', richText: undefined });
      const call = (deps.transcriptStore.addEntry as any).mock.calls[0];
      expect(call[2]).toBe('initiative');
    });

    it('resets the tracker cooldown after the turn', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'a', richText: undefined });
      expect(deps.tracker.resetCooldown).toHaveBeenCalled();
    });

    it('posts ai_response_complete with text + richText', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'a', richText: 'b' });
      expect(deps.__posted).toContainEqual({ type: 'ai_response_complete', text: 'a', richText: 'b' });
    });

    it('in chat mode posts idle immediately', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'a', richText: undefined });
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'idle' });
    });

    it('in voice mode with pending TTS, does NOT post idle (waits for TTS onDone)', () => {
      const deps = makeDeps({ getInteractionMode: () => 'voice' } as any);
      (deps.ttsClient.hasPendingWork as any).mockReturnValue(true);
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'a', richText: undefined });
      const idles = deps.__posted.filter((m) => m.type === 'status' && m.state === 'idle');
      expect(idles).toHaveLength(0);
      expect(deps.ttsClient.flush).toHaveBeenCalled();
    });

    it('in voice mode with drained TTS, posts idle right away', () => {
      const deps = makeDeps({ getInteractionMode: () => 'voice' } as any);
      (deps.ttsClient.hasPendingWork as any).mockReturnValue(false);
      const c = new AICoordinator(deps);
      c.handleAIDone({ text: 'a', richText: undefined });
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'idle' });
    });
  });

  describe('handleSentenceBoundary', () => {
    it('in voice mode with voiceResponsesEnabled, enqueues and posts speaking', () => {
      const deps = makeDeps({ getInteractionMode: () => 'voice' } as any);
      const c = new AICoordinator(deps);
      c.handleSentenceBoundary('Hello.');
      expect(deps.ttsClient.enqueueSentence).toHaveBeenCalledWith('Hello.');
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'speaking' });
    });

    it('in chat mode, does nothing', () => {
      const deps = makeDeps();   // default chat mode
      const c = new AICoordinator(deps);
      c.handleSentenceBoundary('Hello.');
      expect(deps.ttsClient.enqueueSentence).not.toHaveBeenCalled();
    });

    it('when voiceResponsesEnabled is false, does nothing even in voice mode', () => {
      const deps = makeDeps({ getInteractionMode: () => 'voice' } as any);
      deps.__config.voiceResponsesEnabled = false;
      const c = new AICoordinator(deps);
      c.handleSentenceBoundary('Hello.');
      expect(deps.ttsClient.enqueueSentence).not.toHaveBeenCalled();
    });
  });

  describe('handleStop', () => {
    it('cancels AI + TTS and posts idle + ai_stopped', () => {
      const deps = makeDeps();
      const c = new AICoordinator(deps);
      c.handleStop();
      expect(deps.aiClient.cancel).toHaveBeenCalled();
      expect(deps.ttsClient.cancel).toHaveBeenCalled();
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'idle' });
      expect(deps.__posted).toContainEqual({ type: 'ai_stopped' });
    });
  });

  describe('transcribeAndRespond', () => {
    it('posts transcribing, routes successful text through handleUserMessage, and calls ready()', async () => {
      const deps = makeDeps();
      (deps.sttClient.transcribe as any).mockResolvedValue('hello Zee');
      const c = new AICoordinator(deps);
      await c.transcribeAndRespond(new Float32Array(16000));
      expect(deps.__posted).toContainEqual({ type: 'stt_status', state: 'transcribing' });
      expect(deps.__posted).toContainEqual({ type: 'stt_result', text: 'hello Zee' });
      expect(deps.aiClient.sendMessage).toHaveBeenCalled();
      expect(deps.micRecorder.ready).toHaveBeenCalled();
    });

    it('empty transcription → stt_status listening + ready()', async () => {
      const deps = makeDeps();
      (deps.sttClient.transcribe as any).mockResolvedValue('');
      const c = new AICoordinator(deps);
      await c.transcribeAndRespond(new Float32Array(16000));
      expect(deps.__posted).toContainEqual({ type: 'stt_status', state: 'listening' });
      expect(deps.aiClient.sendMessage).not.toHaveBeenCalled();
      expect(deps.micRecorder.ready).toHaveBeenCalled();
    });

    it('noise transcription → stt_status listening (not sent to AI)', async () => {
      const deps = makeDeps({ isNoiseTranscription: () => true });
      (deps.sttClient.transcribe as any).mockResolvedValue('thank');
      const c = new AICoordinator(deps);
      await c.transcribeAndRespond(new Float32Array(16000));
      expect(deps.__posted).toContainEqual({ type: 'stt_status', state: 'listening' });
      expect(deps.aiClient.sendMessage).not.toHaveBeenCalled();
    });

    it('transcription error → stt_status error + status idle, still calls ready()', async () => {
      const deps = makeDeps();
      (deps.sttClient.transcribe as any).mockRejectedValue(new Error('boom'));
      const c = new AICoordinator(deps);
      await c.transcribeAndRespond(new Float32Array(16000));
      expect(deps.__posted.some(m => m.type === 'stt_status' && m.state === 'error')).toBe(true);
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'idle' });
      expect(deps.micRecorder.ready).toHaveBeenCalled();
    });

    it('ready() is called even if handleUserMessage rejects asynchronously', async () => {
      // Regression: fire-and-forget handleUserMessage must not prevent ready()
      const deps = makeDeps();
      (deps.aiClient.sendMessage as any).mockImplementation(() => {
        return Promise.reject(new Error('network'));
      });
      const c = new AICoordinator(deps);
      await c.transcribeAndRespond(new Float32Array(16000));
      expect(deps.micRecorder.ready).toHaveBeenCalled();
    });
  });

  describe('handleVoiceAudio (webview fallback)', () => {
    it('transcribes base64 PCM and routes through handleUserMessage', async () => {
      const deps = makeDeps();
      (deps.sttClient.transcribe as any).mockResolvedValue('spoken text');
      const c = new AICoordinator(deps);
      // 4 Float32 values = 16 bytes
      const buf = Buffer.alloc(16);
      await c.handleVoiceAudio(buf.toString('base64'));
      expect(deps.sttClient.transcribe).toHaveBeenCalled();
      expect(deps.__posted).toContainEqual({ type: 'stt_result', text: 'spoken text' });
    });

    it('when companionEnabled=false, returns silently', async () => {
      const deps = makeDeps();
      deps.__config.companionEnabled = false;
      const c = new AICoordinator(deps);
      await c.handleVoiceAudio('dGVzdA==');
      expect(deps.sttClient.transcribe).not.toHaveBeenCalled();
    });
  });
});
