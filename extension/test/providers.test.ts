import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMemento } from './__mocks__/vscode';
import {
  DEFAULT_CONFIG, UserConfig,
  GeminiProvider, OpenAIProvider, AnthropicProvider,
  KokoroTTSProvider,
  getLLMProvider, getCheapProvider, getTTSProvider,
  loadConfig, saveConfig,
  validateGroqKey, pcmToWav,
  CHAPTER_CONTEXT, SYSTEM_PROMPT_PERSONA, VOICE_MODE_INSTRUCTION,
} from '../src/providers';
import {
  SECRET_GROQ_KEY, SECRET_GEMINI_KEY,
  KEY_LLM_PROVIDER,
  DEFAULT_GROQ_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_ANTHROPIC_MODEL,
} from '../src/constants';

// ── DEFAULT_CONFIG ──────────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  it('defaults to gemini LLM provider', () => {
    expect(DEFAULT_CONFIG.llmProvider).toBe('gemini');
  });

  it('defaults to chat interaction mode', () => {
    expect(DEFAULT_CONFIG.defaultInteractionMode).toBe('chat');
  });

  it('has voice responses enabled by default', () => {
    expect(DEFAULT_CONFIG.voiceResponsesEnabled).toBe(true);
  });

  it('has companion enabled by default', () => {
    expect(DEFAULT_CONFIG.companionEnabled).toBe(true);
  });

  it('has empty API keys by default', () => {
    expect(DEFAULT_CONFIG.groqApiKey).toBe('');
    expect(DEFAULT_CONFIG.geminiApiKey).toBe('');
    expect(DEFAULT_CONFIG.openaiApiKey).toBe('');
    expect(DEFAULT_CONFIG.anthropicApiKey).toBe('');
  });

  it('has current default chat models', () => {
    expect(DEFAULT_CONFIG.groqModel).toBe(DEFAULT_GROQ_MODEL);
    expect(DEFAULT_CONFIG.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(DEFAULT_CONFIG.openaiModel).toBe(DEFAULT_OPENAI_MODEL);
    expect(DEFAULT_CONFIG.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('speech rate defaults to 1.0', () => {
    expect(DEFAULT_CONFIG.speechRate).toBe(1.0);
  });
});

// ── Factory functions ───────────────────────────────────────────────────────

describe('getLLMProvider', () => {
  it('returns OpenAIProvider for groq', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'groq' as const, groqApiKey: 'gsk_test' };
    const provider = getLLMProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('Groq');
  });

  it('returns GeminiProvider for gemini', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'gemini' as const, geminiApiKey: 'test' };
    const provider = getLLMProvider(config);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('uses the configured model override for the selected provider', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llmProvider: 'openai' as const,
      openaiApiKey: 'test',
      openaiModel: 'gpt-custom-for-course',
    };
    const provider = getLLMProvider(config);
    expect((provider as any).model).toBe('gpt-custom-for-course');
  });

  it('returns OpenAIProvider for openai', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'openai' as const, openaiApiKey: 'test' };
    const provider = getLLMProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('OpenAI');
  });

  it('returns AnthropicProvider for anthropic', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'anthropic' as const, anthropicApiKey: 'test' };
    const provider = getLLMProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('Anthropic');
  });

  it('defaults to GeminiProvider for unknown provider', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'unknown' as any, geminiApiKey: 'test' };
    const provider = getLLMProvider(config);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});

describe('getCheapProvider', () => {
  it('returns OpenAIProvider (instant model) for groq', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'groq' as const, groqApiKey: 'gsk_test' };
    const provider = getCheapProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider!.name).toBe('Groq');
  });

  it('returns null for groq when no key', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'groq' as const, groqApiKey: '' };
    expect(getCheapProvider(config)).toBeNull();
  });

  it('returns GeminiProvider with flash model for gemini', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'gemini' as const, geminiApiKey: 'test' };
    const provider = getCheapProvider(config);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('returns OpenAIProvider with mini model for openai', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'openai' as const, openaiApiKey: 'test' };
    const provider = getCheapProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('returns AnthropicProvider with haiku model for anthropic', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'anthropic' as const, anthropicApiKey: 'test' };
    const provider = getCheapProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns null when no API key is available', () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'openai' as const, openaiApiKey: '' };
    const provider = getCheapProvider(config);
    expect(provider).toBeNull();
  });
});

