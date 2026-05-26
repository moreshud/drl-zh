import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../src/sessionManager';

describe('SessionManager', () => {
  let s: SessionManager;

  beforeEach(() => { s = new SessionManager(); });

  describe('current notebook', () => {
    it('starts null', () => {
      expect(s.getCurrent()).toBeNull();
    });

    it('setCurrent → getCurrent returns what was set', () => {
      s.setCurrent('03_DQN.ipynb');
      expect(s.getCurrent()).toBe('03_DQN.ipynb');
    });

    it('setCurrent returns true on new-file transition', () => {
      expect(s.setCurrent('03_DQN.ipynb')).toBe(true);
    });

    it('setCurrent returns false if the file is the same as before (idempotent)', () => {
      s.setCurrent('03_DQN.ipynb');
      expect(s.setCurrent('03_DQN.ipynb')).toBe(false);
    });

    it('setCurrent returns true when switching to a different notebook', () => {
      s.setCurrent('03_DQN.ipynb');
      expect(s.setCurrent('04_PolicyGradient.ipynb')).toBe(true);
    });

    it('clearCurrent nulls the current file and remembers it as lastClosed', () => {
      s.setCurrent('03_DQN.ipynb');
      s.clearCurrent();
      expect(s.getCurrent()).toBeNull();
      expect(s.getLastClosed()).toBe('03_DQN.ipynb');
    });

    it('clearCurrent with no current is a safe no-op', () => {
      s.clearCurrent();
      expect(s.getCurrent()).toBeNull();
      expect(s.getLastClosed()).toBeNull();
    });
  });

  describe('lastClosed', () => {
    it('starts null', () => {
      expect(s.getLastClosed()).toBeNull();
    });

    it('tracks the most recently closed notebook', () => {
      s.setCurrent('A.ipynb');
      s.clearCurrent();
      s.setCurrent('B.ipynb');
      s.clearCurrent();
      expect(s.getLastClosed()).toBe('B.ipynb');
    });

    it('does not change on setCurrent — only on clearCurrent', () => {
      s.setCurrent('A.ipynb');
      s.setCurrent('B.ipynb');   // switched before ever closing
      expect(s.getLastClosed()).toBeNull();
    });
  });

  describe('active sessions', () => {
    it('no file is active initially', () => {
      expect(s.isActive()).toBe(false);
      expect(s.isActive('anything.ipynb')).toBe(false);
    });

    it('isActive() defaults to the current file', () => {
      s.setCurrent('A.ipynb');
      expect(s.isActive()).toBe(false);   // not activated yet
      s.activate('A.ipynb');
      expect(s.isActive()).toBe(true);
    });

    it('isActive(file) checks the named file regardless of current', () => {
      s.activate('A.ipynb');
      s.setCurrent('B.ipynb');
      expect(s.isActive()).toBe(false);
      expect(s.isActive('A.ipynb')).toBe(true);
      expect(s.isActive('B.ipynb')).toBe(false);
    });

    it('deactivate removes from the active set', () => {
      s.activate('A.ipynb');
      s.deactivate('A.ipynb');
      expect(s.isActive('A.ipynb')).toBe(false);
    });

    it('tracks multiple active sessions simultaneously', () => {
      s.activate('A.ipynb');
      s.activate('B.ipynb');
      expect(s.isActive('A.ipynb')).toBe(true);
      expect(s.isActive('B.ipynb')).toBe(true);
    });

    it('isActive() with no current notebook always returns false', () => {
      s.activate('A.ipynb');   // activated but not current
      expect(s.isActive()).toBe(false);
    });
  });

  describe('realistic session flow', () => {
    it('full session lifecycle: open, activate, switch, close', () => {
      // User opens chapter 1
      expect(s.setCurrent('01_MDP.ipynb')).toBe(true);
      s.activate('01_MDP.ipynb');
      expect(s.isActive()).toBe(true);

      // User switches to chapter 3
      expect(s.setCurrent('03_DQN.ipynb')).toBe(true);
      // Chapter 1's session is still "active" (remembered)
      expect(s.isActive('01_MDP.ipynb')).toBe(true);
      // Chapter 3's session hasn't started yet
      expect(s.isActive()).toBe(false);
      s.activate('03_DQN.ipynb');
      expect(s.isActive()).toBe(true);

      // User closes the editor
      s.clearCurrent();
      expect(s.getCurrent()).toBeNull();
      expect(s.getLastClosed()).toBe('03_DQN.ipynb');
      // Both sessions remain in the active set until explicitly cleared
      expect(s.isActive('01_MDP.ipynb')).toBe(true);
      expect(s.isActive('03_DQN.ipynb')).toBe(true);
    });

    it('clear transcript flow: deactivate the cleared session', () => {
      s.setCurrent('03_DQN.ipynb');
      s.activate('03_DQN.ipynb');
      s.deactivate('03_DQN.ipynb');
      expect(s.isActive()).toBe(false);
      expect(s.getCurrent()).toBe('03_DQN.ipynb');   // notebook still open
    });
  });
});
