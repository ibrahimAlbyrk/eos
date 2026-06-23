// In-memory registry for worker→worker consultations (the ask_peer MCP tool).
// Same register→poll shape as PendingQuestionService, but the answer producer
// is the target peer's agent (via respond_to_peer), not a human — so a request
// also carries a delivery lifecycle: [awaiting (target named but not spawned
// yet) →] queued (target known, not yet in the peer's PTY) → delivered (the
// PeerRequestPump put it in the peer's PTY for a turn) → answered/declined/gone
// (terminal). The no-TTL pending + terminal-grace + first-settle-wins lifecycle
// is the shared PendingStore; this service adds the peer-specific states, the
// awaiting→queued bind (tryBind) + deadline expiry, the queued→delivered
// transition, by-target queries and the deadlock guard. awaiting reads as
// "pending" to the asker — its ask_peer poll loop blocks the same way.
//
// Invariant: at most ONE delivered request per target at a time — the pump only
// delivers the next queued one once the current resolves or auto-declines. That
// is what lets respond_to_peer omit a requestId (no ambiguity about which).

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { PeerRef } from "../../contracts/src/http.ts";
import { resolvePeerRef } from "../../core/src/services/Peers.ts";
import { PendingStore } from "./PendingStore.ts";

// Fallback wait window for an awaiting consult whose target never spawns. The
// route passes the configured value (collaborate.awaitTimeoutMs); this is only
// the standalone/unit default.
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

export type PeerRequestState =
  // awaiting: the consult names a peer that isn't present yet. It carries the
  // ref so tryBind can re-resolve it as siblings arrive, and a deadline so a
  // peer that never shows up declines instead of hanging the asker forever.
  | { status: "awaiting"; ref: PeerRef; deadline: number }
  | { status: "queued" }
  | { status: "delivered" }
  | { status: "answered"; answer: string }
  | { status: "declined"; reason: string }
  | { status: "gone" };

// What a poller (the asker's ask_peer loop) sees. awaiting/queued/delivered all
// read as "pending" — the asker doesn't care whether its target has spawned, the
// question reached it, or it's still waiting; only the terminal states differ.
export type PeerRequestPoll =
  | { status: "pending" }
  | { status: "answered"; answer: string }
  | { status: "declined"; reason: string }
  | { status: "gone" };

interface PeerMeta {
  from: string;
  // null while awaiting (the target peer isn't resolved yet); set to the bound
  // worker id once tryBind matches a sibling, or at register for a known target.
  to: string | null;
  // The asker's parent (collaboration group) — set on awaiting entries so tryBind
  // only re-resolves consults within the group a newly-spawned worker joined.
  parentId: string | null;
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
  private clock: Clock;
  private awaitTimeoutMs: number;

  constructor(ids: IdGenerator, clock: Clock, awaitTimeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS) {
    this.ids = ids;
    this.clock = clock;
    this.awaitTimeoutMs = awaitTimeoutMs;
    this.store = new PendingStore<PeerRequestState, PeerMeta>(clock);
  }

  // Per-tick maintenance shared by every public method: reclaim terminal entries
  // past the grace window AND decline awaiting consults whose wait window expired.
  private maintain(): void {
    this.store.sweep();
    const now = this.clock.now();
    for (const e of this.store.all()) {
      if (e.state.status === "awaiting" && now >= e.state.deadline) {
        this.store.settle(e.id, {
          status: "declined",
          reason: "no peer matching your request joined within the wait window — proceed on your best judgment, or finish with a 'needs input:'/'failed:' report if you are truly blocked",
        });
      }
    }
  }

  // The target is a known, live sibling — consult it now (queued for the pump).
  register(from: string, to: string, question: string): { requestId: string } {
    this.maintain();
    const requestId = this.ids.newRequestId();
    this.store.add(requestId, { status: "queued" }, { from, to, parentId: null, question });
    return { requestId };
  }

  // The target peer isn't present yet. Park the consult (reads as "pending" to
  // the asker) until tryBind matches a sibling or the deadline expires.
  registerAwaiting(from: string, parentId: string, ref: PeerRef, question: string): { requestId: string } {
    this.maintain();
    const requestId = this.ids.newRequestId();
    const deadline = this.clock.now() + this.awaitTimeoutMs;
    this.store.add(requestId, { status: "awaiting", ref, deadline }, { from, to: null, parentId, question });
    return { requestId };
  }

  poll(requestId: string): PeerRequestPoll {
    this.maintain();
    const e = this.store.get(requestId);
    if (!e) return { status: "gone" };
    switch (e.state.status) {
      case "awaiting":
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
    this.maintain();
    for (const e of this.store.all()) {
      if (e.meta.to === to && e.state.status === "queued") {
        return { requestId: e.id, from: e.meta.from, to, question: e.meta.question };
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
  // a mutual/transitive cycle — we must prevent it at register/bind. The pending
  // requests with a known target are the wait-for edges (from→to); reject if `to`
  // already reaches `from`. Awaiting entries (to === null) are not yet edges.
  wouldDeadlock(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack: string[] = [to];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === from) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const e of this.store.all()) {
        if (this.store.isPending(e) && e.meta.to != null && e.meta.from === node) stack.push(e.meta.to);
      }
    }
    return false;
  }

  // A worker just joined the mesh — re-resolve every awaiting consult in its
  // collaboration group. A consult whose ref now matches a live sibling binds
  // (→ queued, so the pump delivers it); one that would close a circular wait or
  // is no longer allowed declines. Returns the ids of newly-bound targets so the
  // caller can nudge the pump for any that are already IDLE. Still-unresolved
  // consults stay awaiting until a later arrival or the deadline.
  tryBind(parentId: string, workers: Pick<WorkerRepo, "findById" | "listByParent">): string[] {
    this.maintain();
    const boundTargets: string[] = [];
    for (const e of [...this.store.all()]) {
      if (e.state.status !== "awaiting" || e.meta.parentId !== parentId) continue;
      const res = resolvePeerRef(workers, e.meta.from, e.state.ref);
      if (res.kind === "absent") continue;
      if (res.kind === "denied") {
        this.store.settle(e.id, { status: "declined", reason: res.reason });
        continue;
      }
      const targetId = res.target.id;
      if (this.wouldDeadlock(e.meta.from, targetId)) {
        this.store.settle(e.id, {
          status: "declined",
          reason: `consulting ${res.target.name ?? targetId} would create a circular wait — answer from what you already have, or restructure`,
        });
        continue;
      }
      e.meta.to = targetId;
      this.store.transition(e.id, { status: "queued" });
      boundTargets.push(targetId);
    }
    return boundTargets;
  }
}
