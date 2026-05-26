import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextTracker, NotebookContext, ContextTrackerEvents } from '../src/contextTracker';
import { DEFAULT_CONFIG, UserConfig, CHAPTER_CONTEXT } from '../src/providers';
import {
  STUCK_ERROR_THRESHOLD, IDLE_ON_TODO_MS, READING_ON_MARKDOWN_MS,
  TRANSCRIPT_CELL_PREVIEW_LEN, CONTEXT_THROTTLE_MS, BRIEF_VISIT_MS,
  FOCUS_SEQUENCE_MAX, SOFT_IDLE_PRESENCE_MS, SOFT_IDLE_NUDGE_MS,
} from '../src/constants';
import { _events, window as vscodeWindow, NotebookCellKind } from './__mocks__/vscode';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvents(overrides?: Partial<ContextTrackerEvents>): ContextTrackerEvents {
  return {
    onContextUpdate: vi.fn(),
    onRequestToSpeak: vi.fn(),
    onFlowStateChange: vi.fn(),
    ...overrides,
  };
}

interface MockCell {
  document: { getText: () => string };
  kind: number;
  outputs?: any[];
}

// Per-cell counter so each mock cell has a unique URI — the tracker
// keys cursor snapshots by URI string, so duplicates would collide.
let __mockCellSeq = 0;
function cell(text: string, kind: 'code' | 'markdown', outputs: any[] = []): MockCell {
  const id = ++__mockCellSeq;
  return {
    document: {
      getText: () => text,
      uri: { toString: () => `mock-cell://${id}` },
    },
    kind: kind === 'code' ? NotebookCellKind.Code : NotebookCellKind.Markup,
    outputs,
  };
}

function setEditor(fsPath: string, cells: MockCell[], activeIndex: number) {
  vscodeWindow.activeNotebookEditor = {
    notebook: {
      uri: { fsPath },
      cellCount: cells.length,
      cellAt: (idx: number) => cells[idx],
    },
    selections: [{ start: activeIndex }],
  };
}

function fireSelection() {
  _events.onDidChangeTextEditorSelection.fire();
}