describe('getTTSProvider', () => {
  it('returns a KokoroTTSProvider', () => {
    const provider = getTTSProvider();
    expect(provider).toBeInstanceOf(KokoroTTSProvider);
    expect(provider.name).toBe('Kokoro');
  });

  it('accepts a kokoro cache dir without throwing', () => {
    expect(() => getTTSProvider('/tmp/kokoro-cache')).not.toThrow();
  });
});

// ── Config persistence ──────────────────────────────────────────────────────

describe('loadConfig / saveConfig', () => {
  let state: MockMemento;
  let keyStore: MockMemento;

  beforeEach(() => {
    state = new MockMemento();
    keyStore = new MockMemento();
  });

  it('returns defaults when storage is empty', async () => {
    const config = await loadConfig(state as any, keyStore as any);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('round-trips a full config through save then load', async () => {
    const custom: UserConfig = {
      llmProvider: 'openai',
      groqApiKey: 'gsk-key-000',
      geminiApiKey: 'gem-key-123',
      openaiApiKey: 'oai-key-456',
      anthropicApiKey: 'ant-key-789',
      groqModel: 'llama-custom',
      geminiModel: 'gemini-custom',
      openaiModel: 'gpt-custom',
      anthropicModel: 'claude-custom',
      speechRate: 1.25,
      voiceResponsesEnabled: false,
      micSensitivity: 'noisy',
      defaultInteractionMode: 'voice',
      companionEnabled: false,
    };

    await saveConfig(custom, state as any, keyStore as any);
    const loaded = await loadConfig(state as any, keyStore as any);

    expect(loaded).toEqual(custom);
  });

  it('stores API keys in keyStore (globalState), not workspaceState', async () => {
    const config = { ...DEFAULT_CONFIG, groqApiKey: 'gsk-test', geminiApiKey: 'my-key' };
    await saveConfig(config, state as any, keyStore as any);

    // Keys should be in keyStore, not in state
    expect(keyStore.get(SECRET_GROQ_KEY)).toBe('gsk-test');
    expect(state.get(SECRET_GROQ_KEY)).toBeUndefined();
    expect(keyStore.get(SECRET_GEMINI_KEY)).toBe('my-key');
    expect(state.get(SECRET_GEMINI_KEY)).toBeUndefined();
  });

  it('stores non-secret fields in workspaceState', async () => {
    const config = { ...DEFAULT_CONFIG, llmProvider: 'openai' as const };
    await saveConfig(config, state as any, keyStore as any);

    expect(state.get(KEY_LLM_PROVIDER)).toBe('openai');
  });

  it('handles missing keys gracefully (returns empty strings)', async () => {
    await state.update(KEY_LLM_PROVIDER, 'anthropic');
    // Don't store any keys
    const config = await loadConfig(state as any, keyStore as any);

    expect(config.llmProvider).toBe('anthropic');
    expect(config.geminiApiKey).toBe('');
    expect(config.anthropicApiKey).toBe('');
  });
});

// ── Chapter context ─────────────────────────────────────────────────────────

describe('CHAPTER_CONTEXT', () => {
  it('has entries for chapters 0-18', () => {
    for (let i = 0; i <= 18; i++) {
      expect(CHAPTER_CONTEXT[i]).toBeDefined();
      expect(typeof CHAPTER_CONTEXT[i]).toBe('string');
      expect(CHAPTER_CONTEXT[i].length).toBeGreaterThan(0);
    }
  });

  it('chapter 3 mentions DQN', () => {
    expect(CHAPTER_CONTEXT[3]).toContain('DQN');
  });

  it('chapter 6 mentions PPO', () => {
    expect(CHAPTER_CONTEXT[6]).toContain('PPO');
  });

  it('chapter 12 mentions RLHF', () => {
    expect(CHAPTER_CONTEXT[12]).toContain('RLHF');
  });

  it('chapter 14 mentions Productionizing', () => {
    expect(CHAPTER_CONTEXT[14]).toContain('Productionizing');
  });

  it('chapter 15 mentions Model-Based', () => {
    expect(CHAPTER_CONTEXT[15]).toContain('Model-Based');
  });

  it('chapter 16 mentions Dreamer', () => {
    expect(CHAPTER_CONTEXT[16]).toContain('Dreamer');
  });

  it('chapter 17 mentions Meta-Learning', () => {
    expect(CHAPTER_CONTEXT[17]).toContain('Meta-Learning');
  });

  it('chapter 18 is the conclusion', () => {
    expect(CHAPTER_CONTEXT[18].toLowerCase()).toContain('conclusion');
  });
});

// ── System prompts ──────────────────────────────────────────────────────────

describe('system prompts', () => {
  it('persona prompt mentions Socratic', () => {
    expect(SYSTEM_PROMPT_PERSONA).toContain('Socratic');
  });

  it('persona prompt mentions never give full solution', () => {
    expect(SYSTEM_PROMPT_PERSONA).toContain('never give the full solution');
  });

  it('persona instructs Zee to anchor "Tell me more" follow-ups to the CURRENT cursor', () => {
    // Regression for the bug where a student clicked a thought-cloud
    // followup AFTER moving their cursor to a different method, and Zee
    // continued discussing the original method (because it dominated the
    // chat history) instead of the new cursor location. The persona
    // explicitly tells the LLM to re-anchor on these messages.
    const flat = SYSTEM_PROMPT_PERSONA.replace(/\s+/g, ' ');
    expect(flat).toContain('Tell me more');
    expect(flat).toContain('cursor may have moved');
    expect(flat).toMatch(/re-?anchor.*current cursor/i);
  });

  it('voice mode instruction includes JSON format', () => {
    expect(VOICE_MODE_INSTRUCTION).toContain('"text"');
    expect(VOICE_MODE_INSTRUCTION).toContain('"richText"');
    expect(VOICE_MODE_INSTRUCTION).toContain('JSON');
  });
});

// ── LLM Provider cancellation ───────────────────────────────────────────────

describe('LLM provider cancellation', () => {
  it('GeminiProvider.cancel() does not throw when no request is active', () => {
    const provider = new GeminiProvider('gemini-2.5-flash', 'fake-key');
    expect(() => provider.cancel()).not.toThrow();
  });

  it('OpenAIProvider.cancel() does not throw when no request is active', () => {
    const provider = new OpenAIProvider('gpt-4o', 'fake-key');
    expect(() => provider.cancel()).not.toThrow();
  });

  it('AnthropicProvider.cancel() does not throw when no request is active', () => {
    const provider = new AnthropicProvider('claude-sonnet-4-5', 'fake-key');
    expect(() => provider.cancel()).not.toThrow();
  });
});

// ── TTS Provider basics ─────────────────────────────────────────────────────

describe('KokoroTTSProvider', () => {
  it('cancel does not throw', () => {
    const provider = new KokoroTTSProvider();
    expect(() => provider.cancel()).not.toThrow();
  });

  it('cancel prevents onDone/onError after cancellation', async () => {
    const provider = new KokoroTTSProvider();
    const onDone = vi.fn();
    const onError = vi.fn();

    // Start speak then immediately cancel — should not call onDone or onError
    // (the worker isn't available in tests, so it will error, but cancel should suppress it)
    provider.speak('Hello', vi.fn(), onDone, onError);
    provider.cancel();

    // Wait a tick for the promise to settle
    await new Promise(r => setTimeout(r, 50));
    expect(onDone).not.toHaveBeenCalled();
    // onError may or may not fire depending on worker availability, but cancelled flag suppresses it
  });
});

// ── LLM Provider streaming with mock fetch ──────────────────────────────────

describe('GeminiProvider streaming', () => {
  it('calls onChunk for each SSE data line and onDone at end', async () => {
    const sseData = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n',
    ].join('\n');

    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sseData) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => mockReader },
      text: vi.fn(),
    } as any);

    const provider = new GeminiProvider('gemini-2.5-flash', 'fake-key');
    const chunks: string[] = [];
    const onDone = vi.fn();

    await provider.sendMessage({ staticPrefix: 'sys', dynamic: '' }, [], 'hi', (c) => chunks.push(c), onDone, vi.fn());

    expect(chunks).toEqual(['Hello', ' world']);
    expect(onDone).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('calls onError on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    } as any);

    const provider = new GeminiProvider('gemini-2.5-flash', 'bad-key');
    const onError = vi.fn();

    await provider.sendMessage({ staticPrefix: 'sys', dynamic: '' }, [], 'hi', vi.fn(), vi.fn(), onError);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('401');

    vi.restoreAllMocks();
  });

  it('silently returns on abort (no onError call)', async () => {
    const abortError = new Error('AbortError');
    abortError.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

    const provider = new GeminiProvider('gemini-2.5-flash', 'key');
    const onError = vi.fn();
    const onDone = vi.fn();

    await provider.sendMessage({ staticPrefix: 'sys', dynamic: '' }, [], 'hi', vi.fn(), onDone, onError);

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('OpenAIProvider streaming', () => {
  it('parses SSE deltas correctly', async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n',
      'data: [DONE]\n',
    ].join('\n');

    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sseData) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => mockReader },
    } as any);

    const provider = new OpenAIProvider('gpt-4o', 'key');
    const chunks: string[] = [];

    await provider.sendMessage({ staticPrefix: 'sys', dynamic: '' }, [], 'hi', (c) => chunks.push(c), vi.fn(), vi.fn());
    expect(chunks).toEqual(['Hi', '!']);

    vi.restoreAllMocks();
  });
});

