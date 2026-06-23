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

    // Relay → Mac: a device data frame (opaque payload forwarded verbatim).
    const payload = Buffer.from("ciphertext-bytes");
    serverSocket!.send(encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room, clientId, payload }));
    assert.equal((await data.promise).toString("utf8"), "ciphertext-bytes");

    conn.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