// Signals a cell execution outcome through the notebook-document change event.
function fireExecution(cellIndex: number, cells: MockCell[], error: string | null) {
  const errorBytes = error ? new TextEncoder().encode(error) : null;
  const outputs = errorBytes
    ? [{ items: [{ mime: 'application/vnd.code.notebook.error', data: errorBytes }] }]
    : [{ items: [{ mime: 'text/plain', data: new TextEncoder().encode('42') }] }];
  cells[cellIndex] = { ...cells[cellIndex], outputs };
  _events.onDidChangeNotebookDocument.fire({
    cellChanges: [{ cell: cells[cellIndex], outputs }],
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ContextTracker', () => {
  let events: ContextTrackerEvents;
  let config: UserConfig;
  let tracker: ContextTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    events = makeEvents();
    config = { ...DEFAULT_CONFIG };
    vscodeWindow.activeNotebookEditor = undefined;
    vscodeWindow.activeTextEditor = undefined;
  });

  afterEach(() => {
    tracker?.dispose();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('starts with null notebookFile when no editor is active', () => {
      tracker = new ContextTracker(events, config);
      expect(tracker.getContext().notebookFile).toBeNull();
    });

    it('starts with empty TODO and zero errors', () => {
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      expect(ctx.isTodoCell).toBe(false);
      expect(ctx.todoText).toBe('');
      expect(ctx.consecutiveErrors).toBe(0);
      expect(ctx.lastError).toBeNull();
    });

    it('getContext returns a copy (mutation does not affect internal state)', () => {
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      ctx.consecutiveErrors = 999;
      expect(tracker.getContext().consecutiveErrors).toBe(0);
    });

    it('updates context when the notebook cell SELECTION changes (markdown click)', () => {
      // Regression: clicking a markdown cell in Jupyter doesn't change the
      // active text editor (no Monaco focus), only the notebook cell-list
      // selection. Without listening to onDidChangeNotebookEditorSelection
      // the awareness pill stays stuck on the previous cell.
      const cells = [
        cell('# TODO: implement\nbuf = []', 'code'),
        cell('## Theory: Markov property', 'markdown'),
      ];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      // Reset call count so we can assert the change-driven update.
      (events.onContextUpdate as ReturnType<typeof vi.fn>).mockClear();

      // Move selection to the markdown cell — but do NOT fire a text-editor
      // selection event (markdown clicks don't produce one).
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 1 }];
      _events.onDidChangeNotebookEditorSelection.fire();
      // emitContextUpdate is throttled — flush.
      vi.advanceTimersByTime(CONTEXT_THROTTLE_MS + 10);

      const updates = (events.onContextUpdate as ReturnType<typeof vi.fn>).mock.calls;
      expect(updates.length).toBeGreaterThan(0);
      const lastCtx = updates[updates.length - 1][0];
      expect(lastCtx.activeCellIndex).toBe(1);
      expect(lastCtx.activeCellType).toBe('markdown');
    });
  });

  describe('utility methods', () => {
    it('getCellPreview returns first TRANSCRIPT_CELL_PREVIEW_LEN chars', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).context.activeCellContent = 'x'.repeat(200);
      expect(tracker.getCellPreview()).toHaveLength(TRANSCRIPT_CELL_PREVIEW_LEN);
    });

    it('getCellPreview returns full content if shorter than limit', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).context.activeCellContent = 'short';
      expect(tracker.getCellPreview()).toBe('short');
    });

    it('getChapterContext returns CHAPTER_CONTEXT[n] for known chapter', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).context.chapterNumber = 3;
      expect(tracker.getChapterContext()).toBe(CHAPTER_CONTEXT[3]);
    });

    it('getChapterContext returns empty string for unknown chapter', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).context.chapterNumber = 99;
      expect(tracker.getChapterContext()).toBe('');
    });
  });

  describe('notifyInteraction / resetCooldown / suppressSignals', () => {
    it('notifyInteraction updates lastInteractionAt', () => {
      tracker = new ContextTracker(events, config);
      const before = tracker.getContext().lastInteractionAt;
      vi.advanceTimersByTime(100);
      tracker.notifyInteraction();
      expect(tracker.getContext().lastInteractionAt).toBeGreaterThan(before);
    });

    it('notifyInteraction clears pendingInitiative', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).pendingInitiative = true;
      tracker.notifyInteraction();
      expect((tracker as any).pendingInitiative).toBe(false);
    });

    it('resetCooldown clears pendingInitiative', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).pendingInitiative = true;
      tracker.resetCooldown();
      expect((tracker as any).pendingInitiative).toBe(false);
    });

    it('suppressSignals sets pendingInitiative so timers will not fire', () => {
      tracker = new ContextTracker(events, config);
      tracker.suppressSignals();
      expect((tracker as any).pendingInitiative).toBe(true);
    });
  });

  describe('stuck signal', () => {
    function openTodoNotebook() {
      const cells = [
        cell('# TODO: Implement buffer\nbuf = []', 'code'),
      ];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      return cells;
    }

    it('fires after STUCK_ERROR_THRESHOLD consecutive errors on a TODO cell', () => {
      const cells = openTodoNotebook();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD; i++) {
        fireExecution(0, cells, 'NameError: x is not defined');
      }
      expect(events.onRequestToSpeak).toHaveBeenCalledWith('stuck');
    });

    it('does NOT fire before the threshold is reached', () => {
      const cells = openTodoNotebook();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD - 1; i++) {
        fireExecution(0, cells, 'NameError');
      }
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('fires exactly once per error streak', () => {
      const cells = openTodoNotebook();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD + 3; i++) {
        fireExecution(0, cells, 'NameError');
      }
      const stuckCalls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.filter(c => c[0] === 'stuck');
      expect(stuckCalls).toHaveLength(1);
    });

    it('re-arms after a successful run (new streak can fire again)', () => {
      const cells = openTodoNotebook();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD; i++) {
        fireExecution(0, cells, 'NameError');
      }
      // Clear pendingInitiative as the companion would after handling the offer
      tracker.resetCooldown();
      // Successful run resets the streak. (Also fires the new 'success'
      // signal, which sets pendingInitiative again — clear it before the
      // next streak so stuck can fire.)
      fireExecution(0, cells, null);
      tracker.resetCooldown();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD; i++) {
        fireExecution(0, cells, 'NameError');
      }
      const stuckCalls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.filter(c => c[0] === 'stuck');
      expect(stuckCalls).toHaveLength(2);
    });

    it('does NOT fire on non-TODO cells', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      for (let i = 0; i < STUCK_ERROR_THRESHOLD + 2; i++) {
        fireExecution(0, cells, 'NameError');
      }
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('does NOT fire while pendingInitiative is set', () => {
      const cells = openTodoNotebook();
      tracker.suppressSignals();
      for (let i = 0; i < STUCK_ERROR_THRESHOLD; i++) {
        fireExecution(0, cells, 'NameError');
      }
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });
  });

  describe('success signal', () => {
    function openTodoNotebook() {
      const cells = [cell('# TODO: implement buffer\nbuf = []', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      return cells;
    }

    it('fires when a TODO cell runs clean after a struggle', () => {
      const cells = openTodoNotebook();
      // Build up an error streak first.
      fireExecution(0, cells, 'NameError: x not defined');
      fireExecution(0, cells, 'NameError: x not defined');
      // Then a clean run — should fire success.
      fireExecution(0, cells, null);
      const sigs = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.map(c => c[0]);
      expect(sigs).toContain('success');
    });

    it('does NOT fire when a TODO runs clean without prior errors', () => {
      // The student wrote it right the first time — no celebration nudge,
      // because nothing was overcome. Avoids spam on every cell that runs.
      const cells = openTodoNotebook();
      fireExecution(0, cells, null);
      const sigs = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.map(c => c[0]);
      expect(sigs).not.toContain('success');
    });

    it('does NOT fire on non-TODO cells', () => {
      // "Run this cell to visualize" cells aren't student-written — no point
      // celebrating their successful run.
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      fireExecution(0, cells, 'NameError');
      fireExecution(0, cells, null);
      const sigs = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.map(c => c[0]);
      expect(sigs).not.toContain('success');
    });

    it('fires at most once per cell visit (no repeated celebration)', () => {
      const cells = openTodoNotebook();
      fireExecution(0, cells, 'NameError');
      fireExecution(0, cells, null);     // → success #1
      tracker.resetCooldown();
      fireExecution(0, cells, 'NameError');
      fireExecution(0, cells, null);     // would be #2 — must NOT fire
      const successCalls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.filter(c => c[0] === 'success');
      expect(successCalls).toHaveLength(1);
    });

  });

  describe('idle-on-TODO signal', () => {
    function focusTodoCell() {
      const cells = [cell('# TODO: implement replay\n', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      return cells;
    }

    it('fires after IDLE_ON_TODO_MS on a TODO code cell with no typing', () => {
      focusTodoCell();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      expect(events.onRequestToSpeak).toHaveBeenCalledWith('idle');
    });

    it('does NOT fire before IDLE_ON_TODO_MS elapses', () => {
      focusTodoCell();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS - 1000);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('does NOT fire on a non-TODO code cell', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('does NOT fire on a markdown cell', () => {
      const cells = [cell('## Theory', 'markdown')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      const calls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.map(c => c[0])).not.toContain('idle');
    });

    it('disarms on keystroke (the student is actively coding)', () => {
      focusTodoCell();
      // Fire a text document change — simulates typing
      _events.onDidChangeTextDocument.fire();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('fires at most once per cell visit', () => {
      focusTodoCell();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      tracker.resetCooldown();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      const idleCalls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.filter(c => c[0] === 'idle');
      expect(idleCalls).toHaveLength(1);
    });

    it('does NOT fire while suppressed', () => {
      focusTodoCell();
      tracker.suppressSignals();
      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });
  });

  describe('reading-on-markdown signal', () => {
    function focusMarkdownCell(cellIndex = 0) {
      const cells = [cell('## Theory of Q-learning\n\nSome explanation...', 'markdown')];
      setEditor('/workspace/03_DQN.ipynb', cells, cellIndex);
      tracker = new ContextTracker(events, config);
      return cells;
    }

    it('fires after READING_ON_MARKDOWN_MS on a markdown cell', () => {
      focusMarkdownCell();
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS + 10);
      expect(events.onRequestToSpeak).toHaveBeenCalledWith('reading');
    });

    it('does NOT fire before READING_ON_MARKDOWN_MS elapses', () => {
      focusMarkdownCell();
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS - 1000);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('does NOT fire on code cells', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS + 10);
      const calls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.map(c => c[0])).not.toContain('reading');
    });

    it('is suppressed after notifyLearnMoreClicked on the same cell', () => {
      focusMarkdownCell();
      tracker.notifyLearnMoreClicked(0);
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS + 10);
      expect(events.onRequestToSpeak).not.toHaveBeenCalledWith('reading');
    });

    it('fires once per cell visit', () => {
      focusMarkdownCell();
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS + 10);
      tracker.resetCooldown();
      vi.advanceTimersByTime(READING_ON_MARKDOWN_MS + 10);
      const readingCalls = (events.onRequestToSpeak as ReturnType<typeof vi.fn>)
        .mock.calls.filter(c => c[0] === 'reading');
      expect(readingCalls).toHaveLength(1);
    });

  });

  describe('focus transitions re-arm per-cell timers', () => {
    it('switching cells clears the previous idle timer', () => {
      const cells = [
        cell('# TODO: one\n', 'code'),
        cell('# TODO: two\n', 'code'),
      ];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);

      vi.advanceTimersByTime(IDLE_ON_TODO_MS - 5_000);

      // Switch to cell 1 before the timer fires
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 1 }];
      fireSelection();

      // Advance enough for the original timer to have fired, but not the new one
      vi.advanceTimersByTime(6_000);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();

      // Now advance past the full new timer
      vi.advanceTimersByTime(IDLE_ON_TODO_MS);
      expect(events.onRequestToSpeak).toHaveBeenCalledWith('idle');
    });
  });

  describe('learn-more suppresses reading signal', () => {
    it('notifyLearnMoreClicked also clears pendingInitiative', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).pendingInitiative = true;
      tracker.notifyLearnMoreClicked(3);
      expect((tracker as any).pendingInitiative).toBe(false);
    });
  });

  describe('isReadingMarkdown', () => {
    it('returns false with no active focus entry', () => {
      tracker = new ContextTracker(events, config);
      expect(tracker.isReadingMarkdown()).toBe(false);
    });

    it('returns true after sitting on a markdown cell for BRIEF_VISIT_MS without editing', () => {
      const cells = [cell('## Theory', 'markdown')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      expect(tracker.isReadingMarkdown()).toBe(true);
    });

    it('returns false if the user edited the markdown cell', () => {
      const cells = [cell('## Theory', 'markdown')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      _events.onDidChangeTextDocument.fire();
      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      expect(tracker.isReadingMarkdown()).toBe(false);
    });
  });

  describe('buildFocusSummary', () => {
    it('returns empty string for a single visit', () => {
      const cells = [cell('## Theory', 'markdown')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      expect(tracker.buildFocusSummary()).toBe('');
    });

    it('returns empty string when all visits are the same cell type', () => {
      const cells = [cell('a', 'code'), cell('b', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 1 }];
      fireSelection();
      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 0 }];
      fireSelection();
      // All entries are code cells — skipped
      expect(tracker.buildFocusSummary()).toBe('');
    });

    it('summarises transitions between markdown and code', () => {
      const cells = [cell('## Theory', 'markdown'), cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);

      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 1 }];
      fireSelection();
      vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
      // Leave cell 1 by returning to cell 0 to close its focus entry
      vscodeWindow.activeNotebookEditor!.selections = [{ start: 0 }];
      fireSelection();

      const summary = tracker.buildFocusSummary();
      expect(summary).toContain('Read cell');
      expect(summary).toContain('Code cell');
      expect(summary).toContain('→');
    });

    it('caps the focus sequence at FOCUS_SEQUENCE_MAX entries', () => {
      // A bunch of cells alternating type so heterogeneity gate passes
      const cells: MockCell[] = [];
      for (let i = 0; i < FOCUS_SEQUENCE_MAX + 5; i++) {
        cells.push(cell(`cell ${i}`, i % 2 === 0 ? 'markdown' : 'code'));
      }
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      for (let i = 1; i < cells.length; i++) {
        vi.advanceTimersByTime(BRIEF_VISIT_MS + 100);
        vscodeWindow.activeNotebookEditor!.selections = [{ start: i }];
        fireSelection();
      }
      expect((tracker as any).focusSequence.length).toBeLessThanOrEqual(FOCUS_SEQUENCE_MAX);
    });
  });

  describe('pause / resume', () => {
    it('isPaused is false by default', () => {
      tracker = new ContextTracker(events, config);
      expect(tracker.isPaused()).toBe(false);
    });

    it('pause then resume toggles the state', () => {
      tracker = new ContextTracker(events, config);
      tracker.pause();
      expect(tracker.isPaused()).toBe(true);
      tracker.resume();
      expect(tracker.isPaused()).toBe(false);
    });

    it('pause clears pendingInitiative and stops timers', () => {
      const cells = [cell('# TODO: implement\n', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      (tracker as any).pendingInitiative = true;
      tracker.pause();
      expect((tracker as any).pendingInitiative).toBe(false);

      vi.advanceTimersByTime(IDLE_ON_TODO_MS + 10);
      expect(events.onRequestToSpeak).not.toHaveBeenCalled();
    });

    it('does not emit context updates while paused', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      tracker.pause();
      (events.onContextUpdate as ReturnType<typeof vi.fn>).mockClear();
      fireSelection();
      _events.onDidChangeTextDocument.fire();
      expect(events.onContextUpdate).not.toHaveBeenCalled();
    });
  });

  describe('notebook detection', () => {
    it('parses chapter number and title from filename', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      expect(ctx.notebookFile).toBe('03_DQN.ipynb');
      expect(ctx.chapterNumber).toBe(3);
      expect(ctx.chapterTitle).toBe('Deep Q-Learning');
    });

    it('ignores solution/ notebooks', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/solution/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      expect(tracker.getContext().notebookFile).toBeNull();
    });

    it('clears signal state when switching notebooks', () => {
      const cellsA = [cell('# TODO: foo\n', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cellsA, 0);
      tracker = new ContextTracker(events, config);
      // Fire enough errors to reach the stuck threshold
      for (let i = 0; i < STUCK_ERROR_THRESHOLD; i++) {
        fireExecution(0, cellsA, 'Err');
      }
      expect(events.onRequestToSpeak).toHaveBeenCalledWith('stuck');

      // Switch notebooks
      const cellsB = [cell('x = 1', 'code')];
      setEditor('/workspace/04_PG.ipynb', cellsB, 0);
      _events.onDidChangeActiveNotebookEditor.fire();

      expect(tracker.getContext().notebookFile).toBe('04_PG.ipynb');
      expect(tracker.getContext().consecutiveErrors).toBe(0);
      expect((tracker as any).stuckFiredForErrorStreak).toBe(false);
    });
  });

  describe('TODO parsing', () => {
    it('detects a TODO comment in a code cell', () => {
      const cells = [cell('# TODO: Implement the buffer\nx = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      expect(ctx.isTodoCell).toBe(true);
      expect(ctx.todoText).toBe('Implement the buffer');
    });

    it('is not a TODO cell when no TODO comment is present', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      expect(tracker.getContext().isTodoCell).toBe(false);
    });
  });

  describe('surrounding cells', () => {
    it('includes cell before and cell after the active cell', () => {
      const cells = [
        cell('# Intro', 'markdown'),
        cell('x = 1', 'code'),
        cell('# TODO: implement\n', 'code'),
        cell('y = 2', 'code'),
        cell('## Summary', 'markdown'),
      ];
      setEditor('/workspace/03_DQN.ipynb', cells, 2);
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      // 1 before + 1 after
      expect(ctx.surroundingCells).toHaveLength(2);
      expect(ctx.surroundingCells[0].index).toBe(1);
      expect(ctx.surroundingCells[1].index).toBe(3);
    });

    it('handles edge case: active cell at index 0 (only after)', () => {
      const cells = [cell('first', 'code'), cell('second', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      const ctx = tracker.getContext();
      expect(ctx.surroundingCells).toHaveLength(1);
      expect(ctx.surroundingCells[0].index).toBe(1);
    });

    it('is empty when no notebook is open', () => {
      tracker = new ContextTracker(events, config);
      expect(tracker.getContext().surroundingCells).toEqual([]);
    });
  });

  describe('context throttling', () => {
    it('does not emit more than once per CONTEXT_THROTTLE_MS', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      (events.onContextUpdate as ReturnType<typeof vi.fn>).mockClear();

      fireSelection();
      fireSelection();
      fireSelection();

      const immediate = (events.onContextUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(immediate).toBeLessThanOrEqual(1);
    });

    it('emits a trailing update after the throttle period', () => {
      tracker = new ContextTracker(events, config);
      (tracker as any).lastContextUpdateAt = 0;
      (tracker as any).contextUpdateTimer = null;
      (events.onContextUpdate as ReturnType<typeof vi.fn>).mockClear();

      (tracker as any).emitContextUpdate();
      expect(events.onContextUpdate).toHaveBeenCalledTimes(1);

      (tracker as any).emitContextUpdate();
      expect(events.onContextUpdate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(CONTEXT_THROTTLE_MS + 10);
      expect(events.onContextUpdate).toHaveBeenCalledTimes(2);
    });

    it('clears the throttle timer on dispose', () => {
      const cells = [cell('x = 1', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      fireSelection();
      fireSelection();
      tracker.dispose();
      (events.onContextUpdate as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(CONTEXT_THROTTLE_MS + 10);
      expect(events.onContextUpdate).not.toHaveBeenCalled();
    });
  });

  describe('soft-idle flow state', () => {
    it('emits soft-idle-presence after SOFT_IDLE_PRESENCE_MS of quiet', () => {
      tracker = new ContextTracker(events, config);
      (events.onFlowStateChange as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(SOFT_IDLE_PRESENCE_MS - 1);
      expect(events.onFlowStateChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      expect(events.onFlowStateChange).toHaveBeenCalledWith('soft-idle-presence');
    });

    it('emits soft-idle-nudge after SOFT_IDLE_NUDGE_MS of quiet', () => {
      tracker = new ContextTracker(events, config);
      (events.onFlowStateChange as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 10);

      const calls = (events.onFlowStateChange as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(calls).toContain('soft-idle-presence');
      expect(calls).toContain('soft-idle-nudge');
    });

    it('notifyExternalActivity rearms timers and restores active state', () => {
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(SOFT_IDLE_PRESENCE_MS + 10);
      (events.onFlowStateChange as ReturnType<typeof vi.fn>).mockClear();

      tracker.notifyExternalActivity();
      expect(events.onFlowStateChange).toHaveBeenCalledWith('active');

      // Presence should re-fire only after another full interval — not immediately.
      vi.advanceTimersByTime(SOFT_IDLE_PRESENCE_MS - 1000);
      const calls = (events.onFlowStateChange as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(calls.filter(c => c === 'soft-idle-presence')).toHaveLength(0);
    });

    it('nudge fires at most once per idle period', () => {
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 1000);
      let nudges = (events.onFlowStateChange as ReturnType<typeof vi.fn>).mock.calls
        .filter(c => c[0] === 'soft-idle-nudge');
      expect(nudges).toHaveLength(1);

      // More quiet — still one nudge (the nudge timer has already elapsed,
      // and the flag softIdleNudgeFiredThisPeriod blocks re-fire).
      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 1000);
      nudges = (events.onFlowStateChange as ReturnType<typeof vi.fn>).mock.calls
        .filter(c => c[0] === 'soft-idle-nudge');
      expect(nudges).toHaveLength(1);
    });

    it('activity during nudge period resets the clock and allows a new nudge', () => {
      tracker = new ContextTracker(events, config);
      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 1000);

      tracker.notifyExternalActivity();
      (events.onFlowStateChange as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 1000);
      const nudges = (events.onFlowStateChange as ReturnType<typeof vi.fn>).mock.calls
        .filter(c => c[0] === 'soft-idle-nudge');
      expect(nudges).toHaveLength(1);
    });

    it('pause stops timers', () => {
      tracker = new ContextTracker(events, config);
      tracker.pause();
      (events.onFlowStateChange as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(SOFT_IDLE_NUDGE_MS + 1000);
      expect(events.onFlowStateChange).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('clears per-cell timers', () => {
      const cells = [cell('# TODO: work\n', 'code')];
      setEditor('/workspace/03_DQN.ipynb', cells, 0);
      tracker = new ContextTracker(events, config);
      expect((tracker as any).idleTimer).not.toBeNull();
      tracker.dispose();
      expect((tracker as any).idleTimer).toBeNull();
    });

    it('disposes all subscriptions', () => {
      tracker = new ContextTracker(events, config);
      expect((tracker as any).disposables.length).toBeGreaterThan(0);
      tracker.dispose();
      expect((tracker as any).disposables).toHaveLength(0);
    });
  });
});

// ── findAttachablePlot ─────────────────────────────────────────────────────
// Pure helper, exported for direct testing (no full tracker / event plumbing
// required). Driven by a fake editor object that mimics the VS Code shape.

import { findAttachablePlot, pickRecentlyEngagedCells, pickScopeTodo, pickInCellTodo, pickCurrentSection, pickEnclosingMethod } from '../src/contextTracker';
import type { FocusEntry } from '../src/contextTracker';

function pngOutput(base64: string) {
  return { items: [{ mime: 'image/png', data: Buffer.from(base64, 'base64') }] };
}

function fakeEditor(cells: Array<{ kind: 'code' | 'markdown'; outputs?: any[] }>) {
  return {
    notebook: {
      cellCount: cells.length,
      cellAt: (i: number) => ({
        kind: cells[i].kind === 'code' ? NotebookCellKind.Code : NotebookCellKind.Markup,
        outputs: cells[i].outputs ?? [],
      }),
    },
  } as any;
}

describe('findAttachablePlot', () => {
  it('returns the active cell\'s PNG when the active cell has one', () => {
    const editor = fakeEditor([
      { kind: 'code' },
      { kind: 'code', outputs: [pngOutput('AAAA')] },
      { kind: 'markdown' },
    ]);
    const out = findAttachablePlot(editor, 1);
    expect(out?.cellIndex).toBe(1);
    expect(out?.mimeType).toBe('image/png');
    expect(out?.dataBase64).toBe('AAAA');
  });

  it('falls back to the previous neighbour when the active cell has no plot', () => {
    // Common case: the plot lives in a code cell, and the student is reading
    // the markdown explanation right below it.
    const editor = fakeEditor([
      { kind: 'code' },
      { kind: 'code', outputs: [pngOutput('AAAA')] },
      { kind: 'markdown' },
    ]);
    const out = findAttachablePlot(editor, 2);
    expect(out?.cellIndex).toBe(1);
  });

  it('falls back to the next neighbour when the previous has no plot', () => {
    const editor = fakeEditor([
      { kind: 'markdown' },
      { kind: 'markdown' },
      { kind: 'code', outputs: [pngOutput('BBBB')] },
    ]);
    const out = findAttachablePlot(editor, 1);
    expect(out?.cellIndex).toBe(2);
  });

  it('prefers the active cell over neighbours when both have plots', () => {
    const editor = fakeEditor([
      { kind: 'code', outputs: [pngOutput('CCCC')] },
      { kind: 'code', outputs: [pngOutput('DDDD')] },
      { kind: 'code', outputs: [pngOutput('EEEE')] },
    ]);
    const out = findAttachablePlot(editor, 1);
    expect(out?.cellIndex).toBe(1);
    expect(out?.dataBase64).toBe('DDDD');
  });

  it('returns undefined when no nearby cell has a PNG', () => {
    const editor = fakeEditor([
      { kind: 'code' },
      { kind: 'markdown' },
      { kind: 'code', outputs: [{ items: [{ mime: 'text/plain', data: new TextEncoder().encode('42') }] }] },
    ]);
    expect(findAttachablePlot(editor, 1)).toBeUndefined();
  });

  it('does not look at cells more than ±1 away from active', () => {
    // The scan window is tight on purpose so a far-away plot doesn't get
    // confusingly attached.
    const editor = fakeEditor([
      { kind: 'code', outputs: [pngOutput('FAR')] },
      { kind: 'markdown' },
      { kind: 'markdown' },  // active
      { kind: 'markdown' },
      { kind: 'code', outputs: [pngOutput('FAR')] },
    ]);
    expect(findAttachablePlot(editor, 2)).toBeUndefined();
  });

  it('walks outputs newest-first within a cell (latest re-run wins)', () => {
    // Newer outputs are appended; we want the most recent display.
    const editor = fakeEditor([
      { kind: 'code', outputs: [pngOutput('OLDD'), pngOutput('NEWN')] },
    ]);
    const out = findAttachablePlot(editor, 0);
    expect(out?.dataBase64).toBe('NEWN');
  });
});

// ── pickRecentlyEngagedCells ───────────────────────────────────────────────

function fe(opts: Partial<FocusEntry>): FocusEntry {
  return {
    cellIndex: 0,
    cellType: 'code',
    enteredAt: 1_000,
    duration: 5_000,
    wasEditing: true,
    preview: '',
    ...opts,
  };
}

function makeEditor(cells: Array<{ kind: 'code' | 'markdown'; text: string }>) {
  return {
    notebook: {
      cellCount: cells.length,
      cellAt: (i: number) => ({
        kind: cells[i].kind === 'code' ? NotebookCellKind.Code : NotebookCellKind.Markup,
        document: { getText: () => cells[i].text },
      }),
    },
  } as any;
}

describe('pickRecentlyEngagedCells', () => {
  it('returns the most recently edited code cells, newest first', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'cell 0 contents' },
      { kind: 'code', text: 'cell 1 contents' },
      { kind: 'code', text: 'cell 2 contents' },
    ]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, enteredAt: 0,    duration: 1_000, wasEditing: true }),
      fe({ cellIndex: 2, enteredAt: 2_000, duration: 3_000, wasEditing: true }),
    ];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 1, /*now*/ 10_000);
    expect(out.map(c => c.cellIndex)).toEqual([2, 0]);
    expect(out[0].content).toContain('cell 2');
  });

  it('skips cells that were only visited (no edits)', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'edited' },
      { kind: 'code', text: 'just-scrolled' },
    ]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, wasEditing: true }),
      fe({ cellIndex: 1, wasEditing: false }),
    ];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out.map(c => c.cellIndex)).toEqual([0]);
  });

  it('skips the currently active cell (Zee already has it)', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'a' },
      { kind: 'code', text: 'b' },
    ]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, wasEditing: true }),
      fe({ cellIndex: 1, wasEditing: true }),
    ];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 1, /*now*/ 10_000);
    expect(out.map(c => c.cellIndex)).toEqual([0]);
  });

  it('skips markdown cells (only code-cell engagements count for "here")', () => {
    const editor = makeEditor([
      { kind: 'markdown', text: '# theory' },
      { kind: 'code', text: 'TODO: implement\nbuf = []' },
    ]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, cellType: 'markdown', wasEditing: true }),
      fe({ cellIndex: 1, cellType: 'code', wasEditing: true }),
    ];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out.map(c => c.cellIndex)).toEqual([1]);
  });

  it('caps the result at the configured limit', () => {
    const editor = makeEditor(Array.from({ length: 5 }, (_, i) => ({
      kind: 'code' as const, text: `c${i}`,
    })));
    const seq: FocusEntry[] = [0, 1, 2, 3, 4].map(i => fe({ cellIndex: i, wasEditing: true }));
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('reports secondsAgo measured from when the student LEFT the cell', () => {
    const editor = makeEditor([{ kind: 'code', text: 'hi' }]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, enteredAt: 1_000, duration: 4_000, wasEditing: true }),
    ];
    // Left the cell at 5_000ms; "now" is 12_000ms → 7s ago.
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 12_000);
    expect(out[0].secondsAgo).toBe(7);
  });

  it('detects TODO cells via the same regex used elsewhere', () => {
    const editor = makeEditor([
      { kind: 'code', text: '# TODO: implement replay buffer\nbuf = []' },
    ]);
    const seq: FocusEntry[] = [fe({ cellIndex: 0, wasEditing: true })];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out[0].isTodoCell).toBe(true);
    expect(out[0].todoText).toBe('implement replay buffer');
  });

  it('truncates over-long cell content (keeps the trailing window)', () => {
    const huge = 'EARLY\n' + 'x'.repeat(5000) + '\nLATE_MARK';
    const editor = makeEditor([{ kind: 'code', text: huge }]);
    const seq: FocusEntry[] = [fe({ cellIndex: 0, wasEditing: true })];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out[0].content).toContain('truncated');
    expect(out[0].content).toContain('LATE_MARK');
    expect(out[0].content).not.toContain('EARLY');
  });

  it('deduplicates: the same cell visited twice only appears once', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'a' },
      { kind: 'code', text: 'b' },
    ]);
    const seq: FocusEntry[] = [
      fe({ cellIndex: 0, wasEditing: true, enteredAt: 0,    duration: 1_000 }),
      fe({ cellIndex: 1, wasEditing: true, enteredAt: 2_000, duration: 1_000 }),
      fe({ cellIndex: 0, wasEditing: true, enteredAt: 4_000, duration: 1_000 }),
    ];
    const out = pickRecentlyEngagedCells(editor, seq, /*active*/ 99, /*now*/ 10_000);
    expect(out.map(c => c.cellIndex)).toEqual([0, 1]);  // 0 newest wins; 1 next; not [0, 1, 0]
  });

  it('returns an empty array when no edited code cells qualify', () => {
    const editor = makeEditor([{ kind: 'markdown', text: 'theory' }]);
    const seq: FocusEntry[] = [fe({ cellIndex: 0, cellType: 'markdown', wasEditing: true })];
    expect(pickRecentlyEngagedCells(editor, seq, /*active*/ 0, /*now*/ 0)).toEqual([]);
  });
});

