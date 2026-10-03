// The relay leg of a peer link: a byte pipe between a device and a host that
// both dialled out to the same self-hosted relay. The pipe carries the TLS
// stream opaquely inside relay `data` envelopes — the relay routes by room and
// client id and only ever sees ciphertext; identity is still proven end to end
// by the pinned certificates.
//
// Host side: one relay room just for peering (the phone keeps its own room), a
// pipe per joined device, each fed into the same TLS server as a direct socket.
// Device side: join the host's room with this device's relay bearer (or, while
// pairing, a bearer derived from the invite secret) and get one pipe back.

import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import WebSocket from "ws";

import { Dir, FrameType, encodeEnvelope, encodeJsonEnvelope, parseEnvelope, type Envelope } from "../remote/envelope.ts";
import { RelayConnector } from "../remote/RelayConnector.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

const JOIN_TIMEOUT_MS = 8_000;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024 + 1024;
// One relay frame carries at most this much of a write burst.
const BATCH_BYTES = 256 * 1024;
// Keeps a relay leg's NAT mapping warm and notices a half-open socket.
const PING_INTERVAL_MS = 20_000;

// Pairing over the relay: the relay admits a join by bearer, and it sees that
// bearer in the clear. Deriving it from the invite secret keeps the secret itself
// inside TLS — the relay operator learns nothing it could redeem.
export function relayJoinBearer(inviteSecret: string): string {
  return createHash("sha256").update(`eos-relay-join\0${inviteSecret}`).digest("base64url");
}

export function bearerHash(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

// A Duplex over "send a chunk" + "a chunk arrived": the shape both relay ends share.
export class RelayPipe extends Duplex {
  private readonly sendChunk: (chunk: Buffer, cb: (err?: Error | null) => void) => void;
  private readonly onGone: () => void;

  constructor(args: { send: (chunk: Buffer, cb: (err?: Error | null) => void) => void; onDestroy?: () => void }) {
    super();
    this.sendChunk = args.send;
    this.onGone = args.onDestroy ?? (() => {});
  }

  feed(chunk: Buffer): void {
    if (!this.destroyed) this.push(chunk);
  }

  // The other end is gone for good: end the readable side, then tear down.
  closeFromRemote(): void {
    if (this.destroyed) return;
    this.push(null);
    this.destroy();
  }

  override _read(): void { /* pushed as envelopes arrive */ }

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.sendChunk(chunk, (err) => cb(err ?? null));
  }

  // The TLS records queued behind the frame on the wire leave together: one
  // envelope and one WebSocket frame for a burst instead of one per record.
  override _writev(chunks: Array<{ chunk: Buffer }>, cb: (err?: Error | null) => void): void {
    const batches: Buffer[] = [];
    let group: Buffer[] = [];
    let size = 0;
    for (const { chunk } of chunks) {
      if (size > 0 && size + chunk.length > BATCH_BYTES) { batches.push(Buffer.concat(group)); group = []; size = 0; }
      group.push(chunk);
      size += chunk.length;
    }
    if (group.length > 0) batches.push(Buffer.concat(group));
    const next = (i: number): void => {
      if (i === batches.length) { cb(null); return; }
      this.sendChunk(batches[i], (err) => (err ? cb(err) : next(i + 1)));
    };
    next(0);
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    this.onGone();
    cb(err);
  }
}

export class RelayJoinError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RelayJoinError";
    this.code = code;
  }
}

