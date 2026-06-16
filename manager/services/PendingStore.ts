// Shared lifecycle store behind the register→poll pending registries
// (PendingQuestionService, PendingPeerRequestService). It owns the one subtle
// part both share and nothing else: an entry is PENDING while settledAt === null
// (and is NEVER pruned — a question or consult may legitimately wait days), and
// TERMINAL once settled, where it is kept only for a short grace window (so a
// lost-response poll retry still reads the outcome) and then reclaimed. The
// state shape S and any owner/index/delivery logic stay in the service; this
// store knows only `settledAt`, which makes "first settle wins" and "pending is
// immortal" hold identically for every registry built on it.

import type { Clock } from "../../core/src/ports/Clock.ts";

// Long enough that an asker polling every 2.5s always reads its answer before
// the entry is reclaimed.
export const TERMINAL_GRACE_MS = 5 * 60 * 1000;

export interface PendingEntry<S, M> {
  readonly id: string;
  state: S;
  // null while pending (never pruned); the settle timestamp once terminal
  // (eligible for grace-window reclaim).
  settledAt: number | null;
  readonly meta: M;
}

export class PendingStore<S, M> {
  private entries = new Map<string, PendingEntry<S, M>>();
  private clock: Clock;
  private graceMs: number;

  constructor(clock: Clock, graceMs: number = TERMINAL_GRACE_MS) {
    this.clock = clock;
    this.graceMs = graceMs;
  }

  add(id: string, state: S, meta: M): void {
    this.entries.set(id, { id, state, settledAt: null, meta });
  }

  get(id: string): PendingEntry<S, M> | undefined {
    return this.entries.get(id);
  }

  all(): IterableIterator<PendingEntry<S, M>> {
    return this.entries.values();
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  isPending(entry: PendingEntry<S, M>): boolean {
    return entry.settledAt === null;
  }

  // Move a still-pending entry to a terminal state, stamping settledAt. No-op
  // (false) if the entry is absent or already terminal — this is what makes
  // "first settle wins" hold (a second answer/dismiss cannot overwrite).
  settle(id: string, state: S): boolean {
    const e = this.entries.get(id);
    if (!e || e.settledAt !== null) return false;
    e.state = state;
    e.settledAt = this.clock.now();
    return true;
  }

  // Pending→pending state change (e.g. queued→delivered) that must NOT settle.
  // No-op (false) if absent or already terminal.
  transition(id: string, state: S): boolean {
    const e = this.entries.get(id);
    if (!e || e.settledAt !== null) return false;
    e.state = state;
    return true;
  }

  // Reclaim terminal entries older than the grace window. Pending entries
  // (settledAt === null) are NEVER touched. Services call this from register/poll.
  sweep(): void {
    const cutoff = this.clock.now() - this.graceMs;
    for (const [id, e] of this.entries) {
      if (e.settledAt !== null && e.settledAt < cutoff) this.entries.delete(id);
    }
  }
}
