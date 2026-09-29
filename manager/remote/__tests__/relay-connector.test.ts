// Deterministic RelayConnector test against an in-process mock relay (ws server
// speaking the §5 register/joined/data subset). The LIVE-relay check is a
// separate manual smoke script (remote/scripts/relay-smoke.ts), kept out of the
// suite so `npm test` stays offline + deterministic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { AddressInfo } from "node:net";

import { RelayConnector } from "../RelayConnector.ts";
import { encodeJsonEnvelope, encodeEnvelope, parseEnvelope, FrameType, Dir } from "../envelope.ts";

function once<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("RelayConnector ↔ mock relay", () => {
  it("dials, registers, then routes joined + data callbacks", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as AddressInfo).port)));
    const room = "AAAAAAAAAAAAAAAAAAAAAA";
    const clientId = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

    const gotRegister = once<{ room: string; owner: string; allow: string[] }>();
    let serverSocket: WebSocket | null = null;
    wss.on("connection", (ws) => {
      serverSocket = ws;
      ws.binaryType = "nodebuffer";
      ws.on("message", (data) => {
        const env = parseEnvelope(data as Buffer);
        if (env.type === FrameType.register) {
          const j = JSON.parse(env.payload.toString("utf8"));
          gotRegister.resolve({ room: j.room, owner: j.owner, allow: j.allow });
        }
      });
    });

    const joined = once<Buffer>();
    const data = once<Buffer>();
    const conn = new RelayConnector({
      url: `ws://127.0.0.1:${port}/`, room, owner: "OWNER-SECRET-B64U",
      allow: () => ["deadbeef"], onJoined: (id) => joined.resolve(id),
      onData: (env) => data.resolve(env.payload), now: () => 0, reconnect: false,
    });
    conn.start();

    const reg = await gotRegister.promise;
    assert.equal(reg.room, room);
    assert.equal(reg.owner, "OWNER-SECRET-B64U");
    assert.deepEqual(reg.allow, ["deadbeef"]);
    assert.ok(conn.isRegistered());

    // Relay → Mac: a device joined.
    serverSocket!.send(encodeJsonEnvelope({
      type: FrameType.relayctl, room, dir: Dir.s2c, clientId,
      json: { t: "joined", clientId: clientId.toString("base64url"), room },
    }));
    assert.equal((await joined.promise).toString("hex"), clientId.toString("hex"));

    // Relay → Mac: a device data frame (opaque payload forwarded verbatim). In v3
    // the payload is plaintext inner-frame JSON, but the relay/connector are blind
    // to its contents either way.
    const payload = Buffer.from("plaintext-bytes");
    serverSocket!.send(encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room, clientId, payload }));
    assert.equal((await data.promise).toString("utf8"), "plaintext-bytes");

    conn.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("routes relay `left` to onLeft and tolerates the `registered` ack", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as AddressInfo).port)));
    const room = "AAAAAAAAAAAAAAAAAAAAAA";
    const clientId = Buffer.from("0f0e0d0c0b0a09080706050403020100", "hex");
    wss.on("connection", (ws) => {
      ws.send(encodeJsonEnvelope({ type: FrameType.relayctl, room, dir: Dir.s2c, json: { t: "registered", room } }));
      ws.send(encodeJsonEnvelope({ type: FrameType.relayctl, room, dir: Dir.s2c, clientId, json: { t: "left", clientId: clientId.toString("base64url"), room } }));
    });

    const left = once<Buffer>();
    const logs: string[] = [];
    const conn = new RelayConnector({
      url: `ws://127.0.0.1:${port}/`, room, owner: "O", allow: () => [],
      onJoined: () => {}, onLeft: (id) => left.resolve(id), onData: () => {},
      now: () => 0, reconnect: false, log: (m) => logs.push(m),
    });
    conn.start();
    assert.equal((await left.promise).toString("hex"), clientId.toString("hex"));
    assert.ok(logs.includes("relay acked register"));
    assert.ok(conn.isRegistered());

    conn.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("terminates a relay socket that stops answering pings, keeps a healthy one", async () => {
    const dead = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
    const healthy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const portOf = (w: WebSocketServer) => new Promise<number>((r) => w.on("listening", () => r((w.address() as AddressInfo).port)));
    const [deadPort, healthyPort] = await Promise.all([portOf(dead), portOf(healthy)]);
    const deadClosed = once<void>();
    dead.on("connection", (ws) => ws.on("close", () => deadClosed.resolve()));
    let healthyClosed = false;
    healthy.on("connection", (ws) => ws.on("close", () => { healthyClosed = true; }));

    const mk = (port: number) => new RelayConnector({
      url: `ws://127.0.0.1:${port}/`, room: "AAAAAAAAAAAAAAAAAAAAAA", owner: "O", allow: () => [],
      onJoined: () => {}, onData: () => {}, now: () => 0, reconnect: false, pingIntervalMs: 20,
    });
    const a = mk(deadPort);
    const b = mk(healthyPort);
    a.start();
    b.start();

    await deadClosed.promise; // no pong after one tick ⇒ terminated on the next
    await new Promise((r) => setTimeout(r, 100)); // ~5 ticks
    assert.equal(healthyClosed, false, "a ponging relay socket survives the same ticks");

    a.stop();
    b.stop();
    await Promise.all([dead, healthy].map((w) => new Promise<void>((r) => w.close(() => r()))));
  });

  it("redials once, promptly, when a wall-clock jump shows the Mac slept", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as AddressInfo).port)));
    const first = once<void>();
    const second = once<void>();
    let connections = 0;
    wss.on("connection", () => { connections++; (connections === 1 ? first : second).resolve(); });

    let clock = 0;
    const logs: string[] = [];
    const conn = new RelayConnector({
      url: `ws://127.0.0.1:${port}/`, room: "AAAAAAAAAAAAAAAAAAAAAA", owner: "O", allow: () => [],
      onJoined: () => {}, onData: () => {}, now: () => clock, wakeCheckMs: 20, log: (m) => logs.push(m),
    });
    conn.start();
    await first.promise;

    clock += 10 * 60_000; // ten minutes passed between two ticks
    await second.promise; // well before the ~50s two-ping detection
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(connections, 2, "exactly one redial");
    assert.ok(logs.includes("system wake detected — redialing relay"));

    conn.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("skips a pending backoff and dials at once after wake", async () => {
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((r) => probe.on("listening", () => r((probe.address() as AddressInfo).port)));
    await new Promise<void>((r) => probe.close(() => r()));

    let clock = 0;
    const logs: string[] = [];
    const conn = new RelayConnector({
      url: `ws://127.0.0.1:${port}/`, room: "AAAAAAAAAAAAAAAAAAAAAA", owner: "O", allow: () => [],
      onJoined: () => {}, onData: () => {}, now: () => clock, wakeCheckMs: 20, log: (m) => logs.push(m),
    });
    conn.start(); // relay down → reconnect scheduled 1s out
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.includes("relay reconnect scheduled"));

    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    const connected = once<void>();
    wss.on("connection", () => connected.resolve());
    const startedAt = Date.now();
    clock += 10 * 60_000;
    await connected.promise;
    assert.ok(Date.now() - startedAt < 500, "dialed without waiting out the backoff");

    conn.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
