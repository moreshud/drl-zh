import * as vscode from 'vscode';
import {
  STUCK_ERROR_THRESHOLD, IDLE_ON_TODO_MS, READING_ON_MARKDOWN_MS,
  TRANSCRIPT_CELL_PREVIEW_LEN, CONTEXT_THROTTLE_MS,
  BRIEF_VISIT_MS, FOCUS_SEQUENCE_MAX,
  SOFT_IDLE_PRESENCE_MS, SOFT_IDLE_NUDGE_MS,
  RECENTLY_ENGAGED_CELL_CHAR_CAP, RECENTLY_ENGAGED_CELL_LIMIT,
} from './constants';
import { UserConfig, CHAPTER_CONTEXT, CHAPTER_TITLES } from './providers';

// ── Types ───────────────────────────────────────────────────────────────────

export interface FocusEntry {
  cellIndex: number;
  cellType: 'code' | 'markdown';
  enteredAt: number;
  duration: number;       // ms, set when leaving the cell
  wasEditing: boolean;    // true if keystrokes detected while on this cell
  preview: string;        // first ~60 chars of cell content
}

export interface SurroundingCell {
  index: number;
  type: 'code' | 'markdown';
  content: string;
  outputs?: string;
}

/**
 * A code cell the student spent meaningful time editing recently — used so
 * Zee can resolve "here" / "this" when the active cell is a different one
 * (e.g. theory markdown right above the cell they were just typing in).
 */
export interface RecentlyEngagedCell {
  cellIndex: number;
  type: 'code';
  /** Tail of the cell content (cap matches active-cell budget). */
  content: string;
  isTodoCell: boolean;
  todoText: string;
  /** How long ago, in seconds, the student left this cell. */
  secondsAgo: number;
}

export interface NotebookContext {
  notebookFile: string | null;
  chapterNumber: number;
  chapterTitle: string;
  activeCellIndex: number;
  activeCellContent: string;
  activeCellType: 'code' | 'markdown';
  /** 1-based line number of the cursor inside the active cell's text
   *  editor. Read from a SNAPSHOT we capture on every cursor movement,
   *  not from live VS Code state — clicking on Zee's webview steals
   *  focus and would otherwise lose the cursor. -1 when the student
   *  hasn't clicked into the cell yet. */
  activeCellCursorLine: number;
  /** Tight excerpt of the lines around the cursor, with line numbers and
   *  a `>` marker on the cursor line. Sent to the LLM as a redundant
   *  spatial anchor — even if the section block / cursor marker fail,
   *  this block alone tells the model exactly what the student is
   *  staring at. Empty string when no snapshot exists. */
  activeCellCursorContext: string;
  isTodoCell: boolean;
  todoText: string;
  lastError: string | null;
  consecutiveErrors: number;
  cellRunCount: number;
  lastInteractionAt: number;
  focusSummary: string;
  surroundingCells: SurroundingCell[];
  notebookSummary?: string;
  solutionHint?: string;
  /** A plot near the active cell the student can choose to attach to their
   *  next message. Detected from active or ±1 neighbour cells; null when no
   *  nearby cell has an image output. */
  attachablePlot?: AttachablePlot;
  /** Last 1–2 code cells the student was actively editing. Lets Zee
   *  resolve deictic words like "here" when the student asks a question
   *  while the active cell is different (e.g. they navigated up to read
   *  theory before asking about the cell they were typing in). */
  recentlyEngagedCells?: RecentlyEngagedCell[];
  /** The most recent TODO at-or-before the active cell. When the student
   *  is parked on a markdown explanation or a helper code cell that lives
   *  under a TODO header, this is the TODO they're implementing — even
   *  when the active cell itself isn't the TODO cell. */
  scopeTodo?: { cellIndex: number; todoText: string };
  /** The slice of the active cell from the cursor's TODO line down to the
   *  next TODO (or end of cell). Sent to the LLM as a strongly-labeled
   *  block so deictic words like "here" land on the right section even
   *  when the active cell contains multiple TODOs. */
  currentSection?: CurrentSection;
  /** The Python def/class the cursor sits inside, with its FULL body —
   *  detected by indent-based scope walking. Strongest semantic anchor
   *  for "what method are they working on": with the whole body in the
   *  prompt, the LLM can't drift to a sibling method just because the
   *  cell-content window happened to truncate the right `def` line. */
  enclosingMethod?: EnclosingMethod;
}

/**
 * A Python scope (def, async def, or class) that encloses the cursor.
 * Detected via indent-based walking — minimal but reliable for the
 * course's notebook code style.
 */
export interface EnclosingMethod {
  /** The def/class name (e.g. "__str__"). */
  name: string;
  /** The full signature line, trimmed (e.g. "def __str__(self):"). */
  signature: string;
  /** 1-based start line (the def/class line itself). */
  startLine: number;
  /** 1-based inclusive end line (last line of the body). */
  endLine: number;
  /** Verbatim text from startLine through endLine. */
  text: string;
}

/**
 * Cursor position + nearby code, captured per-cell whenever the user
 * moves the cursor in any text editor. Persisted across focus shifts
 * (e.g. clicking on Zee's webview) so we never lose the location.
 */
export interface CursorSnapshot {
  /** 1-based line number within the cell's text editor. */
  line: number;
  /** Tight excerpt of N lines before + cursor + N lines after, with line
   *  numbers and a `>` marker on the cursor line. */
  contextWithLineNumbers: string;
  /** Wall-clock when the snapshot was taken — for debugging staleness. */
  capturedAt: number;
}

