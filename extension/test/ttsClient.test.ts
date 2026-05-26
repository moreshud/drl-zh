import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TTSClient, TTSClientEvents } from '../src/ttsClient';
import { DEFAULT_CONFIG, UserConfig, TTSProvider } from '../src/providers';

// Mock providers module to control getTTSProvider output
const mockTTSProvider: TTSProvider = {
  name: 'MockTTS',
  speak: vi.fn(async (
    _text: string,
    onAudioChunk: (base64: string) => void,
    onDone: () => void,
    _onError: (error: Error) => void,
  ) => {
    onAudioChunk('base64audio');
    onDone();
  }),
  cancel: vi.fn(),
};

vi.mock('../src/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers')>();
  return {
    ...original,
    getTTSProvider: vi.fn(() => mockTTSProvider),
  };
});

import { getTTSProvider } from '../src/providers';

function makeEvents(overrides?: Partial<TTSClientEvents>): TTSClientEvents {
  return {
    onAudioChunk: vi.fn(),
    onSentenceComplete: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onApiQueueDrain: vi.fn(),
    ...overrides,
  };
}

describe('TTSClient', () => {
  let events: TTSClientEvents;
  let config: UserConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    events = makeEvents();
    config = { ...DEFAULT_CONFIG, voiceResponsesEnabled: true };
    vi.mocked(getTTSProvider).mockReturnValue(mockTTSProvider);
    (mockTTSProvider.speak as any).mockImplementation(async (
      _text: string,
      onAudioChunk: (base64: string) => void,
      onDone: () => void,
      _onError: (error: Error) => void,
    ) => {
      onAudioChunk('base64audio');
      onDone();
    });
  });

  describe('enqueueSentence', () => {
    it('does nothing when voiceResponsesEnabled is false', () => {
      const disabledConfig = { ...config, voiceResponsesEnabled: false };
      const client = new TTSClient(disabledConfig, events);
      client.enqueueSentence('Hello');
      expect(mockTTSProvider.speak).not.toHaveBeenCalled();
    });

    it('speaks when voiceResponsesEnabled is false but force is true', async () => {
      const disabledConfig = { ...config, voiceResponsesEnabled: false };
      const client = new TTSClient(disabledConfig, events);
      client.enqueueSentence('Hello', { force: true });
      await vi.waitFor(() => {
        expect(mockTTSProvider.speak).toHaveBeenCalledWith('Hello', expect.any(Function), expect.any(Function), expect.any(Function));
      });
    });

    it('does nothing when cancelled', () => {
      const client = new TTSClient(config, events);
      client.cancel();
      client.enqueueSentence('Hello');
      expect(mockTTSProvider.speak).not.toHaveBeenCalled();
    });

    it('speaks sentence through provider', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Hello world');

      // Allow async processing
      await vi.waitFor(() => {
        expect(mockTTSProvider.speak).toHaveBeenCalledOnce();
      });
    });

    it('forwards audio chunks to event handler', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Hello');

      await vi.waitFor(() => {
        expect(events.onAudioChunk).toHaveBeenCalledWith('base64audio');
      });
    });

    it('calls onApiQueueDrain (not onDone) when queue empties', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Hello');

      await vi.waitFor(() => {
        expect(events.onApiQueueDrain).toHaveBeenCalled();
      });
      // onDone should NOT fire — the webview must signal api_tts_done first
      expect(events.onDone).not.toHaveBeenCalled();
    });

    it('notifyApiTTSDone triggers onDone', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Hello');

      await vi.waitFor(() => {
        expect(events.onApiQueueDrain).toHaveBeenCalled();
      });

      client.notifyApiTTSDone();
      expect(events.onDone).toHaveBeenCalledOnce();
    });

    it('fires onSentenceComplete per sentence (pipelined)', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('First');
      client.enqueueSentence('Second');

      await vi.waitFor(() => {
        // Each sentence is a separate call → one onSentenceComplete per sentence
        expect(events.onSentenceComplete).toHaveBeenCalledTimes(2);
      });
    });

    it('pipelines sentences individually (not batched)', async () => {
      const speakOrder: string[] = [];
      (mockTTSProvider.speak as any).mockImplementation(async (
        text: string,
        _onAudioChunk: (base64: string) => void,
        onDone: () => void,
        _onError: (error: Error) => void,
      ) => {
        speakOrder.push(text);
        onDone();
      });

      const client = new TTSClient(config, events);
      client.enqueueSentence('First');
      client.enqueueSentence('Second');
      client.enqueueSentence('Third');

      await vi.waitFor(() => {
        expect(speakOrder).toEqual(['First', 'Second', 'Third']);
      });
    });
  });

  describe('cancel', () => {
    it('clears the queue', () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('First');
      client.cancel();
      // After cancel, no more processing should happen
      expect(client['sentenceQueue']).toHaveLength(0);
    });

    it('calls provider.cancel()', () => {
      const client = new TTSClient(config, events);
      client.cancel();
      expect(mockTTSProvider.cancel).toHaveBeenCalledOnce();
    });

    it('prevents new sentences from being enqueued', () => {
      const client = new TTSClient(config, events);
      client.cancel();
      client.enqueueSentence('Should not be spoken');
      expect(client['sentenceQueue']).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('allows enqueueing after cancel+reset', async () => {
      const client = new TTSClient(config, events);
      client.cancel();
      client.reset();
      client.enqueueSentence('After reset');

      await vi.waitFor(() => {
        expect(mockTTSProvider.speak).toHaveBeenCalled();
      });
    });

    it('clears sentence queue', () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('queued');
      client.reset();
      expect(client['sentenceQueue']).toHaveLength(0);
    });

    it('resets consecutive error counter', () => {
      const client = new TTSClient(config, events);
      (client as any).consecutiveErrors = 5;
      client.reset();
      expect(client['consecutiveErrors']).toBe(0);
    });
  });

  describe('error handling', () => {
    it('continues queue after single error (silent fallback)', async () => {
      let callCount = 0;
      (mockTTSProvider.speak as any).mockImplementation(async (
        text: string,
        _onAudioChunk: (base64: string) => void,
        onDone: () => void,
        onError: (error: Error) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          onError(new Error('TTS failed'));
        } else {
          onDone();
        }
      });

      const client = new TTSClient(config, events);
      // Flush separately to create two distinct queue entries
      client.enqueueSentence('Fail');
      client.flush();
      client.enqueueSentence('Succeed');
      client.flush();

      await vi.waitFor(() => {
        expect(callCount).toBe(2);
      });

      // Error is reported immediately but queue continues
      expect(events.onError).toHaveBeenCalledTimes(1);
    });

    it('stops queue after 3 consecutive failures', async () => {
      let callCount = 0;
      (mockTTSProvider.speak as any).mockImplementation(async (
        _text: string,
        _onAudioChunk: (base64: string) => void,
        _onDone: () => void,
        onError: (error: Error) => void,
      ) => {
        callCount++;
        onError(new Error(`TTS failed ${callCount}`));
      });

      const client = new TTSClient(config, events);
      // Flush each separately to create individual queue entries
      for (let i = 0; i < 5; i++) {
        client.enqueueSentence(`Fail ${i}`);
        client.flush();
      }

      await vi.waitFor(() => {
        expect(events.onError).toHaveBeenCalled();
      });
      // Provider was called at most 3 times then stopped
      expect(callCount).toBeLessThanOrEqual(3);
    });

    it('hasGivenUp returns true after 3 consecutive failures', async () => {
      (mockTTSProvider.speak as any).mockImplementation(async (
        _text: string,
        _onAudioChunk: (base64: string) => void,
        _onDone: () => void,
        onError: (error: Error) => void,
      ) => {
        onError(new Error('TTS failed'));
      });

      const client = new TTSClient(config, events);
      for (let i = 0; i < 5; i++) {
        client.enqueueSentence(`Fail ${i}`);
        client.flush();
      }

      await vi.waitFor(() => {
        expect(client.hasGivenUp()).toBe(true);
      });
    });

    it('hasGivenUp returns false when healthy', () => {
      const client = new TTSClient(config, events);
      expect(client.hasGivenUp()).toBe(false);
    });

    it('resets error counter after successful speak', async () => {
      let callCount = 0;
      (mockTTSProvider.speak as any).mockImplementation(async (
        _text: string,
        _onAudioChunk: (base64: string) => void,
        onDone: () => void,
        onError: (error: Error) => void,
      ) => {
        callCount++;
        if (callCount <= 2) {
          onError(new Error('fail'));
        } else {
          onDone();
        }
      });

      const client = new TTSClient(config, events);
      client.enqueueSentence('Fail 1');
      client.flush();
      client.enqueueSentence('Fail 2');
      client.flush();
      client.enqueueSentence('Succeed');
      client.flush();

      await vi.waitFor(() => {
        expect(callCount).toBe(3);
      });

      expect(client['consecutiveErrors']).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('resets consecutiveErrors so TTS can recover', () => {
      const client = new TTSClient(config, events);
      // Simulate 3 errors which would block processQueue
      (client as any).consecutiveErrors = 3;
      client.updateConfig(config);
      expect((client as any).consecutiveErrors).toBe(0);
    });

    it('does not recreate the provider', () => {
      const client = new TTSClient(config, events);
      vi.mocked(getTTSProvider).mockClear();
      client.updateConfig({ ...config, speechRate: 1.25 });
      expect(getTTSProvider).not.toHaveBeenCalled();
    });
  });

  describe('hasPendingWork', () => {
    it('returns false when idle', () => {
      const client = new TTSClient(config, events);
      expect(client.hasPendingWork()).toBe(false);
    });

    it('returns true while processing a sentence', async () => {
      let resolveSpeak!: () => void;
      (mockTTSProvider.speak as any).mockImplementation(async (
        _text: string,
        _onAudioChunk: (base64: string) => void,
        onDone: () => void,
        _onError: (error: Error) => void,
      ) => {
        await new Promise<void>((resolve) => { resolveSpeak = resolve; });
        onDone();
      });

      const client = new TTSClient(config, events);
      client.enqueueSentence('Processing...');

      // While speak is awaiting, hasPendingWork should be true
      expect(client.hasPendingWork()).toBe(true);

      // Let speak complete
      resolveSpeak();
      await vi.waitFor(() => {
        expect(client.hasPendingWork()).toBe(false);
      });
    });

    it('returns true when queue has waiting sentences', () => {
      // First sentence blocks forever so second stays queued
      (mockTTSProvider.speak as any).mockImplementation(async () => {
        await new Promise(() => {});
      });

      const client = new TTSClient(config, events);
      client.enqueueSentence('First');
      client.enqueueSentence('Second');

      expect(client.hasPendingWork()).toBe(true);
    });

    it('returns false after cancel', () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Will be cancelled');
      client.cancel();
      expect(client.hasPendingWork()).toBe(false);
    });

    it('returns false after reset', () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Will be reset');
      client.reset();
      expect(client.hasPendingWork()).toBe(false);
    });
  });

  describe('premature idle prevention', () => {
    it('onDone callback fires but idle should be gated by external checks', async () => {
      // This test verifies the TTS client correctly calls onDone when
      // playback reports complete, giving the host a chance to gate it.
      // The host (extension.ts) should check aiClient.isStreaming() before
      // sending idle to the webview.
      const client = new TTSClient(config, events);
      client.enqueueSentence('Sentence one.');

      await vi.waitFor(() => {
        expect(events.onApiQueueDrain).toHaveBeenCalled();
      });

      // Simulate webview reporting playback done
      client.notifyApiTTSDone();
      // onDone fires — the host callback should gate this on AI streaming state
      expect(events.onDone).toHaveBeenCalledOnce();
    });

    it('does NOT fire onDone via notifyApiTTSDone when cancelled', async () => {
      const client = new TTSClient(config, events);
      client.enqueueSentence('Will be cancelled');

      await vi.waitFor(() => {
        expect(events.onApiQueueDrain).toHaveBeenCalled();
      });

      client.cancel();
      client.notifyApiTTSDone();
      expect(events.onDone).not.toHaveBeenCalled();
    });
  });

  describe('mode switch: cancel then reset', () => {
    it('cancel blocks new sentences, reset re-enables them (voice→chat→voice)', async () => {
      const client = new TTSClient(config, events);

      // Simulate switching to chat mode: cancel TTS
      client.cancel();
      client.enqueueSentence('Should be ignored');
      expect(mockTTSProvider.speak).not.toHaveBeenCalled();

      // Simulate switching back to voice mode: reset TTS
      client.reset();
      client.enqueueSentence('Now it works');

      await vi.waitFor(() => {
        expect(mockTTSProvider.speak).toHaveBeenCalledWith(
          'Now it works',
          expect.any(Function),
          expect.any(Function),
          expect.any(Function),
        );
      });
    });
  });

  describe('cancel clears queue', () => {
    it('clears sentenceQueue on cancel', () => {
      // Use a slow mock so sentences stay queued
      (mockTTSProvider.speak as any).mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 5000));
      });
      const client = new TTSClient(config, events);
      client.enqueueSentence('A');
      client.enqueueSentence('B');
      // First is processing, second is in queue
      client.cancel();
      expect((client as any).sentenceQueue.length).toBe(0);
    });
  });
});
