import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createRelay } from "../server.ts";
import { loadConfig } from "../config.ts";
import { encodeEnvelope, encodeJsonEnvelope, parseEnvelope, FrameType, Dir } from "../envelope.ts";
import { sha256Hex } from "../admission.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";

// Buffers inbound binary messages so a test can await them in arrival order.
class Inbox {
  private queue: Buffer[] = [];
  private waiters: ((b: Buffer) => void)[] = [];
  constructor(ws: WebSocket) {
    ws.binaryType = "nodebuffer";
    ws.on("message", (d) => {
      const buf = d as Buffer;
      const w = this.waiters.shift();
      if (w) w(buf);
      else this.queue.push(buf);
    });
  }
  next(): Promise<Buffer> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

async function withRelay(fn: (url: string, registry: ReturnType<typeof createRelay>["registry"]) => Promise<void>) {
  const { httpServer, wss, registry } = createRelay({ ...loadConfig(), host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  try {
    await fn(url, registry);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

test("register → join → bidirectional opaque forwarding", async () => {
  await withRelay(async (url, registry) => {
    const mac = new WebSocket(url);
    await once(mac, "open");
    const macIn = new Inbox(mac);
    mac.send(encodeJsonEnvelope({ type: FrameType.register, room: ROOM, dir: Dir.c2s, json: { t: "register", room: ROOM, owner: "owner-secret", allow: [sha256Hex("dev-bearer")] } }));
    await waitFor(() => registry.roomCount() === 1);

    const dev = new WebSocket(url);
    await once(dev, "open");
    const devIn = new Inbox(dev);
    dev.send(encodeJsonEnvelope({ type: FrameType.join, room: ROOM, dir: Dir.c2s, json: { t: "join", room: ROOM, bearer: "dev-bearer" } }));

    // Mac is notified to spin up the client session; device is acked with its clientId.
    const macJoined = parseEnvelope(await macIn.next());
    assert.equal(macJoined.type, FrameType.relayctl);
    const macBody = JSON.parse(macJoined.payload.toString("utf8"));
    assert.equal(macBody.t, "joined");

    const devJoined = parseEnvelope(await devIn.next());
    const devBody = JSON.parse(devJoined.payload.toString("utf8"));
    assert.equal(devBody.t, "joined");
    // §5.3: clientId is b64u (22 chars) of 16 raw bytes; header clientId == body clientId.
    assert.equal(devBody.clientId.length, 22);
    const clientId = Buffer.from(devBody.clientId, "base64url");
    assert.equal(clientId.length, 16);
    assert.ok(devJoined.clientId.equals(clientId), "join-ack header clientId matches the JSON body");
    // The Mac learns the byte-identical clientId from its own notify.
    assert.equal(macBody.clientId, devBody.clientId);

    // device → Mac (c2s): opaque payload forwarded verbatim
    const upPayload = Buffer.from("opaque-ciphertext-up");
    const upFrame = encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, seq: 1n, room: ROOM, clientId, payload: upPayload });
    dev.send(upFrame);
    const gotUp = await macIn.next();
    assert.ok(gotUp.equals(upFrame), "Mac receives the c2s frame byte-for-byte");

    // Mac → device (s2c): unicast to the addressed clientId
    const downPayload = Buffer.from("opaque-ciphertext-down");
    const downFrame = encodeEnvelope({ type: FrameType.data, dir: Dir.s2c, seq: 1n, room: ROOM, clientId, payload: downPayload });
    mac.send(downFrame);
    const gotDown = await devIn.next();
    assert.ok(gotDown.equals(downFrame), "device receives the s2c frame byte-for-byte");

    mac.close();
    dev.close();
  });
});

test("join with a denied bearer returns BEARER_DENIED", async () => {
  await withRelay(async (url, registry) => {
    const mac = new WebSocket(url);
    await once(mac, "open");
    mac.send(encodeJsonEnvelope({ type: FrameType.register, room: ROOM, dir: Dir.c2s, json: { t: "register", room: ROOM, owner: "owner", allow: [sha256Hex("good")] } }));
    await waitFor(() => registry.roomCount() === 1);

    const dev = new WebSocket(url);
    await once(dev, "open");
    const devIn = new Inbox(dev);
    dev.send(encodeJsonEnvelope({ type: FrameType.join, room: ROOM, dir: Dir.c2s, json: { t: "join", room: ROOM, bearer: "bad" } }));

    const err = parseEnvelope(await devIn.next());
    assert.equal(err.type, FrameType.error);
    assert.equal(JSON.parse(err.payload.toString("utf8")).code, "BEARER_DENIED");
    mac.close();
    dev.close();
  });
});

test("join on an unregistered room returns ROOM_NOT_FOUND", async () => {
  await withRelay(async (url) => {
    const dev = new WebSocket(url);
    await once(dev, "open");
    const devIn = new Inbox(dev);
    dev.send(encodeJsonEnvelope({ type: FrameType.join, room: "UNKNOWNROOMUNKNOWNROO0", dir: Dir.c2s, json: { t: "join", room: "UNKNOWNROOMUNKNOWNROO0", bearer: "x" } }));
    const err = parseEnvelope(await devIn.next());
    assert.equal(err.type, FrameType.error);
    assert.equal(JSON.parse(err.payload.toString("utf8")).code, "ROOM_NOT_FOUND");
    dev.close();
  });
});

test("/health responds 200 with room count", async () => {
  await withRelay(async (url) => {
    const res = await fetch(url.replace("ws://", "http://") + "/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});
