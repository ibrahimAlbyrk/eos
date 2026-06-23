// Remote gateway mount (design §2.2, §6.2). The ONE network surface: a /ws
// upgrade on the daemon's existing listener. Admission is the per-device bearer;
// the connection then runs a per-device SIGMA handshake, and once live, control
// frames dispatch into the EXISTING route handlers while the EventBus fans out
// as sealed event frames. Off-box reachability is bounded to exactly this
// upgrade by the loopback-lock middleware (which never sees upgrades).
//
// LAN-direct mode wires this onto the daemon's server.on("upgrade"); relay mode
// drives the same per-connection driver from RelayConnector callbacks. This file
// owns the connection state machine; the transport binding is the caller's.

import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, createHash } from "node:crypto";

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { parseEnvelope, encodeEnvelope, encodeJsonEnvelope, FrameType, Dir, MAX_ENVELOPE_BYTES, type Envelope } from "./envelope.ts";
import { RemoteSessionCodec } from "./session.ts";
import { HandshakeServer, type HandshakeContext } from "./handshake.ts";
import { handleResume } from "./resume.ts";
import { ChallengeStore } from "./stepup.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "./dispatch.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "./WsBridge.ts";
import type { MacIdentity, DeviceKeyring } from "./keyring.ts";
import type { TicketStore } from "./tickets.ts";
import type { RemoteAuditLog } from "./audit.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";

function sha256Hex(s: string): string { return createHash("sha256").update(s).digest("hex"); }

export interface PairingProvider {
  // The current one-time pairing bearer hash (hex), or null when no offer armed.
  pairingBearerHash(): string | null;
  // The one-time secret for the active offer, consumed on a successful pair.
  ots(): Buffer | null;
  burn(): void;
}

export interface GatewayDeps {
  identity: MacIdentity;
  keyring: DeviceKeyring;
  tickets: TicketStore;
  audit: RemoteAuditLog;
  uiToken: string;
  routeDispatch: RouteDispatch;
  bus: EventBus;
  room: string;
  now: () => number;
  pairing: PairingProvider;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

// Admission: a bearer is allowed if it is an enrolled device bearer OR the
// current one-time pairing bearer. Constant-time over the candidate hashes.
function bearerAdmitted(bearer: string, deps: GatewayDeps): "device" | "pairing" | null {
  const h = sha256Hex(bearer);
  for (const allowed of deps.keyring.bearerHashAllowlist()) {
    if (constantTimeEqual(h, allowed)) return "device";
  }
  const pair = deps.pairing.pairingBearerHash();
  if (pair && constantTimeEqual(h, pair)) return "pairing";
  return null;
}

// Drives ONE device connection through join-ack → handshake → live dispatch.
// `send` writes a raw outer-envelope buffer to the transport.
export class GatewayConnection {
  private readonly deps: GatewayDeps;
  private readonly bridge: WsBridge;
  private readonly send: (buf: Buffer) => void;
  private readonly close: (reason?: string) => void;
  private readonly clientId: Buffer;
  private readonly dispatcher: ControlDispatcher;
  private hs: HandshakeServer | null = null;
  private codec: RemoteSessionCodec | null = null;
  private challenges = new ChallengeStore();
  private session: RemoteSession | null = null;
  private readonly joinAck: boolean;

  constructor(args: {
    deps: GatewayDeps; bridge: WsBridge;
    send: (buf: Buffer) => void; close: (reason?: string) => void; clientId?: Buffer;
    // LAN: the daemon assigns the clientId + sends the join-ack. Relay: the relay
    // already assigned + acked, so we suppress it.
    joinAck?: boolean;
  }) {
    this.deps = args.deps;
    this.bridge = args.bridge;
    this.send = args.send;
    this.close = args.close;
    this.clientId = args.clientId ?? randomBytes(16);
    this.joinAck = args.joinAck ?? true;
    this.dispatcher = new ControlDispatcher({
      routeDispatch: args.deps.routeDispatch, keyring: args.deps.keyring,
      audit: args.deps.audit, uiToken: args.deps.uiToken, now: args.deps.now,
    });
  }

  // LAN: the daemon is the clientId authority and join-acks before any hs frame.
  start(): void {
    const ctx: HandshakeContext = { room: this.deps.room, clientId: this.clientId, ots: this.deps.pairing.ots() ?? undefined };
    this.hs = new HandshakeServer(
      { identity: this.deps.identity, keyring: this.deps.keyring, tickets: this.deps.tickets, now: this.deps.now, burnOts: () => this.deps.pairing.burn() },
      ctx,
    );
    if (this.joinAck) {
      this.send(encodeJsonEnvelope({
        type: FrameType.relayctl, room: this.deps.room, dir: Dir.s2c, clientId: this.clientId,
        json: { t: "joined", clientId: this.clientId.toString("base64url"), room: this.deps.room },
      }));
    }
  }

  // Feed one raw inbound outer-envelope buffer (LAN). Relay mode hands a
  // pre-parsed envelope to onEnvelope directly.
  onMessage(buf: Buffer): void {
    if (buf.length > MAX_ENVELOPE_BYTES) { this.fail("FRAME_TOO_LARGE"); return; }
    let env;
    try { env = parseEnvelope(buf); } catch { return; }
    this.onEnvelope(env);
  }

