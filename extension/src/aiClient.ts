import {
  LLMProvider, Message, UserConfig, InteractionMode, SystemPrompt, TokenUsage,
  ImageAttachment,
  SYSTEM_PROMPT_PERSONA, SYSTEM_PROMPT_META_MODE, VOICE_MODE_INSTRUCTION,
  CHAPTER_CONTEXT, getLLMProvider,
} from './providers';
import { NotebookContext } from './contextTracker';
import { LearnerProfile, EMPTY_LEARNER_PROFILE, formatLearnerSection } from './learnerProfile';
import { SENTENCE_BOUNDARY_RE, ACTIVE_CELL_CHAR_CAP } from './constants';

// ── Markdown stripping for TTS ─────────────────────────────────────────────

/**
 * Strip markdown formatting so TTS reads clean prose.
 * Handles: bold, italic, inline code, code fences, headers, links, images, strikethrough.
 */
/**
 * Truncate cell text to ~`cap` chars, centred on the cursor line. When
 * the cursor is unknown or the text fits in `cap`, returns the original
 * (or a tail-only truncation for back-compat). Critical for long cells
 * with multiple methods: tail-only truncation would silently drop the
 * `def` line above the cursor and the model would answer about whichever
 * method survives the truncation.
 */
export function centerTruncate(text: string, cursorLine1Based: number, cap: number): string {
  if (text.length <= cap) { return text; }
  const lines = text.split('\n');
  // Cursor unknown / out of range — fall back to tail-only (legacy).
  if (cursorLine1Based < 1 || cursorLine1Based > lines.length) {
    return `… (truncated; showing last ${cap} chars)\n${text.slice(-cap)}`;
  }
  // Char offset of the cursor line's START.
  let offset = 0;
  for (let i = 0; i < cursorLine1Based - 1; i++) {
    offset += lines[i].length + 1;   // +1 for the \n
  }
  const half = Math.floor(cap / 2);
  let start = Math.max(0, offset - half);
  let end = Math.min(text.length, start + cap);
  // If we hit the right edge but didn't fill `cap`, slide left.
  if (end - start < cap) { start = Math.max(0, end - cap); }

  const head = start > 0 ? `… (truncated head, ${start} chars cut)\n` : '';
  const tail = end < text.length ? `\n… (truncated tail, ${text.length - end} chars cut)` : '';
  return head + text.slice(start, end) + tail;
}

/**
 * Insert a visually obvious cursor marker into a cell's text just BEFORE
 * the cursor's 1-based line. The marker is a long sentinel that is hard
 * to confuse with normal code so the LLM can latch onto it as the
 * student's spatial anchor. Returns the original text when `cursorLine`
 * is out of range — caller should only call this when cursor is known.
 */
export function insertCursorMarker(text: string, cursorLine1Based: number): string {
  const lines = text.split('\n');
  if (cursorLine1Based < 1 || cursorLine1Based > lines.length + 1) { return text; }
  const marker = `# >>> CURSOR HERE (line ${cursorLine1Based}) <<<`;
  // Insert BEFORE the cursor line so the marker shows what the student is
  // about to look at / type on.
  lines.splice(cursorLine1Based - 1, 0, marker);
  return lines.join('\n');
}

export function stripMarkdown(text: string): string {
  return text
    // Replace code fences with a spoken placeholder
    .replace(/```[\s\S]*?```/g, ' (written code) ')
    // Replace LaTeX blocks with a spoken placeholder
    .replace(/\$\$[\s\S]*?\$\$/g, ' (written formula) ')
    // Replace inline LaTeX
    .replace(/\$[^$]+\$/g, '(formula)')
    // Remove inline code (`...`) — keep the content for short identifiers
    .replace(/`([^`]*)`/g, '$1')
    // Remove images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Convert links [text](url) to just text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Remove bold/italic (*** or **_ combos, then ** or __, then * or _)
    .replace(/\*{3}(.*?)\*{3}/g, '$1')
    .replace(/\*{2}(.*?)\*{2}/g, '$1')
    .replace(/_{2}(.*?)_{2}/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    // Remove strikethrough ~~text~~
    .replace(/~~(.*?)~~/g, '$1')
    // Remove headers (# ... at start of line)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParsedAIResponse {
  text: string;
  richText?: string;
}

export interface AIClientEvents {
  onChunk: (text: string, richText?: string, done?: boolean) => void;
  onDone: (parsed: ParsedAIResponse) => void;
  onError: (error: Error) => void;
  onSentenceBoundary: (sentence: string) => void;
  /** Optional: fired when the provider reports token usage for the turn. */
  onUsage?: (usage: TokenUsage) => void;
}

/**
 * Parse a voice-mode LLM response. The prompt asks for raw JSON, but LLMs
 * commonly wrap it in ```json fences or prepend a sentence — we extract
 * the JSON object defensively and fall back to plain text on mismatch.
 */
