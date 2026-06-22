// End-to-end over a REAL WebSocket on the daemon-style listener: mountWsGateway
// on an http.Server, then a ws client does bearer upgrade → join-ack → cold
// pairing → control round-trip. Proves the live /ws mount, not just the codec.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { randomBytes, createHash, generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";

import { mountWsGateway, type GatewayDeps } from "../gateway.ts";
import { MacIdentity, DeviceKeyring } from "../keyring.ts";
import { TicketStore } from "../tickets.ts";
import { RemoteAuditLog } from "../audit.ts";
import {
  hash, keyedHash, kdf, kxKeypair, kxSession, makeNonce, makeAad, aeadSeal, aeadOpen,
  p256Sign, p256PubToSec1, Dir,
} from "../crypto.ts";
import { ENVELOPE_VER, FrameType, encodeEnvelope, parseEnvelope } from "../envelope.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

// Minimal device-side crypto for the pairing + record path.
class Device {
  priv: KeyObject; pubSec1: Buffer; devId = "22222222-2222-4222-8222-222222222222";
  ePubC!: Buffer; eSecC!: Buffer; nC!: Buffer; kC2s!: Buffer; kS2c!: Buffer; th3!: Buffer;
  kC2sFinal!: Buffer; kS2cFinal!: Buffer; txSeq = 0n;
  constructor() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.priv = privateKey; this.pubSec1 = p256PubToSec1(createPublicKey(privateKey));
  }
  pair1(): object {
    const e = kxKeypair(); this.ePubC = e.pub; this.eSecC = e.sec; this.nC = randomBytes(16);
    return { v: 1, t: "hs", step: 1, mode: "pair", ePubC: b64u(this.ePubC), nC: b64u(this.nC) };
  }
  pair3(p2: any, macPub: Buffer, ots: Buffer): object {
    const ePubS = unb64u(p2.ePubS), nS = unb64u(p2.nS), encS = unb64u(p2.encS);
    const { kC2s, kS2c } = kxSession("client", this.ePubC, this.eSecC, ePubS);
    this.kC2s = kC2s; this.kS2c = kS2c;
    const th2 = hash(this.ePubC, this.nC, ePubS, nS);
    const s2 = aeadOpen(kdf(kS2c, "eos/v1 hs s2c", th2), makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), encS)!;
    assert.equal(JSON.parse(s2.toString()).iMac, b64u(macPub));
    this.th3 = hash(this.ePubC, this.nC, ePubS, nS, encS);
    const kHsC2s = kdf(kC2s, "eos/v1 hs c2s", this.th3);
    const sigC = p256Sign(this.priv, Buffer.concat([ascii("eos/v1 pair client"), this.th3]));
    const c3 = Buffer.from(JSON.stringify({
      iDev: b64u(this.pubSec1), devId: this.devId, label: "ws-dev",
      sigC: b64u(sigC), ots: b64u(keyedHash(ots, this.th3)),
    }), "utf8");
    const encC = aeadSeal(kHsC2s, makeNonce(0, Dir.c2s, 0n), Buffer.alloc(0), c3);
    this.kC2sFinal = kdf(kC2s, "eos/v1 data c2s", this.th3);
    this.kS2cFinal = kdf(kS2c, "eos/v1 data s2c", this.th3);
    return { v: 1, t: "hs", step: 3, mode: "pair", encC: b64u(encC) };
  }
  wrapHs(frame: object, room: string, clientId: Buffer): Buffer {
    return encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room, clientId, payload: Buffer.from(JSON.stringify(frame), "utf8") });
  }
  sealControl(frame: object, room: string, clientId: Buffer): Buffer {
    const seq = this.txSeq++;
    const aad = makeAad(ENVELOPE_VER, 0, Dir.c2s, seq, room, clientId);
    const ct = aeadSeal(this.kC2sFinal, makeNonce(0, Dir.c2s, seq), aad, Buffer.from(JSON.stringify(frame), "utf8"));
    return encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq, room, clientId, payload: ct });
  }
  open(buf: Buffer): any {
    const env = parseEnvelope(buf);
    if (env.type === FrameType.relayctl || env.type === FrameType.data && this.kS2cFinal === undefined) {
      return { __ctl: JSON.parse(env.payload.toString("utf8")), env };
    }
    const aad = makeAad(ENVELOPE_VER, 0, Dir.s2c, env.seq, env.room, env.clientId);
    const pt = aeadOpen(this.kS2cFinal, makeNonce(0, Dir.s2c, env.seq), aad, env.payload)!;
    return JSON.parse(pt.toString("utf8"));
  }
}

