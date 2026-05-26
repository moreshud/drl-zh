// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createThoughtCloud } from '../src/webview/thoughtCloud';

let timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
let nextTimerId = 0;
function fakeSet(fn: () => void, ms: number) {
  const id = ++nextTimerId;
  timers.push({ fn, ms, cleared: false });
  return id;
}
function fakeClear(id: number) {
  // We identify timers by ID via index — id starts at 1.
  const t = timers[id - 1];
  if (t) { t.cleared = true; }
}
function runTimer(idx: number) {
  const t = timers[idx];
  if (t && !t.cleared) { t.fn(); }
}
function runAll() {
  // Snapshot — running a callback may register more.
  const initial = [...timers];
  for (const t of initial) { if (!t.cleared) { t.fn(); } }
}

describe('createThoughtCloud', () => {
  let root: HTMLElement;
  let onFollowUp: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;
  let cloud: ReturnType<typeof createThoughtCloud>;

  beforeEach(() => {
    timers = [];
    nextTimerId = 0;
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    onFollowUp = vi.fn();
    onDismiss = vi.fn();
    cloud = createThoughtCloud({
      root, onFollowUp, onDismiss,
      setTimerFn: fakeSet as any,
      clearTimerFn: fakeClear as any,
    });
  });

  describe('show / hide', () => {
    it('renders a bubble with the thought text', () => {
      cloud.show({ text: 'Hmm — want a hint?', expandHint: 'help me with this', ttlMs: 1000 });
      expect(cloud.isVisible()).toBe(true);
      expect(cloud.visibleText()).toBe('Hmm — want a hint?');
      expect(root.querySelector('.zee-thought-cloud')).not.toBeNull();
    });

    it('replaces an existing thought when show() is called again', () => {
      cloud.show({ text: 'first', expandHint: 'first', ttlMs: 1000 });
      cloud.show({ text: 'second', expandHint: 'second', ttlMs: 1000 });
      // Old bubble starts fading (still in DOM until removeNow timer); new
      // bubble is the active one.
      expect(cloud.visibleText()).toBe('second');
    });

    it('clear() removes the active thought', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000 });
      cloud.clear();
      expect(cloud.isVisible()).toBe(false);
    });

    it('exposes the trigger as a data attribute when provided', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000, trigger: 'stuck' });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      expect(bubble.dataset.trigger).toBe('stuck');
    });

    it('renders kind="callout" with .is-callout class (vs default .is-thought)', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000, kind: 'callout' });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      expect(bubble.classList.contains('is-callout')).toBe(true);
      expect(bubble.dataset.kind).toBe('callout');
    });

    it('defaults to kind="thought" when not provided', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000 });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      expect(bubble.classList.contains('is-thought')).toBe(true);
      expect(bubble.classList.contains('is-callout')).toBe(false);
    });

    it('fires onVisibilityChange(true) on show and (false) on dismiss/TTL', () => {
      const onVis = vi.fn();
      const c = createThoughtCloud({
        root, onFollowUp, onVisibilityChange: onVis,
        setTimerFn: fakeSet as any, clearTimerFn: fakeClear as any,
      });
      c.show({ text: 'X', expandHint: 'X', ttlMs: 1000 });
      expect(onVis).toHaveBeenLastCalledWith(true);
      c.clear();
      runAll();   // fire-out remove timer
      expect(onVis).toHaveBeenLastCalledWith(false);
    });

    it('renders an X dismiss button — body click does follow-up, X dismisses', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000 });
      const dismiss = root.querySelector('.zee-thought-dismiss');
      expect(dismiss).not.toBeNull();
      expect(dismiss?.textContent).toBe('×');
      // No standalone "follow up" button — the whole cloud body is the
      // click target for follow-up.
      expect(root.querySelector('.zee-thought-followup')).toBeNull();
    });

    it('clicking the × dismiss closes the cloud without firing onFollowUp', () => {
      cloud.show({ text: 'X', expandHint: 'X-hint', ttlMs: 5000 });
      const dismiss = root.querySelector('.zee-thought-dismiss') as HTMLButtonElement;
      dismiss.click();
      expect(cloud.isVisible()).toBe(false);
      expect(onFollowUp).not.toHaveBeenCalled();
    });

    it('dismiss-button click does NOT bubble up and trigger follow-up', () => {
      // Defensive: the cloud-level click handler triggers follow-up. The
      // dismiss button must stop propagation, otherwise clicking × would
      // both close AND escalate.
      cloud.show({ text: 'X', expandHint: 'hint', ttlMs: 5000 });
      const dismiss = root.querySelector('.zee-thought-dismiss') as HTMLButtonElement;
      dismiss.click();
      expect(onFollowUp).not.toHaveBeenCalled();
    });

    it('Escape on the focused bubble dismisses without follow-up', () => {
      cloud.show({ text: 'X', expandHint: 'hint', ttlMs: 5000 });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      bubble.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(cloud.isVisible()).toBe(false);
      expect(onFollowUp).not.toHaveBeenCalled();
    });

    it('replacing a thought does NOT fire visibility-off-then-on (no flicker)', () => {
      // We want the host's "shift Zee left" class to stay applied across a
      // smooth replace, not flicker off and back on.
      const onVis = vi.fn();
      const c = createThoughtCloud({
        root, onFollowUp, onVisibilityChange: onVis,
        setTimerFn: fakeSet as any, clearTimerFn: fakeClear as any,
      });
      c.show({ text: 'first', expandHint: 'a', ttlMs: 1000 });
      c.show({ text: 'second', expandHint: 'b', ttlMs: 1000 });
      // Should have been called once with `true`, never with `false` so far.
      expect(onVis).toHaveBeenCalledTimes(1);
      expect(onVis).toHaveBeenCalledWith(true);
    });
  });

  describe('TTL', () => {
    it('schedules a fade-out timer for the given ttlMs', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 25_000 });
      // First registered timer is the TTL fade.
      expect(timers[0].ms).toBe(25_000);
    });

    it('TTL fires onDismiss and clears visibility', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 1000 });
      runTimer(0);                  // TTL fires destroyBubble('ttl')
      runAll();                     // run the fade-out remove timer
      expect(cloud.isVisible()).toBe(false);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('replacing the thought cancels the previous TTL timer', () => {
      cloud.show({ text: 'first', expandHint: 'first', ttlMs: 1000 });
      cloud.show({ text: 'second', expandHint: 'second', ttlMs: 1000 });
      // The first TTL timer must be cleared so it doesn't dismiss the new one.
      expect(timers[0].cleared).toBe(true);
    });
  });

  describe('click → onFollowUp', () => {
    it('clicking the bubble fires onFollowUp with the expandHint', () => {
      cloud.show({ text: 'maybe a hint?', expandHint: 'help me here', ttlMs: 5000 });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      bubble.click();
      expect(onFollowUp).toHaveBeenCalledWith('help me here');
    });

    it('Enter/Space on the bubble fires onFollowUp (keyboard accessible)', () => {
      cloud.show({ text: 'X', expandHint: 'X-hint', ttlMs: 5000 });
      const bubble = root.querySelector('.zee-thought-cloud') as HTMLElement;
      bubble.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(onFollowUp).toHaveBeenCalledWith('X-hint');
    });

    it('clicking does NOT fire onDismiss (only TTL does)', () => {
      cloud.show({ text: 'X', expandHint: 'X', ttlMs: 5000 });
      (root.querySelector('.zee-thought-cloud') as HTMLElement).click();
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  describe('isolation', () => {
    it('clear() before show() is a no-op (no DOM, no callbacks)', () => {
      cloud.clear();
      expect(cloud.isVisible()).toBe(false);
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });
});