export function parseVoiceResponse(raw: string): ParsedAIResponse {
  const trimmed = raw.trim();
  if (!trimmed) { return { text: '' }; }

  // 1. Try straight parse first — covers the happy path.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
      return { text: parsed.text, richText: typeof parsed.richText === 'string' ? parsed.richText : undefined };
    }
  } catch { /* fall through */ }

  // 2. Strip markdown code fences (```json ... ``` or ``` ... ```) and retry.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        return { text: parsed.text, richText: typeof parsed.richText === 'string' ? parsed.richText : undefined };
      }
    } catch { /* fall through */ }
  }

  // 3. Find the first "{" and the matching last "}" and parse the slice.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        return { text: parsed.text, richText: typeof parsed.richText === 'string' ? parsed.richText : undefined };
      }
    } catch { /* fall through */ }
  }

  // 4. LLM ignored the JSON contract entirely — treat as plain text. Better
  // than reading raw JSON aloud or echoing ```json fences to the transcript.
  return { text: trimmed };
}

// ── AIClient ────────────────────────────────────────────────────────────────

export class AIClient {
  private provider: LLMProvider;
  private config: UserConfig;
  private events: AIClientEvents;
  private contextWindowHistory: Message[] = [];
  private streaming = false;
  private learnerProfile: LearnerProfile = { ...EMPTY_LEARNER_PROFILE };

  constructor(config: UserConfig, events: AIClientEvents) {
    this.config = config;
    this.events = events;
    this.provider = getLLMProvider(config);
  }

  updateConfig(config: UserConfig): void {
    this.config = config;
    this.provider = getLLMProvider(config);
  }

