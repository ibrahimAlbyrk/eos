// Remote gateway mount (connection v2). The ONE network surface: a /ws upgrade
// (LAN) or a per-device relay session. Each connection runs a single Noise_IK
// handshake (the device → Mac msg-1 carries the device static, encrypted; the Mac
// records it on enrollment or matches it against the persisted allowlist), then
// control frames dispatch into the EXISTING route handlers while the EventBus
// fans out as sealed event frames.
//
// The handshake is the binary Noise message set carried as the opaque payload of
// a type=0x01 data envelope (the relay never inspects it). There is ONE connect
// path used byte-identically on first connect and every reconnect — the only
// delta is a one-time enrollment token inside msg-1 and a record-vs-match branch
// here (docs/ios-remote-connection-v2.md §5).

import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, createHash } from "node:crypto";

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { parseEnvelope, encodeEnvelope, encodeJsonEnvelope, FrameType, Dir, MAX_ENVELOPE_BYTES, type Envelope } from "./envelope.ts";
import { RemoteSessionCodec } from "./session.ts";
import { NoiseResponder } from "./noise.ts";
import { parsePayload1 } from "./identity.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "./dispatch.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "./WsBridge.ts";
import { MacIdentity, DeviceKeyring, sha256Hex } from "./keyring.ts";
import type { RemoteAuditLog } from "./audit.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";

// The wire version byte that prefixes every Noise handshake message. A v1 client
// (or a future v3) fails closed here rather than misparsing.
const HS_WIRE_VERSION = 0x02;

// Every v2 session is a full mutual-auth Noise session — there is no reduced-
// capability (resumed) tier anymore, so every connection holds the full set.
// "mutate" gates the local ui-token for ✦ routes; "highrisk" gates HIGH routes.
export const SESSION_CAPS = ["read", "lowrisk", "mutate", "highrisk"] as const;

export interface PairingProvider {
  // SHA-256 (hex) of the armed one-time enrollment token, or null when no offer.
  enrollTokenHash(): string | null;
  // Constant-time match of a token a device presented inside Noise msg-1.
  matchToken(tokenB64u: string): boolean;
  burn(): void;
}

export interface GatewayDeps {
  identity: MacIdentity;
  keyring: DeviceKeyring;
  audit: RemoteAuditLog;
  uiToken: string;
  routeDispatch: RouteDispatch;
  bus: EventBus;
  room: string;
  now: () => number;
  pairing: PairingProvider;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  // Relay mode: a device just enrolled — add SHA-256(relayDeviceId) to the relay
  // allowlist so its NEXT reopen (which joins on that id) is admitted. LAN mode
  // leaves this undefined (/ws admits the id directly).
  onEnrolled?: (relayDeviceIdHashHex: string) => void;
}

// LAN admission: the value a device presents at /ws is its relayDeviceId (an
// enrolled device) OR the one-time enrollment token (pairing). Constant-time over
// the candidate hashes; mirrors the relay's blind hash-membership admission.
function admitted(value: string, deps: GatewayDeps): "device" | "pairing" | null {
  const h = createHash("sha256").update(value).digest("hex");
  for (const allowed of deps.keyring.admissionHashes()) {
    if (constantTimeEqual(h, allowed)) return "device";
  }
  const enroll = deps.pairing.enrollTokenHash();
  if (enroll && constantTimeEqual(h, enroll)) return "pairing";
  return null;
}