// Buffer EVERY inbound message so none is lost to a listener-attach race (the
// server sends the join-ack the instant the socket opens).
class MsgQueue {
  private buf: Buffer[] = [];
  private waiter: ((b: Buffer) => void) | null = null;
  constructor(ws: WebSocket) {
    ws.on("message", (d) => {
      const b = d as Buffer;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(b); }
      else this.buf.push(b);
    });
  }
  next(): Promise<Buffer> {
    const b = this.buf.shift();
    if (b) return Promise.resolve(b);
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}

describe("mountWsGateway over a real WebSocket", () => {
  it("rejects a missing/invalid bearer with 401", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-ws-"));
    const server = createServer();
    try {
      const deps = mkDeps(dir, null);
      const mount = mountWsGateway(server, deps);
      const port = await listen(server);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); // no Authorization
      const err = await new Promise<Error>((r) => ws.on("error", r));
      assert.match(err.message, /401/);
      mount.stop();
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("upgrade → join-ack → cold pairing → control reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-ws-"));
    const server = createServer();
    try {
      const ots = randomBytes(32);
      const pairBearer = randomBytes(32).toString("base64url");
      const deps = mkDeps(dir, { ots, bearerHash: sha256Hex(pairBearer) });
      const mount = mountWsGateway(server, deps);
      const port = await listen(server);

      const dev = new Device();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${pairBearer}` } });
      const q = new MsgQueue(ws);
      await new Promise<void>((r) => ws.on("open", () => r()));

      // join-ack
      const ack = dev.open(await q.next());
      assert.equal(ack.__ctl.t, "joined");
      const clientId = unb64u(ack.__ctl.clientId);
      const room = deps.room;

      // PAIR-1 → PAIR-2
      ws.send(dev.wrapHs(dev.pair1(), room, clientId));
      const pair2 = dev.open(await q.next()).__ctl;
      assert.equal(pair2.step, 2);

      // PAIR-3 → welcome (sealed)
      ws.send(dev.wrapHs(dev.pair3(pair2, deps.identity.publicSec1(), ots), room, clientId));
      const welcome = dev.open(await q.next());
      assert.equal(welcome.t, "reply");
      assert.ok(welcome.body.bearer && welcome.body.ticket);
      assert.ok(deps.keyring.find(dev.devId), "device enrolled via the live mount");

      // control round-trip (READ)
      ws.send(dev.sealControl({ t: "control", correlationId: crypto.randomUUID(), method: "GET", path: "/workers", body: "{}" }, room, clientId));
      const reply = dev.open(await q.next());
      assert.equal(reply.t, "reply");
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { ok: true, path: "/workers" });

      ws.close();
      mount.stop();
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

function mkDeps(dir: string, pairing: { ots: Buffer; bearerHash: string } | null): GatewayDeps {
  const identity = new MacIdentity(dir);
  const keyring = new DeviceKeyring(dir);
  const tickets = new TicketStore();
  const audit = new RemoteAuditLog(dir);
  return {
    identity, keyring, tickets, audit, uiToken: "UITOK",
    routeDispatch: async ({ path }) => ({ status: 200, body: { ok: true, path } }),
    bus: new NullBus(), room: "AAAAAAAAAAAAAAAAAAAAAA", now: () => Date.now(),
    pairing: {
      pairingBearerHash: () => pairing?.bearerHash ?? null,
      ots: () => pairing?.ots ?? null,
      burn: () => {},
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}