// Device side: dial the relay, join the host's room, resolve with the pipe once
// the relay has assigned this connection its client id.
export function openRelayPipe(args: { url: string; room: string; bearer: string; timeoutMs?: number }): Promise<RelayPipe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(args.url, { maxPayload: MAX_PAYLOAD_BYTES });
    ws.binaryType = "nodebuffer";
    let pipe: RelayPipe | null = null;
    let clientId: Buffer | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const fail = (e: Error): void => {
      clearTimeout(timer);
      if (ping) clearInterval(ping);
      try { ws.terminate(); } catch { /* already down */ }
      if (pipe) pipe.destroy(e);
      else reject(e);
    };
    const timer = setTimeout(() => fail(new RelayJoinError("TIMEOUT", "relay did not admit this device in time")), args.timeoutMs ?? JOIN_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(encodeJsonEnvelope({ type: FrameType.join, room: args.room, dir: Dir.c2s, json: { t: "join", room: args.room, bearer: args.bearer } }));
    });
    ws.on("message", (data: WebSocket.RawData) => {
      let env: Envelope;
      try { env = parseEnvelope(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); } catch { return; }
      if (env.type === FrameType.data) {
        if (pipe && clientId && env.clientId.equals(clientId)) pipe.feed(Buffer.from(env.payload));
        return;
      }
      const j = parseJson(env.payload);
      if (env.type === FrameType.error) {
        fail(new RelayJoinError(typeof j?.code === "string" ? j.code : "RELAY_ERROR", typeof j?.message === "string" ? j.message : "relay refused"));
        return;
      }
      if (env.type === FrameType.relayctl && j?.t === "joined" && typeof j.clientId === "string" && !pipe) {
        clearTimeout(timer);
        const id = Buffer.from(j.clientId, "base64url");
        clientId = id;
        pipe = new RelayPipe({
          send: (chunk, cb) => {
            if (ws.readyState !== WebSocket.OPEN) { cb(new Error("relay closed")); return; }
            ws.send(encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, room: args.room, clientId: id, payload: chunk }), cb);
          },
          onDestroy: () => { if (ping) clearInterval(ping); try { ws.close(); } catch { /* closing */ } },
        });
        let ponged = true;
        ws.on("pong", () => { ponged = true; });
        ping = setInterval(() => {
          if (!ponged) { fail(new Error("relay stopped answering")); return; }
          ponged = false;
          ws.ping();
        }, PING_INTERVAL_MS);
        ping.unref?.();
        resolve(pipe);
      }
    });
    ws.on("error", (e: Error) => fail(e));
    ws.on("close", () => {
      if (ping) clearInterval(ping);
      if (pipe) pipe.closeFromRemote();
      else fail(new RelayJoinError("CLOSED", "relay closed the connection"));
    });
  });
}

function parseJson(payload: Buffer): Record<string, unknown> | null {
  try { return JSON.parse(payload.toString("utf8")) as Record<string, unknown>; } catch { return null; }
}

// Host side: this Mac's peering room on the relay. Every device the relay admits
// becomes a pipe handed to `onPipe` (the peer TLS server).
export class PeerRelayHost {
  private readonly connector: RelayConnector;
  private readonly pipes = new Map<string, RelayPipe>();
  readonly url: string;
  readonly room: string;

  constructor(args: {
    url: string;
    room: string;
    owner: string;
    allow: () => string[];
    onPipe: (pipe: RelayPipe) => void;
    log: Logger;
  }) {
    this.url = args.url;
    this.room = args.room;
    const drop = (hex: string): void => {
      const p = this.pipes.get(hex);
      this.pipes.delete(hex);
      p?.closeFromRemote();
    };
    this.connector = new RelayConnector({
      url: args.url,
      room: args.room,
      owner: args.owner,
      allow: args.allow,
      now: () => Date.now(),
      onJoined: (clientId) => {
        const hex = clientId.toString("hex");
        drop(hex);
        const pipe = new RelayPipe({
          send: (chunk, cb) => {
            this.connector.sendData(encodeEnvelope({ type: FrameType.data, dir: Dir.s2c, room: args.room, clientId, payload: chunk }), (err) => cb(err ?? null));
          },
          onDestroy: () => { if (this.pipes.get(hex) === pipe) this.pipes.delete(hex); },
        });
        this.pipes.set(hex, pipe);
        args.onPipe(pipe);
      },
      onLeft: (clientId) => drop(clientId.toString("hex")),
      // A fresh relay socket: the relay dropped every device joined through the
      // old one, so their pipes are dead — they rejoin.
      onRegistered: () => { for (const hex of [...this.pipes.keys()]) drop(hex); },
      onData: (env) => this.pipes.get(env.clientId.toString("hex"))?.feed(Buffer.from(env.payload)),
      onError: (code, message) => args.log.warn("[peer] relay error", { code, message }),
      log: (m, x) => args.log.info(`[peer-relay] ${m}`, x ?? {}),
    });
  }

  start(): void { this.connector.start(); }

  stop(): void {
    this.connector.stop();
    for (const p of this.pipes.values()) p.destroy();
    this.pipes.clear();
  }

  online(): boolean { return this.connector.isRegistered(); }

  refreshAllow(): void { this.connector.refreshAllow(); }
}