// Drives ONE device connection through join-ack → Noise handshake → live
// dispatch. `send` writes a raw outer-envelope buffer to the transport.
export class GatewayConnection {
  private readonly deps: GatewayDeps;
  private readonly bridge: WsBridge;
  private readonly send: (buf: Buffer) => void;
  private readonly close: (reason?: string) => void;
  private readonly clientId: Buffer;
  private readonly dispatcher: ControlDispatcher;
  private codec: RemoteSessionCodec | null = null;
  private session: RemoteSession | null = null;
  private readonly joinAck: boolean;

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
    this.dispatcher = new ControlDispatcher({
      routeDispatch: args.deps.routeDispatch, audit: args.deps.audit,
      uiToken: args.deps.uiToken, now: args.deps.now,
    });
  }

  // LAN: the daemon is the clientId authority and join-acks before any hs frame.
  start(): void {
    if (this.joinAck) {
      this.send(encodeJsonEnvelope({
        type: FrameType.relayctl, room: this.deps.room, dir: Dir.s2c, clientId: this.clientId,
        json: { t: "joined", clientId: this.clientId.toString("base64url"), room: this.deps.room },
      }));
    }
  }

  onMessage(buf: Buffer): void {
    if (buf.length > MAX_ENVELOPE_BYTES) { this.fail("FRAME_TOO_LARGE"); return; }
    let env;
    try { env = parseEnvelope(buf); } catch { return; }
    this.onEnvelope(env);
  }

  onEnvelope(env: Envelope): void {
    if (env.type !== FrameType.data) return; // gateway only consumes data-typed frames
    if (!this.codec) { this.onHandshake(env.payload); return; }
    void this.onLiveFrame(env).catch((e) =>
      this.deps.log?.("remote dispatch error", { error: e instanceof Error ? e.message : String(e) }));
  }

  // The whole Noise_IK handshake completes on receiving msg-1: read msg-1
  // (record/match the device static), then write msg-2 and go live.
  private onHandshake(payload: Buffer): void {
    if (payload.length < 1 || payload[0] !== HS_WIRE_VERSION) { this.fail("BAD_VERSION"); return; }
    const resp = new NoiseResponder(this.deps.identity.keypair());
    const r1 = resp.readMessage1(payload.subarray(1));
    if (!r1) { this.fail("DECRYPT_FAIL"); return; }

    const p1 = parsePayload1(r1.payload1);
    if (!p1) { this.fail("AUTH_FAILED"); return; }

    let devId: string;
    let label: string;
    if (p1.kind === "enroll") {
      if (!this.deps.pairing.matchToken(p1.token)) { this.rejectAuth(); return; }
      const rec = this.deps.keyring.record(r1.deviceStaticPub, p1.label, this.deps.now());
      this.deps.pairing.burn();
      this.deps.onEnrolled?.(sha256Hex(rec.relayDeviceId));
      devId = rec.relayDeviceId; label = rec.label;
      this.deps.log?.("remote device enrolled", { relayDeviceId: devId, label });
    } else {
      const rec = this.deps.keyring.findByStaticPub(r1.deviceStaticPub);
      if (!rec) { this.rejectAuth(); return; }
      devId = rec.relayDeviceId; label = rec.label;
    }

    const { msg2, keys } = resp.writeMessage2(Buffer.alloc(0));
    this.sendCleartext(Buffer.concat([Buffer.from([HS_WIRE_VERSION]), msg2]));

    this.codec = new RemoteSessionCodec({
      clientId: this.clientId, room: this.deps.room, devId, caps: [...SESSION_CAPS],
      sessionTH: keys.sessionTH, keys: { kC2sFinal: keys.kC2sFinal, kS2cFinal: keys.kS2cFinal },
    });
    this.goLive(devId, label);
  }

  private goLive(devId: string, label: string): void {
    this.session = {
      id: this.clientId.toString("hex"),
      send: (f: ServerFrame) => this.send(this.codec!.seal(f)),
      close: (reason?: string) => this.close(reason),
    };
    this.bridge.add(this.session);
    this.deps.log?.("remote device live", { clientId: this.session.id, devId, label });
  }

  // A pre-traffic-key frame (Noise msg-2 / auth-rejected): rides cleartext in a
  // type=0x01 envelope; the relay never inspects it.
  private sendCleartext(payload: Buffer): void {
    this.send(encodeEnvelope({
      type: FrameType.data, dir: Dir.s2c, epoch: 0, seq: 0n,
      room: this.deps.room, clientId: this.clientId, payload,
    }));
  }

  // Signal genuine de-enrollment so the device goes to NEEDS_PAIRING (not a
  // transient retry). Sent cleartext (no session key yet), then close.
  private rejectAuth(): void {
    this.sendCleartext(Buffer.from(JSON.stringify({ t: "error", code: "AUTH_REJECTED" }), "utf8"));
    this.fail("AUTH_REJECTED");
  }

  private async onLiveFrame(env: Envelope): Promise<void> {
    const opened = this.codec!.open(env);
    if (!opened.ok) {
      this.deps.log?.("remote live-frame rejected", { code: opened.code, seq: env.seq.toString() });
      return;
    }
    const frame = opened.frame;
    if (frame.t === "ka") return;
    if (frame.t === "hello") return;
    const ds: DispatchSession = { devId: this.codec!.devId, hasCap: (c) => this.codec!.hasCap(c) };
    const reply = await this.dispatcher.handle(ds, frame);
    this.deps.log?.("remote control", { method: frame.method, path: frame.path, status: reply.t === "reply" ? reply.status : reply.t });
    this.send(this.codec!.seal(reply));
  }

  private fail(code: string): void {
    this.deps.log?.("remote connection rejected", { code });
    this.close(code);
  }

  dispose(): void {
    if (this.session) this.bridge.remove(this.session.id);
  }
}

// Build the LAN-direct /ws gateway WITHOUT binding it to a server (see the
// RemoteController for why the upgrade listener is held persistently).
export function createLanGateway(deps: GatewayDeps): {
  onUpgrade: (req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer) => void;
  stop: () => void;
} {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ENVELOPE_BYTES + 1024 });
  const bridge = new WsBridge({ bus: deps.bus, now: deps.now });
  bridge.start();

  const onUpgrade = (req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return; // not ours — leave for any other upgrade handler
    const auth = req.headers["authorization"];
    const value = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!value || !admitted(value, deps)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = "nodebuffer";
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

  return { onUpgrade, stop: (): void => { bridge.stop(); wss.close(); } };
}

// Mount the LAN-direct /ws gateway onto the daemon's HTTP server. Thin wrapper for
// callers that own the server lifetime (the gateway-ws test, direct LAN boot).
export function mountWsGateway(server: Server, deps: GatewayDeps): { stop: () => void } {
  const gw = createLanGateway(deps);
  server.on("upgrade", gw.onUpgrade);
  return {
    stop: (): void => {
      server.off("upgrade", gw.onUpgrade);
      gw.stop();
    },
  };
}