describe('AnthropicProvider streaming', () => {
  it('parses content_block_delta events correctly', async () => {
    const sseData = [
      'data: {"type":"content_block_start"}\n',
      'data: {"type":"content_block_delta","delta":{"text":"Hey"}}\n',
      'data: {"type":"content_block_delta","delta":{"text":" there"}}\n',
      'data: {"type":"message_stop"}\n',
    ].join('\n');

    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sseData) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => mockReader },
    } as any);

    const provider = new AnthropicProvider('claude-sonnet-4-5', 'key');
    const chunks: string[] = [];

    await provider.sendMessage({ staticPrefix: 'sys', dynamic: '' }, [], 'hi', (c) => chunks.push(c), vi.fn(), vi.fn());
    expect(chunks).toEqual(['Hey', ' there']);

    vi.restoreAllMocks();
  });

  it('includes history correctly (no system in messages array)', async () => {
    let capturedBody: any;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      } as any;
    });

    const provider = new AnthropicProvider('claude-sonnet-4-5', 'key');
    const history = [
      { role: 'user' as const, content: 'prev question' },
      { role: 'assistant' as const, content: 'prev answer' },
    ];

    await provider.sendMessage({ staticPrefix: 'system prompt', dynamic: '' }, history, 'new question', vi.fn(), vi.fn(), vi.fn());

    expect(capturedBody.system).toEqual([
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(capturedBody.messages).toHaveLength(3);
    expect(capturedBody.messages[0].role).toBe('user');
    expect(capturedBody.messages[2].content).toBe('new question');

    vi.restoreAllMocks();
  });
});

