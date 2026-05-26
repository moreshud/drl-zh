// @ts-check
// Thought-cloud surface — a comic-style bubble anchored near Zee's face that
// surfaces hedged thoughts ("hmm — maybe…"). Single visible thought at a
// time; tapping it (or the follow-up button) escalates to a real chat
// exchange. Auto-fades after a TTL so an ignored thought doesn't linger.
//
// This module owns the DOM lifecycle and animations. The "when to show"
// policy lives host-side in thoughtOrchestrator.ts; we just render what
// we're told.
//
// Dual-loaded: globalThis.ZeeThoughtCloud for the webview <script> tag,
// CommonJS export for vitest unit tests.

'use strict';

(function (global) {
  /**
   * @typedef {object} ThoughtCloudDeps
   * @property {HTMLElement} root           Container the cloud renders into.
   * @property {(text: string) => void} onFollowUp
   *           Called with the expandHint when the student clicks the cloud
   *           or its follow-up button. Host turns this into a user message.
   * @property {() => void} [onDismiss]     Optional hook fired when the cloud
   *           fades on its own (TTL) or is dismissed.
   * @property {(visible: boolean) => void} [onVisibilityChange]
   *           Fires when the cloud appears or disappears. Used by chat.js
   *           to toggle a class on Zee's face host (so the face can shift
   *           left to make room for the bubble).
   * @property {(timer: any) => void} [clearTimerFn] Test seam.
   * @property {(fn: () => void, ms: number) => any} [setTimerFn] Test seam.
   */

  /**
   * @typedef {'thought' | 'callout'} CloudKind
   */

  /**
   * @typedef {object} ShowOpts
   * @property {string} text         Visible thought line.
   * @property {string} expandHint   The phrase put in quotes when escalated.
   * @property {number} ttlMs        Auto-fade timeout.
   * @property {string} [trigger]    Optional tag forwarded for analytics/CSS.
   * @property {CloudKind} [kind]    'thought' (default, subtle) or 'callout'
   *           (yellow/orange, more attentive). Distinct visual register.
   */

  /**
   * @param {ThoughtCloudDeps} deps
   */
  function createThoughtCloud(deps) {
    const doc = deps.root.ownerDocument;
    const setT = deps.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    const clrT = deps.clearTimerFn ?? ((t) => clearTimeout(t));

    /** @type {HTMLElement | null} */ let bubbleEl = null;
    /** @type {any | null} */ let fadeTimer = null;
    /** @type {string | null} */ let activeExpandHint = null;

    function clearFadeTimer() {
      if (fadeTimer !== null) { clrT(fadeTimer); fadeTimer = null; }
    }

    function destroyBubble(reason /* 'click' | 'ttl' | 'replace' | 'manual' */) {
      clearFadeTimer();
      const wasVisible = bubbleEl !== null;
      if (bubbleEl) {
        // Add a fade-out class; if CSS is present, transitionend will clean
        // up. Fallback: a short timer to remove if no transition fires.
        bubbleEl.classList.add('zee-thought-fade-out');
        const el = bubbleEl;
        const removeNow = () => { try { el.remove(); } catch (e) { /* gone */ } };
        setT(removeNow, 250);
      }
      bubbleEl = null;
      activeExpandHint = null;
      if (reason === 'ttl') { deps.onDismiss?.(); }
      // Replacement keeps the cloud visible from the user's POV — don't
      // flicker the visibility class off/on. Other reasons truly hide it.
      if (wasVisible && reason !== 'replace') { deps.onVisibilityChange?.(false); }
    }

    /**
     * Render (or replace) the cloud with a new thought.
     * @param {ShowOpts} opts
     */
    function show(opts) {
      const wasVisible = bubbleEl !== null;
      // Replace any prior thought immediately — only one cloud at a time.
      if (bubbleEl) { destroyBubble('replace'); }

      const el = doc.createElement('div');
      el.className = 'zee-thought-cloud';
      const kind = opts.kind === 'callout' ? 'callout' : 'thought';
      el.classList.add(`is-${kind}`);
      el.dataset.kind = kind;
      if (opts.trigger) { el.dataset.trigger = opts.trigger; }
      // The whole cloud is the click target — clicking anywhere on the
      // body escalates to a chat exchange. The × is a separate sub-target
      // that stops propagation. Hover styles in CSS provide the affordance.
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.title = `Tell me more — "${opts.expandHint}"`;

      const dots = doc.createElement('div');
      dots.className = 'zee-thought-trail';
      // Three small dots forming the classic thought-trail.
      dots.innerHTML = '<span></span><span></span><span></span>';
      el.appendChild(dots);

      const body = doc.createElement('div');
      body.className = 'zee-thought-body';
      body.textContent = opts.text;
      el.appendChild(body);

      // Dismiss × — separate action so an accidental click on the body
      // doesn't both close AND escalate. stopPropagation defends against
      // the cloud-level click handler firing follow-up.
      const dismiss = doc.createElement('button');
      dismiss.className = 'zee-thought-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss thought');
      dismiss.title = 'Dismiss';
      dismiss.textContent = '×';
      el.appendChild(dismiss);

      const fire = () => {
        const hint = activeExpandHint;
        destroyBubble('click');
        if (hint) { deps.onFollowUp(hint); }
      };
      el.addEventListener('click', fire);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fire(); }
        if (ev.key === 'Escape') { ev.preventDefault(); destroyBubble('manual'); }
      });
      dismiss.addEventListener('click', (ev) => {
        ev.stopPropagation();
        destroyBubble('manual');
      });

      deps.root.appendChild(el);
      bubbleEl = el;
      activeExpandHint = opts.expandHint;

      fadeTimer = setT(() => destroyBubble('ttl'), opts.ttlMs);
      if (!wasVisible) { deps.onVisibilityChange?.(true); }
    }

    /** Force-clear any visible thought. Used when companion is paused or on
     *  context resets. */
    function clear() {
      if (bubbleEl) { destroyBubble('manual'); }
    }

    function isVisible() { return bubbleEl !== null; }
    function visibleText() { return bubbleEl ? bubbleEl.querySelector('.zee-thought-body')?.textContent ?? '' : ''; }

    return { show, clear, isVisible, visibleText };
  }

  if (global) { global.ZeeThoughtCloud = { createThoughtCloud }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createThoughtCloud };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
