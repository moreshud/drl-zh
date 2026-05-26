import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commands, window as vscodeWindow } from './__mocks__/vscode';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    // Mock readFileSync so getWebviewHtml() doesn't try to read the real HTML file
    readFileSync: vi.fn((p: any, enc?: any) => {
      if (typeof p === 'string' && p.endsWith('.html')) { return ''; }
      return actual.readFileSync(p, enc);
    }),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// We test the activate function and verify command registration
const mockTranscribe = vi.fn().mockResolvedValue('');
vi.mock('../src/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers')>();
  class MockMoonshineSTT {
    name = 'MockSTT';
    transcribe = mockTranscribe;
    cancel = vi.fn();
  }
  return {
    ...original,
    loadConfig: vi.fn().mockResolvedValue(original.DEFAULT_CONFIG),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    getLLMProvider: vi.fn(() => ({
      name: 'MockLLM',
      sendMessage: vi.fn(async (_s: any, _h: any, _u: any, _c: any, onDone: any) => onDone()),
      cancel: vi.fn(),
    })),
    getTTSProvider: vi.fn(() => ({
      name: 'MockTTS',
      speak: vi.fn(async (_t: any, _c: any, onDone: any) => onDone()),
      cancel: vi.fn(),
    })),
    MoonshineSTT: MockMoonshineSTT,
    validateGeminiKey: vi.fn().mockResolvedValue(true),
    validateOpenAIKey: vi.fn().mockResolvedValue(true),
    validateAnthropicKey: vi.fn().mockResolvedValue(true),
  };
});

import { activate, deactivate, isNoiseTranscription, extractErrorDetail, pickSoftIdleNudgeLine } from '../src/extension';
import { micSensitivityMultiplier } from '../src/providers';
import { createMockExtensionContext } from './__mocks__/vscode';

