/**
 * Minimal VS Code API mock for unit testing.
 * Only the surface area used by extension source code is mocked.
 */

import { vi } from 'vitest';

// ── Event emitter helper ────────────────────────────────────────────────────

export class MockEventEmitter {
  private listeners: Function[] = [];

  event = (listener: Function) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };

  fire(data?: any) {
    this.listeners.forEach(l => l(data));
  }
}

// Reusable event emitters that tests can access and fire
export const _events = {
  onDidChangeTextEditorSelection: new MockEventEmitter(),
  onDidChangeTextDocument: new MockEventEmitter(),
  onDidChangeActiveTextEditor: new MockEventEmitter(),
  onDidChangeActiveNotebookEditor: new MockEventEmitter(),
  onDidChangeNotebookEditorSelection: new MockEventEmitter(),
  onDidChangeNotebookDocument: new MockEventEmitter(),
  onDidCloseNotebookDocument: new MockEventEmitter(),
};

// ── Uri ─────────────────────────────────────────────────────────────────────

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;

  constructor(fsPath: string) {
    this.scheme = 'file';
    this.fsPath = fsPath;
  }

  static file(p: string) {
    return new Uri(p);
  }

  toString() {
    return `file://${this.fsPath}`;
  }
}

// ── NotebookCellKind ────────────────────────────────────────────────────────

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

// ── window ──────────────────────────────────────────────────────────────────

export const window = {
  activeNotebookEditor: undefined as any,
  activeTextEditor: undefined as any,
  onDidChangeTextEditorSelection: _events.onDidChangeTextEditorSelection.event,
  onDidChangeActiveTextEditor: _events.onDidChangeActiveTextEditor.event,
  onDidChangeActiveNotebookEditor: _events.onDidChangeActiveNotebookEditor.event,
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeNotebookEditorSelection: _events.onDidChangeNotebookEditorSelection.event,
};

// ── workspace ───────────────────────────────────────────────────────────────

export const workspace = {
  onDidChangeTextDocument: _events.onDidChangeTextDocument.event,
  onDidChangeNotebookDocument: _events.onDidChangeNotebookDocument.event,
  onDidCloseNotebookDocument: _events.onDidCloseNotebookDocument.event,
  getWorkspaceFolder: vi.fn((_uri: any) => ({
    uri: new Uri('/workspace'),
    name: 'workspace',
    index: 0,
  })),
  workspaceFolders: [
    { uri: new Uri('/workspace'), name: 'workspace', index: 0 },
  ],
  notebookDocuments: [] as any[],
};

// ── EventEmitter (vscode.EventEmitter) ──────────────────────────────────────
// Tests need this exported under the name `EventEmitter` because the
// CellBadgeProvider does `new vscode.EventEmitter<void>()`.

export class EventEmitter<T = any> {
  private listeners: Array<(data: T) => void> = [];
  event = (listener: (data: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T) { this.listeners.forEach(l => l(data)); }
  dispose() { this.listeners = []; }
}

// ── notebooks ───────────────────────────────────────────────────────────────

export const notebooks = {
  registerNotebookCellStatusBarItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

// ── NotebookCellStatusBarItem(+ alignment) ──────────────────────────────────

export enum NotebookCellStatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class NotebookCellStatusBarItem {
  command?: string;
  tooltip?: string;
  constructor(public text: string, public alignment: NotebookCellStatusBarAlignment) {}
}

// ── commands ────────────────────────────────────────────────────────────────

export const commands = {
  registerCommand: vi.fn((_cmd: string, _cb: Function) => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(),
};

// ── Memento mock ────────────────────────────────────────────────────────────

export class MockMemento {
  private store = new Map<string, any>();

  get<T>(key: string, defaultValue?: T): T {
    return this.store.has(key) ? this.store.get(key) : defaultValue;
  }

  async update(key: string, value: any): Promise<void> {
    this.store.set(key, value);
  }

  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
}

// ── SecretStorage mock ──────────────────────────────────────────────────────

export class MockSecretStorage {
  private _data = new Map<string, string>();
  onDidChange = vi.fn();

  async get(key: string): Promise<string | undefined> {
    return this._data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this._data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this._data.delete(key);
  }
}

// ── ExtensionContext mock factory ────────────────────────────────────────────

export function createMockExtensionContext() {
  return {
    subscriptions: [] as any[],
    workspaceState: new MockMemento(),
    globalState: new MockMemento(),
    secrets: new MockSecretStorage(),
    extensionPath: '/mock/extension',
    extensionUri: new Uri('/mock/extension'),
    storagePath: '/mock/storage',
    globalStoragePath: '/mock/global-storage',
    logPath: '/mock/log',
  };
}
