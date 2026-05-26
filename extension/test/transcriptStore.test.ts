import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptStore, TranscriptEntry, TranscriptFile } from '../src/transcriptStore';
import { CONTEXT_TOKEN_BUDGET, TRANSCRIPT_ROLLING_MAX, TRANSCRIPT_ROLLING_KEEP, TRANSCRIPT_CELL_PREVIEW_LEN } from '../src/constants';
import { Uri, workspace } from './__mocks__/vscode';

// Mock fs operations
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

describe('TranscriptStore', () => {
  let store: TranscriptStore;
  const notebookUri = new Uri('/workspace/03_DQN.ipynb') as any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (fs.existsSync as any).mockReturnValue(false);
    store = new TranscriptStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  describe('load', () => {
    it('creates empty transcript for new notebook', () => {
      const transcript = store.load(notebookUri, 3, 'Deep Q-Learning');
      expect(transcript.notebookFile).toBe('03_DQN.ipynb');
      expect(transcript.chapterNumber).toBe(3);
      expect(transcript.chapterTitle).toBe('Deep Q-Learning');
      expect(transcript.entries).toHaveLength(0);
    });

    it('creates .companion directory if it does not exist', () => {
      store.load(notebookUri, 3, 'DQN');
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.companion'),
        { recursive: true }
      );
    });

    it('creates .gitignore entry for .companion/ if missing', () => {
      // .gitignore does not exist
      (fs.existsSync as any).mockReturnValue(false);
      store.load(notebookUri, 3, 'DQN');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        expect.stringContaining('.companion/')
      );
    });

    it('appends to .gitignore if .companion not in it', () => {
      (fs.existsSync as any).mockImplementation((p: string) => {
        if (p.endsWith('.gitignore')) return true;
        return false;
      });
      (fs.readFileSync as any).mockReturnValue('node_modules/\n');

      store.load(notebookUri, 3, 'DQN');
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        expect.stringContaining('.companion/')
      );
    });

    it('does not modify .gitignore if .companion already in it', () => {
      (fs.existsSync as any).mockImplementation((p: string) => {
        if (p.endsWith('.gitignore')) return true;
        return false;
      });
      (fs.readFileSync as any).mockReturnValue('.companion/\nnode_modules/\n');

      store.load(notebookUri, 3, 'DQN');
      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    it('loads existing transcript from disk', () => {
      const existing: TranscriptFile = {
        notebookFile: '03_DQN.ipynb',
        chapterNumber: 3,
        chapterTitle: 'DQN',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T01:00:00.000Z',
        entries: [{
          id: 'existing-1',
          timestamp: '2025-01-01T00:30:00.000Z',
          role: 'user',
          inputMode: 'chat',
          text: 'What is DQN?',
          context: { cellIndex: 0, cellPreview: 'test', isTodoCell: false, todoText: '' },
        }],
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(existing));

      const transcript = store.load(notebookUri, 3, 'DQN');
      expect(transcript.entries).toHaveLength(1);
      expect(transcript.entries[0].text).toBe('What is DQN?');
    });

    it('returns cached transcript on second load', () => {
      const first = store.load(notebookUri, 3, 'DQN');
      const second = store.load(notebookUri, 3, 'DQN');
      expect(first).toBe(second);
    });

    it('handles corrupted JSON by creating empty transcript', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue('not valid json');

      const transcript = store.load(notebookUri, 3, 'DQN');
      expect(transcript.entries).toHaveLength(0);
    });
  });

  describe('addEntry', () => {
    it('adds entry with correct fields', () => {
      store.load(notebookUri, 3, 'DQN');
      const entry = store.addEntry(
        '03_DQN.ipynb', 'user', 'chat', 'What is DQN?', undefined,
        5, 'cell content', true, 'Implement DQN'
      );

      expect(entry.id).toBe('test-uuid-1234');
      expect(entry.role).toBe('user');
      expect(entry.inputMode).toBe('chat');
      expect(entry.text).toBe('What is DQN?');
      expect(entry.richText).toBeUndefined();
      expect(entry.context.cellIndex).toBe(5);
      expect(entry.context.isTodoCell).toBe(true);
      expect(entry.context.todoText).toBe('Implement DQN');
    });

    it('truncates cellPreview to TRANSCRIPT_CELL_PREVIEW_LEN', () => {
      store.load(notebookUri, 3, 'DQN');
      const longPreview = 'x'.repeat(300);
      const entry = store.addEntry(
        '03_DQN.ipynb', 'user', 'chat', 'test', undefined,
        0, longPreview, false, ''
      );
      expect(entry.context.cellPreview).toHaveLength(TRANSCRIPT_CELL_PREVIEW_LEN);
    });

    it('stores richText when provided', () => {
      store.load(notebookUri, 3, 'DQN');
      const entry = store.addEntry(
        '03_DQN.ipynb', 'companion', 'voice', 'Spoken text', 'Q(s,a) = r + γ·max',
        0, '', false, ''
      );
      expect(entry.richText).toBe('Q(s,a) = r + γ·max');
    });

    it('marks transcript as dirty', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'test', undefined, 0, '', false, '');
      expect((store as any).dirty.has('03_DQN.ipynb')).toBe(true);
    });

    it('throws for unknown notebook', () => {
      expect(() => {
        store.addEntry('unknown.ipynb', 'user', 'chat', 'test', undefined, 0, '', false, '');
      }).toThrow('No transcript loaded');
    });

    it('updates transcript updatedAt timestamp', () => {
      const transcript = store.load(notebookUri, 3, 'DQN');
      const before = transcript.updatedAt;
      vi.advanceTimersByTime(100);

      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'test', undefined, 0, '', false, '');
      expect(transcript.updatedAt).not.toBe(before);
    });
  });

  describe('getContextWindow', () => {
    it('returns empty array for unknown notebook', () => {
      expect(store.getContextWindow('unknown.ipynb')).toEqual([]);
    });

    it('walks newest→oldest until token budget is hit', () => {
      store.load(notebookUri, 3, 'DQN');
      // Each entry is ~400 chars → ~100 tokens. With CONTEXT_TOKEN_BUDGET=3000,
      // we should fit roughly 30 of them. Add well over that.
      const text = 'x'.repeat(400);
      for (let i = 0; i < 100; i++) {
        store.addEntry(
          '03_DQN.ipynb',
          i % 2 === 0 ? 'user' : 'companion',
          'chat', `${i}-${text}`, undefined, 0, '', false, ''
        );
      }

      const window = store.getContextWindow('03_DQN.ipynb');
      // Budget truncates hard — we should get fewer than the 100 we added.
      expect(window.length).toBeGreaterThan(0);
      expect(window.length).toBeLessThan(100);
      // Total estimated tokens stay under (or near) the budget.
      const approxTokens = window.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
      expect(approxTokens).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET + 100);
      // Last entry in window is the most recent added
      expect(window[window.length - 1].content).toContain('99-');
    });

    it('always returns at least one entry even if it exceeds the budget', () => {
      store.load(notebookUri, 3, 'DQN');
      // One giant entry that alone exceeds the token budget
      const huge = 'x'.repeat(CONTEXT_TOKEN_BUDGET * 8);
      store.addEntry('03_DQN.ipynb', 'user', 'chat', huge, undefined, 0, '', false, '');

      const window = store.getContextWindow('03_DQN.ipynb');
      expect(window).toHaveLength(1);
      expect(window[0].content).toBe(huge);
    });

    it('maps companion role to assistant role', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'Hello', undefined, 0, '', false, '');

      const window = store.getContextWindow('03_DQN.ipynb');
      expect(window[0].role).toBe('assistant');
    });

    it('keeps user role as user', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'Question', undefined, 0, '', false, '');

      const window = store.getContextWindow('03_DQN.ipynb');
      expect(window[0].role).toBe('user');
    });
  });

  describe('getEntries', () => {
    it('returns all entries', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'A', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'B', undefined, 0, '', false, '');

      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(2);
    });

    it('returns empty array for unknown notebook', () => {
      expect(store.getEntries('unknown.ipynb')).toEqual([]);
    });
  });

  describe('hasEntries', () => {
    it('returns false for empty transcript', () => {
      store.load(notebookUri, 3, 'DQN');
      expect(store.hasEntries('03_DQN.ipynb')).toBe(false);
    });

    it('returns true after adding an entry', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'test', undefined, 0, '', false, '');
      expect(store.hasEntries('03_DQN.ipynb')).toBe(true);
    });

    it('returns false for unknown notebook', () => {
      expect(store.hasEntries('nope.ipynb')).toBe(false);
    });
  });

  describe('getLastEntryTimestamp', () => {
    it('returns null for empty transcript', () => {
      store.load(notebookUri, 3, 'DQN');
      expect(store.getLastEntryTimestamp('03_DQN.ipynb')).toBeNull();
    });

    it('returns timestamp of last entry', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'First', undefined, 0, '', false, '');
      vi.advanceTimersByTime(1000);
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'Second', undefined, 0, '', false, '');

      const ts = store.getLastEntryTimestamp('03_DQN.ipynb');
      expect(ts).toBeDefined();
      expect(typeof ts).toBe('string');
    });

    it('returns null for unknown notebook', () => {
      expect(store.getLastEntryTimestamp('unknown.ipynb')).toBeNull();
    });
  });

  describe('removeLastPair', () => {
    it('removes a trailing (user, companion) pair and returns true', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user',      'chat', 'q1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'a1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'user',      'chat', 'q2', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'a2', undefined, 0, '', false, '');

      expect(store.removeLastPair('03_DQN.ipynb')).toBe(true);

      const entries = store.getEntries('03_DQN.ipynb');
      expect(entries.map((e: TranscriptEntry) => e.text)).toEqual(['q1', 'a1']);
    });

    it('refuses to pop when the trailing companion turn is an initiative', () => {
      // Initiatives aren't paired with a user turn; popping them would
      // orphan the preceding user message.
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user',      'chat',       'q1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat',       'a1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'initiative', 'hint!', undefined, 0, '', false, '');

      expect(store.removeLastPair('03_DQN.ipynb')).toBe(false);
      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(3);
    });

    it('returns false when there are fewer than 2 entries', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'solo', undefined, 0, '', false, '');
      expect(store.removeLastPair('03_DQN.ipynb')).toBe(false);
    });

    it('returns false for unknown notebook file', () => {
      expect(store.removeLastPair('unknown.ipynb')).toBe(false);
    });
  });

  describe('removeLastUserEntry', () => {
    it('removes a trailing user entry and returns true', () => {
      // Real bug: LLM errored after handleUserMessage persisted the user
      // turn → without disk cleanup, the failed turn would resurrect on
      // the next notebook reopen.
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user',      'chat', 'q1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'a1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'user',      'chat', 'failed', undefined, 0, '', false, '');

      expect(store.removeLastUserEntry('03_DQN.ipynb')).toBe(true);
      const entries = store.getEntries('03_DQN.ipynb');
      expect(entries.map((e: TranscriptEntry) => e.text)).toEqual(['q1', 'a1']);
    });

    it('refuses when the last entry is a companion turn (no orphan to remove)', () => {
      // Defensive: the only legitimate use of this is right after a user
      // turn was persisted but before any companion reply landed. If the
      // last entry is a companion, the caller is confused — no-op.
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user',      'chat', 'q1', undefined, 0, '', false, '');
      store.addEntry('03_DQN.ipynb', 'companion', 'chat', 'a1', undefined, 0, '', false, '');

      expect(store.removeLastUserEntry('03_DQN.ipynb')).toBe(false);
      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(2);
    });

    it('refuses when the last entry is an initiative companion', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'companion', 'initiative', 'hint!', undefined, 0, '', false, '');
      expect(store.removeLastUserEntry('03_DQN.ipynb')).toBe(false);
    });

    it('returns false on an empty transcript', () => {
      store.load(notebookUri, 3, 'DQN');
      expect(store.removeLastUserEntry('03_DQN.ipynb')).toBe(false);
    });

    it('returns false for unknown notebook file', () => {
      expect(store.removeLastUserEntry('unknown.ipynb')).toBe(false);
    });

    it('updates the transcript timestamp so the change is recognised on re-read', () => {
      // The flush-to-disk pattern (dirty.add + flushOne) is the same as
      // removeLastPair, already covered. Here we verify the in-memory
      // state was actually mutated and the updatedAt advanced — both
      // proxies for "the change is real and will be persisted".
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'failed', undefined, 0, '', false, '');
      const beforeTs = store.getEntries('03_DQN.ipynb').length === 1
        ? new Date().toISOString()
        : '';
      vi.advanceTimersByTime(10);
      expect(store.removeLastUserEntry('03_DQN.ipynb')).toBe(true);
      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(0);
      // updatedAt was set to the post-removal time.
      const transcript = (store as any).transcripts.get('03_DQN.ipynb');
      expect(transcript.updatedAt).not.toBe(beforeTs);
    });
  });

  describe('auto-archive at rolling max', () => {
    it('archives oldest entries when exceeding TRANSCRIPT_ROLLING_MAX', () => {
      store.load(notebookUri, 3, 'DQN');

      // Add entries up to the max + 1
      for (let i = 0; i <= TRANSCRIPT_ROLLING_MAX; i++) {
        store.addEntry('03_DQN.ipynb', 'user', 'chat', `Entry ${i}`, undefined, 0, '', false, '');
      }

      // After auto-archive, entries should be trimmed to TRANSCRIPT_ROLLING_KEEP
      const entries = store.getEntries('03_DQN.ipynb');
      expect(entries.length).toBe(TRANSCRIPT_ROLLING_KEEP);
    });

    it('keeps the most recent entries after archive', () => {
      store.load(notebookUri, 3, 'DQN');

      for (let i = 0; i <= TRANSCRIPT_ROLLING_MAX; i++) {
        store.addEntry('03_DQN.ipynb', 'user', 'chat', `Entry ${i}`, undefined, 0, '', false, '');
      }

      const entries = store.getEntries('03_DQN.ipynb');
      // The last entry should be "Entry {ROLLING_MAX}"
      expect(entries[entries.length - 1].text).toBe(`Entry ${TRANSCRIPT_ROLLING_MAX}`);
    });
  });

  describe('clearTranscript', () => {
    it('deletes current file and creates fresh transcript', () => {
      (fs.existsSync as any).mockReturnValue(true);
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'test', undefined, 0, '', false, '');

      store.clearTranscript('03_DQN.ipynb', notebookUri as any);

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('transcript_03_DQN.json'),
      );

      // Fresh transcript should have no entries
      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(0);
    });

    it('does nothing for unknown notebook', () => {
      store.clearTranscript('unknown.ipynb', notebookUri as any);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('clearInMemory', () => {
    it('clears entries without touching files', () => {
      store.load(notebookUri, 3, 'DQN');
      store.addEntry('03_DQN.ipynb', 'user', 'chat', 'hello', undefined, 0, '', false, '');
      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(1);

      vi.mocked(fs.unlinkSync).mockClear();
      store.clearInMemory('03_DQN.ipynb');

      expect(store.getEntries('03_DQN.ipynb')).toHaveLength(0);
      // Should NOT delete any files
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('does nothing for unknown notebook', () => {
      store.clearInMemory('unknown.ipynb');
      // No throw, no side effects
      expect(store.getEntries('unknown.ipynb')).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('clears flush timer', () => {
      expect((store as any).flushTimer).not.toBeNull();
      store.dispose();
      expect((store as any).flushTimer).toBeNull();
    });
  });
});
