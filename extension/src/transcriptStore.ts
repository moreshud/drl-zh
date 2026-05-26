import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  COMPANION_DIR, TRANSCRIPT_ROLLING_MAX, TRANSCRIPT_ROLLING_KEEP,
  TRANSCRIPT_FLUSH_INTERVAL_MS, TRANSCRIPT_CELL_PREVIEW_LEN,
  CONTEXT_TOKEN_BUDGET,
} from './constants';
import { Message } from './providers';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TranscriptEntryContext {
  cellIndex: number;
  cellPreview: string;
  isTodoCell: boolean;
  todoText: string;
}

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  role: 'user' | 'companion';
  inputMode: 'chat' | 'voice' | 'initiative';
  text: string;
  richText?: string;
  context: TranscriptEntryContext;
}

export interface TranscriptFile {
  notebookFile: string;
  chapterNumber: number;
  chapterTitle: string;
  createdAt: string;
  updatedAt: string;
  entries: TranscriptEntry[];
}

// ── TranscriptStore ─────────────────────────────────────────────────────────

export class TranscriptStore implements vscode.Disposable {
  private transcripts = new Map<string, TranscriptFile>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.flushTimer = setInterval(() => this.flushAll(), TRANSCRIPT_FLUSH_INTERVAL_MS);