  setLearnerProfile(profile: LearnerProfile): void {
    this.learnerProfile = profile;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * Set the context window from loaded transcript entries.
   */
  setContextWindow(history: Message[]): void {
    this.contextWindowHistory = [...history];
  }

  /**
   * Clear the context window (start fresh).
   */
  clearContextWindow(): void {
    this.contextWindowHistory = [];
  }

  /**
   * Pop the trailing user message from the context window. Used on LLM errors
   * (e.g. Gemini 503) so the retry doesn't start with an orphan user turn
   * that never got an assistant reply — which would poison subsequent turns.
   * Safe to call when the last entry isn't a user message (no-op).
   */
  rollbackLastUserTurn(): void {
    const last = this.contextWindowHistory[this.contextWindowHistory.length - 1];
    if (last?.role === 'user') {
      this.contextWindowHistory.pop();
    }
  }

  /**
   * Pop the trailing user+assistant PAIR — i.e. an entire turn. Used for the
   * user-initiated "undo last turn" button (e.g. when background noise
   * derailed the conversation and they want to rewind). Returns true if a
   * pair was actually removed, false if history was empty or malformed.
   * Repeatable: caller can invoke it multiple times to peel back further.
   */
  rollbackLastTurn(): boolean {
    const h = this.contextWindowHistory;
    if (h.length < 2) { return false; }
    const last = h[h.length - 1];
    const prev = h[h.length - 2];
    if (last.role === 'assistant' && prev.role === 'user') {
      h.pop();
      h.pop();
      return true;
    }
    return false;
  }

  /**
   * Send a user message to the LLM with full context. `attachments` carries
   * any images the student deliberately attached (typically a notebook plot)
   * — providers that support multimodal input inline them, others ignore.
   */
  async sendMessage(
    userMessage: string,
    notebookContext: NotebookContext,
    interactionMode: InteractionMode,
    attachments?: ImageAttachment[],
  ): Promise<void> {
    if (this.streaming) {
      this.cancel();
    }

    const system = this.buildSystemPrompt(notebookContext, interactionMode);
    const history = [...this.contextWindowHistory];

    // Add user message to context window
    this.contextWindowHistory.push({ role: 'user', content: userMessage });

    this.streaming = true;
    let fullResponse = '';
    let sentenceBuffer = '';

    await this.provider.sendMessage(
      system,
      history,
      userMessage,
      (chunk: string) => {
        fullResponse += chunk;

        if (interactionMode === 'voice') {
          // In voice mode, the LLM returns JSON — buffer the whole response.
          // Don't stream partial JSON to the UI or TTS.
          return;
        }

        sentenceBuffer += chunk;

        // Detect sentence boundaries for TTS
        const match = sentenceBuffer.match(SENTENCE_BOUNDARY_RE);
        if (match && match.index !== undefined) {
          const boundary = match.index + match[0].length;
          const sentence = sentenceBuffer.slice(0, boundary).trim();
          sentenceBuffer = sentenceBuffer.slice(boundary);
          if (sentence) {
            this.events.onSentenceBoundary(stripMarkdown(sentence));
          }
        }

        // Forward chunk to webview
        this.events.onChunk(chunk, undefined, false);
      },
      () => {
        this.streaming = false;

        // Parse response based on mode
        const parsed = this.parseResponse(fullResponse, interactionMode);

        if (interactionMode === 'voice') {
          // Voice mode: emit sentences from the parsed (clean) text for TTS
          for (const sentence of this.splitIntoSentences(parsed.text)) {
            this.events.onSentenceBoundary(stripMarkdown(sentence));
          }
        } else {
          // Chat mode: flush remaining sentence buffer
          const remainder = stripMarkdown(sentenceBuffer.trim());
          if (remainder) {
            this.events.onSentenceBoundary(remainder);
          }
        }

        // Add assistant response to context window
        this.contextWindowHistory.push({ role: 'assistant', content: parsed.text });

        this.events.onDone(parsed);
      },
      (error: Error) => {
        this.streaming = false;
        // Drop the user turn we just pushed so a retry starts clean. Without
        // this the history has a trailing user message with no assistant
        // reply, which confuses subsequent turns.
        this.rollbackLastUserTurn();
        this.events.onError(error);
      },
      (usage: TokenUsage) => { this.events.onUsage?.(usage); },
      attachments,
    );
  }

  /**
   * Generate an initiative message (companion-initiated).
   */
  async generateInitiative(
    prompt: string,
    notebookContext: NotebookContext,
    interactionMode: InteractionMode,
  ): Promise<void> {
    // Initiative messages use the same flow as user messages,
    // but the "user message" is an internal prompt not shown to the student.
    await this.sendMessage(prompt, notebookContext, interactionMode);
  }

  cancel(): void {
    this.provider.cancel();
    this.streaming = false;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private splitIntoSentences(text: string): string[] {
    // Split on sentence-ending punctuation, then coalesce short fragments
    // into the following sentence. Kokoro pads each inference with trailing
    // silence, so emitting "Hello!" as its own chunk produces an audible gap
    // before the real reply. Threshold is short enough to catch greetings
    // and interjections without merging normal sentences.
    const parts = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    const merged: string[] = [];
    let pending = '';
    for (const p of parts) {
      const cur = pending ? pending + ' ' + p : p;
      if (cur.length < 15) {
        pending = cur;
      } else {
        merged.push(cur);
        pending = '';
      }
    }
    if (pending) { merged.push(pending); }
    return merged;
  }

  /**
   * Build the system prompt as a (staticPrefix, dynamic) pair.
   * - staticPrefix is byte-identical across a session for a given notebook +
   *   interaction mode → enables prompt caching.
   * - dynamic holds everything that changes between turns (active cell,
   *   error, surrounding cells, solution hint, focus summary).
   */
  private buildSystemPrompt(ctx: NotebookContext, mode: InteractionMode): SystemPrompt {
    const prefixParts: string[] = [SYSTEM_PROMPT_PERSONA];

    const learnerSection = formatLearnerSection(this.learnerProfile);
    if (learnerSection) {
      prefixParts.push(learnerSection);
    }

    if (ctx.notebookFile) {
      const chapterContext = CHAPTER_CONTEXT[ctx.chapterNumber] ?? '';
      prefixParts.push(
        `The student is currently working on: Chapter ${ctx.chapterNumber} — ${ctx.chapterTitle}.
Chapter context: ${chapterContext}`
      );

      if (ctx.notebookSummary) {
        prefixParts.push(`Notebook overview: ${ctx.notebookSummary}`);
      }
    } else {
      prefixParts.push(SYSTEM_PROMPT_META_MODE);
    }

    if (mode === 'voice') {
      prefixParts.push(VOICE_MODE_INSTRUCTION.trim());
    }

    const staticPrefix = prefixParts.join('\n\n');

    // Dynamic block — only if a notebook is open
    if (!ctx.notebookFile) {
      return { staticPrefix, dynamic: '' };
    }

    const dynamicParts: string[] = [];
    // Cap the active cell. Long cells (100+ lines with multiple methods)
    // can push 2-3k tokens per turn; we cap at ACTIVE_CELL_CHAR_CAP and
    // CENTER the truncation around the cursor — tail-only truncation
    // could silently drop the `def` line above the cursor and the LLM
    // would answer about whichever method survives the cut. The cursor
    // marker is inserted FIRST so it stays visible after truncation
    // (which slides it slightly down by one line in the offsets, but
    // since we center on the cursor's NEW line it's still in-window).
    const cursor = ctx.activeCellCursorLine;
    const withMarker = cursor > 0
      ? insertCursorMarker(ctx.activeCellContent, cursor)
      : ctx.activeCellContent;
    // Marker insertion adds a line above the cursor, so the cursor's line
    // number in `withMarker` is one greater than in the raw content.
    const cursorInMarked = cursor > 0 ? cursor + 1 : cursor;
    const cellContent = centerTruncate(withMarker, cursorInMarked, ACTIVE_CELL_CHAR_CAP);
    // Scope TODO line: when the active cell isn't itself a TODO, but a
    // recent TODO sits above the cursor, surface that as the broader
    // implementation scope. Helps Zee anchor "what are they really
    // working on" even when the active cell is a theory paragraph or
    // helper code right under the TODO.
    let todoLine: string;
    if (ctx.todoText) {
      todoLine = `TODO they are implementing: ${ctx.todoText}`;
    } else if (ctx.scopeTodo) {
      todoLine = `Active cell isn't a TODO, but the nearest TODO above is at cell ${ctx.scopeTodo.cellIndex + 1}: ${ctx.scopeTodo.todoText}`;
    } else {
      todoLine = `TODO they are implementing: none`;
    }
    // Cursor line — only mention when known. Helps Zee resolve "here" /
    // "this" within long multi-method cells: the line number tells her
    // which method or block the student is actually inside.
    const cursorLine = ctx.activeCellCursorLine > 0
      ? `\nCursor is at line ${ctx.activeCellCursorLine} of the active cell.`
      : '';
    // Cell numbers are 1-based throughout the prompt — must match what the
    // student sees in the awareness pill. If we sent 0-based here, Zee would
    // say "Cell 4" while the student is looking at "Cell 5", and references
    // back to past turns would be off by one.
    dynamicParts.push(
      `Active cell (Cell ${ctx.activeCellIndex + 1}, type: ${ctx.activeCellType}):
${cellContent}${cursorLine}

${todoLine}
Most recent execution error: ${ctx.lastError || 'none'}
Consecutive errors on this cell: ${ctx.consecutiveErrors}`
    );

    // Strongly-labeled "current section" excerpt: the slice between the
    // cursor's TODO and the next TODO. This is the single biggest steering
    // lever for keeping Zee anchored to where the student actually is when
    // the active cell holds multiple TODOs / methods. Persona is told to
    // treat this as authoritative for deictic resolution.
    // Enclosing method: the strongest semantic anchor for "what is this
    // method?" / "what should I do here?" type questions. The full body
    // means the LLM can't drift to a sibling method just because the
    // active-cell window happened to truncate the right `def` line.
    // Enclosing method: the strongest semantic anchor for "what is this
    // method?" / "what should I do here?" type questions. The full body
    // means the LLM can't drift to a sibling method just because the
    // active-cell window happened to truncate the right `def` line.
    const enc = ctx.enclosingMethod;
    if (enc) {
      dynamicParts.push(
        `ENCLOSING METHOD — the Python def/class the cursor is INSIDE (lines ${enc.startLine}–${enc.endLine}). When the student says "this method" / "this function" / "this class" / "what is this about", they mean THIS one. Do NOT answer about a sibling method:
${enc.text}`
      );
    }

    // Current section block — only ship when the enclosing method ISN'T
    // already shipping the same lines. When the section sits fully inside
    // the enclosing method (the common case for cursor-inside-a-method),
    // the method body covers it and the section is pure duplication.
    if (
      ctx.currentSection &&
      !(enc && ctx.currentSection.startLine >= enc.startLine && ctx.currentSection.endLine <= enc.endLine)
    ) {
      const s = ctx.currentSection;
      dynamicParts.push(
        `THE SECTION THE STUDENT IS CURRENTLY IN (lines ${s.startLine}–${s.endLine}, between TODO "${s.todoText}" and the next TODO or end of cell). When the student uses deictic words like "here" / "this" / "that", they almost certainly mean THIS section — answer about it, not other parts of the cell:
${s.text}`
      );
    }

    // Cursor surroundings: tight excerpt of ±3 lines around the cursor,
    // line-numbered with a `>` marker on the cursor line. Captured from a
    // snapshot taken WHILE THE STUDENT WAS EDITING. Skipped when the
    // enclosing method is present — its body already includes these lines
    // and the cell content already carries the `# >>> CURSOR HERE` marker
    // for the spatial pointer, so surroundings would be pure duplication.
    if (ctx.activeCellCursorContext && !enc) {
      dynamicParts.push(
        `Cursor surroundings — captured snapshot, \`>\` marks the cursor line:
${ctx.activeCellCursorContext}`
      );
    }

    if (ctx.surroundingCells && ctx.surroundingCells.length > 0) {
      const surrounding: string[] = ['Surrounding cells for additional context:'];
      for (const cell of ctx.surroundingCells) {
        const position = cell.index < ctx.activeCellIndex ? 'before' : 'after';
        let block = `\n--- Cell ${cell.index + 1} (${cell.type}, ${position} active cell) ---\n${cell.content}`;
        if (cell.outputs) {
          block += `\nCell output:\n${cell.outputs}`;
        }
        surrounding.push(block);
      }
      dynamicParts.push(surrounding.join(''));
    }

    // Recently-engaged code cells: cells the student was actively editing
    // before navigating to the current active cell. Critical for resolving
    // "here" / "this" / "that line" when they ask a question while reading
    // theory next to a TODO they were just typing in.
    if (ctx.recentlyEngagedCells && ctx.recentlyEngagedCells.length > 0) {
      const blocks: string[] = ['Cells the student was recently editing (most recent first — useful for resolving "here"/"this"):'];
      for (const c of ctx.recentlyEngagedCells) {
        const todoTag = c.isTodoCell && c.todoText ? ` (TODO: ${c.todoText})` : '';
        blocks.push(`\n--- Cell ${c.cellIndex + 1}${todoTag}, last edited ~${c.secondsAgo}s ago ---\n${c.content}`);
      }
      dynamicParts.push(blocks.join(''));
    }

    // Reference solution gating lives in extension.decorateContext (it
    // attaches solutionHint whenever a solution exists for the active
    // TODO). Here we just include whatever decorateContext attached.
    if (ctx.solutionHint) {
      dynamicParts.push(
        `Reference solution for the current TODO. Default to Socratic hints, BUT if the student explicitly asks to see the solution / a specific line / how it's done, provide it from this reference — do not refuse or say "I can't give you the full solution"; that's wrong, the reference is in context for exactly this purpose:
${ctx.solutionHint}`
      );
    }

    if (ctx.focusSummary) {
      dynamicParts.push(
        `Student's recent focus sequence: ${ctx.focusSummary}
Use this to understand what the student has been doing — e.g., reading then coding then re-reading may indicate they're trying to connect theory to practice.`
      );
    }

    // Per-turn re-anchor banner (placed LAST so it sits closest to the
    // student's user message in the final prompt — that's where the model
    // pays the most attention). Critical for follow-up questions like
    // "does this look ok?" where past assistant turns were about a
    // DIFFERENT TODO and the model otherwise drifts back to that thread.
    const anchorTodo = ctx.todoText
      || ctx.scopeTodo?.todoText
      || ctx.currentSection?.todoText;
    if (anchorTodo) {
      dynamicParts.push(
        `BEFORE ANSWERING THIS TURN, RE-READ THE SECTION BLOCK ABOVE. The student's current focus is the TODO "${anchorTodo}". Their question concerns THAT section. Past assistant turns about other TODOs or methods do NOT apply unless the student explicitly references them.`
      );
    }

    return { staticPrefix, dynamic: dynamicParts.join('\n\n') };
  }

  private parseResponse(raw: string, mode: InteractionMode): ParsedAIResponse {
    if (mode === 'voice') {
      return parseVoiceResponse(raw);
    }
    return { text: raw };
  }
}
