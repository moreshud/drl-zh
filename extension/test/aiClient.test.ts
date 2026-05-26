import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIClient, ParsedAIResponse, AIClientEvents, stripMarkdown, insertCursorMarker, centerTruncate } from '../src/aiClient';
import { DEFAULT_CONFIG, UserConfig, LLMProvider, Message, SystemPrompt, SYSTEM_PROMPT_PERSONA, VOICE_MODE_INSTRUCTION, CHAPTER_CONTEXT } from '../src/providers';
import { NotebookContext } from '../src/contextTracker';

// ── Mock LLM Provider ───────────────────────────────────────────────────────

function createMockProvider(responses: string[]): LLMProvider {
  return {
    name: 'MockLLM',
    sendMessage: vi.fn(async (
      _systemPrompt: SystemPrompt,
      _history: Message[],
      _userMessage: string,
      onChunk: (text: string) => void,
      onDone: () => void,
      _onError: (error: Error) => void,
    ) => {
      for (const chunk of responses) {
        onChunk(chunk);
      }
      onDone();
    }),
    cancel: vi.fn(),
  };
}

function createErrorProvider(error: Error): LLMProvider {
  return {
    name: 'ErrorLLM',
    sendMessage: vi.fn(async (
      _systemPrompt: SystemPrompt,
      _history: Message[],
      _userMessage: string,
      _onChunk: (text: string) => void,
      _onDone: () => void,
      onError: (error: Error) => void,
    ) => {
      onError(error);
    }),
    cancel: vi.fn(),
  };
}

/** Flatten a SystemPrompt back into a single string for assertions. */
function fullSystemText(call: unknown[]): string {
  const sys = call[0] as SystemPrompt;
  return sys.dynamic ? `${sys.staticPrefix}\n\n${sys.dynamic}` : sys.staticPrefix;
}

function makeNotebookContext(overrides?: Partial<NotebookContext>): NotebookContext {
  return {
    notebookFile: '03_DQN.ipynb',
    chapterNumber: 3,
    chapterTitle: 'Deep Q-Learning',
    activeCellIndex: 5,
    activeCellContent: '# TODO: Implement experience replay buffer',
    activeCellType: 'code',
    activeCellCursorLine: -1,
    activeCellCursorContext: '',
    isTodoCell: true,
    todoText: 'Implement experience replay buffer',
    lastError: null,
    consecutiveErrors: 0,
    cellRunCount: 3,
    lastInteractionAt: Date.now(),
    focusSummary: '',
    surroundingCells: [],
    ...overrides,
  };
}

function makeEvents(overrides?: Partial<AIClientEvents>): AIClientEvents {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onSentenceBoundary: vi.fn(),
    ...overrides,
  };
}

// We need to mock getLLMProvider to return our mock
vi.mock('../src/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers')>();
  return {
    ...original,
    getLLMProvider: vi.fn(() => createMockProvider(['Hello', ' world'])),
  };
});

import { getLLMProvider } from '../src/providers';