    // Flush on notebook close
    if (vscode.workspace.onDidCloseNotebookDocument) {
      this.disposables.push(
        vscode.workspace.onDidCloseNotebookDocument(doc => {
          const filename = path.basename(doc.uri.fsPath);
          this.flushOne(filename);
        })
      );
    }
  }

  /**
   * Load or create transcript for a notebook.
   */
  load(notebookUri: vscode.Uri, chapterNumber: number, chapterTitle: string): TranscriptFile {
    const filename = path.basename(notebookUri.fsPath);

    if (this.transcripts.has(filename)) {
      return this.transcripts.get(filename)!;
    }

    const companionDir = this.getCompanionDir(notebookUri);
    this.ensureCompanionDir(companionDir, notebookUri);
    const filePath = path.join(companionDir, `transcript_${filename.replace('.ipynb', '')}.json`);

    let transcript: TranscriptFile;
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        transcript = JSON.parse(raw);
      } catch {
        transcript = this.createEmptyTranscript(filename, chapterNumber, chapterTitle);
      }
    } else {
      transcript = this.createEmptyTranscript(filename, chapterNumber, chapterTitle);
    }

    this.transcripts.set(filename, transcript);
    return transcript;
  }

  /**
   * Append an entry to the transcript for a notebook.
   */
  addEntry(
    notebookFile: string,
    role: 'user' | 'companion',
    inputMode: 'chat' | 'voice' | 'initiative',
    text: string,
    richText: string | undefined,
    cellIndex: number,
    cellPreview: string,
    isTodoCell: boolean,
    todoText: string,
  ): TranscriptEntry {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) {
      throw new Error(`No transcript loaded for ${notebookFile}`);
    }

    const entry: TranscriptEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      role,
      inputMode,
      text,
      richText,
      context: {
        cellIndex,
        cellPreview: cellPreview.slice(0, TRANSCRIPT_CELL_PREVIEW_LEN),
        isTodoCell,
        todoText,
      },
    };

    transcript.entries.push(entry);
    transcript.updatedAt = entry.timestamp;
    this.dirty.add(notebookFile);

    // Auto-archive if too many entries
    if (transcript.entries.length > TRANSCRIPT_ROLLING_MAX) {
      this.autoArchive(notebookFile);
    }

    return entry;
  }

  /**
   * Get recent entries as Message[] for the LLM context window, walking
   * newest→oldest until the token budget is reached. Character count / 4 is
   * used as a rough token estimate — good enough for clamping; the alternative
   * is a full tokenizer dependency per provider.
   */
  getContextWindow(notebookFile: string): Message[] {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return []; }

    const picked: Message[] = [];
    let tokenCount = 0;
    for (let i = transcript.entries.length - 1; i >= 0; i--) {
      const e = transcript.entries[i];
      const entryTokens = Math.ceil(e.text.length / 4);
      if (tokenCount + entryTokens > CONTEXT_TOKEN_BUDGET && picked.length > 0) {
        break;
      }
      tokenCount += entryTokens;
      picked.push({
        role: e.role === 'user' ? 'user' as const : 'assistant' as const,
        content: e.text,
      });
    }
    return picked.reverse();
  }

  /**
   * Get all entries for display in the webview.
   */
  getEntries(notebookFile: string): TranscriptEntry[] {
    return this.transcripts.get(notebookFile)?.entries ?? [];
  }

  /**
   * Check if a transcript exists and has entries.
   */
  hasEntries(notebookFile: string): boolean {
    const transcript = this.transcripts.get(notebookFile);
    return !!transcript && transcript.entries.length > 0;
  }

  /**
   * Get the last entry's timestamp (for session dividers).
   */
  getLastEntryTimestamp(notebookFile: string): string | null {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript || transcript.entries.length === 0) { return null; }
    return transcript.entries[transcript.entries.length - 1].timestamp;
  }

  /**
   * Clear the active context window (LLM forgets, but transcript stays).
   */
  clearContextWindow(notebookFile: string): void {
    // This is handled by the aiClient — it resets its own window.
    // The transcript file is unchanged.
  }

  /**
   * Clear the full transcript (archive first).
   */
  clearTranscript(notebookFile: string, notebookUri: vscode.Uri): void {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return; }

    // Delete current transcript file
    const companionDir = this.getCompanionDir(notebookUri);
    const baseName = notebookFile.replace('.ipynb', '');
    const currentPath = path.join(companionDir, `transcript_${baseName}.json`);

    if (fs.existsSync(currentPath)) {
      fs.unlinkSync(currentPath);
    }

    // Create fresh transcript
    const fresh = this.createEmptyTranscript(
      notebookFile,
      transcript.chapterNumber,
      transcript.chapterTitle
    );
    this.transcripts.set(notebookFile, fresh);
    this.dirty.add(notebookFile);
    this.flushOne(notebookFile);
  }

  /**
   * Remove the trailing user + companion turn pair from disk, for the
   * user-initiated "undo last turn" action. Returns true iff a pair was
   * actually peeled off. Repeatable: caller can invoke multiple times to
   * unwind further. Skips initiative-originated companion entries — those
   * weren't paired with a user message, so popping them would orphan the
   * preceding user turn.
   */
  removeLastPair(notebookFile: string): boolean {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return false; }
    const n = transcript.entries.length;
    if (n < 2) { return false; }
    const last = transcript.entries[n - 1];
    const prev = transcript.entries[n - 2];
    if (last.role !== 'companion' || last.inputMode === 'initiative') { return false; }
    if (prev.role !== 'user') { return false; }
    transcript.entries.splice(n - 2, 2);
    transcript.updatedAt = new Date().toISOString();
    this.dirty.add(notebookFile);
    this.flushOne(notebookFile);
    return true;
  }

  /**
   * Remove the trailing user entry from disk — used when the LLM call
   * errored before producing a reply, so the user turn we persisted in
   * handleUserMessage is now an orphan. Without this, reopening the
   * notebook would re-load the failed turn into both the chat UI AND the
   * LLM context window (it survives across restarts because the in-memory
   * rollback in aiClient only touches `contextWindowHistory`). Returns
   * true iff a user entry was actually removed.
   */
  removeLastUserEntry(notebookFile: string): boolean {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return false; }
    const n = transcript.entries.length;
    if (n < 1) { return false; }
    const last = transcript.entries[n - 1];
    if (last.role !== 'user') { return false; }
    transcript.entries.splice(n - 1, 1);
    transcript.updatedAt = new Date().toISOString();
    this.dirty.add(notebookFile);
    this.flushOne(notebookFile);
    return true;
  }

  /**
   * Clear transcript in memory only (no file ops). Used when notebook is already closed
   * and we don't have a notebookUri to resolve the companion dir.
   */
  clearInMemory(notebookFile: string): void {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return; }
    const fresh = this.createEmptyTranscript(
      notebookFile,
      transcript.chapterNumber,
      transcript.chapterTitle,
    );
    this.transcripts.set(notebookFile, fresh);
  }

  /**
   * Wipe every transcript everywhere — in-memory caches, the per-workspace
   * `.companion/transcript_*.json` files for every notebook we know about,
   * and any pending dirty marks. Used by the "Reset Zee" path. Best-effort
   * on disk: a transcript file we can't resolve a workspace folder for (e.g.
   * a notebook that was loaded once and is no longer open) gets dropped
   * from memory; the on-disk leftover would be wiped the next time the
   * notebook is opened (load → clearTranscript path), but the more
   * thorough cleanup happens here for every open notebook.
   */
  clearAllTranscripts(): void {
    // Build the set of companion dirs we should sweep — one per workspace
    // folder that hosts a known notebook. (Several notebooks in the same
    // folder share a `.companion` dir; using a Set avoids re-deleting.)
    const companionDirs = new Set<string>();
    for (const doc of vscode.workspace.notebookDocuments) {
      try {
        companionDirs.add(this.getCompanionDir(doc.uri));
      } catch (e) {
        // Notebook with no resolvable workspace folder; skip — we'll still
        // wipe its in-memory entry below.
      }
    }

    for (const dir of companionDirs) {
      if (!fs.existsSync(dir)) { continue; }
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith('transcript_') && name.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* swallow */ }
          }
        }
      } catch (e) {
        // Couldn't read the dir — leave it; a re-run will pick it up.
      }
    }

    this.transcripts.clear();
    this.dirty.clear();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private createEmptyTranscript(
    notebookFile: string,
    chapterNumber: number,
    chapterTitle: string
  ): TranscriptFile {
    const now = new Date().toISOString();
    return {
      notebookFile,
      chapterNumber,
      chapterTitle,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
  }

  private getCompanionDir(notebookUri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebookUri);
    if (!workspaceFolder) {
      return path.join(path.dirname(notebookUri.fsPath), COMPANION_DIR);
    }
    return path.join(workspaceFolder.uri.fsPath, COMPANION_DIR);
  }

  private ensureCompanionDir(companionDir: string, notebookUri: vscode.Uri): void {
    if (!fs.existsSync(companionDir)) {
      fs.mkdirSync(companionDir, { recursive: true });
    }

    // Ensure .companion/ is in .gitignore
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebookUri);
    const gitignorePath = workspaceFolder
      ? path.join(workspaceFolder.uri.fsPath, '.gitignore')
      : path.join(path.dirname(notebookUri.fsPath), '.gitignore');

    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.companion')) {
        fs.appendFileSync(gitignorePath, '\n# DRL-ZH Companion transcripts\n.companion/\n');
      }
    } else {
      fs.writeFileSync(gitignorePath, '# DRL-ZH Companion transcripts\n.companion/\n');
    }
  }

  private autoArchive(notebookFile: string): void {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return; }

    // Trim old entries — keep only the most recent ones (single file, no separate archive)
    transcript.entries.splice(0, transcript.entries.length - TRANSCRIPT_ROLLING_KEEP);
    this.dirty.add(notebookFile);
  }

  private flushAll(): void {
    for (const notebookFile of this.dirty) {
      this.flushOne(notebookFile);
    }
  }

  private flushOne(notebookFile: string): void {
    const transcript = this.transcripts.get(notebookFile);
    if (!transcript) { return; }

    // Find the companion dir
    for (const doc of vscode.workspace.notebookDocuments) {
      if (path.basename(doc.uri.fsPath) === notebookFile) {
        const companionDir = this.getCompanionDir(doc.uri);
        const baseName = notebookFile.replace('.ipynb', '');
        const filePath = path.join(companionDir, `transcript_${baseName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(transcript, null, 2));
        this.dirty.delete(notebookFile);
        return;
      }
    }

    // Fallback: try workspace folders
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        const companionDir = path.join(folder.uri.fsPath, COMPANION_DIR);
        if (fs.existsSync(companionDir)) {
          const baseName = notebookFile.replace('.ipynb', '');
          const filePath = path.join(companionDir, `transcript_${baseName}.json`);
          fs.writeFileSync(filePath, JSON.stringify(transcript, null, 2));
          this.dirty.delete(notebookFile);
          return;
        }
      }
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this.flushAll();
    this.disposables.forEach(d => d.dispose());
  }
}
