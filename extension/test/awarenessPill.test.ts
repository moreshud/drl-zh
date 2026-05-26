import { describe, it, expect } from 'vitest';
import { formatAwarenessPill, plainText } from '../src/webview/awarenessPill';

describe('formatAwarenessPill', () => {
  it('returns an empty pill in meta mode (no notebook open)', () => {
    const p = formatAwarenessPill({ notebook: null });
    expect(p.segments).toEqual([]);
    expect(p.tooltip).toBe('');
  });

  it('shows chapter title when a notebook is open but no cell is focused yet', () => {
    const p = formatAwarenessPill({
      notebook: '03_DQN.ipynb', cell: -1,
      chapter: 3, chapterTitle: 'Deep Q-Learning',
    });
    expect(plainText(p.segments)).toContain('Deep Q-Learning');
    expect(plainText(p.segments).startsWith('👁')).toBe(true);
  });

  it('formats a TODO cell with bold "Cell" / "TODO:" labels around plain values (1-based display)', () => {
    // The internal `cell` field is 0-based (notebook API index); the pill
    // shifts to 1-based so the student counts cells starting at 1.
    const p = formatAwarenessPill({
      notebook: '03_DQN.ipynb', cell: 4, cellType: 'code',
      todoText: 'implement experience replay buffer',
      chapter: 3, chapterTitle: 'Deep Q-Learning',
      cursorLine: 12,
    });
    // Structure: 👁 [Cell] 5 - L12 - [TODO:] <descriptor>  (cell 4 → "Cell 5")
    const labels = p.segments.filter(s => s.kind === 'label').map(s => s.text);
    expect(labels).toEqual(['Cell', 'TODO:']);
    const flat = plainText(p.segments);
    expect(flat).toBe('👁 Cell 5 - L12 - TODO: implement experience replay buffer');
    expect(p.tooltip).toContain('Chapter 3: Deep Q-Learning');
    expect(p.tooltip).toContain('cell 5');
    expect(p.tooltip).toContain('line 12');
    expect(p.tooltip).toContain('TODO: implement experience replay');
  });

  it('truncates long TODO text in the pill but keeps it full in tooltip', () => {
    const longTodo = 'implement a prioritized experience replay buffer with importance sampling weights';
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 2, cellType: 'code', todoText: longTodo,
      cursorLine: 1,
    });
    const flat = plainText(p.segments);
    expect(flat.length).toBeLessThan(80);
    expect(flat).toContain('…');
    expect(p.tooltip).toContain(longTodo);
  });

  it('labels plain code cells "Coding" and markdown cells "Reading" (both bold)', () => {
    const code = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 3, cellType: 'code', cursorLine: 1,
    });
    expect(code.segments.find(s => s.kind === 'label' && s.text === 'Coding')).toBeDefined();
    expect(plainText(code.segments)).toBe('👁 Cell 4 - L1 - Coding');

    const md = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 3, cellType: 'markdown', cursorLine: 1,
    });
    expect(md.segments.find(s => s.kind === 'label' && s.text === 'Reading')).toBeDefined();
    expect(plainText(md.segments)).toBe('👁 Cell 4 - L1 - Reading');
  });

  it('uses scopeTodo as descriptor when the active cell isn\'t itself a TODO', () => {
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 6, cellType: 'markdown',
      todoText: '',
      scopeTodo: { cellIndex: 4, todoText: 'parse the input spec into Cells' },
      cursorLine: 1,
    });
    expect(plainText(p.segments)).toBe('👁 Cell 7 - L1 - TODO: parse the input spec into Cells');
    expect(p.tooltip).toContain('scope TODO (cell 5)');
  });

  it('active-cell todoText still wins when both are present (avoid double-anchoring)', () => {
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 5, cellType: 'code',
      todoText: 'implement replay buffer',
      scopeTodo: { cellIndex: 5, todoText: 'implement replay buffer' },
      cursorLine: 1,
    });
    expect(plainText(p.segments)).toContain('TODO: implement replay buffer');
    expect(p.tooltip.match(/TODO/g)?.length).toBe(1);
  });

  it('truncates a long scopeTodo just like a long active todoText', () => {
    const longTodo = 'implement a prioritized experience replay buffer with importance sampling';
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 9, cellType: 'markdown',
      scopeTodo: { cellIndex: 5, todoText: longTodo },
    });
    const flat = plainText(p.segments);
    expect(flat).toContain('…');
    expect(flat.length).toBeLessThan(80);
    expect(p.tooltip).toContain(longTodo);
  });

  it('labels errored cells as "Debugging" and includes the error count when > 1', () => {
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 5, cellType: 'code',
      todoText: 'some todo',
      errors: 'IndexError: list index out of range',
      consecutiveErrors: 3,
    });
    expect(p.segments.find(s => s.kind === 'label' && s.text === 'Debugging')).toBeDefined();
    expect(plainText(p.segments)).toContain('Debugging');
    expect(plainText(p.segments)).toContain('(3 errors)');
    expect(p.tooltip).toContain('IndexError');
  });

  it('does not show error count for a single error', () => {
    const p = formatAwarenessPill({
      notebook: 'x.ipynb', cell: 4, cellType: 'code',
      errors: 'NameError: foo',
      consecutiveErrors: 1,
      cursorLine: 1,
    });
    expect(plainText(p.segments)).toBe('👁 Cell 5 - L1 - Debugging');
  });

  describe('cursor line', () => {
    it('includes an "L<n>" segment when cursor line is known', () => {
      const p = formatAwarenessPill({
        notebook: 'x.ipynb', cell: 5, cellType: 'code',
        todoText: 'implement', cursorLine: 47,
      });
      expect(plainText(p.segments)).toContain('L47');
      expect(p.tooltip).toContain('line 47');
    });

    it('drops the L<n> segment entirely when cursor is unknown', () => {
      // No "?" suffix — that flickered while the snapshot was warming up.
      // Tooltip still notes "cursor not focused" so the user can find out.
      const p = formatAwarenessPill({
        notebook: 'x.ipynb', cell: 5, cellType: 'code',
        todoText: 'implement', cursorLine: -1,
      });
      const flat = plainText(p.segments);
      expect(flat).not.toMatch(/\bL\d+\b/);
      expect(flat).not.toMatch(/\?\s*$/);
      expect(p.tooltip.toLowerCase()).toContain('cursor not focused');
    });

    it('treats undefined cursorLine the same as -1 (no L segment, no "?")', () => {
      const p = formatAwarenessPill({
        notebook: 'x.ipynb', cell: 5, cellType: 'code',
        todoText: 'implement',
      });
      expect(plainText(p.segments)).not.toMatch(/\bL\d+\b/);
      expect(plainText(p.segments)).not.toMatch(/\?\s*$/);
    });
  });

  describe('plainText helper', () => {
    it('flattens segments to a single string', () => {
      expect(plainText([
        { kind: 'plain', text: 'a' },
        { kind: 'label', text: 'B' },
        { kind: 'plain', text: 'c' },
      ])).toBe('aBc');
    });
  });
});
