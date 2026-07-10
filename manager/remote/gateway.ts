// Remote gateway driver (relay v3). ONE surface: a per-device relay session.
// With encryption removed there is no handshake — the relay's `join` admission
// (SHA-256(bearer) membership) is the whole auth step. When the relay acks a
// join, the daemon immediately spins up a live session: control frames dispatch
// into the EXISTING route handlers while the EventBus fans out as plaintext
// `event` frames.
//
// A `data (0x01)` envelope's payload is plaintext UTF-8 JSON (§5) — the relay,
// which you self-host, can see it (the explicit trade of removing AEAD). There
// is no per-action step-up and no reduced-capability tier: every session is
// dispatched at full capability, gated only by the REFUSED set + the ✦ ui-token.

import { randomBytes } from "node:crypto";

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { FrameType, Dir, MAX_ENVELOPE_BYTES, encodeJsonEnvelope, parseEnvelope, type Envelope } from "./envelope.ts";
import { encodeServerFrame, decodeClientFrame } from "./framer.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "./dispatch.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "./WsBridge.ts";
import type { RemoteAuditLog } from "./audit.ts";

// Every relay session holds the full capability set — "mutate" gates the local
// ui-token for ✦ routes. "highrisk" is retained for completeness but is no longer
// checked in dispatch (HIGH routes pass for any joined session); there is no
// step-up tier to withhold anymore (no SE key), so a joined device gets them all.
export const SESSION_CAPS = ["read", "lowrisk", "mutate", "highrisk"] as const;

export interface GatewayDeps {
  audit: RemoteAuditLog;
  uiToken: string;
  routeDispatch: RouteDispatch;
  bus: EventBus;
  room: string;
  now: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

// Drives ONE device connection: on join-ack (relay-assigned clientId) go live
// immediately, then dispatch each incoming `data` frame. `send` writes a raw
// outer-envelope buffer to the transport (the relay's s2c pipe).
export class GatewayConnection {
  private readonly deps: GatewayDeps;
  private readonly bridge: WsBridge;
  private readonly send: (buf: Buffer) => void;
  private readonly close: (reason?: string) => void;
  private readonly clientId: Buffer;
  private readonly dispatcher: ControlDispatcher;
  private session: RemoteSession | null = null;
  private readonly joinAck: boolean;
  // The relay never tells the daemon a device left (its error frames carry no
  // clientId), so liveness is inferred from inbound traffic: the phone sends a
  // ka every 20s while its socket is open, and hello/control frames count too.
  // wire.ts sweeps sessions whose lastActivityAt is older than the idle TTL.
  private lastActivity: number;

  constructor(args: {
    deps: GatewayDeps; bridge: WsBridge;
    send: (buf: Buffer) => void; close: (reason?: string) => void; clientId?: Buffer;
    joinAck?: boolean;
  }) {
    this.deps = args.deps;
    this.bridge = args.bridge;
    this.send = args.send;
    this.close = args.close;
    this.clientId = args.clientId ?? randomBytes(16);
    this.joinAck = args.joinAck ?? true;
    this.lastActivity = args.deps.now();
    this.dispatcher = new ControlDispatcher({
      routeDispatch: args.deps.routeDispatch, audit: args.deps.audit,
      uiToken: args.deps.uiToken, now: args.deps.now,
    });
  }

  // Relay mode: the relay is the clientId authority and already sent the join-ack
  // to both peers, so the daemon goes live straight away (joinAck defaults false
  // from the relay wiring). The LAN-style self-ack path is kept only for a caller
  // that owns clientId assignment itself.
  start(): void {
    if (this.joinAck) {
      this.send(encodeJsonEnvelope({
        type: FrameType.relayctl, room: this.deps.room, dir: Dir.s2c, clientId: this.clientId,
        json: { t: "joined", clientId: this.clientId.toString("base64url"), room: this.deps.room },
      }));
    }
    this.goLive();
  }

  private goLive(): void {
    if (this.session) return;
    this.session = {
      id: this.clientId.toString("hex"),
      send: (f: ServerFrame) => this.send(encodeServerFrame({ room: this.deps.room, clientId: this.clientId, frame: f })),
      close: (reason?: string) => this.close(reason),
    };
    this.bridge.add(this.session);
    this.deps.log?.("remote device live", { clientId: this.session.id });
  }

  onMessage(buf: Buffer): void {
    if (buf.length > MAX_ENVELOPE_BYTES) { this.fail("FRAME_TOO_LARGE"); return; }
    let env: Envelope;
    try { env = parseEnvelope(buf); } catch { return; }
    this.onEnvelope(env);
  }

  lastActivityAt(): number { return this.lastActivity; }

  onEnvelope(env: Envelope): void {
    if (env.type !== FrameType.data) return; // gateway only consumes data-typed frames
    this.lastActivity = this.deps.now();
    void this.onLiveFrame(env).catch((e) =>
      this.deps.log?.("remote dispatch error", { error: e instanceof Error ? e.message : String(e) }));
  }

  private async onLiveFrame(env: Envelope): Promise<void> {
    const frame = decodeClientFrame(env);
    if (!frame) { this.deps.log?.("remote frame rejected (bad shape)", {}); return; }
    if (frame.t === "ka") return;
    if (frame.t === "hello") { await this.sendSnapshot(); return; } // §5.4.3: resume / seq-gap recovery
    const ds: DispatchSession = { devId: this.clientId.toString("hex"), hasCap: (c) => SESSION_CAPS.includes(c as typeof SESSION_CAPS[number]) };
    const reply = await this.dispatcher.handle(ds, frame);
    this.deps.log?.("remote control", { method: frame.method, path: frame.path, status: reply.t === "reply" ? reply.status : reply.t });
    this.session?.send(reply);
  }

  // Answer a `hello` with a full §5.4.3 snapshot: the device declared a resume
  // cursor (reconnect) or detected a seq gap; either way a full re-seed from the
  // authoritative list routes is the recovery. `seq` carries the bridge cursor at
  // snapshot time so the device resumes gap detection from here.
  private async sendSnapshot(): Promise<void> {
    const [w, p] = await Promise.all([
      this.deps.routeDispatch({ method: "GET", path: "/workers", body: {} }),
      this.deps.routeDispatch({ method: "GET", path: "/pending", body: {} }),
    ]);
    const rows = (r: typeof w): unknown[] => ("body" in r && Array.isArray(r.body) ? r.body : []);
    this.session?.send({ t: "snapshot", seq: this.bridge.currentSeq(), workers: rows(w), pending: rows(p) });
    this.deps.log?.("remote snapshot sent", { workers: rows(w).length, pending: rows(p).length });
  }

  private fail(code: string): void {
    this.deps.log?.("remote connection rejected", { code });
    this.close(code);
  }

  dispose(): void {
    if (this.session) this.bridge.remove(this.session.id);
  }
}