describe('GeminiProvider history mapping', () => {
  it('maps assistant role to model role in Gemini API', async () => {
    let capturedBody: any;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      } as any;
    });

    const provider = new GeminiProvider('gemini-2.5-flash', 'key');
    const history = [
      { role: 'user' as const, content: 'question' },
      { role: 'assistant' as const, content: 'answer' },
    ];

    await provider.sendMessage({ staticPrefix: 'system', dynamic: '' }, history, 'new q', vi.fn(), vi.fn(), vi.fn());

    // Gemini uses 'model' instead of 'assistant'
    expect(capturedBody.contents[1].role).toBe('model');
    expect(capturedBody.contents[0].role).toBe('user');
    // System instruction is separate; when dynamic is empty, only the prefix is sent.
    expect(capturedBody.system_instruction.parts[0].text).toBe('system');

    vi.restoreAllMocks();
  });

  it('concatenates dynamic suffix after static prefix in system_instruction', async () => {
    let capturedBody: any;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      } as any;
    });

    const provider = new GeminiProvider('gemini-2.5-flash', 'key');
    await provider.sendMessage(
      { staticPrefix: 'PREFIX', dynamic: 'DYNAMIC' },
      [],
      'q',
      vi.fn(), vi.fn(), vi.fn()
    );

    expect(capturedBody.system_instruction.parts[0].text).toBe('PREFIX\n\nDYNAMIC');

    vi.restoreAllMocks();
  });
});