describe('pickScopeTodo', () => {
  it('returns the most recent TODO at-or-before the active cell', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'imports' },
      { kind: 'code', text: '# TODO: parse spec\nself.cells = ???' },
      { kind: 'markdown', text: '## Markov property\n…' },
      { kind: 'code', text: 'something else' },
    ]);
    // Active = cell 2 (markdown explanation). Scope TODO is cell 1.
    expect(pickScopeTodo(editor, 2)).toEqual({ cellIndex: 1, todoText: 'parse spec' });
  });

  it('returns the active cell itself when it has a TODO', () => {
    const editor = makeEditor([
      { kind: 'code', text: '# TODO: implement\nbuf = []' },
    ]);
    expect(pickScopeTodo(editor, 0)).toEqual({ cellIndex: 0, todoText: 'implement' });
  });

  it('skips intervening non-TODO cells when looking back', () => {
    const editor = makeEditor([
      { kind: 'code', text: '# TODO: outer task\npass' },
      { kind: 'markdown', text: 'theory' },
      { kind: 'code', text: 'helper code, no todo' },
    ]);
    expect(pickScopeTodo(editor, 2)?.cellIndex).toBe(0);
  });

  it('returns undefined when no TODO exists at or before the active cell', () => {
    const editor = makeEditor([
      { kind: 'markdown', text: 'intro' },
      { kind: 'code', text: 'imports' },
    ]);
    expect(pickScopeTodo(editor, 1)).toBeUndefined();
  });

  it('does not look forward — TODOs after the active cell don\'t count', () => {
    const editor = makeEditor([
      { kind: 'code', text: 'imports' },
      { kind: 'code', text: '# TODO: future\npass' },
    ]);
    expect(pickScopeTodo(editor, 0)).toBeUndefined();
  });

  it('clamps an out-of-range active index to the last cell', () => {
    const editor = makeEditor([
      { kind: 'code', text: '# TODO: first\npass' },
    ]);
    expect(pickScopeTodo(editor, 99)?.cellIndex).toBe(0);
  });
});