/**
 * A section of the active cell delimited by TODO markers, anchored on
 * whichever TODO sits at-or-above the cursor.
 */
export interface CurrentSection {
  todoText: string;
  /** 1-based line numbers within the active cell. */
  startLine: number;
  endLine: number;
  /** Verbatim text between startLine and endLine, inclusive. */
  text: string;
}

/**
 * A PNG image output from a notebook cell, with its base64-encoded bytes
 * inlined so the webview can render a thumbnail and the host can forward
 * the same bytes to a multimodal LLM at send-time.
 */
export interface AttachablePlot {
  cellIndex: number;
  mimeType: string;        // 'image/png' (only PNG supported for now)
  dataBase64: string;
}

/**
 * Three event-driven awareness triggers. Fired exactly once per qualifying
 * situation (per cell visit, per error streak) — no cooldown polling.
 */
export type SignalType = 'stuck' | 'idle' | 'reading' | 'success';

/**
 * Cell-agnostic flow state, derived from global activity.
 * 'active' = user did something recently (typing, cell edit, cell run, voice).
 * 'soft-idle-presence' = 2min quiet → face drifts to drowsy, no text.
 * 'soft-idle-nudge' = 5min quiet → one gentle templated nudge, then silence.
 */
export type FlowState = 'active' | 'soft-idle-presence' | 'soft-idle-nudge';

export interface ContextTrackerEvents {
  onContextUpdate: (ctx: NotebookContext) => void;
  onRequestToSpeak: (signal: SignalType) => void;
  onFlowStateChange: (state: FlowState) => void;
}

// ── Attachable-plot detection ──────────────────────────────────────────────

/**
 * Find the nearest cell (active first, then ±1 neighbours) that has a PNG
 * image output, and return its bytes base64-encoded for the webview to
 * thumbnail. Returns undefined when no such cell exists. Cells are scanned
 * from output[last] backward so we pick the most recent display call.
 */
export function findAttachablePlot(
  editor: vscode.NotebookEditor,
  activeCellIndex: number,
): { cellIndex: number; mimeType: string; dataBase64: string } | undefined {
  const total = editor.notebook.cellCount;
  // Active first, then immediate neighbours by Manhattan distance.
  const order = [activeCellIndex, activeCellIndex - 1, activeCellIndex + 1];
  for (const idx of order) {
    if (idx < 0 || idx >= total) { continue; }
    const cell = editor.notebook.cellAt(idx);
    if (cell.kind !== vscode.NotebookCellKind.Code) { continue; }
    if (!cell.outputs || cell.outputs.length === 0) { continue; }
    // Newest output last in the array — walk backward so a re-run beats an
    // older display in the same cell.
    for (let oi = cell.outputs.length - 1; oi >= 0; oi--) {
      for (const item of cell.outputs[oi].items) {
        if (item.mime === 'image/png') {
          return {
            cellIndex: idx,
            mimeType: 'image/png',
            dataBase64: Buffer.from(item.data).toString('base64'),
          };
        }
      }
    }
  }
  return undefined;
}

// ── In-cell TODO lookup ────────────────────────────────────────────────────

/**
 * Find the nearest `TODO: …` line at-or-above the given 1-based cursor
 * line within a cell's text. Returns the TODO text (trimmed) and the
 * 1-based line number where it was declared, or undefined when no TODO
 * exists at-or-above the cursor.
 *
 * If `cursorLine1Based <= 0` (cursor unknown) we fall back to the FIRST
 * TODO match — same behavior the old single-line regex had.
 *
 * Why this exists: a single notebook cell can contain multiple TODOs
 * (especially as you scroll deeper into a class). The student's "current"
 * TODO is the closest one above where their cursor sits, not the first
 * one anywhere in the cell.
 */
export function pickInCellTodo(
  cellText: string,
  cursorLine1Based: number,
): { todoText: string; lineNumber: number } | undefined {
  const lines = cellText.split('\n');
  if (cursorLine1Based <= 0) {
    // No cursor anchor — walk forwards and return the FIRST TODO. Matches
    // the old `text.match(/TODO:.../)` semantics so callers without a
    // focused text editor see the same behavior they always have.
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/TODO:\s*(.*?)\s*$/);
      if (m) { return { todoText: m[1].trim(), lineNumber: i + 1 }; }
    }
    return undefined;
  }
  // Cursor known: cap the search at the cursor line and walk backwards so
  // we return the closest TODO at-or-above the cursor.
  const searchEnd = Math.min(lines.length, cursorLine1Based);
  for (let i = searchEnd - 1; i >= 0; i--) {
    const m = lines[i].match(/TODO:\s*(.*?)\s*$/);
    if (m) { return { todoText: m[1].trim(), lineNumber: i + 1 }; }
  }
  return undefined;
}

/**
 * Find the section of a cell the cursor is currently in — defined as the
 * lines from the most-recent `TODO:` marker at-or-above the cursor down to
 * the next `TODO:` marker (or end of cell). Returns undefined when the
 * active cell has no TODO at-or-above the cursor.
 *
 * Why this exists: a single notebook cell can hold several TODOs and full
 * method definitions. A 1-line "Cursor is at line N" hint isn't enough to
 * keep the LLM from drifting toward whichever TODO/method looks more
 * "well-defined". A labeled section excerpt is far stronger steering.
 */
