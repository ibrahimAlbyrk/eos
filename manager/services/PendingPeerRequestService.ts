// In-memory registry for worker→worker consultations (the ask_peer MCP tool).
// Same register→poll shape as PendingQuestionService, but the answer producer
// is the target peer's agent (via respond_to_peer), not a human — so a request
// also carries a delivery lifecycle: queued (registered, not yet in the peer's
// PTY) → delivered (the PeerRequestPump put it in the peer's PTY for a turn) →
// answered/declined/gone (terminal). A pending request has no TTL; the asker
// blocks in its tool call (MCP_TOOL_TIMEOUT is lifted platform-wide) until a
// terminal state, the peer dies, or the daemon restarts (lost map → "gone").
// A TERMINAL request is kept for a short grace window (not deleted on read) so a
// retried poll after a lost response still sees the answer — ask_peer's poll
// loop swallows transient GET failures and retries — then pruned so settled
// consultations can't pile up on a persistent orchestrator. Mirrors
// PendingQuestionService exactly.
//
// Invariant: at most ONE delivered request per target at a time — the pump only
// delivers the next queued one once the current resolves or auto-declines. That
// is what lets respond_to_peer omit a requestId (no ambiguity about which).

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";

// Comfortably longer than the ask_peer poll interval (2.5s) so the asker always
// reads its answer before the entry is reclaimed.
const TERMINAL_GRACE_MS = 5 * 60 * 1000;

export type PeerRequestState =
  | { status: "queued" }
  | { status: "delivered" }
  | { status: "answered"; answer: string }
  | { status: "declined"; reason: string }
  | { status: "gone" };

// What a poller (the asker's ask_peer loop) sees. queued/delivered both read as
// "pending" — the asker doesn't care whether its question reached the peer yet.
export type PeerRequestPoll =
  | { status: "pending" }
  | { status: "answered"; answer: string }
  | { status: "declined"; reason: string }
  | { status: "gone" };

interface PeerRequestEntry {
  requestId: string;
  from: string;
  to: string;
  question: string;
  state: PeerRequestState;
  // Set when the entry reaches a terminal state; null while queued/delivered.
  // Only terminal entries are eligible for grace-window pruning.
  settledAt: number | null;
}

function isPending(s: PeerRequestState): boolean {
  return s.status === "queued" || s.status === "delivered";
}

export class PendingPeerRequestService {
  private entries = new Map<string, PeerRequestEntry>();
  private ids: IdGenerator;
  private clock: Clock;

  constructor(ids: IdGenerator, clock: Clock) {
    this.ids = ids;
    this.clock = clock;
  }

  register(from: string, to: string, question: string): { requestId: string } {
    this.sweepStaleTerminal();
    const requestId = this.ids.newRequestId();
    this.entries.set(requestId, { requestId, from, to, question, state: { status: "queued" }, settledAt: null });
    return { requestId };
  }

  poll(requestId: string): PeerRequestPoll {
    this.sweepStaleTerminal();
    const e = this.entries.get(requestId);
    if (!e) return { status: "gone" };
    switch (e.state.status) {
      case "queued":
      case "delivered":
        return { status: "pending" };
      case "answered":
        return { status: "answered", answer: e.state.answer };
      case "declined":
        return { status: "declined", reason: e.state.reason };
      case "gone":
        return { status: "gone" };
    }
  }

  // Pump: the oldest queued request addressed to `to` (insertion order). Null
  // when none is waiting.
  nextQueuedFor(to: string): PeerRequestEntry | null {
    for (const e of this.entries.values()) {
      if (e.to === to && e.state.status === "queued") return e;
    }
    return null;
  }

  markDelivered(requestId: string): void {
    const e = this.entries.get(requestId);
    if (e && e.state.status === "queued") e.state = { status: "delivered" };
  }

  // respond_to_peer: resolve the single delivered request addressed to `to`.
  // Returns the resolved request's id+asker, or null if there was none (the
  // asker vanished, or the peer answered without an in-flight request).
  resolveDelivered(to: string, answer: string): { requestId: string; from: string } | null {
    for (const e of this.entries.values()) {
      if (e.to === to && e.state.status === "delivered") {
        e.state = { status: "answered", answer };
        e.settledAt = this.clock.now();
        return { requestId: e.requestId, from: e.from };
      }
    }
    return null;
  }

  // Pump: the peer reached IDLE with a delivered request still unanswered — it
  // ended its turn without calling respond_to_peer. Decline so the asker
  // unblocks. No-op when the request was already answered in the same turn.
  declineDelivered(to: string, reason: string): boolean {
    for (const e of this.entries.values()) {
      if (e.to === to && e.state.status === "delivered") {
        e.state = { status: "declined", reason };
        e.settledAt = this.clock.now();
        return true;
      }
    }
    return false;
  }

  // Worker died/interrupted/cleared. Its outbound requests are dropped (it is no
  // longer waiting); its inbound pending requests go "gone" so their askers
  // unblock instead of waiting on a peer that will never answer.
  cancelByWorker(workerId: string): void {
    for (const [requestId, e] of this.entries) {
      if (e.from === workerId) {
        this.entries.delete(requestId);
      } else if (e.to === workerId && isPending(e.state)) {
        e.state = { status: "gone" };
        e.settledAt = this.clock.now();
      }
    }
  }

  // Reclaim terminal (answered/declined/gone) entries older than the grace
  // window. Pending entries (settledAt === null) are NEVER touched — a request
  // may wait indefinitely for the peer to answer.
  private sweepStaleTerminal(): void {
    const cutoff = this.clock.now() - TERMINAL_GRACE_MS;
    for (const [requestId, e] of this.entries) {
      if (e.settledAt !== null && e.settledAt < cutoff) this.entries.delete(requestId);
    }
  }

  // Would registering from→to close a circular wait? A worker blocked in
  // ask_peer is mid-turn (never IDLE), so the pump's auto-decline cannot break
  // a mutual/transitive cycle — we must prevent it at register. The pending
  // requests are the wait-for edges (from→to); reject if `to` already reaches
  // `from`.
  wouldDeadlock(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack: string[] = [to];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === from) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const e of this.entries.values()) {
        if (isPending(e.state) && e.from === node) stack.push(e.to);
      }
    }
    return false;
  }
}
