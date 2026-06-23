// End-to-end over a REAL WebSocket on the daemon-style listener: mountWsGateway
// on an http.Server, then a ws client does bearer upgrade → join-ack → Noise_IK
// handshake → control round-trip. Proves the live /ws mount, the enroll vs steady
// branch, and a reconnect with the SAME static key — not just the codec.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { randomBytes, createHash } from "node:crypto";

import { mountWsGateway, type GatewayDeps } from "../gateway.ts";
import { MacIdentity, DeviceKeyring } from "../keyring.ts";
import { RemoteAuditLog } from "../audit.ts";
import { makeNonce, makeAad, aeadSeal, aeadOpen, x25519Keypair, Dir, type X25519KeyPair } from "../crypto.ts";
import { NoiseInitiator } from "../noise.ts";
import { relayDeviceId, buildEnrollPayload, STEADY_PAYLOAD } from "../identity.ts";
import { ENVELOPE_VER, FrameType, encodeEnvelope, parseEnvelope } from "../envelope.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

const HS_WIRE_VERSION = 0x02;
const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

// Minimal Noise_IK initiator + transport codec for one device connection.
class Device {
  readonly staticKp: X25519KeyPair;
  private kC2s!: Buffer;
  private kS2c!: Buffer;
  private txSeq = 0n;
  constructor(staticKp?: X25519KeyPair) { this.staticKp = staticKp ?? x25519Keypair(); }

  get relayDeviceId(): string { return relayDeviceId(this.staticKp.pub); }

  // Returns the c2s envelope carrying Noise msg-1 (version-prefixed).
  handshakeMsg1(macStaticPub: Buffer, payload1: Buffer, room: string, clientId: Buffer): { env: Buffer; init: NoiseInitiator } {
    const init = new NoiseInitiator(this.staticKp, macStaticPub);
    const msg1 = init.writeMessage1(payload1);
    const payload = Buffer.concat([Buffer.from([HS_WIRE_VERSION]), msg1]);
    return { env: encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room, clientId, payload }), init };
  }

  // Consume the cleartext msg-2 envelope → derive transport keys.
  readMsg2(buf: Buffer, init: NoiseInitiator): void {
    const env = parseEnvelope(buf);
    assert.equal(env.payload[0], HS_WIRE_VERSION);
    const r2 = init.readMessage2(env.payload.subarray(1));
    assert.ok(r2, "readMessage2 must succeed");
    this.kC2s = r2!.keys.kC2sFinal;
    this.kS2c = r2!.keys.kS2cFinal;
  }

  sealControl(frame: object, room: string, clientId: Buffer): Buffer {
    const seq = this.txSeq++;
    const aad = makeAad(ENVELOPE_VER, 0, Dir.c2s, seq, room, clientId);
    const ct = aeadSeal(this.kC2s, makeNonce(0, Dir.c2s, seq), aad, Buffer.from(JSON.stringify(frame), "utf8"));
    return encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq, room, clientId, payload: ct });
  }

  openReply(buf: Buffer): any {
    const env = parseEnvelope(buf);
    const aad = makeAad(ENVELOPE_VER, 0, Dir.s2c, env.seq, env.room, env.clientId);
    const pt = aeadOpen(this.kS2c, makeNonce(0, Dir.s2c, env.seq), aad, env.payload)!;
    return JSON.parse(pt.toString("utf8"));
  }

  ctl(buf: Buffer): any { return JSON.parse(parseEnvelope(buf).payload.toString("utf8")); }
}

// Buffer EVERY inbound message so none is lost to a listener-attach race.
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

describe("mountWsGateway over a real WebSocket (Noise_IK)", () => {
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

  it("enroll handshake → control reply, then steady reconnect with the same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-ws-"));
    const server = createServer();
    try {
      const enrollToken = randomBytes(32).toString("base64url");
      const deps = mkDeps(dir, enrollToken);
      const mount = mountWsGateway(server, deps);
      const port = await listen(server);
      const room = deps.room;
      const dev = new Device();

      // ---- ENROLL: join with the enrollment token ----
      {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${enrollToken}` } });
        const q = new MsgQueue(ws);
        await new Promise<void>((r) => ws.on("open", () => r()));
        const ack = dev.ctl(await q.next());
        assert.equal(ack.t, "joined");
        const clientId = unb64u(ack.clientId);

        const { env, init } = dev.handshakeMsg1(deps.identity.publicKey(), buildEnrollPayload(enrollToken, "ws-dev"), room, clientId);
        ws.send(env);
        dev.readMsg2(await q.next(), init);
        assert.ok(deps.keyring.findByStaticPub(dev.staticKp.pub), "device enrolled via the live mount");

        ws.send(dev.sealControl({ t: "control", correlationId: crypto.randomUUID(), method: "GET", path: "/workers", body: "{}" }, room, clientId));
        const reply = dev.openReply(await q.next());
        assert.equal(reply.t, "reply");
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, { ok: true, path: "/workers" });
        ws.close();
      }

      // ---- STEADY RECONNECT: join with the stable relayDeviceId, no token ----
      {
        const dev2 = new Device(dev.staticKp); // same static key
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${dev2.relayDeviceId}` } });
        const q = new MsgQueue(ws);
        await new Promise<void>((r) => ws.on("open", () => r()));
        const ack = dev2.ctl(await q.next());
        const clientId = unb64u(ack.clientId);

        const { env, init } = dev2.handshakeMsg1(deps.identity.publicKey(), STEADY_PAYLOAD, room, clientId);
        ws.send(env);
        dev2.readMsg2(await q.next(), init);

        ws.send(dev2.sealControl({ t: "control", correlationId: crypto.randomUUID(), method: "GET", path: "/pending", body: "{}" }, room, clientId));
        const reply = dev2.openReply(await q.next());
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, { ok: true, path: "/pending" });
        ws.close();
      }

      mount.stop();
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

function mkDeps(dir: string, enrollToken: string | null): GatewayDeps {
  const identity = new MacIdentity(dir);
  const keyring = new DeviceKeyring(dir);
  const audit = new RemoteAuditLog(dir);
  return {
    identity, keyring, audit, uiToken: "UITOK",
    routeDispatch: async ({ path }) => ({ status: 200, body: { ok: true, path } }),
    bus: new NullBus(), room: "AAAAAAAAAAAAAAAAAAAAAA", now: () => Date.now(),
    pairing: {
      enrollTokenHash: () => enrollToken ? createHash("sha256").update(enrollToken).digest("hex") : null,
      matchToken: (t: string) => enrollToken !== null && t === enrollToken,
      burn: () => {},
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}
