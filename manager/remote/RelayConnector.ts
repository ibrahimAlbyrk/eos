// RelayConnector — the daemon's outbound relay leg (relay v3, §4). The daemon
// dials OUT to the self-hosted relay (no inbound NAT hole), registers/owns its
// room (TOFU), and thereafter the relay is a dumb unicast pipe: it forwards our
// per-device frames by clientId + dir. Payloads are now PLAINTEXT UTF-8 JSON —
// the relay (which you self-host) can see content; TLS at the relay edge is the
// only confidentiality layer (§1, decision 1).
//
// This owns ONLY the relay transport: dial, register, reconnect (1s→60s), and
// envelope in/out. Per-device session + dispatch is the caller's job, driven by
// the onJoined / onData callbacks. relayUrl is always config-driven
// (config.remote.relay.url) — never hardcoded here.

import WebSocket from "ws";
import { encodeJsonEnvelope, parseEnvelope, FrameType, type Envelope } from "./envelope.ts";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface RelayConnectorDeps {
  url: string; // wss://<relay>/  — from config.remote.relay.url
  room: string; // b64url(>=32 bytes) routing key + capability
  owner: string; // b64u room-owner secret (relay stores only its SHA-256)
  allow: () => string[]; // the room's admission allowlist (hex) — in v3 [ sha256Hex(bearer) ]
  onJoined: (clientId: Buffer) => void; // a device joined → go live for it
  onData: (env: Envelope) => void; // incoming c2s data frame for a device session
  onError?: (code: string, message: string) => void;
  onRegistered?: () => void;
  now: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  reconnect?: boolean; // default true
  // Injectable for tests (a local ws server); defaults to the real ws client.
  WebSocketCtor?: typeof WebSocket;
}

type State = "idle" | "connecting" | "registered" | "stopped";

export class RelayConnector {
  private readonly deps: RelayConnectorDeps;
  private ws: WebSocket | null = null;
  private state: State = "idle";
  private backoff = BACKOFF_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: RelayConnectorDeps) { this.deps = deps; }

  start(): void {
    if (this.state === "stopped") this.state = "idle";
    this.dial();
  }

  stop(): void {
    this.state = "stopped";
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
  }

  isRegistered(): boolean { return this.state === "registered"; }

  // Send an outgoing s2c data envelope (plaintext inner frame, framed by the session).
  sendData(envelope: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(envelope);
    return true;
  }

  private dial(): void {
    if (this.state === "stopped") return;
    this.state = "connecting";
    const Ctor = this.deps.WebSocketCtor ?? WebSocket;
    const ws = new Ctor(this.deps.url, { maxPayload: 5 * 1024 * 1024 + 1024 });
    ws.binaryType = "nodebuffer";
    this.ws = ws;

    ws.on("open", () => {
      this.deps.log?.("relay connected", { url: this.deps.url, room: this.deps.room });
      ws.send(encodeJsonEnvelope({
        type: FrameType.register, room: this.deps.room,
        json: { t: "register", room: this.deps.room, owner: this.deps.owner, allow: this.deps.allow() },
      }));
      // The relay acks success by silence (errors only on failure, §5.2); treat
      // a clean register send as registered and reset backoff.
      this.state = "registered";
      this.backoff = BACKOFF_MIN_MS;
      this.deps.onRegistered?.();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const buf = toBuffer(data);
      if (buf) this.onMessage(buf);
    });

    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (e: Error) => {
      this.deps.log?.("relay socket error", { error: e.message });
      // 'close' follows 'error' for ws; reconnect is scheduled there.
    });
  }

  private onMessage(buf: Buffer): void {
    let env: Envelope;
    try { env = parseEnvelope(buf); } catch { return; }
    switch (env.type) {
      case FrameType.data:
        this.deps.onData(env);
        return;
      case FrameType.relayctl: {
        const j = parseJson(env.payload);
        if (j?.t === "joined" && typeof j.clientId === "string") {
          this.deps.onJoined(Buffer.from(j.clientId, "base64url"));
        }
        return;
      }
      case FrameType.error: {
        const j = parseJson(env.payload);
        this.deps.onError?.(typeof j?.code === "string" ? j.code : "UNKNOWN", typeof j?.message === "string" ? j.message : "");
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    this.ws = null;
    if (this.state === "stopped" || this.deps.reconnect === false) return;
    this.state = "idle";
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.deps.log?.("relay reconnect scheduled", { delayMs: delay });
    this.retryTimer = setTimeout(() => this.dial(), delay);
    this.retryTimer.unref?.();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

function parseJson(payload: Buffer): Record<string, unknown> | null {
  try { return JSON.parse(payload.toString("utf8")) as Record<string, unknown>; } catch { return null; }
}
