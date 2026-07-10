// WsBridge — the remote edge's EventBus↔frame fan-out (§5.4). It mirrors
// SseBroadcaster (subscribe to the bus "*" fan-out, push to every connected
// remote session) but adds the monotonic `seq` cursor the resumable contract
// needs, and emits typed plaintext inner frames (§5.4) instead of SSE `change`
// events. A RemoteSession here is the live per-device peer — WsBridge hands it a
// server frame; the session serializes it into a `data` envelope (framer.ts).

import type { EventBus, EventBusMessage } from "../../core/src/ports/EventBus.ts";
import type { AssetFrame, EventFrame, PatchFrame, RemoteErrorCode, SnapshotFrame } from "../../contracts/src/remote.ts";

// One server→client inner frame (§5.4), plaintext. `seq` is stamped by the
// bridge; the session wraps it in the outer envelope. `asset` carries binary
// route reads out-of-band as base64 (§5.4.5) — it is correlationId-addressed
// like `reply`, not seq-stamped like the fan-out frames. `error` fails a specific
// pending control (with correlationId) or the session (without).
export type ServerFrame =
  | EventFrame
  | PatchFrame
  | SnapshotFrame
  | { t: "reply"; correlationId: string; status: number; body: unknown }
  | AssetFrame
  | { t: "error"; code: RemoteErrorCode; message?: string; correlationId?: string }
  | { t: "ka"; ts: number };

// A live remote peer. The transport/framing is the session's job; the bridge only
// feeds it plaintext frames.
export interface RemoteSession {
  readonly id: string; // clientId (relay-assigned)
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

  // Arm the bus subscription. Called when remote is enabled; idle and
  // allocation-free while no sessions are connected.
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
  // detect a gap (missed events → request a snapshot). Ordering only, not a
  // security boundary (§5.4.1).
  nextSeq(): number { return ++this.seq; }
  currentSeq(): number { return this.seq; }

  // Broadcast one §5.4.2 patch to every live session (StatePatcher's emit hook).
  pushPatch(resource: PatchFrame["resource"], op: PatchFrame["op"], data: unknown): void {
    if (this.sessions.size === 0) return;
    this.broadcast({ t: "patch", seq: this.nextSeq(), resource, op, data });
  }

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