export function pickCurrentSection(
  cellText: string,
  cursorLine1Based: number,
): CurrentSection | undefined {
  const lines = cellText.split('\n');
  const todo = pickInCellTodo(cellText, cursorLine1Based);
  if (!todo) { return undefined; }

  const startLine = todo.lineNumber;
  // Find the EARLIEST boundary after the start: either the next TODO line
  // or the next `def`/`class`/`async def` line. Stopping at method
  // boundaries is critical — without it, a section anchored on TODO #2
  // would bleed into the START of the NEXT method whose own TODO comes
  // later, and the LLM would pivot to that method's signature in its
  // answer (real bug we hit: cursor in __init__ TODO, but the section
  // included `def __str__:` and the model answered about __str__).
  let boundary = -1;
  for (let i = startLine; i < lines.length; i++) {
    if (/TODO:\s*\S/.test(lines[i])) { boundary = i + 1; break; }
    if (/^\s*(?:async\s+)?(?:def|class)\s+\w/.test(lines[i])) {
      boundary = i + 1;
      break;
    }
  }
  // 1-based inclusive end: line before the boundary, or last line.
  const endLine = boundary > 0 ? boundary - 1 : lines.length;

  const text = lines.slice(startLine - 1, endLine).join('\n');
  return { todoText: todo.todoText, startLine, endLine, text };
}

// ── Enclosing-method detection ────────────────────────────────────────────

/**
 * Find the `def` / `async def` / `class` that encloses the cursor, and
 * return the full body of that scope. Uses indent-based scope walking —
 * minimal but reliable for the course's notebook code style.
 *
 * Algorithm: walk lines BACKWARDS from the cursor; the first def/class
 * line we hit is the innermost enclosing scope (Python statements are
 * indent-block scoped, and any deeper scope would have its own def).
 * Then walk FORWARDS from there until we hit a sibling-or-shallower
 * def/class line (or end of cell) — that's the body's terminator.
 *
 * Returns undefined when the cursor isn't inside any def/class (e.g.
 * top-level imports / module-level code).
 */
export function pickEnclosingMethod(
  cellText: string,
  cursorLine1Based: number,
): EnclosingMethod | undefined {
  if (cursorLine1Based < 1) { return undefined; }
  const lines = cellText.split('\n');
  if (cursorLine1Based > lines.length) { cursorLine1Based = lines.length; }

  // Walk backwards from the cursor (inclusive) looking for an enclosing
  // def/class. Stop on the first one — it's the innermost.
  const defRe = /^(\s*)((?:async\s+)?(?:def|class))\s+(\w+)/;
  let defIdx = -1;
  let defIndent = -1;
  let defName = '';
  for (let i = cursorLine1Based - 1; i >= 0; i--) {
    const m = lines[i].match(defRe);
    if (m) {
      defIdx = i;
      defIndent = m[1].length;
      defName = m[3];
      break;
    }
  }
  if (defIdx === -1) { return undefined; }

  // Walk forwards looking for a sibling-or-shallower def/class — that's
  // where this scope's body ends. Blank lines don't count.
  let endIdx = lines.length - 1;
  for (let i = defIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/\S/.test(line)) { continue; }
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    if (indent > defIndent) { continue; }    // deeper than def → still inside body
    // Same-or-shallower: if it's a def/class, this scope ends.
    if (defRe.test(line)) {
      endIdx = i - 1;
      break;
    }
    // Same-or-shallower but not a def — could be top-level code AFTER the
    // method. We still consider the body to end here.
    endIdx = i - 1;
    break;
  }

  // Trim trailing blank lines from the body for cleaner LLM excerpts.
  while (endIdx > defIdx && !/\S/.test(lines[endIdx])) { endIdx--; }

  const text = lines.slice(defIdx, endIdx + 1).join('\n');
  const sig = lines[defIdx].trim();
  return {
    name: defName,
    signature: sig,
    startLine: defIdx + 1,
    endLine: endIdx + 1,
    text,
  };
}

// ── Scope-TODO lookup ──────────────────────────────────────────────────────

/**
 * Walk backwards from the active cell to find the most recent TODO cell
 * (the cell whose text contains a `TODO:` line). Returns the active cell
 * itself when it's a TODO. Returns undefined when no such TODO exists
 * at-or-before the active position. Used by the awareness pill so a
 * student parked on a markdown explanation right under a TODO still sees
 * the TODO they're implementing as the visible scope.
 */
export function pickScopeTodo(
  editor: vscode.NotebookEditor,
  activeCellIndex: number,
): { cellIndex: number; todoText: string } | undefined {
  const total = editor.notebook.cellCount;
  for (let i = Math.min(activeCellIndex, total - 1); i >= 0; i--) {
    const cell = editor.notebook.cellAt(i);
    if (cell.kind !== vscode.NotebookCellKind.Code) { continue; }
    const m = cell.document.getText().match(/TODO:\s*(.*?)(?:\n|$)/);
    if (m) { return { cellIndex: i, todoText: m[1].trim() }; }
  }
  return undefined;
}

// ── Recently-engaged cell selection ────────────────────────────────────────

/**
 * Walk a focus history newest→oldest and pick up to `limit` code cells
 * the student was actively editing. Skips the active cell itself (Zee
 * already has that one) and skips entries without `wasEditing` (passive
 * scrolling shouldn't qualify as "engagement"). Resolves each pick's
 * current cell content from the editor — so if the student edited cell 5,
 * navigated to cell 3, and asks "I'm confused here", Zee gets cell 5's
 * latest text, not stale bytes from when they navigated away.
 */