describe('AIClient', () => {
  let events: AIClientEvents;
  let config: UserConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    events = makeEvents();
    config = { ...DEFAULT_CONFIG, geminiApiKey: 'test-key' };
  });

  describe('sendMessage', () => {
    it('forwards chunks to onChunk event', async () => {
      const mockProvider = createMockProvider(['Hello', ' world']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('test', makeNotebookContext(), 'chat');

      expect(events.onChunk).toHaveBeenCalledTimes(2);
      expect(events.onChunk).toHaveBeenCalledWith('Hello', undefined, false);
      expect(events.onChunk).toHaveBeenCalledWith(' world', undefined, false);
    });

    it('calls onDone with parsed response when stream completes', async () => {
      const mockProvider = createMockProvider(['Hello world']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('test', makeNotebookContext(), 'chat');

      expect(events.onDone).toHaveBeenCalledOnce();
      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('Hello world');
      expect(parsed.richText).toBeUndefined();
    });

    it('calls onError when provider errors', async () => {
      const error = new Error('API down');
      vi.mocked(getLLMProvider).mockReturnValue(createErrorProvider(error));

      const client = new AIClient(config, events);
      await client.sendMessage('test', makeNotebookContext(), 'chat');

      expect(events.onError).toHaveBeenCalledWith(error);
    });

    it('rolls back the user turn when provider errors, so retry is clean', async () => {
      // Regression guard: Gemini 503 used to leave the failed user message
      // in history. The next turn then had an orphan user with no assistant
      // reply, which confused the model.
      let callIdx = 0;
      const provider: LLMProvider = {
        name: 'Flaky',
        sendMessage: vi.fn(async (_sys, _hist, _msg, onChunk, onDone, onError) => {
          if (callIdx++ === 0) { onError(new Error('503 high demand')); return; }
          onChunk('ok'); onDone();
        }),
        cancel: vi.fn(),
      };
      vi.mocked(getLLMProvider).mockReturnValue(provider);

      const client = new AIClient(config, events);
      await client.sendMessage('first try (errors)', makeNotebookContext(), 'chat');
      await client.sendMessage('retry', makeNotebookContext(), 'chat');

      const retryCall = (provider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
      const history = retryCall[1] as Message[];
      expect(history).toHaveLength(0);
    });

    it('adds user and assistant messages to context window', async () => {
      const mockProvider = createMockProvider(['Response']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('first question', makeNotebookContext(), 'chat');
      await client.sendMessage('second question', makeNotebookContext(), 'chat');

      // Second call should include first Q&A in history
      const secondCall = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
      const history = secondCall[1] as Message[];
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'first question' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Response' });
    });

    it('rollbackLastTurn pops the (user, assistant) pair and is repeatable', async () => {
      // User-initiated undo: lets the student peel back turns ruined by
      // background noise etc. Must remove BOTH sides so history isn't orphan.
      const mockProvider = createMockProvider(['turn 1 reply']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('q1', makeNotebookContext(), 'chat');
      await client.sendMessage('q2', makeNotebookContext(), 'chat');
      // History now = [u:q1, a:t1, u:q2, a:t1] (mock always returns 'turn 1 reply')

      expect(client.rollbackLastTurn()).toBe(true);
      expect(client.rollbackLastTurn()).toBe(true);

      // Fresh turn should include NO history.
      await client.sendMessage('q3', makeNotebookContext(), 'chat');
      const thirdCall = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[2];
      const history = thirdCall[1] as Message[];
      expect(history).toHaveLength(0);
    });

    it('rollbackLastTurn is a no-op on empty or malformed history', () => {
      const client = new AIClient(config, events);
      expect(client.rollbackLastTurn()).toBe(false);

      // Trailing user-only (e.g. after an error) — rollbackLastUserTurn handles
      // that case; rollbackLastTurn should refuse, not orphan-pop.
      client.setContextWindow([{ role: 'user', content: 'orphan' }]);
      expect(client.rollbackLastTurn()).toBe(false);
    });

    it('forwards provider-reported token usage to the onUsage event', async () => {
      const provider: LLMProvider = {
        name: 'UsageLLM',
        sendMessage: vi.fn(async (_sys, _hist, _msg, onChunk, onDone, _err, onUsage) => {
          onChunk('hi');
          onUsage?.({ inputTokens: 1234, outputTokens: 56, totalTokens: 1290 });
          onDone();
        }),
        cancel: vi.fn(),
      };
      vi.mocked(getLLMProvider).mockReturnValue(provider);

      const onUsage = vi.fn();
      const client = new AIClient(config, { ...events, onUsage });
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1234, outputTokens: 56, totalTokens: 1290 });
    });
  });

  describe('context window management', () => {
    it('setContextWindow replaces history', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      client.setContextWindow([
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ]);

      await client.sendMessage('new question', makeNotebookContext(), 'chat');

      const call = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const history = call[1] as Message[];
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('old question');
    });

    it('clearContextWindow empties history', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      client.setContextWindow([
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'answer' },
      ]);
      client.clearContextWindow();

      await client.sendMessage('new', makeNotebookContext(), 'chat');

      const call = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const history = call[1] as Message[];
      expect(history).toHaveLength(0);
    });
  });

  describe('system prompt assembly', () => {
    it('includes persona in system prompt', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const call = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const systemPrompt = fullSystemText(call);
      expect(systemPrompt).toContain('Socratic guide');
    });

    it('includes chapter context for active notebook', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ chapterNumber: 3 });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Chapter 3');
      expect(systemPrompt).toContain('Deep Q-Learning');
    });

    it('includes TODO text in context block', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ todoText: 'Implement replay buffer' });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Implement replay buffer');
    });

    it('includes error info when present', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ lastError: 'NameError: x is not defined', consecutiveErrors: 2 });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('NameError');
      expect(systemPrompt).toContain('Consecutive errors on this cell: 2');
    });

    it('appends voice mode instruction in voice mode', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('voice mode');
      expect(systemPrompt).toContain('"text"');
      expect(systemPrompt).toContain('"richText"');
    });

    it('does NOT append voice instruction in chat mode', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('voice mode');
    });

    it('includes focus summary when present', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ focusSummary: 'Read cell 2 (45s, reading) → Code cell 5 (2min, edited)' });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('focus sequence');
      expect(systemPrompt).toContain('Read cell 2 (45s, reading)');
    });

    it('includes notebook summary when present', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ notebookSummary: 'This chapter covers DQN with experience replay.' });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Notebook overview:');
      expect(systemPrompt).toContain('DQN with experience replay');
    });

    it('omits notebook summary when not present', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('Notebook overview:');
    });

    it('includes solution hint whenever decorateContext attached one', async () => {
      // Reference-solution gating lives in extension.decorateContext (it
      // attaches `solutionHint` whenever a solution is loaded for the
      // active TODO). The aiClient just includes whatever it sees — no
      // local re-gating on errors.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        isTodoCell: true,
        consecutiveErrors: 0,   // even with zero errors, the hint must flow through
        solutionHint: 'def replay_buffer():\n    return deque(maxlen=10000)',
      });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Reference solution');
      expect(systemPrompt).toContain('replay_buffer');
      // The block now uses a positive "default Socratic, BUT if asked,
      // give it" framing rather than the old discouraging "Socratic only"
      // wording — pick a phrase from the new framing.
      expect(systemPrompt).toContain('Default to Socratic hints');
    });

    it('omits solution hint when none is attached', async () => {
      // Empty / unset solutionHint → the section is dropped entirely.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ solutionHint: undefined });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('Reference solution');
    });

    it('includes scopeTodo when active cell isn\'t itself a TODO', async () => {
      // Student parked on a markdown explanation right under a TODO cell.
      // The prompt should anchor on the TODO so Zee answers about what
      // they're implementing, not just what they're staring at.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        activeCellIndex: 6,                           // 0-based → "Cell 7"
        activeCellType: 'markdown',
        activeCellContent: '## Markov Property\nthe future is independent...',
        isTodoCell: false,
        todoText: '',
        scopeTodo: { cellIndex: 4, todoText: 'parse the input spec into Cells' },  // → "cell 5"
      });
      await client.sendMessage('what does this mean?', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('nearest TODO above');
      // 1-based — must match the "Cell N" the student sees in the pill.
      expect(systemPrompt).toContain('cell 5');
      expect(systemPrompt).toContain('parse the input spec into Cells');
    });

    it('inserts a cursor marker into the active cell content when cursor is known', async () => {
      // The marker is the strongest spatial anchor we ship. It lets the
      // LLM stop counting newlines and just look for the sentinel line.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('what should I do here?', makeNotebookContext({
        activeCellContent: 'alpha\nbeta\ngamma\ndelta',
        activeCellCursorLine: 3,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('# >>> CURSOR HERE (line 3) <<<');
      // Marker must come BEFORE the cursor line (line "gamma") — that's
      // the convention: marker indicates where the student is about to
      // type / look at.
      const markerIdx = systemPrompt.indexOf('# >>> CURSOR HERE');
      const gammaIdx = systemPrompt.indexOf('gamma');
      expect(markerIdx).toBeLessThan(gammaIdx);
    });

    it('omits the cursor marker when cursor is unknown', async () => {
      // The persona text references the marker by name as part of the
      // deictic-resolution rules, so the literal "# >>> CURSOR HERE"
      // string IS in the prompt either way. What we care about is that
      // no instance carries a real line number from the active cell.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        activeCellContent: 'alpha\nbeta',
        activeCellCursorLine: -1,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toMatch(/# >>> CURSOR HERE \(line \d+\) <<</);
    });

    it('emits the labeled current-section block when ctx.currentSection is set', async () => {
      // Strong, scoped excerpt of the section between the cursor's TODO
      // and the next TODO. This is the single biggest steering lever — see
      // the user-reported "Store a list / __str__" drift.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('any help here?', makeNotebookContext({
        currentSection: {
          todoText: 'Store a list of lists of `Cell`s',
          startLine: 1,
          endLine: 6,
          text: '# TODO: Store a list of lists of `Cell`s\nself.cells = ???\n',
        },
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('THE SECTION THE STUDENT IS CURRENTLY IN');
      expect(systemPrompt).toContain('lines 1–6');
      expect(systemPrompt).toContain('Store a list of lists of `Cell`s');
      expect(systemPrompt).toContain('self.cells = ???');
    });

    it('omits the current-section block when ctx.currentSection is undefined', async () => {
      // Same caveat as the cursor-marker test: the persona references the
      // block name. We assert the dynamic-block-specific phrasing
      // ("(lines N–M, between TODO …") is absent.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({ currentSection: undefined }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toMatch(/THE SECTION THE STUDENT IS CURRENTLY IN \(lines \d+/);
    });

    it('persona instructs Zee to treat current-section as authoritative for deictics', async () => {
      // The persona must say in directive language not to drift to other
      // parts of the cell. After cursor-surroundings was promoted to the
      // top of the priority list, the section bullet's wording shifted
      // slightly — we still check the "Do NOT pivot" directive.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('THE SECTION THE STUDENT IS CURRENTLY IN');
      expect(systemPrompt.toLowerCase()).toContain('do not pivot');
    });

    it('mentions the cursor line in the prompt when known', async () => {
      // Long multi-method cell; cursor at line 30 lets Zee know which
      // method "here" refers to.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('what should I do here?', makeNotebookContext({
        activeCellCursorLine: 30,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Cursor is at line 30 of the active cell');
    });

    it('omits the per-turn cursor line when unknown (no Monaco focus on the cell)', async () => {
      // The persona text itself talks about "Cursor is at line N" as a
      // hint Zee should USE — so match the per-turn instance specifically
      // (which includes "of the active cell").
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({ activeCellCursorLine: -1 }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toMatch(/Cursor is at line \d+ of the active cell/);
    });

    it('emits an ENCLOSING METHOD block when ctx.enclosingMethod is set', async () => {
      // Strongest semantic anchor for "what is this method about?" type
      // questions. With the full body in the prompt, the LLM can't drift
      // to a sibling method just because the active-cell window happened
      // to truncate the right `def` line.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('what is this method about?', makeNotebookContext({
        enclosingMethod: {
          name: '__str__',
          signature: 'def __str__(self):',
          startLine: 6, endLine: 10,
          text: 'def __str__(self):\n    """Render."""\n    return "\\n".join(rows)',
        },
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('ENCLOSING METHOD');
      expect(systemPrompt).toContain('lines 6–10');
      expect(systemPrompt).toContain('def __str__');
      // Persona must explicitly forbid drifting to sibling methods.
      const flat = systemPrompt.replace(/\s+/g, ' ');
      expect(flat).toContain('Do NOT pivot to a sibling def/class');
    });

    it('omits the ENCLOSING METHOD block when ctx.enclosingMethod is undefined', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({ enclosingMethod: undefined }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      // Dynamic-block-specific phrasing — persona references "ENCLOSING
      // METHOD" by name in the priority list, but the per-turn block
      // uses "the Python def/class the cursor is INSIDE" which is unique.
      expect(systemPrompt).not.toContain('the Python def/class the cursor is INSIDE');
    });

    it('drops the cursor-surroundings block when enclosing method is present (dedup)', async () => {
      // The enclosing method body already contains the cursor's
      // surrounding lines, and the cell content carries the
      // "# >>> CURSOR HERE" marker — surroundings would be pure
      // duplication (~140 tokens). Drop it.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        activeCellCursorContext: '> 12: self.width = ...\n  13: foo()\n',
        enclosingMethod: {
          name: '__init__', signature: 'def __init__(self, spec):',
          startLine: 5, endLine: 20,
          text: 'def __init__(self, spec):\n    self.width = ...',
        },
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('ENCLOSING METHOD');
      // Dynamic-block-specific phrase ("captured snapshot") only appears
      // when the surroundings block is actually emitted.
      expect(systemPrompt).not.toContain('captured snapshot');
    });

    it('keeps the cursor-surroundings block when there is no enclosing method (top-level code)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        activeCellCursorContext: '> 12: x = 1\n',
        enclosingMethod: undefined,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('captured snapshot');
    });

    it('drops the section block when it is fully inside the enclosing method (dedup)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        currentSection: {
          todoText: 'compute width', startLine: 8, endLine: 12,
          text: '# TODO: compute width\nself.width = ...',
        },
        enclosingMethod: {
          name: '__init__', signature: 'def __init__(self, spec):',
          startLine: 5, endLine: 20,    // section [8..12] ⊂ [5..20]
          text: 'def __init__(self, spec):\n    ...full body...',
        },
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('ENCLOSING METHOD');
      expect(systemPrompt).not.toContain('THE SECTION THE STUDENT IS CURRENTLY IN (lines 8');
    });

    it('keeps the section block when it spans BEYOND the enclosing method', async () => {
      // Edge case: section starts inside the method but extends past its
      // end (or vice versa). Don't drop — the section is carrying info
      // the method body doesn't have.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        currentSection: {
          todoText: 'compute width', startLine: 8, endLine: 25,
          text: '# TODO: compute width\nself.width = ...\n... beyond method ...',
        },
        enclosingMethod: {
          name: '__init__', signature: 'def __init__(self, spec):',
          startLine: 5, endLine: 20,    // section [8..25] NOT ⊂ [5..20]
          text: 'def __init__(self, spec):\n    ...',
        },
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('ENCLOSING METHOD');
      expect(systemPrompt).toContain('THE SECTION THE STUDENT IS CURRENTLY IN (lines 8');
    });

    it('persona priority list places ENCLOSING METHOD at #1', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      const enclosingIdx = systemPrompt.indexOf('ENCLOSING METHOD');
      const cursorSurrIdx = systemPrompt.indexOf('Cursor surroundings');
      const sectionIdx = systemPrompt.indexOf('THE SECTION THE STUDENT IS CURRENTLY IN');
      expect(enclosingIdx).toBeGreaterThan(0);
      expect(cursorSurrIdx).toBeGreaterThan(0);
      expect(enclosingIdx).toBeLessThan(cursorSurrIdx);
      expect(cursorSurrIdx).toBeLessThan(sectionIdx);
    });

    it('emits a "Cursor surroundings" block when activeCellCursorContext is non-empty', async () => {
      // The snapshot-based cursor excerpt — captured WHILE THE STUDENT
      // WAS EDITING, not at LLM-call time when focus has moved to Zee's
      // panel. This is the strongest spatial anchor because it survives
      // focus shifts.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const cursorContext =
        '  10:     def __init__(self, spec):\n' +
        '  11:         self.height = len(spec)\n' +
        '> 12:         self.width = len(spec[0])\n' +
        '  13:         self.cells = ???\n';

      const client = new AIClient(config, events);
      await client.sendMessage('I might need a hint here…', makeNotebookContext({
        activeCellCursorLine: 12,
        activeCellCursorContext: cursorContext,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      // Dynamic-block-specific intro wording (distinct from the persona's
      // priority-list mention of "Cursor surroundings").
      expect(systemPrompt).toContain('captured snapshot');
      expect(systemPrompt).toContain('> 12:');
      expect(systemPrompt).toContain('self.width = len(spec[0])');
    });

    it('omits the "Cursor surroundings" block when no snapshot has been captured', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({ activeCellCursorContext: '' }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      // The dynamic-block intro ("captured snapshot") only appears when a
      // real cursor snapshot is being shipped — the persona references
      // "Cursor surroundings" by name but doesn't use this phrasing.
      expect(systemPrompt).not.toContain('captured snapshot');
    });

    it('persona priority list places "Cursor surroundings" at the top', async () => {
      // The cursor-surroundings block is more reliable than the
      // section/marker/recently-engaged anchors because it's snapshotted
      // from real edit-time data rather than inferred. Persona must
      // reflect that priority.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      // Cursor-surroundings rule should appear before the section rule
      // and before the cursor-marker rule in the priority list.
      const cursorSurrIdx = systemPrompt.indexOf('Cursor surroundings');
      const sectionIdx = systemPrompt.indexOf('THE SECTION THE STUDENT IS CURRENTLY IN');
      expect(cursorSurrIdx).toBeGreaterThan(0);
      expect(sectionIdx).toBeGreaterThan(0);
      expect(cursorSurrIdx).toBeLessThan(sectionIdx);
    });

    it('appends a per-turn re-anchor banner naming the current TODO', async () => {
      // Critical for follow-up questions like "does this look ok?" where
      // past assistant turns were about a different TODO. The banner
      // sits at the END of the dynamic block (closest to the user
      // message) so the model gives it the most attention.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('does this look ok?', makeNotebookContext({
        todoText: 'Set the height and the width of the grid',
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('BEFORE ANSWERING THIS TURN');
      expect(systemPrompt).toContain('Set the height and the width of the grid');
      expect(systemPrompt).toContain('Past assistant turns about other TODOs');
      // The banner must appear AFTER the section block (closer to the
      // user message means higher attention).
      const sectionIdx = systemPrompt.indexOf('THE SECTION THE STUDENT IS CURRENTLY IN');
      const bannerIdx = systemPrompt.indexOf('BEFORE ANSWERING THIS TURN');
      // When section is present, banner comes after; when section is
      // absent (this test fixture doesn't pass currentSection), at
      // least the banner must be present at all.
      if (sectionIdx >= 0) {
        expect(bannerIdx).toBeGreaterThan(sectionIdx);
      } else {
        expect(bannerIdx).toBeGreaterThan(0);
      }
    });

    it('omits the re-anchor banner when there\'s nothing to anchor on', async () => {
      // Meta mode (no notebook) — no TODO, no scope, no section. Don't
      // emit a banner pointing at "undefined".
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        notebookFile: null,
        todoText: '',
        scopeTodo: undefined,
        currentSection: undefined,
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('BEFORE ANSWERING THIS TURN');
    });

    it('persona instructs Zee to comply when the student explicitly asks for the solution', async () => {
      // Real bug: student asked twice for "the solution for just this line"
      // and Zee kept refusing. The persona was effectively "always
      // Socratic". Now it must say: default Socratic, BUT comply on
      // explicit requests.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      const lower = systemPrompt.toLowerCase();
      // Whitespace can wrap mid-phrase in the persona — collapse runs
      // before matching multi-word phrases.
      const flat = lower.replace(/\s+/g, ' ');
      expect(flat).toContain('comply');
      expect(flat).toContain('explicitly asks');
      expect(flat).toContain('do not refuse');
      expect(flat).toContain('i can\'t give you the full solution');
    });

    it('solutionHint block tells the LLM the reference IS for solution requests', async () => {
      // The old framing said "Socratic hints only — reveal ONLY if asked".
      // It read as a discouragement. New wording is positive: "default
      // Socratic, BUT if asked, use this for the answer".
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        isTodoCell: true,
        consecutiveErrors: 1,
        solutionHint: 'self.cells = [[Cell(c) for c in row] for row in spec]',
      });
      await client.sendMessage('show me the answer for this line', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Reference solution');
      expect(systemPrompt).toContain('Default to Socratic hints, BUT if the student');
      expect(systemPrompt).toContain('do not refuse');
    });

    it('persona forbids fabricating code reviews when the section is a TODO stub', async () => {
      // Real bug: student asks "does this look ok?" while sitting on an
      // unimplemented TODO; the model invents code and grades it
      // positively. Persona must explicitly forbid this.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      const lower = systemPrompt.toLowerCase();
      expect(lower).toContain('do not fabricate');
      expect(lower).toContain('todo stub');
      expect(lower).toContain('do not praise');
      expect(lower).toContain('never make up code');
    });

    it('persona teaches Zee a strict deictic-resolution priority order', async () => {
      // The new persona uses a numbered priority list (current-section
      // block → cursor marker → recently-engaged cells → clarifying
      // question). This is stronger than the old soft "use the line N
      // hint" because the previous wording let the model drift to other
      // TODOs in the same cell.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      const lower = systemPrompt.toLowerCase();
      expect(lower).toContain('the section the student is currently in');
      expect(systemPrompt).toContain('# >>> CURSOR HERE');
      expect(lower).toContain('do not pivot');
      expect(lower).toContain('clarifying question');
    });

    it('uses the active-cell todoText line when it IS a TODO (no scope override)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        isTodoCell: true,
        todoText: 'implement replay buffer',
        scopeTodo: { cellIndex: 5, todoText: 'implement replay buffer' },
      });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('TODO they are implementing: implement replay buffer');
      expect(systemPrompt).not.toContain('nearest TODO above');
    });

    it('includes recently-engaged code cells when present, with secondsAgo and TODO tag', async () => {
      // The "here"-awareness fix: if the student was editing cell 5 (TODO),
      // then navigated to cell 4 (markdown) to read theory and asked
      // "I'm confused here", we want cell 5's content available so Zee can
      // resolve "here" → cell 5 instead of guessing wrong.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        activeCellIndex: 3,                           // 0-based → "Cell 4"
        activeCellType: 'markdown',
        activeCellContent: '# Markov Property\nthe future is independent of the past...',
        recentlyEngagedCells: [{
          cellIndex: 4,                                // 0-based → "Cell 5"
          type: 'code',
          content: '# TODO: Store a list of lists of Cells\nself.cells = ???',
          isTodoCell: true,
          todoText: 'Store a list of lists of Cells',
          secondsAgo: 12,
        }],
      });
      await client.sendMessage('I am confused here', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('recently editing');
      // 1-based — same numbering the student sees in the pill.
      expect(systemPrompt).toContain('Cell 5');
      expect(systemPrompt).toContain('Store a list of lists of Cells');
      expect(systemPrompt).toContain('12s ago');
    });

    it('omits the recently-engaged section entirely when none is loaded', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ recentlyEngagedCells: undefined });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('recently editing');
    });

    it('persona prompt teaches Zee how to resolve deictic words ("here", "this")', async () => {
      // The deictic-resolution paragraph must reach the model — without it,
      // recentlyEngagedCells is just data the LLM doesn't know how to use.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt.toLowerCase()).toContain('deictic');
      expect(systemPrompt.toLowerCase()).toContain('clarifying');
    });

    it('truncates over-long active cell content centered on the cursor', async () => {
      // The user-reported bug: tail-only truncation silently dropped
      // __str__ when the cell was long, leaving __getitem__ as the only
      // visible def, and the LLM answered about __getitem__.
      // Center truncation keeps the cursor area in the kept window.
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const huge =
        'HEAD_MARKER\n' +
        'x'.repeat(2500) + '\n' +    // head padding
        'CURSOR_AREA\n' +             // line ~3 + 2500 = roughly mid-cell
        'y'.repeat(2500) + '\n' +     // tail padding
        'TAIL_MARKER';

      const client = new AIClient(config, events);
      // Cursor on the CURSOR_AREA line (after the marker insertion shifts
      // it down by 1, but center-truncate handles that).
      const ctx = makeNotebookContext({
        activeCellContent: huge,
        activeCellCursorLine: huge.split('\n').findIndex(l => l === 'CURSOR_AREA') + 1,
      });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('truncated');
      expect(systemPrompt).toContain('CURSOR_AREA');   // cursor stays in-window
      // Both head and tail markers are far from the cursor → both dropped.
      expect(systemPrompt).not.toContain('HEAD_MARKER');
      expect(systemPrompt).not.toContain('TAIL_MARKER');
    });

    it('falls back to tail-only truncation when cursor is unknown (back-compat)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const huge = 'EARLY\n' + 'x'.repeat(5000) + '\nLATE_MARKER';
      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({
        activeCellContent: huge,
        activeCellCursorLine: -1,    // unknown
      }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('LATE_MARKER');
      expect(systemPrompt).not.toContain('EARLY');
    });

    it('omits focus summary when empty', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ focusSummary: '' });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('focus sequence');
    });

    it('includes surrounding cells in system prompt when present', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        surroundingCells: [
          { index: 3, type: 'markdown', content: '## Experience Replay' },
          { index: 4, type: 'code', content: 'import numpy as np', outputs: 'array([1, 2])' },
          { index: 6, type: 'code', content: 'buffer.sample(32)' },
        ],
      });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('Surrounding cells');
      expect(systemPrompt).toContain('Experience Replay');
      expect(systemPrompt).toContain('import numpy');
      expect(systemPrompt).toContain('Cell output:');
      expect(systemPrompt).toContain('array([1, 2])');
      expect(systemPrompt).toContain('buffer.sample(32)');
      expect(systemPrompt).toContain('before active cell');
      expect(systemPrompt).toContain('after active cell');
    });

    it('omits surrounding cells section when surroundingCells is empty', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext({ surroundingCells: [] }), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('Surrounding cells');
    });

    it('uses meta-mode prompt with course TOC when no notebook is open', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ notebookFile: null });
      await client.sendMessage('hi', ctx, 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      // Meta-mode marker + course TOC
      expect(systemPrompt).toContain('meta mode');
      expect(systemPrompt).toContain('Course table of contents');
      // No dynamic per-cell context
      expect(systemPrompt).not.toContain('Active cell');
    });

    it('includes learner profile section when skill/goal are known', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      client.setLearnerProfile({
        skillLevel: 'some',
        goal: 'apply RL to robotics',
        chaptersTouched: ['01_MDP.ipynb'],
        stuckConcepts: ['policy gradient'],
        createdAt: 1,
        lastActiveAt: 2,
      });
      await client.sendMessage('hi', makeNotebookContext({}), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).toContain('What you know about this student');
      expect(systemPrompt).toContain('some RL background');
      expect(systemPrompt).toContain('apply RL to robotics');
      expect(systemPrompt).toContain('01_MDP.ipynb');
      expect(systemPrompt).toContain('policy gradient');
    });

    it('omits learner section when the profile is empty', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      // Default profile is all-empty/unknown — section should not appear
      await client.sendMessage('hi', makeNotebookContext({}), 'chat');

      const systemPrompt = fullSystemText((mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]);
      expect(systemPrompt).not.toContain('What you know about this student');
    });

    it('puts persona + chapter + notebook summary in staticPrefix (cacheable)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({ notebookSummary: 'DQN overview.' });
      await client.sendMessage('hi', ctx, 'chat');

      const sys = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as SystemPrompt;
      expect(sys.staticPrefix).toContain('Socratic');
      expect(sys.staticPrefix).toContain('Chapter 3');
      expect(sys.staticPrefix).toContain('DQN overview.');
    });

    it('puts active cell + error + surrounding cells in dynamic (not cacheable)', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const ctx = makeNotebookContext({
        lastError: 'NameError',
        consecutiveErrors: 1,
        surroundingCells: [{ index: 4, type: 'code', content: 'x = 1' }],
      });
      await client.sendMessage('hi', ctx, 'chat');

      const sys = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as SystemPrompt;
      expect(sys.dynamic).toContain('Active cell');
      expect(sys.dynamic).toContain('NameError');
      expect(sys.dynamic).toContain('Surrounding cells');
      // These must NOT leak into the cacheable prefix
      expect(sys.staticPrefix).not.toContain('Active cell');
      expect(sys.staticPrefix).not.toContain('NameError');
    });

    it('staticPrefix is byte-identical across turns with the same notebook/mode', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('first', makeNotebookContext(), 'chat');
      // Context changes between turns (different error, different cell) — the
      // prefix must not change, or prompt caching is defeated.
      await client.sendMessage('second', makeNotebookContext({
        activeCellIndex: 7,
        lastError: 'TypeError',
        consecutiveErrors: 2,
      }), 'chat');

      const calls = (mockProvider.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const prefix1 = (calls[0][0] as SystemPrompt).staticPrefix;
      const prefix2 = (calls[1][0] as SystemPrompt).staticPrefix;
      expect(prefix1).toBe(prefix2);
    });
  });

  describe('voice mode JSON parsing', () => {
    it('parses valid JSON with text and richText', async () => {
      const json = JSON.stringify({ text: 'Spoken text', richText: 'Q(s,a) = ...' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('Spoken text');
      expect(parsed.richText).toBe('Q(s,a) = ...');
    });

    it('parses JSON with only text field', async () => {
      const json = JSON.stringify({ text: 'Just spoken text' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('Just spoken text');
      expect(parsed.richText).toBeUndefined();
    });

    it('falls back to plain text when JSON is invalid', async () => {
      const mockProvider = createMockProvider(['This is not JSON']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('This is not JSON');
      expect(parsed.richText).toBeUndefined();
    });

    it('in chat mode, does not attempt JSON parsing', async () => {
      const json = JSON.stringify({ text: 'Should be plain', richText: 'ignored' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      // In chat mode the raw text IS the JSON string — no parsing
      expect(parsed.text).toBe(json);
    });

    it('extracts JSON from markdown code fences', async () => {
      // Gemini / Claude both occasionally wrap JSON output in ```json fences
      // despite being told not to. Without fence handling, the whole fenced
      // string gets read aloud as "```json { text: ... }" which was the bug.
      const fenced = '```json\n{"text":"Hello","richText":"code"}\n```';
      const mockProvider = createMockProvider([fenced]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('Hello');
      expect(parsed.richText).toBe('code');
    });

    it('extracts JSON when prefixed with prose', async () => {
      const prefixed = 'Here is my reply:\n{"text":"Great question"}';
      const mockProvider = createMockProvider([prefixed]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('Great question');
    });

    it('extracts JSON from fenced block without json tag', async () => {
      const fenced = '```\n{"text":"plain fences"}\n```';
      const mockProvider = createMockProvider([fenced]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const parsed = (events.onDone as ReturnType<typeof vi.fn>).mock.calls[0][0] as ParsedAIResponse;
      expect(parsed.text).toBe('plain fences');
    });
  });

  describe('sentence boundary detection', () => {
    it('emits sentence boundary on period-space', async () => {
      const mockProvider = createMockProvider(['Hello world. This is great']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      // The first sentence should be detected, plus remainder flushed
      expect(events.onSentenceBoundary).toHaveBeenCalled();
      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      expect(allSentences.join(' ')).toContain('Hello world.');
    });

    it('flushes remaining text as final sentence', async () => {
      const mockProvider = createMockProvider(['No boundary here']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      // Remaining buffer is flushed on done
      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      expect(allSentences).toContain('No boundary here');
    });

    it('does NOT emit sentence boundaries during voice mode streaming', async () => {
      const json = JSON.stringify({ text: 'Hello world. This is great.' });
      // Simulate streaming: the JSON arrives in chunks
      const mockProvider = createMockProvider(['{"text": "Hello world. ', 'This is great."}']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      // Sentence boundaries should come from parsed text, not raw JSON chunks
      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      // Should NOT contain any JSON syntax
      for (const s of allSentences) {
        expect(s).not.toContain('{');
        expect(s).not.toContain('"text"');
      }
    });

    it('emits sentences from parsed text after voice mode response', async () => {
      const json = JSON.stringify({ text: 'Hello world. This is great.' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      expect(allSentences.join(' ')).toContain('Hello world.');
      expect(allSentences.join(' ')).toContain('This is great.');
    });

    it('preserves question marks when splitting sentences (chat mode)', async () => {
      const mockProvider = createMockProvider(['Is this Q-learning? Yes it is.']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      const questionSentence = allSentences.find((s: string) => s.includes('Q-learning'));
      expect(questionSentence).toContain('?');
    });

    it('preserves question marks when splitting sentences (voice mode)', async () => {
      const json = JSON.stringify({ text: 'Would you like a hint? Let me help.' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      const questionSentence = allSentences.find((s: string) => s.includes('hint'));
      expect(questionSentence).toContain('?');
    });

    it('merges short interjections with the next sentence for TTS (no double pause)', async () => {
      // Kokoro pads each inference with silence — emitting "Hello!" as its
      // own chunk produces an audible gap before the real reply. "Hello!"
      // should be folded into the next sentence.
      const json = JSON.stringify({
        text: "Hello! I'm doing well, and I'm ready to dive in.",
      });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      const sentences = (events.onSentenceBoundary as ReturnType<typeof vi.fn>)
        .mock.calls.map(c => c[0] as string);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('Hello!');
      expect(sentences[0]).toContain("I'm doing well");
    });

    it('does NOT stream chunks to onChunk in voice mode', async () => {
      const json = JSON.stringify({ text: 'Hello.' });
      const mockProvider = createMockProvider([json]);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'voice');

      // No chunks forwarded during streaming in voice mode
      expect(events.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('streaming state', () => {
    it('isStreaming returns false initially', () => {
      vi.mocked(getLLMProvider).mockReturnValue(createMockProvider([]));
      const client = new AIClient(config, events);
      expect(client.isStreaming()).toBe(false);
    });

    it('cancel sets streaming to false', async () => {
      const mockProvider = createMockProvider(['ok']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      client.cancel();
      expect(client.isStreaming()).toBe(false);
    });

    it('isStreaming is true during onSentenceBoundary callbacks', async () => {
      // Use a provider that streams chunks one at a time
      const mockProvider: LLMProvider = {
        name: 'MockLLM',
        sendMessage: vi.fn(async (
          _systemPrompt: SystemPrompt,
          _history: Message[],
          _userMessage: string,
          onChunk: (text: string) => void,
          onDone: () => void,
          _onError: (error: Error) => void,
        ) => {
          onChunk('First sentence. Second sentence.');
          onDone();
        }),
        cancel: vi.fn(),
      };
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const streamingStates: boolean[] = [];
      const client = new AIClient(config, {
        ...events,
        onSentenceBoundary: vi.fn(() => {
          streamingStates.push(client.isStreaming());
        }),
      });

      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      // During sentence boundary callbacks, AI should still be streaming
      // (the final boundary is flushed in onDone, where streaming is false)
      expect(streamingStates.length).toBeGreaterThan(0);
      // The first sentence boundary fires during streaming (true),
      // the remainder flush fires in onDone (streaming already false)
      expect(streamingStates[0]).toBe(true);
    });

    it('isStreaming is false when onDone fires', async () => {
      const mockProvider = createMockProvider(['Hello.']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      let streamingAtDone = true;
      const client = new AIClient(config, {
        ...events,
        onDone: vi.fn(() => {
          streamingAtDone = client.isStreaming();
        }),
      });

      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      expect(streamingAtDone).toBe(false);
    });

    // Regression test for the acoustic feedback loop: if a second utterance
    // arrives while Zee is still streaming the first, sendMessage must cancel
    // the in-flight provider call before starting the new one. Without this,
    // mic echo would cascade: every transcribed TTS snippet would spawn a
    // new LLM call, none of which ever complete.
    it('sendMessage cancels in-flight provider call before starting a new one', async () => {
      let resolveFirst: (() => void) | null = null;
      const firstDone = new Promise<void>(r => { resolveFirst = r; });

      const mockProvider: LLMProvider = {
        name: 'MockLLM',
        sendMessage: vi.fn(async (
          _sys: any, _hist: any, _msg: any,
          _onChunk: any, onDone: () => void, _onErr: any,
        ) => {
          // Never resolve on its own — caller must cancel
          await firstDone;
          onDone();
        }),
        cancel: vi.fn(() => { resolveFirst?.(); }),
      };
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      const first = client.sendMessage('hey', makeNotebookContext(), 'voice');
      await new Promise(r => setTimeout(r, 5));   // let first call start
      await client.sendMessage('wait no, different question', makeNotebookContext(), 'voice');

      expect(mockProvider.cancel).toHaveBeenCalled();
      await first;  // clean up
    });
  });

  describe('updateConfig', () => {
    it('recreates provider when config changes', () => {
      vi.mocked(getLLMProvider).mockReturnValue(createMockProvider([]));
      const client = new AIClient(config, events);

      const newConfig = { ...config, llmProvider: 'openai' as const };
      client.updateConfig(newConfig);

      expect(getLLMProvider).toHaveBeenCalledWith(newConfig);
    });
  });

  describe('markdown stripping for TTS', () => {
    it('strips sentences of markdown before emitting to onSentenceBoundary', async () => {
      const mockProvider = createMockProvider(['**Bold text.** More words']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      // No ** should remain
      for (const s of allSentences) {
        expect(s).not.toContain('**');
      }
    });

    it('strips inline code from flushed remainder', async () => {
      const mockProvider = createMockProvider(['Use `replay_buffer` here']);
      vi.mocked(getLLMProvider).mockReturnValue(mockProvider);

      const client = new AIClient(config, events);
      await client.sendMessage('hi', makeNotebookContext(), 'chat');

      const calls = (events.onSentenceBoundary as ReturnType<typeof vi.fn>).mock.calls;
      const allSentences = calls.map(c => c[0]);
      for (const s of allSentences) {
        expect(s).not.toContain('`');
      }
    });
  });
});

describe('stripMarkdown', () => {
  it('strips bold (**text**)', () => {
    expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
  });

  it('strips italic (*text*)', () => {
    expect(stripMarkdown('This is *italic* text')).toBe('This is italic text');
  });

  it('strips underscore bold (__text__)', () => {
    expect(stripMarkdown('This is __bold__ text')).toBe('This is bold text');
  });

  it('strips underscore italic (_text_)', () => {
    expect(stripMarkdown('This is _italic_ text')).toBe('This is italic text');
  });

  it('strips inline code (`code`)', () => {
    expect(stripMarkdown('Use `replay_buffer` here')).toBe('Use replay_buffer here');
  });

  it('replaces code fences with spoken placeholder', () => {
    const input = 'Before\n```python\nprint("hi")\n```\nAfter';
    expect(stripMarkdown(input)).toContain('written code');
    expect(stripMarkdown(input)).not.toContain('print');
  });

  it('replaces LaTeX blocks with spoken placeholder', () => {
    expect(stripMarkdown('The formula is $$E = mc^2$$ here')).toContain('written formula');
    expect(stripMarkdown('Inline $x^2$ works')).toContain('formula');
  });

  it('strips headers (# ...)', () => {
    expect(stripMarkdown('# Title\nBody')).toBe('Title\nBody');
    expect(stripMarkdown('### Sub-heading')).toBe('Sub-heading');
  });

  it('strips links [text](url) keeping text', () => {
    expect(stripMarkdown('See [docs](https://example.com) for info')).toBe('See docs for info');
  });

  it('strips images ![alt](url) keeping alt', () => {
    expect(stripMarkdown('Check ![diagram](img.png) out')).toBe('Check diagram out');
  });

  it('strips strikethrough (~~text~~)', () => {
    expect(stripMarkdown('This is ~~wrong~~ correct')).toBe('This is wrong correct');
  });

  it('removes horizontal rules', () => {
    expect(stripMarkdown('Above\n---\nBelow')).toBe('Above\n\nBelow');
  });

  it('handles combined formatting', () => {
    const input = '**Bold** and *italic* with `code` and [link](url)';
    expect(stripMarkdown(input)).toBe('Bold and italic with code and link');
  });

  it('returns plain text unchanged', () => {
    expect(stripMarkdown('Just plain text')).toBe('Just plain text');
  });

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });
});

describe('centerTruncate', () => {
  it('returns the input unchanged when text fits within the cap', () => {
    expect(centerTruncate('short', 1, 100)).toBe('short');
  });

  it('keeps the input unchanged at exactly the cap', () => {
    const text = 'x'.repeat(100);
    expect(centerTruncate(text, 1, 100)).toBe(text);
  });

  it('falls back to tail-only when cursor line is unknown', () => {
    const text = 'A'.repeat(100) + 'TAIL';
    const out = centerTruncate(text, -1, 50);
    expect(out).toContain('TAIL');
    expect(out).toContain('truncated');
    expect(out).not.toContain('A'.repeat(60));
  });

  it('centers the kept window around the cursor line', () => {
    // 200-char text, line "CURSOR" sits in the middle. Cap=80 → head and
    // tail get cut, "CURSOR" stays.
    const text = 'A'.repeat(100) + '\nCURSOR\n' + 'B'.repeat(100);
    const cursorLine = 2;  // 1 ('A...'), 2 ('CURSOR'), 3 ('B...')
    const out = centerTruncate(text, cursorLine, 80);
    expect(out).toContain('CURSOR');
    // Both head and tail are present (annotated as truncated).
    expect(out).toContain('truncated head');
    expect(out).toContain('truncated tail');
  });

  it('clamps to the start when cursor is near the beginning', () => {
    const text = 'START\n' + 'x'.repeat(500);
    const out = centerTruncate(text, 1, 50);
    expect(out).toContain('START');
    expect(out).not.toContain('truncated head');
    expect(out).toContain('truncated tail');
  });

  it('clamps to the end when cursor is near the end', () => {
    const text = 'x'.repeat(500) + '\nEND';
    const lines = text.split('\n').length;
    const out = centerTruncate(text, lines, 50);
    expect(out).toContain('END');
    expect(out).toContain('truncated head');
    expect(out).not.toContain('truncated tail');
  });
});

describe('insertCursorMarker', () => {
  it('inserts a sentinel line BEFORE the cursor line', () => {
    const out = insertCursorMarker('one\ntwo\nthree', 2);
    const lines = out.split('\n');
    expect(lines[0]).toBe('one');
    expect(lines[1]).toContain('CURSOR HERE');
    expect(lines[1]).toContain('line 2');
    expect(lines[2]).toBe('two');
    expect(lines[3]).toBe('three');
  });

  it('mentions the line number in the marker so the LLM can cross-reference', () => {
    const out = insertCursorMarker('a\nb\nc\nd\ne', 4);
    expect(out).toContain('# >>> CURSOR HERE (line 4) <<<');
  });

  it('returns the input unchanged when cursorLine is out of range', () => {
    expect(insertCursorMarker('one\ntwo', 0)).toBe('one\ntwo');
    expect(insertCursorMarker('one\ntwo', -1)).toBe('one\ntwo');
    expect(insertCursorMarker('one\ntwo', 99)).toBe('one\ntwo');
  });

  it('inserts at line 1 → marker is the very first line', () => {
    const out = insertCursorMarker('first\nsecond', 1);
    expect(out.split('\n')[0]).toContain('CURSOR HERE');
    expect(out.split('\n')[1]).toBe('first');
  });
});
