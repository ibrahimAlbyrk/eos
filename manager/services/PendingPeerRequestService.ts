// In-memory registry for worker→worker consultations (the ask_peer MCP tool).
// Same register→poll shape as PendingQuestionService, but the answer producer
// is the target peer's agent (via respond_to_peer), not a human — so a request
// also carries a delivery lifecycle: queued (registered, not yet in the peer's
// PTY) → delivered (the PeerRequestPump put it in the peer's PTY for a turn) →
// answered/declined/gone (terminal). The no-TTL pending + terminal-grace +
// first-settle-wins lifecycle is the shared PendingStore; this service adds the
// peer-specific states, the queued→delivered transition, by-target queries and
// the deadlock guard.
//
// Invariant: at most ONE delivered request per target at a time — the pump only
// delivers the next queued one once the current resolves or auto-declines. That
// is what lets respond_to_peer omit a requestId (no ambiguity about which).

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import { PendingStore } from "./PendingStore.ts";

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

interface PeerMeta {
  from: string;
  to: string;
  question: string;
}

// What nextQueuedFor hands the pump. Keeps the original field names so the pump
// call sites (daemon.ts) don't change.
export interface QueuedPeerRequest {
  requestId: string;
  from: string;
  to: string;
  question: string;
}

export class PendingPeerRequestService {
  private store: PendingStore<PeerRequestState, PeerMeta>;
  private ids: IdGenerator;

  constructor(ids: IdGenerator, clock: Clock) {
    this.ids = ids;
    this.store = new PendingStore<PeerRequestState, PeerMeta>(clock);
  }

  register(from: string, to: string, question: string): { requestId: string } {
    this.store.sweep();
    const requestId = this.ids.newRequestId();
    this.store.add(requestId, { status: "queued" }, { from, to, question });
    return { requestId };
  }

  poll(requestId: string): PeerRequestPoll {
    this.store.sweep();
    const e = this.store.get(requestId);
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
  nextQueuedFor(to: string): QueuedPeerRequest | null {
    for (const e of this.store.all()) {
      if (e.meta.to === to && e.state.status === "queued") {
        return { requestId: e.id, from: e.meta.from, to: e.meta.to, question: e.meta.question };
      }
    }
    return null;
  }

  markDelivered(requestId: string): void {
    const e = this.store.get(requestId);
    if (e && e.state.status === "queued") this.store.transition(requestId, { status: "delivered" });
  }

  // respond_to_peer: resolve the single delivered request addressed to `to`.
  // Returns the resolved request's id+asker, or null if there was none (the
  // asker vanished, or the peer answered without an in-flight request).
  resolveDelivered(to: string, answer: string): { requestId: string; from: string } | null {
    for (const e of this.store.all()) {
      if (e.meta.to === to && e.state.status === "delivered") {
        this.store.settle(e.id, { status: "answered", answer });
        return { requestId: e.id, from: e.meta.from };
      }
    }
    return null;
  }

  // Pump: the peer reached IDLE with a delivered request still unanswered — it
  // ended its turn without calling respond_to_peer. Decline so the asker
  // unblocks. No-op when the request was already answered in the same turn.
  declineDelivered(to: string, reason: string): boolean {
    for (const e of this.store.all()) {
      if (e.meta.to === to && e.state.status === "delivered") {
        return this.store.settle(e.id, { status: "declined", reason });
      }
    }
    return false;
  }

  // Worker died/interrupted/cleared. Its outbound requests are dropped (it is no
  // longer waiting); its inbound pending requests go "gone" so their askers
  // unblock instead of waiting on a peer that will never answer.
  cancelByWorker(workerId: string): void {
    for (const e of [...this.store.all()]) {
      if (e.meta.from === workerId) {
        this.store.delete(e.id);
      } else if (e.meta.to === workerId && this.store.isPending(e)) {
        this.store.settle(e.id, { status: "gone" });
      }
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
      for (const e of this.store.all()) {
        if (this.store.isPending(e) && e.meta.from === node) stack.push(e.meta.to);
      }
    }
    return false;
  }
}