export function pickRecentlyEngagedCells(
  editor: vscode.NotebookEditor,
  focusSequence: ReadonlyArray<FocusEntry>,
  activeCellIndex: number,
  now: number,
  limit = RECENTLY_ENGAGED_CELL_LIMIT,
): RecentlyEngagedCell[] {
  const out: RecentlyEngagedCell[] = [];
  const total = editor.notebook.cellCount;
  const seen = new Set<number>();
  for (let i = focusSequence.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = focusSequence[i];
    if (entry.cellType !== 'code') { continue; }
    if (!entry.wasEditing) { continue; }
    if (entry.cellIndex === activeCellIndex) { continue; }
    if (seen.has(entry.cellIndex)) { continue; }
    if (entry.cellIndex < 0 || entry.cellIndex >= total) { continue; }
    seen.add(entry.cellIndex);

    const cell = editor.notebook.cellAt(entry.cellIndex);
    if (cell.kind !== vscode.NotebookCellKind.Code) { continue; }
    const raw = cell.document.getText();
    const content = raw.length > RECENTLY_ENGAGED_CELL_CHAR_CAP
      ? `… (truncated)\n${raw.slice(-RECENTLY_ENGAGED_CELL_CHAR_CAP)}`
      : raw;
    const todoMatch = raw.match(/TODO:\s*(.*?)(?:\n|$)/);
    out.push({
      cellIndex: entry.cellIndex,
      type: 'code',
      content,
      isTodoCell: !!todoMatch,
      todoText: todoMatch ? todoMatch[1].trim() : '',
      // duration is set when the entry was closed; we report time since
      // they LEFT the cell, which is now − (enteredAt + duration).
      secondsAgo: Math.max(0, Math.round((now - (entry.enteredAt + entry.duration)) / 1000)),
    });
  }
  return out;
}

// ── Chapter parsing ─────────────────────────────────────────────────────────

function parseNotebookInfo(filename: string): { chapter: number; title: string } {
  const match = filename.match(/^(\d{2})_/);
  if (!match) { return { chapter: -1, title: 'Unknown' }; }
  const num = parseInt(match[1], 10);
  return { chapter: num, title: CHAPTER_TITLES[num] ?? 'Unknown' };
}

// ── Context Tracker ─────────────────────────────────────────────────────────