describe('pickInCellTodo', () => {
  it('returns the first TODO when cursor is unknown (cursorLine <= 0)', () => {
    // Back-compat: pre-cursor-aware behavior just matched the first TODO
    // anywhere. We preserve that as the fallback.
    const text = '# TODO: alpha\nx = 1\n# TODO: beta\ny = 2';
    expect(pickInCellTodo(text, 0)).toEqual({ todoText: 'alpha', lineNumber: 1 });
    expect(pickInCellTodo(text, -1)).toEqual({ todoText: 'alpha', lineNumber: 1 });
  });

  it('returns the nearest TODO above the cursor when there are multiple', () => {
    // Cell with two TODOs:
    //   line 1: # TODO: parse spec       <- first TODO
    //   line 2: x = 1
    //   line 3: # TODO: render grid      <- second TODO
    //   line 4: y = 2  (cursor here, line 4)
    const text = '# TODO: parse spec\nx = 1\n# TODO: render grid\ny = 2';
    expect(pickInCellTodo(text, 4)).toEqual({ todoText: 'render grid', lineNumber: 3 });
  });

  it('returns the TODO on the cursor line itself (at-or-above)', () => {
    const text = '# TODO: alpha\nx = 1\n# TODO: beta\n';
    expect(pickInCellTodo(text, 3)).toEqual({ todoText: 'beta', lineNumber: 3 });
  });

  it('returns the earlier TODO when cursor is between two TODOs', () => {
    const text = '# TODO: alpha\nx = 1\nhelper()\n# TODO: beta\ny = 2';
    // Cursor on line 2 (between alpha at line 1 and beta at line 4) → alpha.
    expect(pickInCellTodo(text, 2)?.todoText).toBe('alpha');
  });

  it('returns undefined when no TODO exists at-or-above the cursor', () => {
    const text = 'x = 1\ny = 2\n# TODO: future\n';
    // Cursor on line 1 — the only TODO is later, doesn't count.
    expect(pickInCellTodo(text, 1)).toBeUndefined();
  });

  it('handles trailing whitespace + comment forms uniformly', () => {
    expect(pickInCellTodo('# TODO: implement   ', 1)?.todoText).toBe('implement');
    expect(pickInCellTodo('# TODO:   spaced out  ', 1)?.todoText).toBe('spaced out');
  });

  it('survives an out-of-range cursor (clamps at last line)', () => {
    const text = '# TODO: alpha\nx = 1';
    expect(pickInCellTodo(text, 99)?.todoText).toBe('alpha');
  });
});