describe('extension activation', () => {
  let context: ReturnType<typeof createMockExtensionContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createMockExtensionContext();
  });

  it('registers the webview view provider', () => {
    activate(context as any);
    expect(vscodeWindow.registerWebviewViewProvider).toHaveBeenCalledWith(
      'drlCompanion.chatView',
      expect.any(Object),
      expect.objectContaining({ webviewOptions: { retainContextWhenHidden: true } })
    );
  });

  it('registers drlCompanion.open command', () => {
    activate(context as any);
    const registeredCommands = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(registeredCommands).toContain('drlCompanion.open');
  });

  it('registers drlCompanion.clearHistory command', () => {
    activate(context as any);
    const registeredCommands = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(registeredCommands).toContain('drlCompanion.clearHistory');
  });

  it('registers drlCompanion.settings command', () => {
    activate(context as any);
    const registeredCommands = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(registeredCommands).toContain('drlCompanion.settings');
  });

  it('adds all disposables to context.subscriptions', () => {
    activate(context as any);
    // Should have: webview provider + 3 commands = 4 disposables
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(4);
  });

  it('deactivate is a no-op', () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe('extension module', () => {
  it('loads without error', async () => {
    const mod = await import('../src/extension');
    expect(mod.activate).toBeDefined();
    expect(mod.deactivate).toBeDefined();
  });
});

describe('CompanionViewProvider — initiative acceptance', () => {
  // Test via AIClient's handleAcceptRequest path using pendingInitiativePrompt
  // We test the AIClient directly since CompanionViewProvider is not easily
  // instantiable without a full VS Code context.
  it('AIClient.generateInitiative uses the prompt passed to it', async () => {
    const { AIClient } = await import('../src/aiClient');
    const { getLLMProvider } = await import('../src/providers');
    const mockProvider = {
      name: 'MockLLM',
      sendMessage: vi.fn(async (_s: any, _h: any, userMsg: any, _c: any, onDone: any) => onDone()),
      cancel: vi.fn(),
    };
    vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

    const events = {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onSentenceBoundary: vi.fn(),
    };
    const { DEFAULT_CONFIG } = await import('../src/providers');
    const client = new AIClient({ ...DEFAULT_CONFIG }, events);

    const ctx = {
      notebookFile: '03_DQN.ipynb',
      chapterNumber: 3,
      chapterTitle: 'Deep Q-Learning',
      activeCellIndex: 0,
      activeCellContent: '',
      activeCellType: 'code' as const,
      isTodoCell: false,
      todoText: '',
      lastError: null,
      consecutiveErrors: 0,
      cellRunCount: 0,
      lastInteractionAt: Date.now(),
      focusSummary: '',
      surroundingCells: [],
    };

    await client.generateInitiative('Custom resumption prompt', ctx, 'chat');
    expect(mockProvider.sendMessage).toHaveBeenCalledOnce();
    // The third arg is the userMessage — should be our custom prompt
    const userMsg = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(userMsg).toBe('Custom resumption prompt');
    expect(events.onDone).toHaveBeenCalled();
  });
});

describe('isNoiseTranscription', () => {
  it('filters short phrases containing "thank"', () => {
    expect(isNoiseTranscription('Thank you')).toBe(true);
    expect(isNoiseTranscription('thank you.')).toBe(true);
    expect(isNoiseTranscription('Thanks')).toBe(true);
    expect(isNoiseTranscription('Thank you so much')).toBe(true); // 4 words
  });

  it('allows longer phrases with "thank"', () => {
    expect(isNoiseTranscription('Thank you for explaining that concept')).toBe(false); // 6 words
    expect(isNoiseTranscription('I want to thank you for the help')).toBe(false);
  });

  it('allows normal speech without "thank"', () => {
    expect(isNoiseTranscription('What is Q-learning?')).toBe(false);
    expect(isNoiseTranscription('Hi')).toBe(false);
    expect(isNoiseTranscription('Explain the Bellman equation')).toBe(false);
  });

  it('handles empty and whitespace input', () => {
    expect(isNoiseTranscription('')).toBe(false);
    expect(isNoiseTranscription('  ')).toBe(false);
  });
});

// ── extractErrorDetail ─────────────────────────────────────────────────────

describe('extractErrorDetail', () => {
  it('extracts code and message from Gemini-style error', () => {
    const msg = 'Gemini API error 429: {"error":{"code":429,"message":"Resource has been exhausted."}}';
    expect(extractErrorDetail(msg)).toBe('HTTP 429 · Resource has been exhausted.');
  });

  it('extracts message from OpenAI-style error', () => {
    const msg = 'OpenAI API error 429: {"error":{"message":"Rate limit exceeded.","code":"rate_limit_exceeded"}}';
    expect(extractErrorDetail(msg)).toBe('HTTP rate_limit_exceeded · Rate limit exceeded.');
  });

  it('extracts type and message from Anthropic-style error', () => {
    const msg = 'Anthropic API error 529: {"error":{"type":"overloaded_error","message":"Overloaded."}}';
    expect(extractErrorDetail(msg)).toBe('HTTP overloaded_error · Overloaded.');
  });

  it('falls back gracefully when body is not JSON', () => {
    const msg = 'Gemini API error 500: Internal Server Error';
    expect(extractErrorDetail(msg)).toBe('HTTP 500 · Internal Server Error');
  });

  it('returns raw message when no colon separator', () => {
    expect(extractErrorDetail('Network error')).toBe('Network error');
  });
});

describe('micSensitivityMultiplier', () => {
  it('is less than 1 for quiet, more than 1 for noisy', () => {
    expect(micSensitivityMultiplier('quiet')).toBeLessThan(1);
    expect(micSensitivityMultiplier('normal')).toBe(1);
    expect(micSensitivityMultiplier('noisy')).toBeGreaterThan(1);
  });
});

describe('pickSoftIdleNudgeLine', () => {
  function ctx(overrides: any = {}): any {
    return {
      notebookFile: '03_DQN.ipynb',
      lastError: null,
      activeCellType: 'code',
      ...overrides,
    };
  }

  it('picks from meta bucket when no notebook is open', () => {
    const line = pickSoftIdleNudgeLine(ctx({ notebookFile: null }));
    expect(line).toMatch(/ping me|start|pick|ready|chapter/i);
  });

  it('picks from afterError bucket when lastError is set', () => {
    const line = pickSoftIdleNudgeLine(ctx({ lastError: 'Traceback...' }));
    expect(line.toLowerCase()).toMatch(/stuck|traceback/);
  });

  it('picks from reading bucket on markdown cells', () => {
    const line = pickSoftIdleNudgeLine(ctx({ activeCellType: 'markdown' }));
    expect(line.toLowerCase()).toMatch(/read|dig|unpack/);
  });

  it('picks from coding bucket on code cells with no error', () => {
    const line = pickSoftIdleNudgeLine(ctx({ activeCellType: 'code', lastError: null }));
    expect(line.toLowerCase()).toMatch(/thinking|bounce|hand|take your time/);
  });
});

// ── Notebook session gating ────────────────────────────────────────────────
//
// These tests verify that voice recording and audio processing are gated on an
// active notebook session. When no notebook is open, voice_audio messages must
// be silently dropped and recording must not start.

describe('CompanionViewProvider — notebook session gating', () => {
  let resolvedMessageHandler: ((msg: any) => void) | null = null;

  async function setupProvider(): Promise<void> {
    const ctx = createMockExtensionContext();
    activate(ctx as any);

    const provider = (vscodeWindow.registerWebviewViewProvider as any).mock.calls[0][1];

    const mockView = {
      webview: {
        options: {},
        html: '',
        asWebviewUri: vi.fn(() => ({ toString: () => 'mock-uri' })),
        onDidReceiveMessage: vi.fn((fn: any) => {
          resolvedMessageHandler = fn;
          return { dispose: vi.fn() };
        }),
        postMessage: vi.fn(),
      },
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    };

    await provider.resolveWebviewView(mockView as any, {}, {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    });
  }

  function makeMockNotebookEditor() {
    const mockCell = {
      document: { getText: vi.fn(() => '') },
      kind: 2, // NotebookCellKind.Code
      outputs: [],
    };
    return {
      notebook: {
        uri: { fsPath: '/workspace/03_DQN.ipynb', toString: () => 'file:///workspace/03_DQN.ipynb' },
        cellAt: vi.fn(() => mockCell),
        cellCount: 1,
      },
      selections: [{ start: 0 }], // ContextTracker reads editor.selections (plural)
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset notebook editor state between tests (vi.clearAllMocks doesn't reset object properties)
    (vscodeWindow as any).activeNotebookEditor = undefined;
    resolvedMessageHandler = null;
    await setupProvider();
  });

  it('voice_audio (webview-capture fallback) is transcribed when a notebook is open', async () => {
    const { _events } = await import('./__mocks__/vscode');

    // Open a notebook → currentNotebookFile is set
    (vscodeWindow as any).activeNotebookEditor = makeMockNotebookEditor();
    _events.onDidChangeActiveNotebookEditor.fire((vscodeWindow as any).activeNotebookEditor);
    await new Promise(r => setTimeout(r, 20));

    // Webview sent a base64-encoded PCM segment (Docker/browser path).
    resolvedMessageHandler!({ type: 'voice_audio', audio: 'dGVzdA==' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockTranscribe).toHaveBeenCalledOnce();
  });

  it('voice_audio is transcribed in meta-mode (no notebook open)', async () => {
    // Voice now works without a notebook — the meta-mode chat path accepts
    // voice input just like text input. No gate on currentNotebookFile.
    resolvedMessageHandler!({ type: 'voice_audio', audio: 'dGVzdA==' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockTranscribe).toHaveBeenCalledOnce();
  });

  it('user_message routes to LLM in meta-mode (no notebook open)', async () => {
    const { getLLMProvider } = await import('../src/providers');
    const mockLLM = vi.mocked(getLLMProvider);
    // Grab the one provider instance that activate() constructed
    const providerInstance = mockLLM.mock.results[0]?.value;
    const sendSpy = providerInstance?.sendMessage as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();

    // No active notebook — send a chat message
    resolvedMessageHandler!({ type: 'user_message', text: 'which chapter should I start with?', mode: 'chat' });
    await new Promise(r => setTimeout(r, 20));

    expect(sendSpy).toHaveBeenCalledOnce();
    // System prompt should include meta-mode marker and course TOC
    const system = sendSpy.mock.calls[0][0];
    const systemText = (system.staticPrefix || '') + '\n' + (system.dynamic || '');
    expect(systemText).toContain('meta mode');
    expect(systemText).toContain('Course table of contents');
  });

  it('voice_audio still works after a notebook is closed (meta-mode)', async () => {
    const { _events } = await import('./__mocks__/vscode');

    // Open a notebook, then close it — we should drop into meta-mode where
    // voice remains functional (just without notebook-specific context).
    (vscodeWindow as any).activeNotebookEditor = makeMockNotebookEditor();
    _events.onDidChangeActiveNotebookEditor.fire((vscodeWindow as any).activeNotebookEditor);
    await new Promise(r => setTimeout(r, 550));
    mockTranscribe.mockClear();

    (vscodeWindow as any).activeNotebookEditor = undefined;
    _events.onDidChangeActiveNotebookEditor.fire(undefined);
    await new Promise(r => setTimeout(r, 20));

    resolvedMessageHandler!({ type: 'voice_audio', audio: 'dGVzdA==' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockTranscribe).toHaveBeenCalledOnce();
  }, 3000);
});
