// @ts-check
// Tiny markdown → HTML renderer for the transcript. Scope intentionally
// small: bold, italic, strikethrough, inline code, code fences, headers
// (h2-h5), unordered lists, horizontal rules, and paragraphs. No tables,
// no blockquotes, no reference links — Zee's responses don't use them.
//
// Dual-loaded (matching face.js):
//   - webview: attaches renderMarkdown to globalThis so chat.js can call it
//   - vitest:  CommonJS export so test files can import it
//
// XSS: the input is untrusted LLM output, so we HTML-escape everything
// first and only reintroduce tags via our own controlled substitutions.
// Code block contents are captured BEFORE escaping so inline markdown
// characters in code (e.g. `*args`) don't get mangled.

'use strict';

(function (global) {
  /**
   * @param {string} text
   * @returns {string} HTML string
   */
  function renderMarkdown(text) {
    // XSS-safe: escape HTML entities first; every tag we emit below is
    // under our control via explicit concat.
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Extract code blocks (preserve content, skip markdown inside)
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push('<pre><code' + (lang ? ' class="lang-' + lang + '"' : '') + '>' + code.trimEnd() + '</code></pre>');
      return '\x00CB' + (codeBlocks.length - 1) + '\x00';
    });

    // Extract inline code
    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      inlineCodes.push('<code>' + code + '</code>');
      return '\x00IC' + (inlineCodes.length - 1) + '\x00';
    });

    // Bold then italic (order matters — bold markers are stronger)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_([^\s_].*?[^\s_])_/g, '<em>$1</em>');

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Headers (# → h2, ## → h3, ### → h4, #### → h5)
    html = html.replace(/^####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');

    // Unordered lists
    html = html.replace(/^[*\-]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Horizontal rules
    html = html.replace(/^[-*_]{3,}\s*$/gm, '<hr>');

    // Paragraphs: double newlines split into <p> blocks
    html = html.replace(/\n{2,}/g, '</p><p>');
    // Single newlines → <br>
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs and paragraphs wrapping block elements
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p><br>/g, '<p>');
    html = html.replace(/<p>(\s*<(?:h[2-5]|ul|pre|hr))/g, '$1');
    html = html.replace(/(<\/(?:h[2-5]|ul|pre|hr)>)\s*<\/p>/g, '$1');

    // Re-insert code blocks and inline code
    codeBlocks.forEach((block, i) => {
      html = html.replace('\x00CB' + i + '\x00', block);
    });
    inlineCodes.forEach((code, i) => {
      html = html.replace('\x00IC' + i + '\x00', code);
    });

    return html;
  }

  if (global) { global.ZeeMarkdown = { renderMarkdown }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