describe('pickCurrentSection', () => {
  it('returns the slice from the cursor\'s TODO to the next TODO', () => {
    // Cell layout (1-based lines):
    //   1: # TODO: alpha
    //   2: alphaCode()
    //   3: helper()
    //   4: # TODO: beta
    //   5: betaCode()
    // Cursor on line 3 → section is alpha (lines 1-3).
    const text = '# TODO: alpha\nalphaCode()\nhelper()\n# TODO: beta\nbetaCode()';
    const sec = pickCurrentSection(text, 3);
    expect(sec?.todoText).toBe('alpha');
    expect(sec?.startLine).toBe(1);
    expect(sec?.endLine).toBe(3);
    expect(sec?.text).toBe('# TODO: alpha\nalphaCode()\nhelper()');
  });

  it('cursor INSIDE the second TODO returns the second section', () => {
    // The repro from the user's bug report — multiple TODOs, cursor in
    // the second one. Without this, Zee drifts to the first/last TODO.
    const text = '# TODO: alpha\nalphaCode()\n# TODO: beta\nbetaCode()\nmoreBeta()';
    const sec = pickCurrentSection(text, 5);
    expect(sec?.todoText).toBe('beta');
    expect(sec?.startLine).toBe(3);
    expect(sec?.endLine).toBe(5);
    expect(sec?.text).toContain('betaCode');
    expect(sec?.text).toContain('moreBeta');
    expect(sec?.text).not.toContain('alphaCode');
  });

  it('cursor on the TODO line itself includes that TODO\'s section', () => {
    const text = '# TODO: alpha\nfoo\n# TODO: beta\nbar';
    expect(pickCurrentSection(text, 3)?.todoText).toBe('beta');
  });

  it('section runs to end-of-cell when there is no next TODO', () => {
    const text = '# TODO: only\nfoo\nbar\nbaz';
    const sec = pickCurrentSection(text, 2);
    expect(sec?.endLine).toBe(4);
    expect(sec?.text).toBe(text);
  });

  it('returns undefined when no TODO sits at-or-above the cursor', () => {
    const text = 'plain code\nmore code';
    expect(pickCurrentSection(text, 1)).toBeUndefined();
  });

  it('falls back to first-TODO\'s section when cursor is unknown (cursorLine <= 0)', () => {
    // Symmetric with pickInCellTodo: unknown cursor → first TODO.
    const text = '# TODO: alpha\nfoo\n# TODO: beta\nbar';
    const sec = pickCurrentSection(text, 0);
    expect(sec?.todoText).toBe('alpha');
    expect(sec?.startLine).toBe(1);
    expect(sec?.endLine).toBe(2);
  });

  it('handles a cell with a single TODO and just that one section', () => {
    const text = '# TODO: only\nx = 1';
    const sec = pickCurrentSection(text, 1);
    expect(sec?.todoText).toBe('only');
    expect(sec?.startLine).toBe(1);
    expect(sec?.endLine).toBe(2);
  });

  it('section ends at the next "def" boundary (not just the next TODO)', () => {
    // Real-world layout: the next TODO might live INSIDE a later method.
    // If the section spilled all the way to it, the excerpt would
    // include a `def __str__:` line and the LLM would pivot. The boundary
    // must catch on `def`/`class` first.
    const text = [
      '# TODO: alpha',         // line 1
      'self.x = 1',            // line 2
      '',                      // line 3
      'def __str__(self):',    // line 4 — boundary
      '    """docstring."""',  // line 5
      '    # TODO: beta',      // line 6
      '    return ""',         // line 7
    ].join('\n');
    const sec = pickCurrentSection(text, 2);
    expect(sec?.todoText).toBe('alpha');
    expect(sec?.startLine).toBe(1);
    expect(sec?.endLine).toBe(3);   // up to the line BEFORE `def __str__`
    expect(sec?.text).not.toContain('def __str__');
    expect(sec?.text).not.toContain('docstring');
  });

  it('catches `class` boundaries as well as `def`', () => {
    const text = '# TODO: alpha\nx = 1\nclass Helper:\n    pass';
    const sec = pickCurrentSection(text, 2);
    expect(sec?.endLine).toBe(2);
    expect(sec?.text).not.toContain('class Helper');
  });

  it('catches `async def` boundaries', () => {
    const text = '# TODO: alpha\nx = 1\nasync def fetch():\n    pass';
    const sec = pickCurrentSection(text, 2);
    expect(sec?.endLine).toBe(2);
    expect(sec?.text).not.toContain('async def');
  });

  it('does NOT misfire on words that look like def (e.g. "definition")', () => {
    // The boundary regex requires `def` or `class` followed by whitespace
    // and an identifier — not free-text occurrences.
    const text = '# TODO: alpha\n# the definition is below\nx = 1';
    const sec = pickCurrentSection(text, 2);
    expect(sec?.endLine).toBe(3);
    expect(sec?.text).toContain('definition');
  });

  it('captures the user-reported "Store a list" / "__str__" bug', () => {
    // Real-world layout from the bug report: two TODOs separated by a
    // method def. Cursor in the FIRST TODO area. The section's TODO
    // label is "Store a list" AND the text excerpt now stops at the
    // `def __str__:` boundary — earlier than the next TODO, so the
    // method signature doesn't even appear in the excerpt for the LLM
    // to pivot to.
    const text =
      '# TODO: Store a list of lists of `Cell`s, parsed from the input spec.\n' +  // line 1
      'self.cells = ???\n' +                                                        // line 2
      '\n' +                                                                         // line 3
      'def __str__(self):\n' +                                                       // line 4
      '    """Render the grid."""\n' +                                               // line 5
      '    # TODO: produce a nicely formatted string\n' +                            // line 6
      '    return ""\n';                                                             // line 7
    const sec = pickCurrentSection(text, 2);  // cursor in "Store a list" body
    expect(sec?.todoText).toContain('Store a list');
    expect(sec?.startLine).toBe(1);
    expect(sec?.endLine).toBe(3);    // stops at the line BEFORE `def __str__`
    expect(sec?.text).toContain('self.cells');
    expect(sec?.text).not.toContain('def __str__');               // method def excluded
    expect(sec?.text).not.toContain('produce a nicely formatted'); // next TODO excluded
    expect(sec?.text).not.toContain('return ""');                  // body of next TODO excluded
  });
});

