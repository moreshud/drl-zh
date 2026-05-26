// Decides WHEN to surface a thought. Listens to signal triggers + soft-idle
// + an ambient timer, applies cooldown / suppression, calls the cheap LLM
// when the policy asks for an LLM-source thought, and emits one
// `ThoughtEvent` per fire to its `onThought` callback.
//
// The visual surface (thought cloud in the webview) and the deliveries
// downstream (TTS utterance, accept handler) are owned by extension.ts.
// This module just produces events.

import {
  ThoughtTrigger, pickThought, buildStuckThoughtPrompt,
} from './thoughtPolicy';
import type { LLMProvider, UserConfig } from './providers';
import type { NotebookContext } from './contextTracker';
import {
  THOUGHT_TTL_MS, THOUGHT_COOLDOWN_MS,
  AMBIENT_THOUGHT_MIN_IDLE_MS, STUCK_THOUGHT_LLM_TIMEOUT_MS,
} from './constants';

/**
 * Visual register for a thought event. `'thought'` is the default — gentle,
 * turquoise, easy to ignore. `'callout'` is a more attentive yellow/orange
 * variant for moments where the student SHOULD probably look (e.g. "want
 * me to delve deeper into this section?" right after they've been reading
 * a theory cell).
 */
export type ThoughtKind = 'thought' | 'callout';

export interface ThoughtEvent {
  /** What kicked this off — useful downstream for routing the accept path. */
  trigger: ThoughtTrigger;
  /** Visual register — see ThoughtKind. */
  kind: ThoughtKind;
  /** Final visible line (LLM-resolved or static). */
  text: string;
  /** Phrase the click escalates to a user message: `Tell me more — "<expandHint>"`. */
  expandHint: string;
  /** TTL in ms — how long the cloud should remain before auto-fading. */
  ttlMs: number;
}

export interface ThoughtOrchestratorDeps {
  /** Always-fresh config — pause / proactive-suggestions toggles read live. */
  getConfig: () => UserConfig;
  /** Always-fresh notebook context. */
  getContext: () => NotebookContext;
  /** Cheap-LLM provider for `stuck` thoughts; null when no key is configured. */
  getCheapProvider: () => LLMProvider | null;
  /** Where the resolved thought is delivered. */
  onThought: (event: ThoughtEvent) => void;
  /** Time-source (ms). Override in tests for deterministic clocks. */
  now?: () => number;
  /** RNG (used to pick from static pools). */
  rand?: () => number;
}

export class ThoughtOrchestrator {
  private now: () => number;
  private rand: () => number;
  private lastThoughtAt = 0;
  private lastActivityAt: number;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelInflight: AbortController | null = null;

  constructor(private deps: ThoughtOrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
    this.lastActivityAt = this.now();
    this.armAmbientTimer();
  }

  // ── External nudges ───────────────────────────────────────────────────

  /**
   * Called when the context tracker fires a real awareness signal (today:
   * stuck / idle / reading / success) or its soft-idle nudge. The returned
   * Promise resolves once the (possibly LLM-backed) delivery completes;
   * production callers can `void` it, tests can `await` it.
   */
  fire(trigger: ThoughtTrigger): Promise<void> {
    if (!this.canFire()) { return Promise.resolve(); }
    return this.deliver(trigger);
  }

  /** Bookkeeping: any user activity resets the ambient idle timer. */
  notifyActivity(): void {
    this.lastActivityAt = this.now();
    this.armAmbientTimer();
  }

  /** Stop pending work (paused, or extension shutdown). */
  dispose(): void {
    if (this.ambientTimer) { clearTimeout(this.ambientTimer); this.ambientTimer = null; }
    this.cancelInflight?.abort();
    this.cancelInflight = null;
  }

  // ── Core ──────────────────────────────────────────────────────────────

  /** Gates: companion paused, cooldown still active. */
  private canFire(): boolean {
    const cfg = this.deps.getConfig();
    if (!cfg.companionEnabled) { return false; }
    if (this.now() - this.lastThoughtAt < THOUGHT_COOLDOWN_MS) { return false; }
    return true;
  }

  /** Resolve the policy's pick into an emit-ready event, then emit. */
  private async deliver(trigger: ThoughtTrigger): Promise<void> {
    const ctx = this.deps.getContext();
    const candidate = pickThought(trigger, ctx, this.rand);

    let text = candidate.text;
    if (candidate.source === 'llm') {
      const llmText = await this.tryGenerateLLMThought(ctx);
      if (llmText) { text = llmText; }
      // else: fall back to candidate.text (set deliberately by the policy).
    }

    this.lastThoughtAt = this.now();
    this.deps.onThought({
      trigger,
      kind: candidate.kind ?? 'thought',
      text,
      expandHint: candidate.expandHint ?? candidate.text,
      ttlMs: THOUGHT_TTL_MS,
    });

    this.armAmbientTimer();
  }

  /** Cheap-LLM call for `stuck` thoughts. Times out fast — we fail open. */
  private async tryGenerateLLMThought(ctx: NotebookContext): Promise<string | null> {
    const provider = this.deps.getCheapProvider();
    if (!provider) { return null; }

    this.cancelInflight?.abort();
    this.cancelInflight = new AbortController();

    const { system, user } = buildStuckThoughtPrompt(ctx);
    let acc = '';
    let settled = false;
    let resolveFn!: (s: string | null) => void;
    const result = new Promise<string | null>((r) => { resolveFn = r; });
    const settle = (value: string | null) => {
      if (settled) { return; }
      settled = true;
      resolveFn(value);
    };

    const timeout = setTimeout(() => {
      this.cancelInflight?.abort();
      settle(null);
    }, STUCK_THOUGHT_LLM_TIMEOUT_MS);

    // Don't await the call itself — a stuck/hanging provider would block
    // forever past the timeout. Settlement is driven entirely by the
    // callbacks (success/error) or the timeout above.
    provider.sendMessage(
      { staticPrefix: system, dynamic: '' },
      [],
      user,
      (chunk) => { acc += chunk; },
      () => {
        clearTimeout(timeout);
        const trimmed = acc.trim().split('\n')[0].trim();
        // Strip the LLM's quote-marks if it disobeyed; clamp length.
        const clean = trimmed.replace(/^["'`]|["'`]$/g, '').slice(0, 110);
        settle(clean.length > 0 ? clean : null);
      },
      () => {
        clearTimeout(timeout);
        settle(null);
      },
    ).catch(() => {
      clearTimeout(timeout);
      settle(null);
    });
    return result;
  }

  /** (Re)arm the ambient-thought timer. Fires only after a long stretch of
   *  inactivity, only when nothing else has fired recently, and only when
   *  the policy still wants to. */
  private armAmbientTimer(): void {
    if (this.ambientTimer) { clearTimeout(this.ambientTimer); }
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      // Re-check at fire-time — config may have flipped, or another signal
      // may have fired in the meantime.
      if (!this.canFire()) { this.armAmbientTimer(); return; }
      const sinceActivity = this.now() - this.lastActivityAt;
      if (sinceActivity < AMBIENT_THOUGHT_MIN_IDLE_MS) {
        this.armAmbientTimer();
        return;
      }
      void this.deliver('ambient');
    }, AMBIENT_THOUGHT_MIN_IDLE_MS);
  }
}
