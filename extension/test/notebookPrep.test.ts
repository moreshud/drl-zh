import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotebookPrep, NotebookPrepEvents } from '../src/notebookPrep';
import { DEFAULT_CONFIG, UserConfig } from '../src/providers';

// Mock the vscode module for workspace.workspaceFolders access.
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [] as any[] },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import * as vscode from 'vscode';

/**
 * Helper: write a minimal .ipynb file for the tests.
 */
function writeNotebook(p: string, cells: any[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ cells }), 'utf-8');
}

function events(): NotebookPrepEvents & { summaries: string[]; statuses: Array<'preparing' | 'idle'> } {
  const summaries: string[] = [];
  const statuses: Array<'preparing' | 'idle'> = [];
  return {
    summaries,
    statuses,
    onSummaryReady: (s) => { summaries.push(s); },
    onStatus: (st) => { statuses.push(st); },
  };
}

describe('NotebookPrep', () => {
  let tmpRoot: string;
  let config: UserConfig;
  let evts: ReturnType<typeof events>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nbprep-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    // No API keys → getCheapProvider returns null → generation is a no-op
    config = { ...DEFAULT_CONFIG };
    evts = events();
  });

  describe('solution cells', () => {
    it('loads TODO→solution mappings from the sibling solution/ folder', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      const solPath = path.join(tmpRoot, 'chapters', 'solution', '03_DQN.ipynb');
      writeNotebook(nbPath, [{ cell_type: 'markdown', source: 'stub' }]);
      writeNotebook(solPath, [
        { cell_type: 'code', source: 'TODO: epsilon-greedy policy\ndef act(s):\n    return s.argmax()' },
        { cell_type: 'code', source: 'TODO: Q update\nQ[s,a] += alpha * (r + g*max - Q[s,a])' },
      ]);

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      // prepare runs the solution load synchronously before async summary work
      await new Promise(r => setTimeout(r, 10));

      expect(prep.getSolution('epsilon-greedy policy')).toContain('def act');
      expect(prep.getSolution('Q update')).toContain('Q[s,a]');
    });

    it('maps root notebook TODOs to same-index solved cells when solutions omit TODO markers', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '06_PPO.ipynb');
      const solPath = path.join(tmpRoot, 'chapters', 'solution', '06_PPO.ipynb');
      writeNotebook(nbPath, [
        {
          cell_type: 'code',
          source: [
            'class Agent:\n',
            '    # TODO: Return the critic value.\n',
            '    def get_value(self, states):\n',
            '        pass\n',
          ],
        },
      ]);
      writeNotebook(solPath, [
        {
          cell_type: 'code',
          source: [
            'class Agent:\n',
            '    def get_value(self, states):\n',
            '        return self.critic(states)\n',
          ],
        },
      ]);

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('06_PPO.ipynb', vscode.Uri.file(nbPath) as any);
      await new Promise(r => setTimeout(r, 10));

      expect(prep.getSolution('Return the critic value.', 0)).toContain('return self.critic(states)');
    });

    it('returns undefined when solution file is absent', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      writeNotebook(nbPath, [{ cell_type: 'markdown', source: 'stub' }]);

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      await new Promise(r => setTimeout(r, 10));

      expect(prep.getSolution('anything')).toBeUndefined();
    });

    it('clear() wipes solutions and summary', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      const solPath = path.join(tmpRoot, 'chapters', 'solution', '03_DQN.ipynb');
      writeNotebook(nbPath, [{ cell_type: 'markdown', source: 'stub' }]);
      writeNotebook(solPath, [{ cell_type: 'code', source: 'TODO: test\nx' }]);

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      await new Promise(r => setTimeout(r, 10));
      expect(prep.getSolution('test')).toBeDefined();

      prep.clear();
      expect(prep.getSolution('test')).toBeUndefined();
      expect(prep.getSummary()).toBeNull();
    });
  });

  describe('summary cache', () => {
    it('reads the cached summary and fires onSummaryReady without generation', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      writeNotebook(nbPath, []);

      // Pre-seed the cache
      const cacheDir = path.join(tmpRoot, '.companion', 'summaries');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, '03_DQN.txt'), 'cached summary', 'utf-8');

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      await new Promise(r => setTimeout(r, 10));

      expect(prep.getSummary()).toBe('cached summary');
      expect(evts.summaries).toEqual(['cached summary']);
      // No generation was needed, so no preparing/idle status
      expect(evts.statuses).toEqual([]);
    });

    it('deleteCache removes the on-disk summary', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      writeNotebook(nbPath, []);
      const cacheDir = path.join(tmpRoot, '.companion', 'summaries');
      const cachePath = path.join(cacheDir, '03_DQN.txt');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, 'cached summary', 'utf-8');

      const prep = new NotebookPrep(() => config, evts);
      prep.deleteCache('03_DQN.ipynb');

      expect(fs.existsSync(cachePath)).toBe(false);
    });

    it('deleteCache is a safe no-op for nonexistent cache', () => {
      const prep = new NotebookPrep(() => config, evts);
      expect(() => prep.deleteCache('never-cached.ipynb')).not.toThrow();
    });
  });

  describe('single-flight', () => {
    it('prepare() while the same notebook is already preparing is a no-op', async () => {
      const nbPath = path.join(tmpRoot, 'chapters', '03_DQN.ipynb');
      writeNotebook(nbPath, []);
      // Pre-seed cache so prepare finishes synchronously
      const cacheDir = path.join(tmpRoot, '.companion', 'summaries');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, '03_DQN.txt'), 'cached', 'utf-8');

      const prep = new NotebookPrep(() => config, evts);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      prep.prepare('03_DQN.ipynb', vscode.Uri.file(nbPath) as any);
      await new Promise(r => setTimeout(r, 10));

      // Only one summary event — the second prepare() saw the in-flight flag
      expect(evts.summaries).toHaveLength(1);
    });
  });
});