export class ContextTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private context: NotebookContext;
  private events: ContextTrackerEvents;
  private config: UserConfig;
  private contextUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastContextUpdateAt = 0;
  private paused = false;
  private pendingInitiative = false;   // one signal at a time, cleared by resetCooldown()
  private lastFocusedCellIndex = -1;
  private focusSequence: FocusEntry[] = [];
  private currentFocusEntry: FocusEntry | null = null;
  private editingDuringFocus = false;
  private learnMoreCells = new Set<number>();

  // Per-cell trigger state: a signal fires at most once per (cell, reason).
  // Reset on notebook switch and on cell focus change.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setTimeout> | null = null;
  private stuckFiredForErrorStreak = false;
  private idleFiredForCell = new Set<number>();
  private readingFiredForCell = new Set<number>();
  // Once per cell visit: don't keep celebrating after every successful run
  // on the same cell. Cleared on notebook switch.
  private successFiredForCell = new Set<number>();

  // Cursor snapshots keyed by cell-document URI. Captured on every
  // selection-change in any text editor; read instead of live state when
  // building context. Survives focus shifts to the webview (clicking
  // Zee's panel would otherwise zero out vscode.window.activeTextEditor
  // and lose the cursor we need to resolve "here" / "this" with).
  private cursorByCell = new Map<string, CursorSnapshot>();

  // Soft-idle flow state: global (cell-agnostic), resets on any activity.
  // Nudge fires at most once per idle period — activity re-arms it.
  private softIdlePresenceTimer: ReturnType<typeof setTimeout> | null = null;
  private softIdleNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private flowState: FlowState = 'active';
  private softIdleNudgeFiredThisPeriod = false;

  constructor(events: ContextTrackerEvents, config: UserConfig) {
    this.events = events;
    this.config = config;
    this.context = this.emptyContext();

    // Watch cursor/selection changes — snapshot the cursor first, then
    // fire the rest of the update pipeline. Snapshotting on every move
    // means clicking on Zee's webview (which steals focus) doesn't lose
    // the cursor we need to resolve "here" / "this" with.
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e?.textEditor) { this.captureCursorSnapshot(e.textEditor); }
        this.onActivity();
        this.updateFromActiveEditor();
      })
    );

    // Watch cell edits
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this.paused) { return; }
        this.onActivity();
        this.editingDuringFocus = true;
        this.updateFromActiveEditor();
      })
    );

    // Watch text editor switches (cell focus within a notebook)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateFromActiveEditor();
      })
    );

    // Watch notebook editor focus (open / tab switch)
    if (vscode.window.onDidChangeActiveNotebookEditor) {
      this.disposables.push(
        vscode.window.onDidChangeActiveNotebookEditor(() => {
          this.updateFromActiveEditor();
        })
      );
    }

    // Watch notebook CELL-LIST selection changes (clicking a markdown cell
    // doesn't change the active text editor — it just moves the notebook
    // selection — so without this we miss every transition into a markdown
    // preview, and the awareness pill goes stale.
    if (vscode.window.onDidChangeNotebookEditorSelection) {
      this.disposables.push(
        vscode.window.onDidChangeNotebookEditorSelection(() => {
          this.updateFromActiveEditor();
        })
      );
    }

    // Watch cell execution state
    this.disposables.push(
      vscode.workspace.onDidChangeNotebookDocument(e => {
        this.handleNotebookChange(e);
      })
    );

    // Initial state
    this.updateFromActiveEditor();
    this.rearmSoftIdle();
  }

  updateConfig(config: UserConfig): void {
    this.config = config;
  }

  pause(): void {
    this.paused = true;
    this.pendingInitiative = false;
    this.clearPerCellTimers();
    this.clearSoftIdleTimers();
    if (this.contextUpdateTimer) {
      clearTimeout(this.contextUpdateTimer);
      this.contextUpdateTimer = null;
    }
  }

  resume(): void {
    this.paused = false;
    this.updateFromActiveEditor();
    this.rearmSoftIdle();
  }

  isPaused(): boolean {
    return this.paused;
  }

  getContext(): NotebookContext {
    return { ...this.context, focusSummary: this.buildFocusSummary() };
  }

  /**
   * Called after the companion has resolved an initiative (accepted, dismissed,
   * or replied). Re-arms triggers so a new qualifying situation can fire again.
   */
  resetCooldown(): void {
    this.pendingInitiative = false;
  }

  notifyInteraction(): void {
    this.context.lastInteractionAt = Date.now();
    this.resetCooldown();
  }

  /**
   * Prevent the next observation tick from firing a signal.
   * Used when an initiative is offered externally (e.g. intro offer)
   * so proactive suggestions don't override it until dismissed/accepted.
   */
  suppressSignals(): void {
    this.pendingInitiative = true;
  }

  /**
   * Record that the user clicked "learn more" on a cell.
   * Suppresses the reading signal for that cell.
   */
  notifyLearnMoreClicked(cellIndex: number): void {
    this.learnMoreCells.add(cellIndex);
    this.readingFiredForCell.add(cellIndex);
    if (this.readingTimer) {
      clearTimeout(this.readingTimer);
      this.readingTimer = null;
    }
    this.resetCooldown();
  }

  /**
   * Throttled context update emission — at most once per CONTEXT_THROTTLE_MS.
   */
  private emitContextUpdate(): void {
    const now = Date.now();
    const elapsed = now - this.lastContextUpdateAt;
    if (elapsed >= CONTEXT_THROTTLE_MS) {
      this.lastContextUpdateAt = now;
      this.events.onContextUpdate(this.getContext());
    } else {
      // Schedule a trailing emit if not already scheduled
      if (!this.contextUpdateTimer) {
        this.contextUpdateTimer = setTimeout(() => {
          this.contextUpdateTimer = null;
          this.lastContextUpdateAt = Date.now();
          this.events.onContextUpdate(this.getContext());
        }, CONTEXT_THROTTLE_MS - elapsed);
      }
    }
  }

  private emptyContext(): NotebookContext {
    return {
      notebookFile: null,
      chapterNumber: -1,
      chapterTitle: '',
      activeCellIndex: -1,
      activeCellContent: '',
      activeCellType: 'code',
      activeCellCursorLine: -1,
      activeCellCursorContext: '',
      isTodoCell: false,
      todoText: '',
      lastError: null,
      consecutiveErrors: 0,
      cellRunCount: 0,
      lastInteractionAt: Date.now(),
      focusSummary: '',
      surroundingCells: [],
    };
  }

  private closeFocusEntry(): void {
    if (!this.currentFocusEntry) { return; }
    const now = Date.now();
    const duration = now - this.currentFocusEntry.enteredAt;
    this.currentFocusEntry.duration = duration;
    this.currentFocusEntry.wasEditing = this.editingDuringFocus;

    // Only record if the visit was meaningful (> BRIEF_VISIT_MS)
    if (duration >= BRIEF_VISIT_MS) {
      this.focusSequence.push(this.currentFocusEntry);
      if (this.focusSequence.length > FOCUS_SEQUENCE_MAX) {
        this.focusSequence.shift();
      }
    }
    this.currentFocusEntry = null;
  }

  private formatDuration(ms: number): string {
    if (ms < 60_000) { return `${Math.round(ms / 1000)}s`; }
    return `${Math.round(ms / 60_000)}min`;
  }

  /**
   * Focus summary is only worth sending to the LLM when the student has
   * actually moved between cell types (markdown ↔ code) — that's the pattern
   * a tutor needs to see. Homogeneous sequences (all code, all markdown) are
   * redundant with the active-cell block.
   */
  buildFocusSummary(): string {
    if (this.focusSequence.length < 2) { return ''; }
    const types = new Set(this.focusSequence.map(e => e.cellType));
    if (types.size < 2) { return ''; }

    const parts: string[] = [];
    for (const entry of this.focusSequence) {
      const type = entry.cellType === 'markdown' ? 'Read' : 'Code';
      const action = entry.wasEditing ? 'edited' : (entry.cellType === 'markdown' ? 'reading' : 'working');
      const preview = entry.preview ? ` "${entry.preview.slice(0, 40)}..."` : '';
      parts.push(`${type} cell ${entry.cellIndex}${preview} (${this.formatDuration(entry.duration)}, ${action})`);
    }
    return parts.join(' → ');
  }

  /**
   * Returns whether the user is currently reading (not editing) a markdown cell.
   */
  isReadingMarkdown(): boolean {
    return (
      this.currentFocusEntry !== null &&
      this.currentFocusEntry.cellType === 'markdown' &&
      !this.editingDuringFocus &&
      Date.now() - this.currentFocusEntry.enteredAt >= BRIEF_VISIT_MS
    );
  }

  private updateFromActiveEditor(): void {
    if (this.paused) { return; }
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
      // Check if any active text editor is an ipynb
      const textEditor = vscode.window.activeTextEditor;
      if (!textEditor || !textEditor.document.uri.fsPath.endsWith('.ipynb')) {
        if (this.context.notebookFile !== null) {
          this.context.notebookFile = null;
          this.clearPerCellTimers();
          this.emitContextUpdate();
        }
        return;
      }
    }

    if (editor) {
      const uri = editor.notebook.uri;
      const fsPath = uri.fsPath;
      const filename = fsPath.split('/').pop() ?? '';

      // Ignore solution notebooks
      if (fsPath.includes('/solution/') || fsPath.includes('\\solution\\')) {
        if (this.context.notebookFile !== null) {
          this.context.notebookFile = null;
          this.clearPerCellTimers();
          this.emitContextUpdate();
        }
        return;
      }

      const { chapter, title } = parseNotebookInfo(filename);

      // Detect notebook switch
      if (this.context.notebookFile !== filename) {
        this.context.consecutiveErrors = 0;
        this.context.cellRunCount = 0;
        this.context.lastError = null;
        this.learnMoreCells.clear();
        this.focusSequence = [];
        this.lastFocusedCellIndex = -1;
        this.editingDuringFocus = false;
        this.clearPerCellTimers();
        this.stuckFiredForErrorStreak = false;
        this.idleFiredForCell.clear();
        this.readingFiredForCell.clear();
        this.successFiredForCell.clear();
      }

      this.context.notebookFile = filename;
      this.context.chapterNumber = chapter;
      this.context.chapterTitle = title;

      // Get active cell
      const selections = editor.selections;
      if (selections.length > 0) {
        const cellIndex = selections[0].start;
        const cell = editor.notebook.cellAt(cellIndex);
        this.context.activeCellIndex = cellIndex;
        this.context.activeCellContent = cell.document.getText();
        this.context.activeCellType = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';

        // Read the cursor from our SNAPSHOT, not from live state. Live
        // state is null/wrong the moment the user clicks Zee's webview;
        // the snapshot persists from the last time they actually moved
        // the cursor in this cell. Falls back to live state if no
        // snapshot exists (first interaction with the cell).
        const cellUri = cell.document?.uri?.toString();
        const snap = cellUri ? this.cursorByCell.get(cellUri) : undefined;
        if (snap) {
          this.context.activeCellCursorLine = snap.line;
          this.context.activeCellCursorContext = snap.contextWithLineNumbers;
        } else {
          const activeText = vscode.window.activeTextEditor;
          if (cellUri && activeText && activeText.document?.uri?.toString() === cellUri) {
            // Editor IS focused on this cell but we don't have a snapshot
            // yet — capture now and use it.
            this.captureCursorSnapshot(activeText);
            const fresh = this.cursorByCell.get(cellUri);
            this.context.activeCellCursorLine = fresh?.line ?? -1;
            this.context.activeCellCursorContext = fresh?.contextWithLineNumbers ?? '';
          } else {
            this.context.activeCellCursorLine = -1;
            this.context.activeCellCursorContext = '';
          }
        }

        // Track cell focus transitions
        if (cellIndex !== this.lastFocusedCellIndex) {
          const previousFocusedCellIndex = this.lastFocusedCellIndex;
          this.closeFocusEntry();
          this.lastFocusedCellIndex = cellIndex;
          this.editingDuringFocus = false;

          // Start new focus entry
          this.currentFocusEntry = {
            cellIndex,
            cellType: this.context.activeCellType,
            enteredAt: Date.now(),
            duration: 0,
            wasEditing: false,
            preview: this.context.activeCellContent.slice(0, 60).replace(/\n/g, ' '),
          };

          this.onCellFocusChanged(cellIndex, previousFocusedCellIndex);
        }

        // Gather surrounding cells (1 before, 1 after) for LLM context.
        // Keep 300 chars per cell; include outputs only if the *current* cell
        // had an error (they're irrelevant otherwise and burn tokens).
        const surroundingCells: SurroundingCell[] = [];
        const totalCells = editor.notebook.cellCount;
        const includeOutputs = !!this.context.lastError;
        for (const offset of [-1, 1]) {
          const idx = cellIndex + offset;
          if (idx < 0 || idx >= totalCells) { continue; }
          const nearbyCell = editor.notebook.cellAt(idx);
          const nearbyType: 'code' | 'markdown' = nearbyCell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';
          const nearbyContent = nearbyCell.document.getText().slice(0, 300);

          let outputs: string | undefined;
          if (includeOutputs && nearbyType === 'code' && nearbyCell.outputs && nearbyCell.outputs.length > 0) {
            let outputText = '';
            for (const output of nearbyCell.outputs) {
              for (const item of output.items) {
                if (item.mime === 'text/plain' || item.mime === 'application/vnd.code.notebook.error') {
                  outputText += new TextDecoder().decode(item.data);
                }
              }
            }
            if (outputText) {
              const MAX_OUTPUT_LEN = 300;
              outputs = outputText.length > MAX_OUTPUT_LEN
                ? outputText.slice(0, MAX_OUTPUT_LEN) + '\n... [output truncated]'
                : outputText;
            }
          }

          surroundingCells.push({ index: idx, type: nearbyType, content: nearbyContent, outputs });
        }
        this.context.surroundingCells = surroundingCells;

        // Cursor-aware TODO: when a cell has multiple TODOs we want the
        // one closest above the cursor, not the first one in the file.
        // pickInCellTodo falls back to "first TODO" when cursor is unknown.
        const inCell = pickInCellTodo(
          this.context.activeCellContent,
          this.context.activeCellCursorLine,
        );
        this.context.isTodoCell = !!inCell;
        this.context.todoText = inCell ? inCell.todoText : '';

        // Strongly-labeled section excerpt — single biggest lever for keeping
        // the LLM anchored to the right TODO when a cell holds several.
        this.context.currentSection = pickCurrentSection(
          this.context.activeCellContent,
          this.context.activeCellCursorLine,
        );

        // The Python def/class the cursor sits inside, with full body.
        // Strongest semantic anchor for "what method are they working on";
        // protects against truncation of the active cell content losing
        // the def line above the cursor.
        this.context.enclosingMethod = pickEnclosingMethod(
          this.context.activeCellContent,
          this.context.activeCellCursorLine,
        );

        // Look for an attachable plot (PNG image output) in active or ±1
        // neighbour cells. Active cell wins if it has one; otherwise prefer
        // the closer neighbour. Used by the webview to surface a "📊 attach
        // plot" button so the student can deliberately show Zee a chart.
        this.context.attachablePlot = findAttachablePlot(editor, cellIndex);

        // Recently-engaged code cells the student was editing (so Zee can
        // resolve "here" / "this" when the active cell is a different one).
        const recent = pickRecentlyEngagedCells(
          editor, this.focusSequence, cellIndex, Date.now(),
        );
        this.context.recentlyEngagedCells = recent.length > 0 ? recent : undefined;

        // Scope-TODO: most recent TODO at-or-before the active cell. Lets
        // the awareness pill reflect what the student is implementing even
        // when the active cell isn't the TODO cell itself.
        this.context.scopeTodo = pickScopeTodo(editor, cellIndex);
      }

      this.emitContextUpdate();
    }
  }

  /**
   * Reset per-cell signal state and (re)arm the idle/reading timers for the
   * new active cell.
   *
   * Markdown re-arm: we clear the *previous* cell from `readingFiredForCell`
   * so that returning to a markdown cell after browsing elsewhere offers
   * the "dig deeper" cloud again. The student perceives this as the cloud
   * always being available on markdown — not as a one-shot per session.
   * The idle-on-TODO signal stays one-shot per visit because it's longer
   * and more invasive (60s wait, voice-mode greeting).
   */
  private onCellFocusChanged(cellIndex: number, previousCellIndex: number): void {
    this.clearPerCellTimers();

    // Re-arm the markdown cloud for the cell we just left, so when the
    // student comes back the bubble fires again.
    if (previousCellIndex >= 0 && previousCellIndex !== cellIndex) {
      this.readingFiredForCell.delete(previousCellIndex);
    }

    if (this.pendingInitiative) { return; }

    // Idle-on-TODO: arm only after we know this is a TODO cell (set below
    // in updateFromActiveEditor). We re-check inside the timer callback.
    if (this.context.activeCellType === 'code' && !this.idleFiredForCell.has(cellIndex)) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.paused) { return; }
        if (this.pendingInitiative) { return; }
        if (this.context.activeCellIndex !== cellIndex) { return; }
        if (!this.context.isTodoCell) { return; }
        if (this.editingDuringFocus) { return; } // student is actively coding
        this.idleFiredForCell.add(cellIndex);
        this.pendingInitiative = true;
        this.events.onRequestToSpeak('idle');
      }, IDLE_ON_TODO_MS);
    }

    if (this.context.activeCellType === 'markdown' &&
        !this.readingFiredForCell.has(cellIndex) &&
        !this.learnMoreCells.has(cellIndex)) {
      this.readingTimer = setTimeout(() => {
        this.readingTimer = null;
        if (this.paused) { return; }
        if (this.pendingInitiative) { return; }
        if (this.context.activeCellIndex !== cellIndex) { return; }
        if (this.context.activeCellType !== 'markdown') { return; }
        if (this.learnMoreCells.has(cellIndex)) { return; }
        this.readingFiredForCell.add(cellIndex);
        this.pendingInitiative = true;
        this.events.onRequestToSpeak('reading');
      }, READING_ON_MARKDOWN_MS);
    }
  }

  private onActivity(): void {
    this.context.lastInteractionAt = Date.now();
    // Any keystroke on a code cell disarms the idle-on-TODO timer for that visit
    if (this.context.activeCellType === 'code' && this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.rearmSoftIdle();
  }

  /**
   * Forward webview-side activity (chat typing, mic speech) into the tracker
   * so it counts toward the same soft-idle clock as editor events.
   */
  notifyExternalActivity(): void {
    if (this.paused) { return; }
    this.onActivity();
  }

  /**
   * Re-arm the two soft-idle timers. Called on any activity tick. If the user
   * was previously in a soft-idle state, flip back to 'active' and notify.
   */
  private rearmSoftIdle(): void {
    if (this.softIdlePresenceTimer) { clearTimeout(this.softIdlePresenceTimer); }
    if (this.softIdleNudgeTimer) { clearTimeout(this.softIdleNudgeTimer); }
    this.softIdlePresenceTimer = null;
    this.softIdleNudgeTimer = null;

    if (this.flowState !== 'active') {
      this.flowState = 'active';
      this.softIdleNudgeFiredThisPeriod = false;
      this.events.onFlowStateChange('active');
    }

    this.softIdlePresenceTimer = setTimeout(() => {
      this.softIdlePresenceTimer = null;
      if (this.paused) { return; }
      this.flowState = 'soft-idle-presence';
      this.events.onFlowStateChange('soft-idle-presence');
    }, SOFT_IDLE_PRESENCE_MS);

    this.softIdleNudgeTimer = setTimeout(() => {
      this.softIdleNudgeTimer = null;
      if (this.paused) { return; }
      if (this.softIdleNudgeFiredThisPeriod) { return; }
      this.softIdleNudgeFiredThisPeriod = true;
      this.flowState = 'soft-idle-nudge';
      this.events.onFlowStateChange('soft-idle-nudge');
    }, SOFT_IDLE_NUDGE_MS);
  }

  private clearSoftIdleTimers(): void {
    if (this.softIdlePresenceTimer) { clearTimeout(this.softIdlePresenceTimer); this.softIdlePresenceTimer = null; }
    if (this.softIdleNudgeTimer) { clearTimeout(this.softIdleNudgeTimer); this.softIdleNudgeTimer = null; }
  }

  private clearPerCellTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.readingTimer) { clearTimeout(this.readingTimer); this.readingTimer = null; }
  }

  /**
   * Snapshot the cursor position + ±N lines around it for a given text
   * editor. Keyed by document URI so cursor info survives focus shifts
   * away from the editor (e.g. clicking Zee's webview steals focus, and
   * the live `vscode.window.activeTextEditor.selection` would otherwise
   * be the wrong thing or undefined).
   */
  private captureCursorSnapshot(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const cursorLine = editor.selection.active.line;       // 0-based
    const before = Math.max(0, cursorLine - 3);
    const after = Math.min(doc.lineCount - 1, cursorLine + 3);
    const lines: string[] = [];
    for (let i = before; i <= after; i++) {
      const marker = i === cursorLine ? '>' : ' ';
      lines.push(`${marker} ${i + 1}: ${doc.lineAt(i).text}`);
    }
    this.cursorByCell.set(doc.uri.toString(), {
      line: cursorLine + 1,                                // 1-based for humans
      contextWithLineNumbers: lines.join('\n'),
      capturedAt: Date.now(),
    });
  }

  private handleNotebookChange(e: vscode.NotebookDocumentChangeEvent): void {
    if (this.paused) { return; }
    // Check cell output changes for execution results
    for (const cellChange of e.cellChanges) {
      if (cellChange.outputs) {
        this.context.lastInteractionAt = Date.now();
        this.context.cellRunCount++;
        this.rearmSoftIdle();

        let hasError = false;
        for (const output of cellChange.cell.outputs) {
          for (const item of output.items) {
            if (item.mime === 'application/vnd.code.notebook.error') {
              const errorText = new TextDecoder().decode(item.data);
              this.context.lastError = errorText.slice(0, 500);
              this.context.consecutiveErrors++;
              hasError = true;
              break;
            }
          }
          if (!hasError && output.items.length > 0) {
            // Check for traceback/error in plain text output
            const textItem = output.items.find((i: vscode.NotebookCellOutputItem) => i.mime === 'text/plain');
            if (textItem) {
              const text = new TextDecoder().decode(textItem.data);
              if (text.includes('Traceback') || text.includes('Error:')) {
                this.context.lastError = text.slice(0, 500);
                this.context.consecutiveErrors++;
                hasError = true;
              }
            }
          }
          if (hasError) { break; }
        }

        if (!hasError) {
          // Capture struggle BEFORE we reset the counter — we use it below
          // to decide whether this success deserves a celebration nudge.
          const wasStruggling = this.context.consecutiveErrors > 0;
          this.context.consecutiveErrors = 0;
          this.context.lastError = null;
          this.stuckFiredForErrorStreak = false;
          this.resetCooldown();
          if (wasStruggling) {
            this.maybeFireSuccessSignal();
          }
        } else {
          this.maybeFireStuckSignal();
        }

        this.emitContextUpdate();
      }
    }
  }

  /**
   * Fires the `stuck` signal exactly once per error streak, the moment the
   * streak crosses STUCK_ERROR_THRESHOLD. A successful run resets the streak.
   */
  private maybeFireStuckSignal(): void {
    if (this.pendingInitiative) { return; }
    if (this.stuckFiredForErrorStreak) { return; }
    if (!this.context.isTodoCell) { return; }
    if (this.context.consecutiveErrors < STUCK_ERROR_THRESHOLD) { return; }

    this.stuckFiredForErrorStreak = true;
    this.pendingInitiative = true;
    this.events.onRequestToSpeak('stuck');
  }

  /**
   * Fires the `success` signal exactly once per TODO cell visit, the moment
   * the student gets a clean run after struggling. Lets Zee celebrate the
   * recovery and nudge toward the next TODO. Capped per-cell so re-running
   * the same successful cell doesn't repeatedly celebrate.
   */
  private maybeFireSuccessSignal(): void {
    if (this.pendingInitiative) { return; }
    if (!this.context.isTodoCell) { return; }
    if (this.successFiredForCell.has(this.context.activeCellIndex)) { return; }

    this.successFiredForCell.add(this.context.activeCellIndex);
    this.pendingInitiative = true;
    this.events.onRequestToSpeak('success');
  }

  getCellPreview(): string {
    return this.context.activeCellContent.slice(0, TRANSCRIPT_CELL_PREVIEW_LEN);
  }

  getChapterContext(): string {
    return CHAPTER_CONTEXT[this.context.chapterNumber] ?? '';
  }

  dispose(): void {
    this.clearPerCellTimers();
    this.clearSoftIdleTimers();
    if (this.contextUpdateTimer) {
      clearTimeout(this.contextUpdateTimer);
      this.contextUpdateTimer = null;
    }
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