  onEnvelope(env: Envelope): void {
    if (env.type !== FrameType.data) return; // gateway only consumes data-typed frames
    if (!this.codec) { this.onHandshakeFrame(env.payload); return; }
    void this.onLiveFrame(env).catch((e) =>
      this.deps.log?.("remote dispatch error", { error: e instanceof Error ? e.message : String(e) }));
  }

  private onHandshakeFrame(payload: Buffer): void {
    let frame: { t?: unknown };
    try { frame = JSON.parse(payload.toString("utf8")); } catch { this.fail("DECRYPT_FAIL"); return; }
    if (frame?.t === "resume") { this.onResume(frame); return; }

    const result = this.hs!.handle(frame);
    if (result.kind === "error") { this.fail(result.code); return; }
    if (result.kind === "reply") {
      this.sendCleartext(result.frame);
      return;
    }
    // Complete: switch to the live record codec and deliver the welcome.
    this.goLive(result.codec, result.devId);
    this.send(this.codec!.seal({ t: "reply", correlationId: "pair", status: 200, body: result.welcome }));
  }

  private onResume(frame: unknown): void {
    const result = handleResume(
      { tickets: this.deps.tickets, now: this.deps.now },
      { room: this.deps.room, clientId: this.clientId },
      frame,
    );
    if (result.kind === "error") { this.fail(result.code); return; }
    this.goLive(result.codec, result.devId);
    // RES-2 rides cleartext like the hs frames; the new ticket inside encTicket
    // is sealed with the dedicated K_resume_ticket key, not the traffic key.
    this.sendCleartext(result.frame);
  }

  private goLive(codec: RemoteSessionCodec, devId: string): void {
    this.codec = codec;
    this.session = {
      id: this.clientId.toString("hex"),
      send: (f: ServerFrame) => this.send(this.codec!.seal(f)),
      close: (reason?: string) => this.close(reason),
    };
    this.bridge.add(this.session);
    this.deps.log?.("remote device live", { clientId: this.session.id, devId });
  }

  // A pre-traffic-key frame (hs reply / resume-ok): the JSON rides cleartext in a
  // type=0x01 envelope; the relay never inspects it.
  private sendCleartext(frame: object): void {
    this.send(encodeEnvelope({
      type: FrameType.data, dir: Dir.s2c, epoch: 0, seq: 0n,
      room: this.deps.room, clientId: this.clientId,
      payload: Buffer.from(JSON.stringify(frame), "utf8"),
    }));
  }

  private async onLiveFrame(env: ReturnType<typeof parseEnvelope>): Promise<void> {
    const opened = this.codec!.open(env);
    if (!opened.ok) {
      // A live frame that won't open is a real interop signal (seq/AAD/key) — log
      // it so a failed control round-trip isn't silent.
      this.deps.log?.("remote live-frame rejected", { code: opened.code, seq: env.seq.toString() });
      this.sendError(opened.code);
      return;
    }
    const frame = opened.frame;
    if (frame.t === "ka") { return; }
    if (frame.t === "hello") { return; } // resume/snapshot handled in a later phase
    // control
    const ds: DispatchSession = {
      devId: this.codec!.devId, sessionTH: this.codec!.sessionTH,
      challenges: this.challenges, hasCap: (c) => this.codec!.hasCap(c),
    };
    const reply = await this.dispatcher.handle(ds, frame);
    this.deps.log?.("remote control", { method: frame.method, path: frame.path, status: reply.t === "reply" ? reply.status : reply.t });
    this.send(this.codec!.seal(reply));
  }

  private sendError(code: string): void {
    // Pre-handshake we cannot seal; post-handshake send a sealed error frame.
    if (this.codec) {
      this.send(this.codec.seal({ t: "reply", correlationId: "", status: 400, body: { error: code } } as ServerFrame));
    }
  }

  private fail(code: string): void {
    this.deps.log?.("remote connection rejected", { code });
    this.close(code);
  }

  dispose(): void {
    if (this.session) this.bridge.remove(this.session.id);
  }
}

// Mount the LAN-direct /ws gateway onto the daemon's HTTP server. Returns a stop
// handle. Inert unless called (the daemon calls it only when remote mode != off).
export function mountWsGateway(server: Server, deps: GatewayDeps): { stop: () => void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ENVELOPE_BYTES + 1024 });
  const bridge = new WsBridge({ bus: deps.bus, now: deps.now });
  bridge.start();

  const onUpgrade = (req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return; // not ours — leave for any other upgrade handler
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const admittedAs = bearer ? bearerAdmitted(bearer, deps) : null;
    if (!admittedAs) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = "nodebuffer";
      void admittedAs; // admission already enforced above; mode is driven by the hs frame
      const conn = new GatewayConnection({
        deps, bridge,
        send: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
        close: () => { try { ws.close(); } catch { /* closing */ } },
      });
      ws.on("message", (data: WebSocket.RawData) => {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        conn.onMessage(buf);
      });
      ws.on("close", () => conn.dispose());
      conn.start();
    });
  };

  server.on("upgrade", onUpgrade);
  return {
    stop: (): void => {
      server.off("upgrade", onUpgrade);
      bridge.stop();
      wss.close();
    },
  };
}