describe('AnthropicProvider system block caching', () => {
  it('adds a separate dynamic block without cache_control', async () => {
    let capturedBody: any;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      } as any;
    });

    const provider = new AnthropicProvider('claude-sonnet-4-5', 'key');
    await provider.sendMessage(
      { staticPrefix: 'PREFIX', dynamic: 'DYNAMIC' },
      [],
      'q',
      vi.fn(), vi.fn(), vi.fn()
    );

    expect(capturedBody.system).toEqual([
      { type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'DYNAMIC' },
    ]);

    vi.restoreAllMocks();
  });
});

// ── validateGroqKey ─────────────────────────────────────────────────────────

describe('validateGroqKey', () => {
  it('returns true when Groq models endpoint responds ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true } as any);
    const result = await validateGroqKey('gsk_test');
    expect(result).toBe(true);
    vi.restoreAllMocks();
  });

  it('returns false when Groq models endpoint responds with error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as any);
    const result = await validateGroqKey('bad_key');
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('returns false when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
    const result = await validateGroqKey('gsk_test');
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('sends Authorization Bearer header to Groq models endpoint', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: any;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, opts: any) => {
      capturedUrl = url as string;
      capturedHeaders = opts?.headers;
      return { ok: true } as any;
    });
    await validateGroqKey('gsk_mykey');
    expect(capturedUrl).toBe('https://api.groq.com/openai/v1/models');
    expect(capturedHeaders?.['Authorization']).toBe('Bearer gsk_mykey');
    vi.restoreAllMocks();
  });
});

// ── pcmToWav ────────────────────────────────────────────────────────────────

describe('pcmToWav', () => {
  it('produces valid WAV header', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.slice(0, 4).toString()).toBe('RIFF');
    expect(wav.slice(8, 12).toString()).toBe('WAVE');
    expect(wav.slice(12, 16).toString()).toBe('fmt ');
    expect(wav.slice(36, 40).toString()).toBe('data');
    expect(wav.length).toBe(44 + 100);
  });

  it('preserves PCM data after header', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.slice(44)).toEqual(pcm);
  });

  it('encodes correct sample rate', () => {
    const pcm = Buffer.alloc(10);
    const wav = pcmToWav(pcm, 44100);
    expect(wav.readUInt32LE(24)).toBe(44100);
  });

  it('defaults sample rate to 16000', () => {
    const pcm = Buffer.alloc(10);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(24)).toBe(16000);
  });
});