describe('pickEnclosingMethod', () => {
  // The user-reported scenario inspires most of these:
  //   class Grid:
  //       def __init__(self, spec): ...
  //       def __str__(self): ...           ← cursor here
  //       def __getitem__(self, key): ...
  // We need __str__ as the enclosing method, NOT __getitem__.
  const grid =
    'class Grid:\n' +
    '    def __init__(self, spec):\n' +                  // line 2
    '        self.height = len(spec)\n' +                 // line 3
    '        self.width = len(spec[0])\n' +               // line 4
    '\n' +                                                 // line 5
    '    def __str__(self):\n' +                          // line 6
    '        """Render."""\n' +                            // line 7
    '        rows = [" ".join(c.value for c in row)\n' + // line 8
    '                for row in self.cells]\n' +          // line 9
    '        return "\\n".join(rows)\n' +                 // line 10
    '\n' +                                                 // line 11
    '    def __getitem__(self, key):\n' +                  // line 12
    '        x, y = key\n' +                                // line 13
    '        return self.cells[y][x]\n';                   // line 14

  it('cursor inside __str__ → enclosing method is __str__ (the user\'s exact bug)', () => {
    const m = pickEnclosingMethod(grid, /*cursor*/ 9);
    expect(m?.name).toBe('__str__');
    expect(m?.startLine).toBe(6);
    expect(m?.endLine).toBe(10);
    expect(m?.signature).toBe('def __str__(self):');
    expect(m?.text).toContain('def __str__');
    expect(m?.text).toContain('rows = [');
    expect(m?.text).not.toContain('def __getitem__');
    expect(m?.text).not.toContain('def __init__');
  });

  it('cursor inside __getitem__ → enclosing method is __getitem__', () => {
    const m = pickEnclosingMethod(grid, 13);
    expect(m?.name).toBe('__getitem__');
    expect(m?.text).toContain('def __getitem__');
    expect(m?.text).not.toContain('def __str__');
  });

  it('cursor on the def line itself → that method', () => {
    const m = pickEnclosingMethod(grid, 6);
    expect(m?.name).toBe('__str__');
  });

  it('cursor on a blank line BETWEEN methods → the previous method (best-effort)', () => {
    // Line 11 is blank, between __str__ (ends line 10) and __getitem__
    // (starts line 12). Walking back from line 11 hits __str__ first.
    // This is acceptable best-effort — the indent-aware end-detection
    // would technically treat line 11 as outside __str__'s body, but
    // we'd need a separate "no enclosing scope" branch for that, and
    // pointing at the most-recent enclosing method is fine for student
    // questions like "what is this method about?" when they're between
    // two methods.
    const m = pickEnclosingMethod(grid, 11);
    expect(m?.name).toBe('__str__');
  });

  it('handles `async def`', () => {
    const text = 'class C:\n    async def fetch(self):\n        return 1';
    expect(pickEnclosingMethod(text, 3)?.name).toBe('fetch');
  });

  it('handles `class` as the enclosing scope when not inside a method', () => {
    const text =
      'class Helper:\n' +
      '    """A helper."""\n' +     // line 2
      '    SOME_CONST = 42\n' +      // line 3 ← cursor here, inside class but no method
      '\n' +
      '    def use(self):\n' +
      '        pass';
    const m = pickEnclosingMethod(text, 3);
    expect(m?.name).toBe('Helper');
  });

  it('returns undefined when the cursor is at top-level / no enclosing scope', () => {
    const text = 'import math\nx = 1\ny = 2';
    expect(pickEnclosingMethod(text, 1)).toBeUndefined();
    expect(pickEnclosingMethod(text, 2)).toBeUndefined();
  });

  it('end-of-method detection cuts BEFORE the next sibling def, even with blank gap', () => {
    const text =
      'def a():\n' +
      '    return 1\n' +
      '\n' +
      '\n' +
      'def b():\n' +
      '    return 2';
    const m = pickEnclosingMethod(text, 2);
    expect(m?.name).toBe('a');
    expect(m?.endLine).toBe(2);    // trailing blanks trimmed
    expect(m?.text).not.toContain('def b');
    expect(m?.text).not.toContain('return 2');
  });

  it('returns undefined for cursorLine <= 0 (unknown cursor)', () => {
    expect(pickEnclosingMethod(grid, 0)).toBeUndefined();
    expect(pickEnclosingMethod(grid, -1)).toBeUndefined();
  });

  it('clamps an out-of-range cursor to the last line', () => {
    expect(pickEnclosingMethod(grid, 9999)?.name).toBe('__getitem__');
  });
});
