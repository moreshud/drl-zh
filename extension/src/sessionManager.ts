// Single source of truth for "which notebook is Zee focused on right now
// and which notebooks have active companion sessions". Prior to this split
// these three fields lived on CompanionViewProvider and got mutated from
// four different message handlers with subtly different invariants —
// consolidating makes the state machine inspectable and testable.

export class SessionManager {
  private current: string | null = null;
  private lastClosed: string | null = null;
  private active = new Set<string>();

  // ── Notebook focus ────────────────────────────────────────────────────

  /** Currently focused notebook filename, or null if none open. */
  getCurrent(): string | null {
    return this.current;
  }

  /** Filename of the notebook that was closed most recently — used to
   * target a transcript-clear even after the user has closed the notebook. */
  getLastClosed(): string | null {
    return this.lastClosed;
  }

  /**
   * Record that `file` is now the focused notebook. Returns true if this
   * is a transition from a different notebook (or from "no notebook"),
   * false if it's the same notebook as before (idempotent update).
   */
  setCurrent(file: string): boolean {
    if (this.current === file) { return false; }
    this.current = file;
    return true;
  }

  /** Record that no notebook is focused. Remembers the last one for
   * operations (like clear) that need a target when no notebook is open. */
  clearCurrent(): void {
    if (this.current) { this.lastClosed = this.current; }
    this.current = null;
  }

  // ── Active sessions (per notebook) ────────────────────────────────────

  /**
   * Is there an active companion session for this file? Defaults to the
   * current notebook. A session is "active" from handleStartSession to
   * handleClearTranscript.
   */
  isActive(file?: string): boolean {
    const target = file ?? this.current;
    return !!target && this.active.has(target);
  }

  activate(file: string): void {
    this.active.add(file);
  }

  deactivate(file: string): void {
    this.active.delete(file);
  }

  /** Wipe all session state — used by the "Reset Zee" path. */
  reset(): void {
    this.current = null;
    this.lastClosed = null;
    this.active.clear();
  }
}
