// WsBridge — the remote edge's EventBus↔frame fan-out (design §6.2). This is the
// SKELETON: it mirrors SseBroadcaster (subscribe to the bus "*" fan-out, push to
// every connected remote session) but adds the monotonic `seq` cursor the
// resumable WS contract needs, and emits typed inner frames (§4.2) instead of
// SSE `change` events.
//
// NOT YET WIRED: the per-session AEAD codec, the SIGMA handshake, and the
// control-dispatch shim into manager/routes/* all land in the next phase. A
// RemoteSession here is the post-handshake abstraction — WsBridge hands it
// plaintext inner frames; the session is responsible for sealing + framing.

import type { EventBus, EventBusMessage } from "../../core/src/ports/EventBus.ts";

// One server→client inner frame (§4.2), pre-encryption. `seq` is stamped by the
// bridge; the session adds the AEAD/envelope layer.
export type ServerFrame =
  | { t: "event"; seq: number; reason: string; ts: number; payload: unknown }
  | { t: "patch"; seq: number; resource: string; op: "upsert" | "remove"; data: unknown }
  | { t: "snapshot"; seq: number; workers: unknown; pending: unknown }
  | { t: "reply"; correlationId: string; status: number; body: unknown }
  | { t: "ka"; ts: number };

// A handshake-complete remote peer. The codec/transport is the session's job;
// the bridge only feeds it plaintext frames.
export interface RemoteSession {
  readonly id: string; // clientId (relay-assigned or daemon-assigned on LAN)
  send(frame: ServerFrame): void;
  close(reason?: string): void;
}

export interface WsBridgeOptions {
  bus: EventBus;
  now: () => number;
}

export class WsBridge {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly opts: WsBridgeOptions;
  private seq = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: WsBridgeOptions) {
    this.opts = opts;
  }

  // Arm the bus subscription. Called when remote is enabled (mode != off); idle
  // and allocation-free while no sessions are connected.
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.subscribe("*", (msg) => this.onBusMessage(msg));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const s of this.sessions.values()) s.close("bridge stopped");
    this.sessions.clear();
  }

  add(session: RemoteSession): void { this.sessions.set(session.id, session); }
  remove(id: string): void { this.sessions.delete(id); }
  get(id: string): RemoteSession | undefined { return this.sessions.get(id); }
  size(): number { return this.sessions.size; }

  // Monotonic per-bridge content cursor. The seq lets a reconnecting device
  // detect a gap (SEQ_GAP → request a snapshot) — distinct from the per-frame
  // AEAD seq, which is per-(direction,epoch).
  nextSeq(): number { return ++this.seq; }
  currentSeq(): number { return this.seq; }

  private onBusMessage(msg: EventBusMessage): void {
    if (this.sessions.size === 0) return; // nothing to fan out to
    const frame: ServerFrame = {
      t: "event",
      seq: this.nextSeq(),
      reason: msg.topic,
      ts: this.opts.now(),
      payload: msg.payload,
    };
    this.broadcast(frame);
  }

  private broadcast(frame: ServerFrame): void {
    for (const s of this.sessions.values()) {
      try { s.send(frame); } catch { this.sessions.delete(s.id); }
    }
  }
}
