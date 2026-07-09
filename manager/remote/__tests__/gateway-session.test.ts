// GatewayConnection over the relay path (plaintext v3). No handshake: on join the
// daemon goes live immediately, then a plaintext `control` data frame dispatches
// into the route layer and a plaintext `reply` comes back; a bus publish fans out
// as a plaintext `event`. Mirrors the phone side by building/parsing the outer
// envelope + inner JSON directly (no crypto).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { GatewayConnection, type GatewayDeps } from "../gateway.ts";
import { WsBridge } from "../WsBridge.ts";
import { RemoteAuditLog } from "../audit.ts";
import { Dir, FrameType, encodeEnvelope, parseEnvelope, type Envelope } from "../envelope.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

class FakeBus implements EventBus {
  private subs: EventBusSubscriber[] = [];
  publish(topic: EventBusTopic, payload: unknown): void {
    for (const fn of this.subs) fn({ topic, payload, ts: 0 });
  }
  subscribe(_topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void {
    this.subs.push(fn);
    return () => { this.subs = this.subs.filter((f) => f !== fn); };
  }
}

const ROOM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function mkDeps(dir: string, bus: EventBus): GatewayDeps {
  return {
    audit: new RemoteAuditLog(dir), uiToken: "UITOK",
    routeDispatch: async ({ path }) => ({ status: 200, body: { ok: true, path } }),
    bus, room: ROOM, now: () => Date.now(),
  };
}

// Build a c2s data envelope carrying a plaintext inner frame (the phone side).
function c2s(frame: object, clientId: Buffer): Buffer {
  return encodeEnvelope({
    type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room: ROOM, clientId,
    payload: Buffer.from(JSON.stringify(frame), "utf8"),
  });
}
const parseInner = (buf: Buffer): { env: Envelope; json: any } => {
  const env = parseEnvelope(buf);
  return { env, json: JSON.parse(env.payload.toString("utf8")) };
};

describe("GatewayConnection (relay v3 plaintext session)", () => {
  it("goes live on join and answers a control frame with a plaintext reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-gw-"));
    try {
      const bus = new FakeBus();
      const bridge = new WsBridge({ bus, now: () => 0 });
      bridge.start();
      const clientId = randomBytes(16);
      const out: Buffer[] = [];
      // joinAck:false mirrors the relay wiring (the relay already acked the join).
      const conn = new GatewayConnection({
        deps: mkDeps(dir, bus), bridge, clientId, joinAck: false,
        send: (buf) => out.push(buf), close: () => {},
      });
      conn.start();
      assert.equal(bridge.size(), 1, "session is live after start");

      const corr = crypto.randomUUID();
      conn.onEnvelope(parseEnvelope(c2s({ t: "control", correlationId: corr, method: "GET", path: "/workers", body: "{}" }, clientId)));
      await new Promise((r) => setTimeout(r, 10)); // dispatch is async

      const reply = out.map(parseInner).find((m) => m.json.t === "reply");
      assert.ok(reply, "a reply frame was sent");
      assert.equal(reply!.env.dir, Dir.s2c);
      assert.equal(reply!.json.correlationId, corr);
      assert.equal(reply!.json.status, 200);
      assert.deepEqual(reply!.json.body, { ok: true, path: "/workers" });

      conn.dispose();
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fans a bus event out to the live session as a plaintext event frame", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-gw-"));
    try {
      const bus = new FakeBus();
      const bridge = new WsBridge({ bus, now: () => 777 });
      bridge.start();
      const clientId = randomBytes(16);
      const out: Buffer[] = [];
      const conn = new GatewayConnection({
        deps: mkDeps(dir, bus), bridge, clientId, joinAck: false,
        send: (buf) => out.push(buf), close: () => {},
      });
      conn.start();

      bus.publish("worker:change", { workerId: "w-1" });
      const evt = out.map(parseInner).find((m) => m.json.t === "event");
      assert.ok(evt, "an event frame was fanned out");
      assert.equal(evt!.env.dir, Dir.s2c);
      assert.equal(evt!.json.reason, "worker:change");
      assert.deepEqual(evt!.json.payload, { workerId: "w-1" });
      assert.equal(evt!.json.ts, 777);

      conn.dispose();
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("self-acks the join (joined frame) when it owns clientId assignment", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-gw-"));
    try {
      const bus = new FakeBus();
      const bridge = new WsBridge({ bus, now: () => 0 });
      bridge.start();
      const clientId = randomBytes(16);
      const out: Buffer[] = [];
      const conn = new GatewayConnection({
        deps: mkDeps(dir, bus), bridge, clientId, joinAck: true,
        send: (buf) => out.push(buf), close: () => {},
      });
      conn.start();
      const ack = parseInner(out[0]);
      assert.equal(ack.env.type, FrameType.relayctl);
      assert.equal(ack.json.t, "joined");
      assert.equal(ack.json.clientId, clientId.toString("base64url"));
      assert.equal(ack.json.room, ROOM);

      conn.dispose();
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores a malformed inner frame without dispatching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-gw-"));
    try {
      const bus = new FakeBus();
      const bridge = new WsBridge({ bus, now: () => 0 });
      bridge.start();
      const clientId = randomBytes(16);
      const out: Buffer[] = [];
      const conn = new GatewayConnection({
        deps: mkDeps(dir, bus), bridge, clientId, joinAck: false,
        send: (buf) => out.push(buf), close: () => {},
      });
      conn.start();
      // Not valid JSON for any ClientFrame.
      conn.onEnvelope(parseEnvelope(encodeEnvelope({
        type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room: ROOM, clientId,
        payload: Buffer.from("not json", "utf8"),
      })));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(out.map(parseInner).filter((m) => m.json.t === "reply").length, 0, "no reply for a bad frame");

      conn.dispose();
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
