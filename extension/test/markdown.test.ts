import { describe, it, expect } from 'vitest';
// @ts-expect-error — webview module exports CommonJS for vitest
import { renderMarkdown } from '../src/webview/markdown.js';

const r = renderMarkdown as (text: string) => string;

describe('renderMarkdown', () => {
  describe('security', () => {
    it('escapes raw HTML so LLM output cannot inject markup', () => {
      const out = r('<script>evil()</script>');
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', () => {
      expect(r('tom & jerry')).toContain('tom &amp; jerry');
    });

    it('escapes entities inside code blocks too', () => {
      const out = r('```\n<div>\n```');
      expect(out).not.toContain('<div>');
      expect(out).toContain('&lt;div&gt;');
    });
  });

  describe('bold and italic', () => {
    it('renders **bold**', () => {
      expect(r('this is **bold**')).toContain('<strong>bold</strong>');
    });

    it('renders __bold__ (underscore variant)', () => {
      expect(r('this is __bold__')).toContain('<strong>bold</strong>');
    });

    it('renders *italic*', () => {
      expect(r('this is *italic*')).toContain('<em>italic</em>');
    });

    it('renders _italic_ (underscore variant, non-word boundary required)', () => {
      expect(r('make _this_ italic')).toContain('<em>this</em>');
    });

    // Known limitation: snake_case identifiers get partially italicized
    // by the underscore rule. Acceptable because LLM prose rarely contains
    // raw snake_case; when it does, users can surround it in backticks.
    it('snake_case identifiers get italicized (known limitation — use backticks)', () => {
      const out = r('use snake_case_name here');
      expect(out).toContain('<em>case</em>');
    });
  });

  describe('strikethrough', () => {
    it('renders ~~strike~~', () => {
      expect(r('~~gone~~')).toContain('<del>gone</del>');
    });
  });

  describe('headers', () => {
    it('# at start of line → h2', () => {
      expect(r('# Title')).toContain('<h2>Title</h2>');
    });

    it('## → h3, ### → h4, #### → h5', () => {
      expect(r('## Sub')).toContain('<h3>Sub</h3>');
      expect(r('### Sub')).toContain('<h4>Sub</h4>');
      expect(r('#### Sub')).toContain('<h5>Sub</h5>');
    });

    it('# not at line start is not treated as a header', () => {
      expect(r('x = y # comment')).not.toContain('<h2>');
    });
  });

  describe('code', () => {
    it('renders inline `code`', () => {
      expect(r('use `foo` here')).toContain('<code>foo</code>');
    });

    it('renders fenced ``` blocks with language class', () => {
      const out = r('```python\nprint(1)\n```');
      expect(out).toContain('<pre><code class="lang-python">');
      expect(out).toContain('print(1)');
    });

    it('fenced block without language gets <pre><code> with no class', () => {
      const out = r('```\nplain\n```');
      expect(out).toContain('<pre><code>plain</code></pre>');
    });

    it('markdown inside code blocks is NOT rendered', () => {
      // Bold should stay literal inside the code block
      const out = r('```\n**not bold**\n```');
      expect(out).toContain('**not bold**');
      expect(out).not.toContain('<strong>');
    });

    it('markdown inside inline code is NOT rendered', () => {
      const out = r('use `**literal**`');
      expect(out).toContain('<code>**literal**</code>');
      // No <strong>
      const before = out.indexOf('<code>');
      const after = out.indexOf('</code>');
      expect(out.slice(before, after)).not.toContain('<strong>');
    });
  });

  describe('lists', () => {
    it('bullet lines → <ul><li>', () => {
      const out = r('- one\n- two\n- three');
      expect(out).toContain('<ul>');
      expect(out).toContain('<li>one</li>');
      expect(out).toContain('<li>two</li>');
      expect(out).toContain('<li>three</li>');
    });

    it('asterisk bullets also work', () => {
      const out = r('* one\n* two');
      expect(out).toContain('<li>one</li>');
      expect(out).toContain('<li>two</li>');
    });
  });

  describe('paragraphs', () => {
    it('wraps plain text in a <p>', () => {
      expect(r('hello world')).toMatch(/^<p>hello world<\/p>$/);
    });

    it('double newlines split paragraphs', () => {
      const out = r('first\n\nsecond');
      expect(out).toMatch(/<p>first<\/p><p>second<\/p>/);
    });

    it('does not wrap headers/lists in <p>', () => {
      const out = r('# Title');
      expect(out).not.toMatch(/<p>\s*<h2>/);
    });
  });

  describe('horizontal rules', () => {
    it('three dashes → <hr>', () => {
      expect(r('before\n\n---\n\nafter')).toContain('<hr>');
    });
  });

  describe('empty and edge cases', () => {
    it('empty string returns empty <p></p> → cleaned to empty', () => {
      expect(r('').trim()).toBe('');
    });

    it('only whitespace stays empty', () => {
      expect(r('   ').trim()).toMatch(/^<p>\s*<\/p>$|^$/);
    });
  });
});
