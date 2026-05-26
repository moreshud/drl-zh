import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildWebviewHtml } from '../src/webviewHtml';
import { META_MODE_COPY } from '../src/constants';

// Minimal vscode.Webview surface — we just need asWebviewUri.
function makeWebview(): any {
  return {
    asWebviewUri: vi.fn((uri: any) => ({
      toString: () => `vscode-webview://${uri.fsPath}`,
    })),
  };
}

const REPO_EXTENSION_ROOT = path.resolve(__dirname, '..');

describe('buildWebviewHtml', () => {
  it('inlines the META_MODE_COPY description into the empty-state card', () => {
    const html = buildWebviewHtml(REPO_EXTENSION_ROOT, makeWebview() as any);
    // The description should appear (HTML-escaped — apostrophes are
    // escaped to &#39;) inside the empty-state markup.
    const escapedDesc = META_MODE_COPY.description.replace(/'/g, '&#39;');
    expect(html).toContain(escapedDesc);
  });

  it('does NOT contain the historical "chapters/" lie anywhere', () => {
    // Regression guard for the broken empty-state copy that referred to a
    // chapters/ folder that never existed.
    const html = buildWebviewHtml(REPO_EXTENSION_ROOT, makeWebview() as any);
    expect(html).not.toMatch(/chapters\//);
  });

  it('exposes META_MODE_PILL through window.__DRL_CONSTANTS__ as JSON', () => {
    // chat.js reads this at runtime to keep the context-bar pill in sync
    // with the empty-state card.
    const html = buildWebviewHtml(REPO_EXTENSION_ROOT, makeWebview() as any);
    expect(html).toContain(`META_MODE_PILL: ${JSON.stringify(META_MODE_COPY.pill)}`);
  });

  it('escapes HTML-significant characters in the description (no XSS via constant)', () => {
    // Even though the constant is dev-controlled, escaping is part of the
    // contract — verify a benign apostrophe (U+0027) becomes &#39;.
    const html = buildWebviewHtml(REPO_EXTENSION_ROOT, makeWebview() as any);
    // Apostrophe in "I'll" must be encoded.
    expect(html).not.toMatch(/I'll follow along/);
    expect(html).toContain('I&#39;ll follow along');
  });

  it('default empty-state card markup is NOT hidden (visible on first load)', () => {
    // Before this fix, the card was `class="hidden"` and only got revealed
    // on a context_update with no notebook — but that only fires on
    // close, never on cold start, so the card never appeared. The card
    // must now be visible by default.
    const html = buildWebviewHtml(REPO_EXTENSION_ROOT, makeWebview() as any);
    // Find the noNotebookState block and check it has no `class="hidden"`.
    const m = html.match(/<div id="noNotebookState"([^>]*)>/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/class="[^"]*\bhidden\b/);
  });
});

describe('static index.html', () => {
  // A direct file-level grep so the regression cannot creep back in via a
  // hand-edit to the template (where webviewHtml's substitution wouldn't
  // catch it).
  it('contains no literal "chapters/" reference in the source template', () => {
    const tmpl = fs.readFileSync(
      path.join(REPO_EXTENSION_ROOT, 'src', 'webview', 'index.html'),
      'utf-8',
    );
    expect(tmpl).not.toMatch(/chapters\//);
  });
});
