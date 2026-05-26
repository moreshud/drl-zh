import { describe, it, expect } from 'vitest';
import { decideKeyAction } from '../src/webview/inputKey';

describe('decideKeyAction', () => {
  it('plain Enter → "send"', () => {
    expect(decideKeyAction({ key: 'Enter' })).toBe('send');
  });

  it('Shift+Enter → "newline"', () => {
    expect(decideKeyAction({ key: 'Enter', shiftKey: true })).toBe('newline');
  });

  it('Ctrl/Cmd/Alt + Enter → "pass" (lets the platform handle it)', () => {
    expect(decideKeyAction({ key: 'Enter', ctrlKey: true })).toBe('pass');
    expect(decideKeyAction({ key: 'Enter', metaKey: true })).toBe('pass');
    expect(decideKeyAction({ key: 'Enter', altKey: true })).toBe('pass');
  });

  it('Enter during IME composition → "pass" (commits the candidate, no send)', () => {
    // Hitting Enter to commit a Japanese/Chinese input candidate must NOT
    // send the message. isComposing is the standard signal.
    expect(decideKeyAction({ key: 'Enter', isComposing: true })).toBe('pass');
    expect(decideKeyAction({ key: 'Enter', isComposing: true, shiftKey: true })).toBe('pass');
  });

  it('any non-Enter key → "pass"', () => {
    expect(decideKeyAction({ key: 'a' })).toBe('pass');
    expect(decideKeyAction({ key: 'Tab' })).toBe('pass');
    expect(decideKeyAction({ key: 'ArrowDown' })).toBe('pass');
  });

  it('shift order is correct: shift+enter wins over plain even with weird flags', () => {
    expect(decideKeyAction({ key: 'Enter', shiftKey: true, altKey: false })).toBe('newline');
  });
});
