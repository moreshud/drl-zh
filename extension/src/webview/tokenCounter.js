// @ts-check
// Pure formatting for the token-usage counter shown under Zee. Given a
// context size (input tokens of the most recent turn) and session total
// (cumulative input + output across all turns), returns a display string
// and a severity level — `warn` when usage is worth noticing, `alert` when
// approaching request-level or rate-limit concerns. Pulled out so the
// thresholds are unit-testable and easy to tweak from one place.
//
// Dual-loaded: globalThis.ZeeTokenCounter for the webview <script> tag,
// CommonJS export for vitest unit tests.

'use strict';

(function (global) {
  // Context threshold at which typical LLM requests start to matter (~cheap
  // models' sweet spot). Alert threshold is where most providers begin
  // truncating or where per-request rate-limits start biting.
  const CTX_WARN = 20_000;
  const CTX_ALERT = 80_000;
  // Session totals: conservative free-tier-ish budgets. Warn at 100k
  // cumulative, alert at 500k — the point at which you should probably
  // clear the transcript or switch provider.
  const SESSION_WARN = 100_000;
  const SESSION_ALERT = 500_000;

  /**
   * @param {number} n
   * @returns {string}
   */
  function short(n) {
    if (n < 1000) { return String(n); }
    if (n < 10_000) { return (n / 1000).toFixed(1) + 'k'; }
    return Math.round(n / 1000) + 'k';
  }

  /**
   * @typedef {'normal' | 'warn' | 'alert'} CounterLevel
   */

  /**
   * @param {number} context
   * @param {number} sessionTotal
   * @returns {{ text: string, level: CounterLevel }}
   */
  function formatTokenCounter(context, sessionTotal) {
    const text = `ctx ${short(context)} · total ${short(sessionTotal)}`;
    /** @type {CounterLevel} */
    let level = 'normal';
    if (context >= CTX_ALERT || sessionTotal >= SESSION_ALERT) {
      level = 'alert';
    } else if (context >= CTX_WARN || sessionTotal >= SESSION_WARN) {
      level = 'warn';
    }
    return { text, level };
  }

  if (global) { global.ZeeTokenCounter = { formatTokenCounter }; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatTokenCounter };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
